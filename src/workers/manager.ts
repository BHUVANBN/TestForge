import { Worker, Job } from 'bullmq';
import RedisConnection from '../queue/redis';
import QueueManager from '../queue/manager';
import { TestExecutor } from './executor';
import { DockerExecutor } from './dockerExecutor';
import { logger } from '../utils/logger';
import { JobData, JobResult, WorkerStats } from '../utils/types';
import config from '../config';
import {
  jobSubmittedCounter,
  jobCompletedCounter,
  jobDurationHistogram,
  workersActiveGauge,
  workersIdleGauge,
} from '../utils/metrics';

export class WorkerManager {
  private static instance: WorkerManager;
  private worker: Worker;
  private activeExecutors: Map<string, TestExecutor | DockerExecutor> = new Map();
  private queueManager: QueueManager;
  private redisConnection: RedisConnection;
  private stats: WorkerStats;

  private constructor() {
    this.redisConnection = RedisConnection.getInstance();
    this.queueManager = QueueManager.getInstance();
    const redisClient = this.redisConnection.getClient();

    this.stats = {
      total: config.workers.poolSize,
      active: 0,
      idle: config.workers.poolSize,
      failed: 0,
      completed: 0,
      averageExecutionTime: 0,
      memoryUsage: process.memoryUsage()
    };

    // Initialize BullMQ worker
    this.worker = new Worker(
      'test-execution',
      this.processJob.bind(this),
      {
        connection: redisClient,
        concurrency: config.queue.concurrency,
        maxStalledCount: config.queue.maxStalledCount,
        stalledInterval: config.queue.stalledInterval,
      }
    );

    this.setupWorkerEventHandlers();
    this.startStatsCollection();
  }

  public static getInstance(): WorkerManager {
    if (!WorkerManager.instance) {
      WorkerManager.instance = new WorkerManager();
    }
    return WorkerManager.instance;
  }

  private setupWorkerEventHandlers(): void {
    this.worker.on('completed', (job: Job<JobData>, result: JobResult) => {
      logger.info('Worker completed job', { 
        jobId: job.id, 
        duration: result.duration,
        exitCode: result.exitCode
      });
      
      this.updateStats('completed', result.duration);
      this.activeExecutors.delete(job.id!);
    });

    this.worker.on('failed', (job: Job<JobData> | undefined, error: Error) => {
      const jobId = job?.id || 'unknown';
      logger.error('Worker failed job', { 
        jobId, 
        error: error.message,
        stack: error.stack
      });
      
      this.updateStats('failed');
      this.activeExecutors.delete(jobId);
    });

    this.worker.on('error', (error: Error) => {
      logger.error('Worker error', { error: error.message });
    });

    this.worker.on('stalled', (jobId: string) => {
      logger.warn('Job stalled in worker', { jobId });
    });

    this.worker.on('progress', (job: Job<JobData>, progress: number | object) => {
      logger.debug('Job progress', { jobId: job.id, progress });
    });
  }

  private async processJob(job: Job<JobData>): Promise<JobResult> {
    const jobData = job.data;
    logger.info('Processing job', { jobId: jobData.id, sandbox: config.workers.sandbox });

    jobSubmittedCounter.inc();

    // Choose executor: Docker sandbox if enabled, else child_process
    const executor = config.workers.sandbox
      ? new DockerExecutor(jobData)
      : new TestExecutor(jobData);

    this.activeExecutors.set(jobData.id, executor);
    this.updateStats('active');

    try {
      const result = await executor.execute();
      await this.storeJobResult(jobData.id, result);

      // Emit metrics
      jobCompletedCounter.inc({ status: result.status });
      if (result.duration) {
        jobDurationHistogram.observe({ status: result.status }, result.duration);
      }

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Job processing failed', { jobId: jobData.id, error: err.message });
      jobCompletedCounter.inc({ status: 'failed' });
      throw err;
    } finally {
      this.activeExecutors.delete(jobData.id);
    }
  }

