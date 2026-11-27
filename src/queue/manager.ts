import { Job, Queue } from 'bullmq';
import config from '../config';
import { createRedis } from './redis';
import { QueuePayload, QueueStats } from '../utils/types';

/** Thin wrapper around the BullMQ queue (producer side). */
export class QueueManager {
  private static instance: QueueManager | null = null;
  private readonly queue: Queue<QueuePayload>;

  constructor(queue?: Queue<QueuePayload>) {
    this.queue =
      queue ??
      new Queue<QueuePayload>(config.queue.name, {
        connection: createRedis('queue'),
        defaultJobOptions: {
          // Durable history lives in JobStore; BullMQ only needs short retention.
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 24 * 3600, count: 5000 },
        },
      });
  }

  static getInstance(): QueueManager {
    if (!QueueManager.instance) QueueManager.instance = new QueueManager();
    return QueueManager.instance;
  }

  static setInstance(manager: QueueManager | null): void {
    QueueManager.instance = manager;
  }

  async add(jobId: string, attempts: number, priority = 2): Promise<Job<QueuePayload>> {
    return this.queue.add(
      'execute-test',
      { jobId },
      {
        jobId,
        attempts,
        priority,
        backoff: { type: 'exponential', delay: config.queue.backoffDelayMs },
      }
    );
  }

  async getJob(jobId: string): Promise<Job<QueuePayload> | undefined> {
    return this.queue.getJob(jobId);
  }

  /**
   * Remove a job that has not started yet. Returns false if it is already
   * running (locked by a worker) or gone.
   */
  async removeIfPending(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId);
    if (!job) return false;
    const state = await job.getState();
    if (!['waiting', 'delayed', 'prioritized', 'waiting-children'].includes(state)) return false;
    try {
      await job.remove();
      return true;
    } catch {
      // Picked up by a worker between getState() and remove().
      return false;
    }
  }

  async getStats(): Promise<QueueStats> {
    const [counts, paused] = await Promise.all([
      this.queue.getJobCounts('waiting', 'prioritized', 'active', 'completed', 'failed', 'delayed'),
      this.queue.isPaused(),
    ]);
    return {
      // Every job carries a priority, so BullMQ keeps waiting jobs in "prioritized".
      waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0),
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
      paused,
    };
  }

  async pause(): Promise<void> {
    await this.queue.pause();
  }

  async resume(): Promise<void> {
    await this.queue.resume();
  }

  /** Remove every job that has not started yet; returns their ids. */
  async removePending(): Promise<string[]> {
    const removed: string[] = [];
    for (;;) {
      const jobs = await this.queue.getJobs(['waiting', 'delayed', 'prioritized'], 0, 499);
      if (jobs.length === 0) break;
      let progressed = false;
      for (const job of jobs) {
        try {
          await job.remove();
          removed.push(job.id!);
          progressed = true;
        } catch {
          /* started meanwhile */
        }
      }
      if (!progressed) break;
    }
    await this.queue.clean(0, 0, 'completed');
    await this.queue.clean(0, 0, 'failed');
    return removed;
  }

  async ping(): Promise<boolean> {
    try {
      const client = await this.queue.client;
      return (await client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

export default QueueManager;
