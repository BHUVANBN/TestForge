import request from 'supertest';
import { createApp } from '../src/api';
import { principalForKey } from '../src/api/middleware/auth';
import { loadConfig, setConfig } from '../src/config';
import { ArtifactStore } from '../src/jobs/artifacts';
import { BatchService, expandMatrix } from '../src/jobs/batches';
import { finalizeJob } from '../src/jobs/lifecycle';
import { JobService } from '../src/jobs/service';
import { JobStore } from '../src/jobs/store';
import { setWebhookEnqueue } from '../src/webhooks';
import { ADMIN_KEY, FakeQueue, mockRedis, OTHER_KEY, resetRedis, USER_KEY } from './helpers';

const redis = mockRedis();
const store = new JobStore(redis);
const artifacts = new ArtifactStore(redis);
const queue = new FakeQueue();
const jobs = new JobService(store, queue as any);
const batches = new BatchService(store, jobs);
const webhooks: { url: string; event: string; payload: any }[] = [];

const makeApp = (rateLimitStore: 'redis' | 'memory' = 'memory') =>
  createApp({ jobs, batches, artifacts, rateLimitStore, system: { queue: () => queue as any, store: () => store, listWorkers: async () => [] } });
let app = makeApp();

const as = (key: string) => ({ 'X-API-Key': key });
const user = () => principalForKey(USER_KEY)!;

beforeAll(() => setWebhookEnqueue(async (url, event, payload) => void webhooks.push({ url, event, payload })));
afterAll(() => setWebhookEnqueue(null));

beforeEach(async () => {
  await resetRedis(redis);
  queue.jobs.clear();
  webhooks.length = 0;
});

describe('priority', () => {
  it('maps priorities onto the queue and reports them', async () => {
    const hi = await request(app).post('/api/v1/jobs').set(as(USER_KEY)).send({ script: 'true', priority: 'high' });
    const lo = await request(app).post('/api/v1/jobs').set(as(USER_KEY)).send({ script: 'true', priority: 'low' });
    const def = await request(app).post('/api/v1/jobs').set(as(USER_KEY)).send({ script: 'true' });
    expect(queue.jobs.get(hi.body.data.jobId)?.priority).toBe(1);
    expect(queue.jobs.get(lo.body.data.jobId)?.priority).toBe(3);
    expect(queue.jobs.get(def.body.data.jobId)?.priority).toBe(2);
    const detail = await request(app).get(`/api/v1/jobs/${hi.body.data.jobId}`).set(as(USER_KEY));
    expect(detail.body.data.priority).toBe('high');
    const bad = await request(app).post('/api/v1/jobs').set(as(USER_KEY)).send({ script: 'true', priority: 'urgent' });
    expect(bad.status).toBe(400);
  });
});

describe('finalization', () => {
  it('fires job webhooks and releases quota exactly once, even when raced', async () => {
    const res = await request(app)
      .post('/api/v1/jobs')
      .set(as(USER_KEY))
      .send({ script: 'true', webhookUrl: 'https://hooks.example.com/ci' });
    const id = res.body.data.jobId;
    expect(await store.countActive(user().id)).toBe(1);

    await Promise.all([finalizeJob(id, 'completed', { exitCode: 0 }, store), finalizeJob(id, 'completed', { exitCode: 0 }, store)]);
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]).toMatchObject({ url: 'https://hooks.example.com/ci', event: 'job.finished', payload: { job: { id, status: 'completed' } } });
    expect(webhooks[0].payload.job.script).toBeUndefined();
    expect(await store.countActive(user().id)).toBe(0);
  });

  it('rejects unsafe webhook URLs', async () => {
    const res = await request(app).post('/api/v1/jobs').set(as(USER_KEY)).send({ script: 'true', webhookUrl: 'http://10.0.0.5/x' });
    expect(res.status).toBe(400);
    expect(res.body.details.join()).toMatch(/https|private/);
  });
});

