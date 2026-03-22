/**
 * QueueManager unit tests.
 * BullMQ Queue / QueueEvents are mocked — no live Redis required.
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockJob = {
  id: 'job-abc',
  timestamp: Date.now(),
  processedOn: null,
  finishedOn: null,
  attemptsMade: 0,
  getState: jest.fn().mockResolvedValue('waiting'),
  isActive: jest.fn().mockResolvedValue(false),
  isFailed: jest.fn().mockResolvedValue(true),
  remove: jest.fn().mockResolvedValue(undefined),
  retry: jest.fn().mockResolvedValue(undefined),
};

const mockQueueInstance = {
  add: jest.fn().mockResolvedValue(mockJob),
  getJob: jest.fn().mockResolvedValue(mockJob),
  getJobCounts: jest.fn().mockResolvedValue({ waiting: 1, active: 0, completed: 5, failed: 2, delayed: 0, paused: 0 }),
  pause: jest.fn().mockResolvedValue(undefined),
  resume: jest.fn().mockResolvedValue(undefined),
  clean: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
};

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => mockQueueInstance),
  QueueEvents: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    off: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('./redis', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn().mockReturnValue({
      getClient: jest.fn().mockReturnValue({
        on: jest.fn(),
        status: 'ready',
      }),
    }),
  },
}));

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  __esModule: true,
  default: {
    queue: {
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      },
      concurrency: 5,
      maxStalledCount: 1,
      stalledInterval: 30000,
    },
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

// Reset the singleton between tests
beforeEach(() => {
  // Force re-creation of the singleton
  const { QueueManager } = jest.requireActual('./manager') as any;
  if (QueueManager) {
    (QueueManager as any).instance = undefined;
  }
  jest.clearAllMocks();
});

import { QueueManager } from './manager';
import { JobData } from '../utils/types';

const baseJobData: JobData = {
  id: 'job-abc',
  script: 'echo hi',
  command: 'bash',
  timeout: 5000,
  createdAt: new Date(),
};

describe('QueueManager', () => {
  describe('getInstance()', () => {
    it('should return the same instance on repeated calls', () => {
      const a = QueueManager.getInstance();
      const b = QueueManager.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('addJob()', () => {
    it('should add a job to the queue and return it', async () => {
      const qm = QueueManager.getInstance();
      const job = await qm.addJob(baseJobData);
      expect(mockQueueInstance.add).toHaveBeenCalledWith('execute-test', baseJobData, expect.any(Object));
      expect(job.id).toBe('job-abc');
    });
  });

  describe('getJob()', () => {
    it('should return the job by id', async () => {
      const qm = QueueManager.getInstance();
      const job = await qm.getJob('job-abc');
      expect(mockQueueInstance.getJob).toHaveBeenCalledWith('job-abc');
      expect(job?.id).toBe('job-abc');
    });

    it('should return null when job does not exist', async () => {
      mockQueueInstance.getJob.mockResolvedValueOnce(null);
      const qm = QueueManager.getInstance();
      const job = await qm.getJob('nonexistent');
      expect(job).toBeNull();
    });
  });

  describe('getJobStatus()', () => {
    it('should return the job state', async () => {
      const qm = QueueManager.getInstance();
      const status = await qm.getJobStatus('job-abc');
      expect(status).toBe('waiting');
    });

    it('should return not_found when job is missing', async () => {
      mockQueueInstance.getJob.mockResolvedValueOnce(null);
      const qm = QueueManager.getInstance();
      const status = await qm.getJobStatus('no-such-job');
      expect(status).toBe('not_found');
    });
  });

  describe('getQueueStats()', () => {
    it('should return queue counts', async () => {
      const qm = QueueManager.getInstance();
      const stats = await qm.getQueueStats();
      expect(stats.waiting).toBe(1);
      expect(stats.completed).toBe(5);
      expect(stats.failed).toBe(2);
    });
  });

  describe('pauseQueue() / resumeQueue()', () => {
    it('should pause the queue', async () => {
      const qm = QueueManager.getInstance();
      await qm.pauseQueue();
      expect(mockQueueInstance.pause).toHaveBeenCalledTimes(1);
    });

    it('should resume the queue', async () => {
      const qm = QueueManager.getInstance();
      await qm.resumeQueue();
      expect(mockQueueInstance.resume).toHaveBeenCalledTimes(1);
    });
  });

  describe('clearQueue()', () => {
    it('should clean completed and failed jobs', async () => {
      const qm = QueueManager.getInstance();
      await qm.clearQueue();
      expect(mockQueueInstance.clean).toHaveBeenCalledWith(0, 0, 'completed');
      expect(mockQueueInstance.clean).toHaveBeenCalledWith(0, 0, 'failed');
    });
  });

  describe('retryJob()', () => {
    it('should call retry on a failed job', async () => {
      const qm = QueueManager.getInstance();
      await qm.retryJob('job-abc');
      expect(mockJob.retry).toHaveBeenCalledTimes(1);
    });
  });

  describe('close()', () => {
    it('should close the queue and events', async () => {
      const qm = QueueManager.getInstance();
      await qm.close();
      expect(mockQueueInstance.close).toHaveBeenCalledTimes(1);
    });
  });
});