  private async storeJobResult(jobId: string, result: JobResult): Promise<void> {
    try {
      const redisClient = this.redisConnection.getClient();
      const key = `job-result:${jobId}`;
      const ttl = 86400 * 7; // Store for 7 days instead of 1 hour
      await redisClient.setex(key, ttl, JSON.stringify(result));
      logger.debug('Job result stored', { jobId, ttl });
    } catch (error) {
      logger.error('Failed to store job result', { jobId, error });
      // Don't throw here as it would fail the job
    }
  }

  public async getJobResult(jobId: string): Promise<JobResult | null> {
    try {
      const redisClient = this.redisConnection.getClient();
      const key = `job-result:${jobId}`;
      const result = await redisClient.get(key);
      
      if (result) {
        return JSON.parse(result);
      }
      
      return null;
    } catch (error) {
      logger.error('Failed to get job result', { jobId, error });
      return null;
    }
  }

  public async cancelJob(jobId: string): Promise<boolean> {
    try {
      const executor = this.activeExecutors.get(jobId);
      if (executor) {
        executor.kill();
        logger.info('Job cancelled', { jobId });
        return true;
      }
      
      // Try to cancel via queue
      await this.queueManager.cancelJob(jobId);
      return true;
    } catch (error) {
      logger.error('Failed to cancel job', { jobId, error });
      return false;
    }
  }

  public getActiveExecutors(): Map<string, TestExecutor | DockerExecutor> {
    return new Map(this.activeExecutors);
  }

  public getStats(): WorkerStats {
    return { ...this.stats };
  }

  private updateStats(type: 'completed' | 'failed' | 'active', duration?: number): void {
    switch (type) {
      case 'completed':
        this.stats.completed++;
        this.stats.active = Math.max(0, this.stats.active - 1);
        this.stats.idle = Math.min(this.stats.total, this.stats.idle + 1);
        if (duration) {
          const totalJobs = this.stats.completed;
          this.stats.averageExecutionTime =
            ((this.stats.averageExecutionTime * (totalJobs - 1)) + duration) / totalJobs;
        }
        break;
      case 'failed':
        this.stats.failed++;
        this.stats.active = Math.max(0, this.stats.active - 1);
        this.stats.idle = Math.min(this.stats.total, this.stats.idle + 1);
        break;
      case 'active':
        this.stats.active++;
        this.stats.idle = Math.max(0, this.stats.idle - 1);
        break;
    }

    this.stats.memoryUsage = process.memoryUsage();

    // Sync Prometheus gauges
    workersActiveGauge.set(this.stats.active);
    workersIdleGauge.set(this.stats.idle);
  }

  private startStatsCollection(): void {
    setInterval(() => {
      this.stats.memoryUsage = process.memoryUsage();
      logger.debug('Worker stats updated', this.stats);
    }, 30000); // Update every 30 seconds
  }

  public async pause(): Promise<void> {
    try {
      await this.worker.pause();
      logger.info('Worker manager paused');
    } catch (error) {
      logger.error('Failed to pause worker manager', { error });
      throw error;
    }
  }

  public async resume(): Promise<void> {
    try {
      await this.worker.resume();
      logger.info('Worker manager resumed');
    } catch (error) {
      logger.error('Failed to resume worker manager', { error });
      throw error;
    }
  }

  public async gracefulShutdown(): Promise<void> {
    logger.info('Starting graceful shutdown of worker manager');
    
    try {
      // Pause worker to stop accepting new jobs
      await this.pause();
      
      // Wait for active jobs to complete or timeout
      const maxWaitTime = 30000; // 30 seconds
      const startTime = Date.now();
      
      while (this.activeExecutors.size > 0 && (Date.now() - startTime) < maxWaitTime) {
        logger.info(`Waiting for ${this.activeExecutors.size} active jobs to complete`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // Kill remaining active jobs
      for (const [jobId, executor] of this.activeExecutors) {
        logger.warn('Killing remaining active job', { jobId });
        executor.kill();
      }
      
      // Close worker
      await this.worker.close();
      
      logger.info('Worker manager shutdown complete');
    } catch (error) {
      logger.error('Error during worker manager shutdown', { error });
      throw error;
    }
  }

  public getWorkerInstance(): Worker {
    return this.worker;
  }
}

export default WorkerManager;