describe('quotas', () => {
  afterEach(() => setConfig(loadConfig()));

  it('limits concurrent jobs per key, exempting admins', async () => {
    setConfig(loadConfig({ ...process.env, QUOTA_MAX_ACTIVE_JOBS: '2' }));
    for (let i = 0; i < 2; i++) expect((await request(app).post('/api/v1/jobs').set(as(USER_KEY)).send({ script: 'true' })).status).toBe(201);
    const third = await request(app).post('/api/v1/jobs').set(as(USER_KEY)).send({ script: 'true' });
    expect(third.status).toBe(429);
    expect(third.body.details.join()).toMatch(/at most 2 queued or running/);
    // Other users and admins are unaffected.
    expect((await request(app).post('/api/v1/jobs').set(as(OTHER_KEY)).send({ script: 'true' })).status).toBe(201);
    expect((await request(app).post('/api/v1/jobs').set(as(ADMIN_KEY)).send({ script: 'true' })).status).toBe(201);

    // Finishing a job frees a slot.
    const { jobs: mine } = await store.list({ owner: user().id, page: 1, limit: 10 });
    await finalizeJob(mine[0].id, 'completed', {}, store);
    expect((await request(app).post('/api/v1/jobs').set(as(USER_KEY)).send({ script: 'true' })).status).toBe(201);
  });

  it('limits daily submissions', async () => {
    setConfig(loadConfig({ ...process.env, QUOTA_MAX_JOBS_PER_DAY: '3', QUOTA_MAX_ACTIVE_JOBS: '0' }));
    for (let i = 0; i < 3; i++) await request(app).post('/api/v1/jobs').set(as(USER_KEY)).send({ script: 'true' });
    const res = await request(app).post('/api/v1/jobs').set(as(USER_KEY)).send({ script: 'true' });
    expect(res.status).toBe(429);
    expect(res.body.details.join()).toMatch(/per day/);
  });

  it('checks a whole batch against the quota up front', async () => {
    setConfig(loadConfig({ ...process.env, QUOTA_MAX_ACTIVE_JOBS: '3' }));
    const res = await request(app)
      .post('/api/v1/batches')
      .set(as(USER_KEY))
      .send({ jobs: [{ script: '1' }, { script: '2' }, { script: '3' }, { script: '4' }] });
    expect(res.status).toBe(429);
    expect(queue.jobs.size).toBe(0);
  });
});

describe('batches', () => {
  it('expands matrices as a cartesian product', () => {
    expect(expandMatrix({ language: ['node', 'python'], env: { MODE: ['a', 'b'], V: ['1'] } })).toEqual([
      { language: 'node', env: { MODE: 'a', V: '1' } },
      { language: 'node', env: { MODE: 'b', V: '1' } },
      { language: 'python', env: { MODE: 'a', V: '1' } },
      { language: 'python', env: { MODE: 'b', V: '1' } },
    ]);
  });

  it('runs a matrix batch, tracks progress and fires one batch webhook', async () => {
    const res = await request(app)
      .post('/api/v1/batches')
      .set(as(USER_KEY))
      .send({
        name: 'nightly',
        webhookUrl: 'https://hooks.example.com/batch',
        matrix: { base: { script: 'echo $SUITE', env: { CI: '1' } }, axes: { env: { SUITE: ['unit', 'e2e', 'lint'] } } },
      });
    expect(res.status).toBe(201);
    const { batchId, jobIds } = res.body.data;
    expect(jobIds).toHaveLength(3);

    const job = await store.get(jobIds[1]);
    expect(job).toMatchObject({ batchId, env: { CI: '1', SUITE: 'e2e' }, metadata: { matrix: { SUITE: 'e2e' } } });

    await finalizeJob(jobIds[0], 'completed', { testReport: { format: 'tap', total: 2, passed: 2, failed: 0, skipped: 0, failures: [], sources: [] } }, store);
    let summary = (await request(app).get(`/api/v1/batches/${batchId}`).set(as(USER_KEY))).body.data;
    expect(summary).toMatchObject({ name: 'nightly', status: 'running', total: 3, finished: 1 });

    await finalizeJob(jobIds[1], 'completed', {}, store);
    await finalizeJob(jobIds[2], 'failed', { exitCode: 1 }, store);
    await finalizeJob(jobIds[2], 'failed', { exitCode: 1 }, store); // duplicate must not double count
    summary = (await request(app).get(`/api/v1/batches/${batchId}`).set(as(USER_KEY))).body.data;
    expect(summary).toMatchObject({ status: 'failed', finished: 3, counts: { completed: 2, failed: 1 }, tests: { total: 2, passed: 2 } });
    expect(summary.jobs[1].matrix).toEqual({ SUITE: 'e2e' });

    const batchHooks = webhooks.filter((w) => w.event === 'batch.finished');
    expect(batchHooks).toHaveLength(1);
    expect(batchHooks[0]).toMatchObject({ url: 'https://hooks.example.com/batch', payload: { batch: { id: batchId, status: 'failed' } } });

    const list = await request(app).get('/api/v1/batches').set(as(USER_KEY));
    expect(list.body.data.batches).toHaveLength(1);
    expect(list.body.data.batches[0].jobs).toBeUndefined();
  });

  it('cancels every unfinished job in a batch and hides batches from other users', async () => {
    const { body } = await request(app).post('/api/v1/batches').set(as(USER_KEY)).send({ jobs: [{ script: 'a' }, { command: 'echo', args: ['b'] }] });
    const id = body.data.batchId;
    expect((await request(app).get(`/api/v1/batches/${id}`).set(as(OTHER_KEY))).status).toBe(404);
    const res = await request(app).delete(`/api/v1/batches/${id}`).set(as(USER_KEY));
    expect(res.body.data).toMatchObject({ cancelled: 2, cancelling: 0 });
    const summary = (await request(app).get(`/api/v1/batches/${id}`).set(as(USER_KEY))).body.data;
    expect(summary.status).toBe('failed');
    expect(summary.counts).toEqual({ cancelled: 2 });
  });

  it('validates every job and the matrix size', async () => {
    const res = await request(app).post('/api/v1/batches').set(as(USER_KEY)).send({ jobs: [{ script: 'ok' }, { command: 'curl' }] });
    expect(res.status).toBe(400);
    expect(res.body.details.join()).toMatch(/jobs\[1\]: "command" is not in the allowed command list/);

    const big = await request(app)
      .post('/api/v1/batches')
      .set(as(USER_KEY))
      .send({ matrix: { base: { script: 'x' }, axes: { env: { A: [...Array(11)].map((_, i) => `${i}`), B: [...Array(10)].map((_, i) => `${i}`) } } } });
    expect(big.status).toBe(400);
    expect(big.body.details.join()).toMatch(/expands to 110 jobs/);

    expect((await request(app).post('/api/v1/batches').set(as(USER_KEY)).send({})).status).toBe(400);
  });
});

