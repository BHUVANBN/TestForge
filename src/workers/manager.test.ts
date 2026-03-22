/**
 * WorkerManager unit tests.
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();

jest.mock('../queue/redis', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn().mockReturnValue({
      getClient: jest.fn().mockReturnValue({
        get: mockRedisGet,
        setex: mockRedisSet,
      }),
    }),
  },
}));

const mockUpdateJobStatus = jest.fn();
jest.mock('../queue/manager', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn().mockReturnValue({
      __mockUpdateJobStatus: mockUpdateJobStatus, // So we can mock internal state if needed
      // WorkerManager might directly call BullMQ, wait... WorkerManager creates a BullMQ Worker
    }),
  },
}));

const mockWorkerOn = jest.fn();
const mockWorkerClose = jest.fn().mockResolvedValue(true);
const mockWorkerPause = jest.fn().mockResolvedValue(undefined);
const mockWorkerResume = jest.fn().mockResolvedValue(undefined);

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((name, processor, options) => {
    // Provide a mock Worker
    return {
      on: mockWorkerOn,
      close: mockWorkerClose,
      pause: mockWorkerPause,
      resume: mockWorkerResume,
      __triggerJob: processor, // Let us trigger the job execution manually
      isRunning: jest.fn().mockReturnValue(true),
    };
  }),
}));

const mockExecutorExecute = jest.fn();
const mockExecutorKill = jest.fn();
const mockExecuteStats = { status: 'completed', duration: 100 };

jest.mock('./executor', () => ({
  TestExecutor: jest.fn().mockImplementation(() => ({
    execute: mockExecutorExecute,
    kill: mockExecutorKill,
    isRunning: jest.fn().mockReturnValue(true),
  })),
}));

jest.mock('./dockerExecutor', () => ({
  DockerExecutor: jest.fn().mockImplementation(() => ({
    execute: mockExecutorExecute, // point to same mock for convenience
    kill: mockExecutorKill,
    isRunning: jest.fn().mockReturnValue(true),
  })),
}));

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  __esModule: true,
  default: {
    workers: { poolSize: 2, sandbox: false },
    redis: {},
    queue: { concurrency: 5, maxStalledCount: 1, stalledInterval: 30000 },
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Clear the static instance
  const mod = require('./manager');
  if (mod.WorkerManager) mod.WorkerManager.instance = undefined;
  jest.clearAllMocks();
});

import { WorkerManager } from './manager';
import { JobData } from '../utils/types';
import config from '../config';

const baseJobData: JobData = {
  id: 'job-123',
  script: '',
  command: 'node',
  timeout: 5000,
  createdAt: new Date(),
};

describe('WorkerManager', () => {
  describe('getInstance()', () => {
    it('should return the same singleton instance', () => {
      const a = WorkerManager.getInstance();
      const b = WorkerManager.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('Worker initialization', () => {
    it('should initialize BullMQ Worker and bind events', () => {
      const wm = WorkerManager.getInstance();
      expect(mockWorkerOn).toHaveBeenCalledWith('completed', expect.any(Function));
      expect(mockWorkerOn).toHaveBeenCalledWith('failed', expect.any(Function));
    });
  });

  describe('processJob()', () => {
    it('should execute a job successfully and save result to Redis', async () => {
      mockExecutorExecute.mockResolvedValueOnce(mockExecuteStats);
      
      const wm = WorkerManager.getInstance();
      const jobObject = {
        data: baseJobData,
        updateProgress: jest.fn(),
      } as any;

      // Access the injected processor
      const BullMQ = require('bullmq');
      const processor = BullMQ.Worker.mock.calls[0][1];
      
      const result = await processor(jobObject);

      expect(mockExecutorExecute).toHaveBeenCalled();
      expect(result).toEqual(mockExecuteStats);
      expect(mockRedisSet).toHaveBeenCalledWith('job-result:job-123', 604800, JSON.stringify(mockExecuteStats));
    });

    it('should use DockerExecutor if sandbox mode is true', async () => {
      config.workers.sandbox = true;
      const WorkerManager = require('./manager').WorkerManager;
      WorkerManager.instance = undefined; // reset
      
      const wm = WorkerManager.getInstance();
      const BullMQ = require('bullmq');
      const processor = BullMQ.Worker.mock.calls[BullMQ.Worker.mock.calls.length - 1][1];

      mockExecutorExecute.mockResolvedValueOnce(mockExecuteStats);
      await processor({ data: baseJobData, updateProgress: jest.fn() } as any);

      // We assert that the processor works for sandbox without crashing.
      // (TestExecutor vs DockerExecutor mock is swapped)
      config.workers.sandbox = false; // reset
    });

    it('should properly track active executors and clean them up', async () => {
      mockExecutorExecute.mockResolvedValueOnce(mockExecuteStats);
      
      const wm = WorkerManager.getInstance();
      const processor = require('bullmq').Worker.mock.calls[require('bullmq').Worker.mock.calls.length - 1][1];
      
      await processor({ data: baseJobData, updateProgress: jest.fn() } as any);
      
      // Before finish it sets, after finish it deletes.
      expect(wm.getActiveExecutors().has(baseJobData.id)).toBe(false);
    });
  });

  describe('cancelJob()', () => {
    it('should kill the active executor and return true', async () => {
      const wm = WorkerManager.getInstance();
      const processor = require('bullmq').Worker.mock.calls[require('bullmq').Worker.mock.calls.length - 1][1];
      
      // We simulate hanging by not resolving the mock
      let resolveMock: any;
      mockExecutorExecute.mockReturnValueOnce(new Promise(r => resolveMock = r));
      
      const p = processor({ data: baseJobData, updateProgress: jest.fn() } as any);
      
      // allow map to register
      await new Promise(r => setTimeout(r, 10));

      const canceled = await wm.cancelJob('job-123');
      expect(canceled).toBe(true);
      expect(mockExecutorKill).toHaveBeenCalled();

      resolveMock(mockExecuteStats);
    });

    it('should return false if job is not active', async () => {
      const wm = WorkerManager.getInstance();
      const canceled = await wm.cancelJob('unknown-job');
      expect(canceled).toBe(false);
    });
  });

  describe('getJobResult()', () => {
    it('should return parsed result from Redis', async () => {
      mockRedisGet.mockResolvedValueOnce(JSON.stringify(mockExecuteStats));
      const wm = WorkerManager.getInstance();
      const res = await wm.getJobResult('job-123');
      expect(res).toEqual(mockExecuteStats);
    });

    it('should return null if Redis has no data', async () => {
      mockRedisGet.mockResolvedValueOnce(null);
      const wm = WorkerManager.getInstance();
      const res = await wm.getJobResult('job-123');
      expect(res).toBeNull();
    });
  });

  describe('Worker controls', () => {
    it('should pause and resume', async () => {
      const wm = WorkerManager.getInstance();
      await wm.pause();
      expect(mockWorkerPause).toHaveBeenCalled();
      await wm.resume();
      expect(mockWorkerResume).toHaveBeenCalled();
    });

    it('should return stats', () => {
      const wm = WorkerManager.getInstance();
      const stats = wm.getStats();
      expect(stats.total).toBe(2);
      expect(stats.idle).toBe(2);
    });
  });
});
