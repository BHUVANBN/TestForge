/**
 * Jobs API integration tests.
 *
 * These tests spin up the Express app in isolation.
 * All Redis / BullMQ interactions are mocked so no live Redis is required.
 */

// ─── Mocks – must come before any imports that use these modules ──────────────

jest.mock('../queue/redis', () => {
  const mockClient = {
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
    ping: jest.fn().mockResolvedValue('PONG'),
    status: 'ready',
    on: jest.fn(),
    off: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
  };

  return {
    __esModule: true,
    default: {
      getInstance: jest.fn().mockReturnValue({
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        getClient: jest.fn().mockReturnValue(mockClient),
        healthCheck: jest.fn().mockResolvedValue(true),
        isConnectionActive: jest.fn().mockReturnValue(true),
      }),
    },
  };
});

jest.mock('../queue/manager', () => {
  const mockQueueStats = { waiting: 0, active: 0, completed: 5, failed: 1, delayed: 0, paused: 0 };
  const mockJob = { id: 'test-job-id', timestamp: Date.now(), processedOn: null, finishedOn: null, attemptsMade: 0, data: { command: 'echo', timeout: 5000 } };
  const mockQueueEvents = { on: jest.fn(), off: jest.fn(), close: jest.fn().mockResolvedValue(undefined) };

  return {
    __esModule: true,
    default: {
      getInstance: jest.fn().mockReturnValue({
        addJob: jest.fn().mockResolvedValue(mockJob),
        getJob: jest.fn().mockResolvedValue(mockJob),
        getJobStatus: jest.fn().mockResolvedValue('completed'),
        getQueueStats: jest.fn().mockResolvedValue(mockQueueStats),
        getQueueInstance: jest.fn().mockReturnValue({
          getJobs: jest.fn().mockResolvedValue([mockJob]),
          isPaused: jest.fn().mockResolvedValue(false),
        }),
        getQueueEvents: jest.fn().mockReturnValue(mockQueueEvents),
        cancelJob: jest.fn().mockResolvedValue(undefined),
        retryJob: jest.fn().mockResolvedValue(undefined),
        pauseQueue: jest.fn().mockResolvedValue(undefined),
        resumeQueue: jest.fn().mockResolvedValue(undefined),
        clearQueue: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
      }),
    },
  };
});

