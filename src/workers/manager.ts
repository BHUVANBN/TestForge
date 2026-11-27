import { Job, UnrecoverableError, Worker } from 'bullmq';
import type Redis from 'ioredis';
import os from 'os';
import { randomUUID } from 'crypto';
import config from '../config';
import { channels, CancelEvent, publishLog, publishStatus } from '../jobs/events';
import { getJobStore, JobStore } from '../jobs/store';
import { ArtifactStore, getArtifactStore } from '../jobs/artifacts';
import { finalizeJob } from '../jobs/lifecycle';
import { buildReport } from '../jobs/report';
import { startWebhookWorker, WebhookDelivery } from '../webhooks';
import { createRedis, getRedis, redisKey } from '../queue/redis';
import { createLogger } from '../utils/logger';
import {
  jobCompletedCounter,
  jobDurationHistogram,
  workersActiveGauge,
  workersIdleGauge,
} from '../utils/metrics';
import { ExecutionResult, Executor, JobRecord, OutputListener, QueuePayload, WorkerHeartbeat } from '../utils/types';
import { DockerExecutor, removeOrphanContainers } from './dockerExecutor';
import { LocalExecutor } from './executor';

const log = createLogger('worker');

export type ExecutorFactory = (record: JobRecord, onOutput: OutputListener) => Executor;

export const defaultExecutorFactory: ExecutorFactory = (record, onOutput) =>
  config.workers.executor === 'docker' ? new DockerExecutor(record, onOutput) : new LocalExecutor(record, onOutput);

export interface WorkerManagerOptions {
  store?: JobStore;
  executorFactory?: ExecutorFactory;
  /** Set false in tests to process jobs by calling processJob() directly. */
  startWorker?: boolean;
  /** Opens dedicated Redis connections (subscriber, BullMQ worker). */
  connect?: (name: string) => Redis;
  /** Skip Docker orphan cleanup (tests). */
  skipOrphanCleanup?: boolean;
  artifacts?: ArtifactStore;
  /** Run the webhook delivery worker in this process (default: when startWorker). */
  deliverWebhooks?: boolean;
}

