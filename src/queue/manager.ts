import { Job, Queue, QueueEvents } from 'bullmq';
import RedisConnection from './redis';
import { logger } from '../utils/logger';
import { JobData, QueueStats } from '../utils/types';
import config from '../config';

export class QueueManager {
  private static instance: QueueManager;
  private testQueue: Queue;
  private queueEvents: QueueEvents;
  private redisConnection: RedisConnection;

  private constructor() {
    this.redisConnection = RedisConnection.getInstance();
    const redisClient = this.redisConnection.getClient();

    // Initialize the test execution queue
    this.testQueue = new Queue('test-execution', {
      connection: redisClient,
      defaultJobOptions: config.queue.defaultJobOptions,
    });

    // Initialize queue events listener
    this.queueEvents = new QueueEvents('test-execution', {
      connection: redisClient,
    });

    this.setupQueueEventHandlers();
  }

  public static getInstance(): QueueManager {
    if (!QueueManager.instance) {
      QueueManager.instance = new QueueManager();
    }
    return QueueManager.instance;
  }

  private setupQueueEventHandlers(): void {
    this.queueEvents.on('completed', ({ jobId, returnvalue }) => {
      logger.info('Job completed', { jobId, result: returnvalue });
    });

    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      logger.error('Job failed', { jobId, error: failedReason });
    });

    this.queueEvents.on('stalled', ({ jobId }) => {
      logger.warn('Job stalled', { jobId });
    });

    this.queueEvents.on('progress', ({ jobId, data }) => {
      logger.debug('Job progress', { jobId, progress: data });
    });
  }

  public async addJob(jobData: JobData): Promise<Job<JobData>> {
    try {
      const job = await this.testQueue.add(
        'execute-test',
        jobData,
        {
          jobId: jobData.id,
          removeOnComplete: config.queue.defaultJobOptions.removeOnComplete,
          removeOnFail: config.queue.defaultJobOptions.removeOnFail,
          attempts: jobData.retries || config.queue.defaultJobOptions.attempts,
          backoff: config.queue.defaultJobOptions.backoff,
        }
      );

      logger.info('Job added to queue', { jobId: jobData.id });
      return job;
    } catch (error) {
      logger.error('Failed to add job to queue', { jobId: jobData.id, error });
      throw error;
    }
  }

  public async getJob(jobId: string): Promise<Job<JobData> | null> {
    try {
      return await this.testQueue.getJob(jobId) || null;
    } catch (error) {
      logger.error('Failed to get job', { jobId, error });
      throw error;
    }
  }

  public async getJobStatus(jobId: string): Promise<string> {
    try {
      const job = await this.getJob(jobId);
      if (!job) {
        return 'not_found';
      }

      const state = await job.getState();
      return state;
    } catch (error) {
      logger.error('Failed to get job status', { jobId, error });
      throw error;
    }
  }

  public async cancelJob(jobId: string): Promise<void> {
    try {
      const job = await this.getJob(jobId);
      if (job && (await job.isActive())) {
        await job.remove();
        logger.info('Job cancelled', { jobId });
      }
    } catch (error) {
      logger.error('Failed to cancel job', { jobId, error });
      throw error;
    }
  }

  public async retryJob(jobId: string): Promise<void> {
    try {
      const job = await this.getJob(jobId);
      if (job && (await job.isFailed())) {
        await job.retry();
        logger.info('Job retried', { jobId });
      }
    } catch (error) {
      logger.error('Failed to retry job', { jobId, error });
      throw error;
    }
  }

  public async getQueueStats(): Promise<QueueStats> {
    try {
      const counts = await this.testQueue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
        'paused'
      );

      return {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
        paused: counts.paused ?? 0,
      };
    } catch (error) {
      logger.error('Failed to get queue stats', { error });
      throw error;
    }
  }

  public async pauseQueue(): Promise<void> {
    try {
      await this.testQueue.pause();
      logger.info('Queue paused');
    } catch (error) {
      logger.error('Failed to pause queue', { error });
      throw error;
    }
  }

  public async resumeQueue(): Promise<void> {
    try {
      await this.testQueue.resume();
      logger.info('Queue resumed');
    } catch (error) {
      logger.error('Failed to resume queue', { error });
      throw error;
    }
  }

  public async clearQueue(): Promise<void> {
    try {
      await this.testQueue.clean(0, 0, 'completed');
      await this.testQueue.clean(0, 0, 'failed');
      logger.info('Queue cleared');
    } catch (error) {
      logger.error('Failed to clear queue', { error });
      throw error;
    }
  }

  public getQueueInstance(): Queue {
    return this.testQueue;
  }

  public getQueueEvents(): QueueEvents {
    return this.queueEvents;
  }

  public async close(): Promise<void> {
    try {
      await this.testQueue.close();
      await this.queueEvents.close();
      logger.info('Queue manager closed');
    } catch (error) {
      logger.error('Error closing queue manager', { error });
      throw error;
    }
  }
}

export default QueueManager;