describe('artifacts and reports API', () => {
  it('lists and downloads artifacts as attachments, owner only', async () => {
    const { body } = await request(app).post('/api/v1/jobs').set(as(USER_KEY)).send({ script: 'true' });
    const id = body.data.jobId;
    await artifacts.save(id, [
      { name: 'reports/junit.xml', data: Buffer.from('<testsuite/>') },
      { name: 'evil.html', data: Buffer.from('<script>alert(1)</script>') },
    ]);
    await store.update(id, { artifactCount: 2, testReport: { format: 'junit', total: 1, passed: 1, failed: 0, skipped: 0, failures: [], sources: ['reports/junit.xml'] } });

    const list = await request(app).get(`/api/v1/jobs/${id}/artifacts`).set(as(USER_KEY));
    expect(list.body.data.artifacts).toEqual([
      { name: 'reports/junit.xml', size: 12 },
      { name: 'evil.html', size: 25 },
    ]);

    const file = await request(app).get(`/api/v1/jobs/${id}/artifacts/reports/junit.xml`).set(as(USER_KEY)).buffer(true);
    expect(file.status).toBe(200);
    expect(file.body.toString()).toBe('<testsuite/>');
    expect(file.headers['content-disposition']).toBe('attachment; filename="junit.xml"');

    const html = await request(app).get(`/api/v1/jobs/${id}/artifacts/evil.html`).set(as(USER_KEY));
    expect(html.headers['content-type']).toBe('application/octet-stream');
    expect(html.headers['x-content-type-options']).toBe('nosniff');

    expect((await request(app).get(`/api/v1/jobs/${id}/artifacts/missing.txt`).set(as(USER_KEY))).status).toBe(404);
    expect((await request(app).get(`/api/v1/jobs/${id}/artifacts/reports/junit.xml`).set(as(OTHER_KEY))).status).toBe(404);

    const report = await request(app).get(`/api/v1/jobs/${id}/report`).set(as(USER_KEY));
    expect(report.body.data).toMatchObject({ format: 'junit', passed: 1 });
    const summary = (await request(app).get('/api/v1/jobs').set(as(USER_KEY))).body.data.jobs[0];
    expect(summary).toMatchObject({ artifactCount: 2, tests: { total: 1, passed: 1 } });
  });
});

describe('artifact storage outages', () => {
  it('answers 503 instead of a generic 500', async () => {
    const down = { save: async () => [], list: async () => { throw new Error('connect ECONNREFUSED'); }, get: async () => null };
    const outageApp = createApp({ jobs, batches, artifacts: down as any, rateLimitStore: 'memory', system: { queue: () => queue as any, store: () => store, listWorkers: async () => [] } });
    const { body } = await request(outageApp).post('/api/v1/jobs').set(as(USER_KEY)).send({ script: 'true' });
    const res = await request(outageApp).get(`/api/v1/jobs/${body.data.jobId}/artifacts`).set(as(USER_KEY));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'Artifact storage is temporarily unavailable', details: ['connect ECONNREFUSED'] });
  });
});

describe('shared rate limiting', () => {
  afterEach(() => {
    setConfig(loadConfig());
    app = makeApp();
  });

  it('counts requests in Redis so every API instance shares the limit', async () => {
    setConfig(loadConfig({ ...process.env, RATE_LIMIT_MAX: '3' }));
    const a = makeApp('redis');
    const b = makeApp('redis');
    expect((await request(a).get('/api/v1/jobs').set(as(USER_KEY))).status).toBe(200);
    expect((await request(b).get('/api/v1/jobs').set(as(USER_KEY))).status).toBe(200);
    expect((await request(a).get('/api/v1/jobs').set(as(USER_KEY))).status).toBe(200);
    const limited = await request(b).get('/api/v1/jobs').set(as(USER_KEY));
    expect(limited.status).toBe(429);
    expect(limited.headers['ratelimit']).toBeDefined();
    // Separate keys have separate budgets.
    expect((await request(b).get('/api/v1/jobs').set(as(OTHER_KEY))).status).toBe(200);
  });
});
