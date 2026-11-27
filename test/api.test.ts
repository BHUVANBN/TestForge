import request from 'supertest';
import { createApp } from '../src/api';
import { JobService } from '../src/jobs/service';
import { JobStore } from '../src/jobs/store';
import { WorkerHeartbeat } from '../src/utils/types';
import { ADMIN_KEY, FakeQueue, mockRedis, OTHER_KEY, resetRedis, USER_KEY } from './helpers';

const redis = mockRedis();
const store = new JobStore(redis);
const queue = new FakeQueue();
let workers: WorkerHeartbeat[] = [];
let redisUp = true;

const app = createApp({
  jobs: new JobService(store, queue as any),
  system: {
    queue: () => queue as any,
    store: () => store,
    redisHealthy: async () => redisUp,
    listWorkers: async () => workers,
  },
});

const as = (key: string) => ({ 'X-API-Key': key });

async function submit(key = USER_KEY, body: object = { script: 'echo hello', language: 'bash' }) {
  const res = await request(app).post('/api/v1/jobs').set(as(key)).send(body);
  expect(res.status).toBe(201);
  return res.body.data.jobId as string;
}

describe('API', () => {
  beforeEach(async () => {
    await resetRedis(redis);
    queue.jobs.clear();
    queue.paused = false;
    workers = [];
    redisUp = true;
  });

  describe('authentication', () => {
    it('requires a key', async () => {
      const res = await request(app).get('/api/v1/jobs');
      expect(res.status).toBe(401);
    });

    it('rejects unknown keys', async () => {
      expect((await request(app).get('/api/v1/jobs').set(as('nope-nope-nope-nope'))).status).toBe(403);
    });

    it('accepts Bearer tokens', async () => {
      const res = await request(app).get('/api/v1/jobs').set('Authorization', `Bearer ${USER_KEY}`);
      expect(res.status).toBe(200);
    });

    it('ignores keys in the query string (they would leak into logs)', async () => {
      expect((await request(app).get(`/api/v1/jobs?api_key=${USER_KEY}`)).status).toBe(401);
    });

    it('keeps health public', async () => {
      workers = [{ id: 'w1' } as WorkerHeartbeat];
      const res = await request(app).get('/api/v1/health');
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('healthy');
      expect(res.body.data.metrics).toBeUndefined();
    });
  });

  describe('health', () => {
    it('is degraded without workers but still ready', async () => {
      const res = await request(app).get('/api/v1/health');
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('degraded');
      expect(res.body.data.checks.workers.healthy).toBe(false);
    });

    it('is unhealthy without redis', async () => {
      redisUp = false;
      const res = await request(app).get('/api/v1/health');
      expect(res.status).toBe(503);
      expect(res.body.data.status).toBe('unhealthy');
    });
  });

  describe('jobs', () => {
    it('submits, fetches, lists and returns logs', async () => {
      const jobId = await submit();
      const detail = await request(app).get(`/api/v1/jobs/${jobId}`).set(as(USER_KEY));
      expect(detail.body.data).toMatchObject({ jobId, status: 'queued', language: 'bash', script: 'echo hello' });

      const list = await request(app).get('/api/v1/jobs').set(as(USER_KEY));
      expect(list.body.data.jobs).toHaveLength(1);
      expect(list.body.data.jobs[0]).toMatchObject({ jobId, status: 'queued' });
      expect(list.body.data.jobs[0].script).toBeUndefined();

      await store.saveOutput(jobId, { stdout: 'hello\n', stderr: '', truncated: false });
      const logs = await request(app).get(`/api/v1/logs/${jobId}`).set(as(USER_KEY));
      expect(logs.body.data).toMatchObject({ available: true, logs: { stdout: 'hello\n', stderr: '' } });

      const status = await request(app).get(`/api/v1/status/${jobId}`).set(as(USER_KEY));
      expect(status.body.data.result.stdout).toBe('hello\n');
    });

    it('keeps the legacy /submit-test endpoint', async () => {
      const res = await request(app).post('/api/v1/submit-test').set(as(USER_KEY)).send({ script: 'true' });
      expect(res.status).toBe(201);
    });

    it('redacts env values in job details', async () => {
      const jobId = await submit(USER_KEY, { script: 'true', env: { TOKEN: 'secret-value' } });
      const res = await request(app).get(`/api/v1/jobs/${jobId}`).set(as(USER_KEY));
      expect(res.body.data.envKeys).toEqual(['TOKEN']);
      expect(JSON.stringify(res.body)).not.toContain('secret-value');
    });

    it('returns validation details', async () => {
      const res = await request(app).post('/api/v1/jobs').set(as(USER_KEY)).send({ command: 'rm', args: ['-rf', '/'] });
      expect(res.status).toBe(400);
      expect(res.body.details.join()).toMatch(/allowed command list/);
    });

    it('returns 400 for malformed JSON', async () => {
      const res = await request(app)
        .post('/api/v1/jobs')
        .set(as(USER_KEY))
        .set('Content-Type', 'application/json')
        .send('{"script":');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid JSON body');
    });

    it('isolates jobs between users', async () => {
      const jobId = await submit(USER_KEY);
      expect((await request(app).get(`/api/v1/jobs/${jobId}`).set(as(OTHER_KEY))).status).toBe(404);
      expect((await request(app).get(`/api/v1/logs/${jobId}`).set(as(OTHER_KEY))).status).toBe(404);
      expect((await request(app).delete(`/api/v1/jobs/${jobId}`).set(as(OTHER_KEY))).status).toBe(404);
      expect((await request(app).get('/api/v1/jobs').set(as(OTHER_KEY))).body.data.jobs).toHaveLength(0);
      expect((await request(app).get(`/api/v1/jobs/${jobId}`).set(as(ADMIN_KEY))).status).toBe(200);
    });

    it('404s for malformed ids', async () => {
      expect((await request(app).get('/api/v1/jobs/not-a-uuid').set(as(USER_KEY))).status).toBe(404);
    });

    it('cancels and retries', async () => {
      const jobId = await submit();
      const cancel = await request(app).delete(`/api/v1/jobs/${jobId}`).set(as(USER_KEY));
      expect(cancel.status).toBe(200);
      expect(cancel.body.data.status).toBe('cancelled');

      const again = await request(app).delete(`/api/v1/jobs/${jobId}`).set(as(USER_KEY));
      expect(again.status).toBe(409);

      const retry = await request(app).post(`/api/v1/jobs/${jobId}/retry`).set(as(USER_KEY));
      expect(retry.status).toBe(201);
      expect(retry.body.data.retryOf).toBe(jobId);
    });
  });

  describe('system', () => {
    it('reports queue and aggregated worker stats', async () => {
      workers = [
        { id: 'a', concurrency: 4, active: 1, completed: 3, failed: 1, averageExecutionTime: 100 } as WorkerHeartbeat,
        { id: 'b', concurrency: 2, active: 2, completed: 0, failed: 0, averageExecutionTime: 0 } as WorkerHeartbeat,
      ];
      await submit();
      const res = await request(app).get('/api/v1/queue/stats').set(as(USER_KEY));
      expect(res.body.data.queue.waiting).toBe(1);
      expect(res.body.data.workers).toMatchObject({ instances: 2, total: 6, active: 3, idle: 3, completed: 3, failed: 1, averageExecutionTime: 100 });
    });

    it.each([
      ['post', '/api/v1/queue/pause'],
      ['post', '/api/v1/queue/resume'],
      ['delete', '/api/v1/queue/clear'],
      ['get', '/api/v1/info'],
      ['get', '/api/v1/workers'],
      ['get', '/api/v1/metrics'],
      ['get', '/api/v1/metrics/prometheus'],
    ])('%s %s requires an admin key', async (method, path) => {
      const res = await (request(app) as any)[method](path).set(as(USER_KEY));
      expect(res.status).toBe(403);
    });

    it('lets admins pause, resume and clear the queue', async () => {
      const jobId = await submit();
      expect((await request(app).post('/api/v1/queue/pause').set(as(ADMIN_KEY))).status).toBe(200);
      expect(queue.paused).toBe(true);
      expect((await request(app).post('/api/v1/queue/resume').set(as(ADMIN_KEY))).status).toBe(200);
      expect(queue.paused).toBe(false);
      const clear = await request(app).delete('/api/v1/queue/clear').set(as(ADMIN_KEY));
      expect(clear.body.data.removed).toBe(1);
      expect((await store.get(jobId))?.status).toBe('cancelled');
    });

    it('serves prometheus metrics to admins', async () => {
      const res = await request(app).get('/api/v1/metrics/prometheus').set(as(ADMIN_KEY));
      expect(res.status).toBe(200);
      expect(res.text).toContain('forge_jobs_submitted_total');
    });

    it('serves info to admins', async () => {
      const res = await request(app).get('/api/v1/info').set(as(ADMIN_KEY));
      expect(res.body.data.config.executor).toBe('local');
    });
  });

  describe('http hardening', () => {
    it('sets a strict CSP and hides the framework', async () => {
      const res = await request(app).get('/api');
      expect(res.headers['content-security-policy']).toContain("script-src 'self'");
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('serves the dashboard', async () => {
      expect((await request(app).get('/')).headers.location).toBe('/dashboard.html');
      const page = await request(app).get('/dashboard.html');
      expect(page.status).toBe(200);
      expect(page.text).not.toMatch(/onclick=/);
    });

    it('returns JSON 404s', async () => {
      const res = await request(app).get('/api/v1/nope').set(as(USER_KEY));
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });
});