export class WorkerManager {
  readonly id = `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  private worker: Worker<QueuePayload> | null = null;
  private webhookWorker: Worker<WebhookDelivery> | null = null;
  private readonly artifacts: ArtifactStore;
  private subscriber: Redis | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly active = new Map<string, Executor>();
  private readonly store: JobStore;
  private readonly executorFactory: ExecutorFactory;
  private readonly startedAt = new Date().toISOString();
  private closing = false;
  private stats = { completed: 0, failed: 0, totalDurationMs: 0 };

  constructor(private readonly opts: WorkerManagerOptions = {}) {
    this.store = opts.store ?? getJobStore();
    this.executorFactory = opts.executorFactory ?? defaultExecutorFactory;
    this.artifacts = opts.artifacts ?? getArtifactStore();
  }

  async start(): Promise<void> {
    if (config.workers.executor === 'docker' && !this.opts.skipOrphanCleanup) {
      await removeOrphanContainers().catch((err) =>
        log.warn('Could not clean up orphaned containers', { error: err.message })
      );
    } else if (config.workers.executor === 'local') {
      log.warn(
        'WORKER_EXECUTOR=local: jobs run unsandboxed with this process\'s privileges. Use only with trusted submitters.'
      );
    }

    const connect = this.opts.connect ?? createRedis;
    this.subscriber = connect('worker-cancel-sub');
    await this.subscriber.subscribe(channels.cancel());
    this.subscriber.on('message', (_channel, message) => {
      try {
        const { jobId } = JSON.parse(message) as CancelEvent;
        const executor = this.active.get(jobId);
        if (executor) {
          log.info('Cancelling running job', { jobId });
          void executor.kill('cancel');
        }
      } catch {
        /* ignore malformed messages */
      }
    });

    if (this.opts.startWorker !== false) {
      this.worker = new Worker<QueuePayload>(config.queue.name, (job) => this.processJob(job), {
        connection: connect('worker'),
        concurrency: config.workers.concurrency,
        stalledInterval: config.queue.stalledIntervalMs,
        maxStalledCount: config.queue.maxStalledCount,
      });
      this.worker.on('error', (err) => log.error('Worker error', { error: err.message }));
      this.worker.on('stalled', (jobId) => log.warn('Job stalled; it will be re-queued', { jobId }));
    }
    if (this.opts.deliverWebhooks ?? this.opts.startWorker !== false) {
      this.webhookWorker = startWebhookWorker(connect);
    }

    await this.heartbeat();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), config.workers.heartbeatIntervalMs);
    this.updateGauges();
    log.info('Worker started', {
      workerId: this.id,
      executor: config.workers.executor,
      concurrency: config.workers.concurrency,
    });
  }

  isRunning(): boolean {
    return !this.closing && (this.opts.startWorker === false || !!this.worker?.isRunning());
  }

  async processJob(job: Job<QueuePayload>): Promise<{ status: string; exitCode: number | null }> {
    const jobId = job.data.jobId;
    const record = await this.store.get(jobId);
    if (!record) throw new UnrecoverableError(`Job record ${jobId} not found (expired or deleted)`);

    if (record.cancelRequested || record.status === 'cancelled') {
      await this.finish(record, 'cancelled', { error: 'Cancelled by user' });
      throw new UnrecoverableError('Cancelled by user');
    }

    // BullMQ increments attemptsMade when the job becomes active, so it is the
    // 1-based number of the attempt now running (and matches its retry rule).
    // A re-run after a worker shutdown also counts, so clamp for display.
    const maxAttempts = job.opts.attempts ?? record.maxAttempts ?? 1;
    const attempt = Math.min(Math.max(1, job.attemptsMade), maxAttempts);
    const startedAt = new Date().toISOString();
    await this.store.update(jobId, {
      status: 'running',
      attempt,
      startedAt,
      workerId: this.id,
      error: undefined,
      exitCode: undefined,
    });
    void publishStatus({ jobId, owner: record.owner, status: 'running', attempt });

    const onOutput: OutputListener = (stream, data) =>
      void publishLog({ jobId, owner: record.owner, stream, data });
    const executor = this.executorFactory({ ...record, attempt }, onOutput);
    this.active.set(jobId, executor);
    this.updateGauges();

    let result: ExecutionResult;
    try {
      result = await executor.run();
    } catch (err) {
      result = {
        outcome: 'failed',
        exitCode: null,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: Date.now() - Date.parse(startedAt),
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.active.delete(jobId);
      this.updateGauges();
    }

    if (result.outcome === 'interrupted') {
      // Worker is shutting down: leave the job active so its lock expires and
      // BullMQ's stalled-job check re-queues it on a healthy worker instead of
      // recording a failure the user didn't cause.
      await this.store.update(jobId, { status: 'queued', error: 'Interrupted by worker shutdown; re-queued' });
      void publishStatus({ jobId, owner: record.owner, status: 'queued' });
      return new Promise(() => undefined);
    }

    await this.store.saveOutput(jobId, { stdout: result.stdout, stderr: result.stderr, truncated: result.truncated });
    const artifacts = result.artifacts ?? [];
    if (artifacts.length) await this.artifacts.save(jobId, artifacts);
    const testReport = buildReport({ stdout: result.stdout, artifacts });

    // A cancel may have raced with normal completion.
    const latest = await this.store.get(jobId);
    const outcome = latest?.cancelRequested ? 'cancelled' : result.outcome;

    jobCompletedCounter.inc({ status: outcome });
    jobDurationHistogram.observe({ status: outcome }, result.durationMs);
    this.recordStats(outcome === 'completed', result.durationMs);

    const details = {
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      error: outcome === 'cancelled' ? 'Cancelled by user' : result.error,
      outputTruncated: result.truncated,
      artifactCount: artifacts.length,
      artifactsTruncated: result.artifactsTruncated ?? false,
      testReport,
    };

    if (outcome === 'completed') {
      await this.finish(record, 'completed', details);
      return { status: 'completed', exitCode: result.exitCode };
    }
    if (outcome === 'cancelled') {
      await this.finish(record, 'cancelled', details);
      throw new UnrecoverableError('Cancelled by user');
    }

    const willRetry = attempt < maxAttempts;
    if (willRetry) {
      await this.store.update(jobId, { status: 'retrying', ...details });
      void publishStatus({ jobId, owner: record.owner, status: 'retrying', attempt, ...details });
      log.info('Attempt failed, will retry', { jobId, attempt, maxAttempts, outcome });
    } else {
      await this.finish(record, outcome, details);
    }
    // Throwing hands retry/backoff bookkeeping to BullMQ.
    throw new Error(details.error ?? outcome);
  }

  private async finish(
    record: JobRecord,
    status: 'completed' | 'failed' | 'timeout' | 'cancelled',
    details: Partial<JobRecord>
  ): Promise<void> {
    await finalizeJob(record.id, status, details, this.store);
    log.info('Job finished', { jobId: record.id, status, exitCode: details.exitCode, durationMs: details.durationMs });
  }

  private recordStats(success: boolean, durationMs: number): void {
    if (success) this.stats.completed++;
    else this.stats.failed++;
    this.stats.totalDurationMs += durationMs;
  }

  private updateGauges(): void {
    workersActiveGauge.set(this.active.size);
    workersIdleGauge.set(Math.max(0, config.workers.concurrency - this.active.size));
  }

  heartbeatData(): WorkerHeartbeat {
    const finished = this.stats.completed + this.stats.failed;
    return {
      id: this.id,
      hostname: os.hostname(),
      pid: process.pid,
      executor: config.workers.executor,
      concurrency: config.workers.concurrency,
      active: this.active.size,
      completed: this.stats.completed,
      failed: this.stats.failed,
      averageExecutionTime: finished ? Math.round(this.stats.totalDurationMs / finished) : 0,
      startedAt: this.startedAt,
      lastSeen: new Date().toISOString(),
    };
  }

  private async heartbeat(): Promise<void> {
    try {
      const ttl = Math.ceil((config.workers.heartbeatIntervalMs * 3) / 1000);
      await getRedis().set(redisKey('worker', this.id), JSON.stringify(this.heartbeatData()), 'EX', ttl);
    } catch (err) {
      log.warn('Heartbeat failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Stop taking new jobs, let running ones finish within the shutdown budget,
   * then interrupt the rest (they are re-queued, not failed).
   */
  async close(timeoutMs = config.workers.shutdownTimeoutMs): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    log.info('Worker shutting down', { activeJobs: this.active.size });
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    if (this.worker) {
      let timer: NodeJS.Timeout | undefined;
      const finishedInTime = await Promise.race([
        this.worker.close().then(() => true),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(false), timeoutMs))),
      ]);
      clearTimeout(timer);
      if (!finishedInTime) {
        log.warn('Shutdown timeout reached; interrupting running jobs', { count: this.active.size });
        await Promise.all([...this.active.values()].map((e) => e.kill('shutdown')));
        // Wait briefly for executors to clean up their containers/processes.
        const deadline = Date.now() + config.workers.killGraceMs + 2000;
        while (this.active.size > 0 && Date.now() < deadline) await delay(100);
        await this.worker.close(true).catch(() => undefined);
      }
    } else {
      await Promise.all([...this.active.values()].map((e) => e.kill('shutdown')));
    }

    await this.webhookWorker?.close().catch(() => undefined);
    await getRedis().del(redisKey('worker', this.id)).catch(() => undefined);
    await this.subscriber?.quit().catch(() => undefined);
    log.info('Worker stopped');
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Aggregate heartbeats from all live workers. */
export async function listWorkers(client: Redis = getRedis()): Promise<WorkerHeartbeat[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', redisKey('worker', '*'), 'COUNT', 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  if (keys.length === 0) return [];
  const values = await client.mget(...keys);
  return values.filter((v): v is string => !!v).map((v) => JSON.parse(v) as WorkerHeartbeat);
}

export default WorkerManager;