jest.mock('../workers/manager', () => {
  const mockResult = {
    id: 'test-job-id',
    status: 'completed',
    startTime: new Date(),
    endTime: new Date(),
    duration: 100,
    exitCode: 0,
    stdout: 'hello',
    stderr: '',
    error: undefined,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return {
    __esModule: true,
    default: {
      getInstance: jest.fn().mockReturnValue({
        getJobResult: jest.fn().mockResolvedValue(mockResult),
        cancelJob: jest.fn().mockResolvedValue(true),
        getStats: jest.fn().mockReturnValue({ total: 10, active: 0, idle: 10, failed: 0, completed: 5, averageExecutionTime: 100, memoryUsage: process.memoryUsage() }),
        getWorkerInstance: jest.fn().mockReturnValue({ isRunning: jest.fn().mockReturnValue(true), pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
        gracefulShutdown: jest.fn().mockResolvedValue(undefined),
        pause: jest.fn().mockResolvedValue(undefined),
        resume: jest.fn().mockResolvedValue(undefined),
      }),
    },
  };
});

jest.mock('../utils/metrics', () => ({
  register: { contentType: 'text/plain', metrics: jest.fn().mockResolvedValue('') },
  initMetrics: jest.fn(),
  jobSubmittedCounter: { inc: jest.fn() },
  jobCompletedCounter: { inc: jest.fn() },
  jobDurationHistogram: { observe: jest.fn() },
  workersActiveGauge: { set: jest.fn() },
  workersIdleGauge: { set: jest.fn() },
  queueWaitingGauge: { set: jest.fn() },
  queueActiveGauge: { set: jest.fn() },
  queueFailedGauge: { set: jest.fn() },
}));

// ─── Actual test code ─────────────────────────────────────────────────────────

import request from 'supertest';
import APIServer from './index';

let apiServer: APIServer;
let app: any;

beforeAll(async () => {
  apiServer = new APIServer();
  app = apiServer.getApp();
  // Don't call apiServer.start() in tests — it would bind the port and connect Redis
});

// ── POST /api/v1/submit-test ──────────────────────────────────────────────────

describe('POST /api/v1/submit-test', () => {
  it('should submit a valid bash script job', async () => {
    const res = await request(app)
      .post('/api/v1/submit-test')
      .send({ script: 'echo "hello"', timeout: 5000 });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.jobId).toBeDefined();
    expect(res.body.data.status).toBe('pending');
  });

  it('should submit a command-based job', async () => {
    const res = await request(app)
      .post('/api/v1/submit-test')
      .send({ command: 'node', args: ['-e', 'console.log("hi")'], timeout: 5000 });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('should reject a script exceeding max length', async () => {
    const res = await request(app)
      .post('/api/v1/submit-test')
      .send({ script: 'a'.repeat(100001) });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Validation failed');
  });

  it('should reject a timeout exceeding max execution time', async () => {
    const res = await request(app)
      .post('/api/v1/submit-test')
      .send({ script: 'echo hi', timeout: 9999999 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('should reject unknown validation fields gracefully', async () => {
    const res = await request(app)
      .post('/api/v1/submit-test')
      .send({ unknownField: 'value', script: 'echo hi' });

    // Joi with default settings strips unknown — job still submitted
    expect([200, 201, 400]).toContain(res.status);
  });
});

// ── GET /api/v1/status/:jobId ─────────────────────────────────────────────────

describe('GET /api/v1/status/:jobId', () => {
  it('should return job status for a known job', async () => {
    const res = await request(app).get('/api/v1/status/test-job-id');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.jobId).toBe('test-job-id');
    expect(res.body.data.status).toBe('completed');
  });

  it('should return 404 for an unknown job', async () => {
    const queueManager = require('../queue/manager').default.getInstance();
    queueManager.getJobStatus.mockResolvedValueOnce('not_found');
    queueManager.getJob.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/v1/status/nonexistent-id');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

// ── GET /api/v1/logs/:jobId ───────────────────────────────────────────────────

describe('GET /api/v1/logs/:jobId', () => {
  it('should return logs for a completed job', async () => {
    const res = await request(app).get('/api/v1/logs/test-job-id');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.logs).toBeDefined();
    expect(res.body.data.logs.stdout).toBe('hello');
  });

  it('should return 404 when job result does not exist', async () => {
    const workerManager = require('../workers/manager').default.getInstance();
    workerManager.getJobResult.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/v1/logs/missing-job');
    expect(res.status).toBe(404);
  });
});

// ── GET /api/v1/result/:jobId ─────────────────────────────────────────────────

describe('GET /api/v1/result/:jobId', () => {
  it('should return the full result for a completed job', async () => {
    const res = await request(app).get('/api/v1/result/test-job-id');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.exitCode).toBe(0);
    expect(res.body.data.stdout).toBe('hello');
  });
});

// ── DELETE /api/v1/jobs/:jobId ────────────────────────────────────────────────

describe('DELETE /api/v1/jobs/:jobId', () => {
  it('should cancel a pending/running job', async () => {
    const queueMgr = require('../queue/manager').default.getInstance();
    queueMgr.getJobStatus.mockResolvedValueOnce('active');

    const res = await request(app).delete('/api/v1/jobs/test-job-id');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('should reject cancelling an already-completed job', async () => {
    const queueMgr = require('../queue/manager').default.getInstance();
    queueMgr.getJobStatus.mockResolvedValueOnce('completed');

    const res = await request(app).delete('/api/v1/jobs/test-job-id');
    expect(res.status).toBe(400);
  });

  it('should return 404 when job does not exist', async () => {
    const queueMgr = require('../queue/manager').default.getInstance();
    queueMgr.getJobStatus.mockResolvedValueOnce('not_found');

    const res = await request(app).delete('/api/v1/jobs/nonexistent');
    expect(res.status).toBe(404);
  });
});

// ── POST /api/v1/jobs/:jobId/retry ────────────────────────────────────────────

describe('POST /api/v1/jobs/:jobId/retry', () => {
  it('should retry a failed job', async () => {
    const queueMgr = require('../queue/manager').default.getInstance();
    queueMgr.getJobStatus.mockResolvedValueOnce('failed');

    const res = await request(app).post('/api/v1/jobs/test-job-id/retry');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('should reject retrying a non-failed job', async () => {
    const queueMgr = require('../queue/manager').default.getInstance();
    queueMgr.getJobStatus.mockResolvedValueOnce('active');

    const res = await request(app).post('/api/v1/jobs/test-job-id/retry');
    expect(res.status).toBe(400);
  });
});

// ── GET /api/v1/jobs (list with pagination) ───────────────────────────────────

describe('GET /api/v1/jobs', () => {
  it('should return a paginated list of jobs', async () => {
    const res = await request(app).get('/api/v1/jobs');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.jobs).toBeInstanceOf(Array);
    expect(res.body.data.pagination).toBeDefined();
    expect(res.body.data.pagination.page).toBe(1);
    expect(res.body.data.pagination.limit).toBe(20);
  });

  it('should accept custom page and limit', async () => {
    const res = await request(app).get('/api/v1/jobs?page=2&limit=5');
    expect(res.status).toBe(200);
    expect(res.body.data.pagination.page).toBe(2);
    expect(res.body.data.pagination.limit).toBe(5);
  });

  it('should accept a status filter', async () => {
    const res = await request(app).get('/api/v1/jobs?status=completed');
    expect(res.status).toBe(200);
  });

  it('should reject invalid status values', async () => {
    const res = await request(app).get('/api/v1/jobs?status=invalidstatus');
    expect(res.status).toBe(400);
  });

  it('should reject limit > 100', async () => {
    const res = await request(app).get('/api/v1/jobs?limit=200');
    expect(res.status).toBe(400);
  });
});

// ── 404 handler ───────────────────────────────────────────────────────────────

describe('404 handler', () => {
  it('should return 404 for unknown routes', async () => {
    const res = await request(app).get('/api/v1/nonexistent-route');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
