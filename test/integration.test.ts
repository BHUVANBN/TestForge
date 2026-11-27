/**
 * End-to-end tests against a real Redis + BullMQ, using the local executor.
 * Skipped unless REDIS_TEST_URL is set, e.g.:
 *   docker run -d --rm -p 6390:6379 redis:7-alpine
 *   REDIS_TEST_URL=redis://127.0.0.1:6390/0 npm test
 */
import request from 'supertest';
import { loadConfig, setConfig } from '../src/config';

const REDIS_URL = process.env.REDIS_TEST_URL;
const describeIf = REDIS_URL ? describe : describe.skip;

describeIf('integration (real Redis + BullMQ)', () => {
  let app: import('express').Application;
  let worker: import('../src/workers/manager').WorkerManager;
  let closeAll: () => Promise<void>;
  let QueueManager: typeof import('../src/queue/manager').default;
  const key = { 'X-API-Key': 'user-key-0123456789abcdef' };

  beforeAll(async () => {
    setConfig(
      loadConfig({
        ...process.env,
        REDIS_URL,
        REDIS_KEY_PREFIX: `tf-it-${Date.now()}`,
        QUEUE_NAME: `it-${Date.now()}`,
        QUEUE_BACKOFF_DELAY: '100',
        WORKER_CONCURRENCY: '2',
        WORKER_HEARTBEAT_INTERVAL: '500',
      })
    );
    const redis = await import('../src/queue/redis');
    redis.setRedis(redis.createRedis('it-shared'));
    await redis.waitForRedis(5000);
    closeAll = redis.closeAllRedis;
    QueueManager = (await import('../src/queue/manager')).default;
    QueueManager.setInstance(null);
    const { setJobStore, JobStore } = await import('../src/jobs/store');
    setJobStore(new JobStore());
    const { setJobService } = await import('../src/jobs/service');
    setJobService(null);
    const { createApp } = await import('../src/api');
    app = createApp();
    const { WorkerManager } = await import('../src/workers/manager');
    worker = new WorkerManager();
    await worker.start();
  });

  afterAll(async () => {
    await worker?.close(2000);
    await QueueManager?.getInstance().close();
    await closeAll?.();
  });

  const submit = async (body: object) => {
    const res = await request(app).post('/api/v1/jobs').set(key).send(body);
    expect(res.status).toBe(201);
    return res.body.data.jobId as string;
  };

  const waitFor = async (jobId: string, statuses: string[], timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await request(app).get(`/api/v1/jobs/${jobId}`).set(key);
      if (statuses.includes(res.body.data.status)) return res.body.data;
      if (Date.now() > deadline) throw new Error(`Job ${jobId} stuck in ${res.body.data.status}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  it('runs a job end to end', async () => {
    const jobId = await submit({ script: 'echo "hello from $TESTFORGE_JOB_ID"', language: 'bash' });
    const job = await waitFor(jobId, ['completed', 'failed']);
    expect(job).toMatchObject({ status: 'completed', exitCode: 0, attempt: 1 });
    const logs = await request(app).get(`/api/v1/logs/${jobId}`).set(key);
    expect(logs.body.data.logs.stdout).toBe(`hello from ${jobId}\n`);
  });

  it('retries failing jobs and reports the final failure', async () => {
    const jobId = await submit({ script: 'echo attempt; exit 7', retries: 2 });
    const job = await waitFor(jobId, ['failed', 'completed']);
    expect(job).toMatchObject({ status: 'failed', exitCode: 7, attempt: 3, maxAttempts: 3 });
    const bull = await QueueManager.getInstance().getJob(jobId);
    expect(await bull?.getState()).toBe('failed');
  });

  it('times out long jobs', async () => {
    const jobId = await submit({ script: 'sleep 30', timeout: 1000 });
    const job = await waitFor(jobId, ['timeout', 'failed', 'completed']);
    expect(job.status).toBe('timeout');
  });

  it('cancels a running job across processes (via pub/sub)', async () => {
    const jobId = await submit({ script: 'echo started; sleep 30' });
    await waitFor(jobId, ['running']);
    await new Promise((r) => setTimeout(r, 200));
    const res = await request(app).delete(`/api/v1/jobs/${jobId}`).set(key);
    expect(res.status).toBe(202);
    const job = await waitFor(jobId, ['cancelled', 'failed', 'completed']);
    expect(job.status).toBe('cancelled');
  });

  it('cancels a queued job before it runs', async () => {
    await QueueManager.getInstance().pause();
    try {
      const jobId = await submit({ script: 'echo never' });
      const res = await request(app).delete(`/api/v1/jobs/${jobId}`).set(key);
      expect(res.status).toBe(200);
      expect((await waitFor(jobId, ['cancelled'])).status).toBe('cancelled');
    } finally {
      await QueueManager.getInstance().resume();
    }
  });

  it('reports live workers and queue stats', async () => {
    const res = await request(app).get('/api/v1/queue/stats').set(key);
    expect(res.body.data.workers.instances).toBeGreaterThanOrEqual(1);
    expect(res.body.data.workers.total).toBe(2);
    const health = await request(app).get('/api/v1/health');
    expect(health.body.data.status).toBe('healthy');
  });
});
