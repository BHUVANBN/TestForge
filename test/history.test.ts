/**
 * Job history. Postgres-backed tests run when HISTORY_TEST_DATABASE_URL is set:
 *   docker run -d -p 5490:5432 -e POSTGRES_PASSWORD=pg-test postgres:16-alpine
 *   HISTORY_TEST_DATABASE_URL=postgres://postgres:pg-test@127.0.0.1:5490/postgres npm test
 */
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../src/api';
import { principalForKey } from '../src/api/middleware/auth';
import { HistoryStore, recordHistory, rowToRecord, setHistoryEnqueue } from '../src/history';
import { finalizeJob } from '../src/jobs/lifecycle';
import { JobService } from '../src/jobs/service';
import { JobStore } from '../src/jobs/store';
import { JobRecord } from '../src/utils/types';
import { ADMIN_KEY, FakeQueue, makeRecord, mockRedis, OTHER_KEY, resetRedis, USER_KEY } from './helpers';

const redis = mockRedis();
const store = new JobStore(redis);
const as = (key: string) => ({ 'X-API-Key': key });

describe('history (no database)', () => {
  const app = createApp({ jobs: new JobService(store, new FakeQueue() as any, null), history: () => null, rateLimitStore: 'memory' });

  it('reports that history is disabled', async () => {
    const res = await request(app).get('/api/v1/history/jobs').set(as(USER_KEY));
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not enabled/);
  });

  it('queues finished jobs with env values stripped', async () => {
    const entries: any[] = [];
    setHistoryEnqueue(async (e) => void entries.push(e));
    try {
      await recordHistory({ kind: 'job', record: makeRecord({ env: { TOKEN: 'secret' } }) });
    } finally {
      setHistoryEnqueue(null);
    }
    expect(entries[0].record.env).toEqual({ TOKEN: '' });
  });

  it('maps rows to records', () => {
    const r = rowToRecord({ id: 'x', owner: 'o', status: 'failed', created_at: new Date(0), env_keys: ['A'], exit_code: 2, duration_ms: '12' });
    expect(r).toMatchObject({ id: 'x', status: 'failed', exitCode: 2, durationMs: 12, archived: true, envKeys: ['A'], createdAt: '1970-01-01T00:00:00.000Z' });
  });
});

const dbUrl = process.env.HISTORY_TEST_DATABASE_URL;
(dbUrl ? describe : describe.skip)('history (Postgres)', () => {
  let pool: Pool;
  let history: HistoryStore;
  let app: import('express').Application;
  const user = principalForKey(USER_KEY)!;
  const other = principalForKey(OTHER_KEY)!;
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();

  const rec = (n: number, o: Partial<JobRecord> = {}): JobRecord =>
    makeRecord({ id: id(n), owner: user.id, status: 'completed', exitCode: 0, durationMs: 100 * n, createdAt: daysAgo(0), finishedAt: daysAgo(0), ...o });

  beforeAll(async () => {
    // Isolated schema per run so tests never touch real data.
    const schema = `tf_test_${Date.now()}`;
    const admin = new Pool({ connectionString: dbUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    pool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}` });
    history = new HistoryStore(pool);
    await history.migrate();
    await history.migrate(); // idempotent
    app = createApp({ jobs: new JobService(store, new FakeQueue() as any, history), history: () => history, rateLimitStore: 'memory' });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetRedis(redis);
    await pool.query('TRUNCATE tf_jobs, tf_batches');
  });

  const failure = { format: 'junit' as const, total: 2, passed: 1, failed: 1, skipped: 0, failures: [{ name: 'divides', classname: 'calc' }], sources: [] };

  it('upserts and reads back jobs', async () => {
    await history.recordJob(rec(1, { env: { SECRET: '' }, metadata: { commit: 'abc' }, testReport: failure, status: 'failed', exitCode: 1 }));
    await history.recordJob(rec(1, { status: 'failed', exitCode: 3, testReport: failure, env: { SECRET: '' } }));
    const got = await history.getJob(id(1));
    expect(got).toMatchObject({ id: id(1), status: 'failed', exitCode: 3, envKeys: ['SECRET'], archived: true, testReport: { failed: 1 } });
    expect(got?.env).toBeUndefined();
  });

  it('searches with owner scoping, filters and text search', async () => {
    await history.recordJob(rec(1, { command: undefined, language: 'python', metadata: { branch: 'feature-x' } }));
    await history.recordJob(rec(2, { status: 'failed', exitCode: 1, error: 'AssertionError in checkout' }));
    await history.recordJob(rec(3, { owner: other.id }));
    await history.recordJob(rec(4, { createdAt: daysAgo(10) }));

    const mine = await request(app).get('/api/v1/history/jobs').set(as(USER_KEY));
    expect(mine.body.data.pagination.total).toBe(3);
    const ids = mine.body.data.jobs.map((j: any) => j.jobId);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(expect.arrayContaining([id(1), id(2), id(4)]));
    expect(ids[2]).toBe(id(4)); // newest first
    expect(mine.body.data.jobs[0].archived).toBe(true);

    const failed = await request(app).get('/api/v1/history/jobs?status=failed').set(as(USER_KEY));
    expect(failed.body.data.jobs.map((j: any) => j.jobId)).toEqual([id(2)]);

    const text = await request(app).get('/api/v1/history/jobs?q=feature-x').set(as(USER_KEY));
    expect(text.body.data.jobs.map((j: any) => j.jobId)).toEqual([id(1)]);
    const err = await request(app).get('/api/v1/history/jobs?q=checkout').set(as(USER_KEY));
    expect(err.body.data.jobs.map((j: any) => j.jobId)).toEqual([id(2)]);
    // LIKE wildcards are escaped
    expect((await request(app).get('/api/v1/history/jobs?q=%25').set(as(USER_KEY))).body.data.pagination.total).toBe(0);

    const recent = await request(app).get(`/api/v1/history/jobs?from=${encodeURIComponent(daysAgo(1))}`).set(as(USER_KEY));
    expect(recent.body.data.pagination.total).toBe(2);

    const all = await request(app).get('/api/v1/history/jobs').set(as(ADMIN_KEY));
    expect(all.body.data.pagination.total).toBe(4);

    expect((await request(app).get('/api/v1/history/jobs?status=bogus').set(as(USER_KEY))).status).toBe(400);
  });

  it('computes stats, daily trend and top failing tests', async () => {
    await history.recordJob(rec(1, { durationMs: 100 }));
    await history.recordJob(rec(2, { durationMs: 300, status: 'failed', exitCode: 1, testReport: failure }));
    await history.recordJob(rec(3, { durationMs: 200, status: 'failed', exitCode: 1, testReport: failure, createdAt: daysAgo(2) }));
    await history.recordJob(rec(4, { status: 'cancelled', durationMs: undefined }));
    const res = await request(app).get('/api/v1/history/stats?days=7').set(as(USER_KEY));
    const s = res.body.data;
    expect(s.totals).toMatchObject({ total: 4, completed: 1, failed: 2, cancelled: 1, successRate: 33.3, avgDurationMs: 200, testsTotal: 4, testsFailed: 2 });
    expect(s.daily).toHaveLength(7);
    expect(s.daily[6]).toMatchObject({ total: 3, completed: 1, unsuccessful: 2 });
    expect(s.daily[4]).toMatchObject({ total: 1, unsuccessful: 1 });
    expect(s.topFailingTests).toEqual([expect.objectContaining({ name: 'divides', classname: 'calc', failures: 2 })]);

    const otherStats = await request(app).get('/api/v1/history/stats').set(as(OTHER_KEY));
    expect(otherStats.body.data.totals.total).toBe(0);
  });

  it('serves expired jobs from history, read-only', async () => {
    await history.recordJob(rec(5, { status: 'failed', exitCode: 1, env: { TOKEN: '' } }));
    await history.recordJob(rec(6, { status: 'failed', exitCode: 1 }));
    const detail = await request(app).get(`/api/v1/jobs/${id(5)}`).set(as(USER_KEY));
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ jobId: id(5), status: 'failed', archived: true, envKeys: ['TOKEN'] });
    expect((await request(app).get(`/api/v1/jobs/${id(5)}`).set(as(OTHER_KEY))).status).toBe(404);
    expect((await request(app).get(`/api/v1/logs/${id(5)}`).set(as(USER_KEY))).body.data.available).toBe(false);
    expect((await request(app).delete(`/api/v1/jobs/${id(5)}`).set(as(USER_KEY))).status).toBe(409);

    const retryWithEnv = await request(app).post(`/api/v1/jobs/${id(5)}/retry`).set(as(USER_KEY));
    expect(retryWithEnv.status).toBe(409);
    expect(retryWithEnv.body.error).toMatch(/environment values were not retained/);
    const retry = await request(app).post(`/api/v1/jobs/${id(6)}/retry`).set(as(USER_KEY));
    expect(retry.status).toBe(201);
    expect(retry.body.data.retryOf).toBe(id(6));
  });

  it('records batches and lists them', async () => {
    await history.recordBatch({ id: id(50), owner: user.id, name: 'nightly', status: 'failed', total: 3, createdAt: daysAgo(0), summary: { counts: { completed: 2, failed: 1 } } });
    const res = await request(app).get('/api/v1/history/batches').set(as(USER_KEY));
    expect(res.body.data.batches).toEqual([expect.objectContaining({ id: id(50), name: 'nightly', status: 'failed', total: 3 })]);
  });

  it('purges entries older than the retention period', async () => {
    await history.recordJob(rec(1, { createdAt: daysAgo(400) }));
    await history.recordJob(rec(2));
    expect(await history.purge(365)).toBe(1);
    expect((await history.searchJobs({ page: 1, limit: 10 })).total).toBe(1);
    expect(await history.ping()).toBe(true);
  });

  it('is fed by job finalization', async () => {
    const entries: any[] = [];
    setHistoryEnqueue(async (e) => {
      entries.push(e);
      if (e.kind === 'job') await history.recordJob(e.record);
    });
    try {
      const r = rec(9, { status: 'running' });
      await store.create(r);
      await finalizeJob(r.id, 'completed', { exitCode: 0, durationMs: 5 }, store);
      await finalizeJob(r.id, 'completed', { exitCode: 0, durationMs: 5 }, store);
    } finally {
      setHistoryEnqueue(null);
    }
    expect(entries).toHaveLength(1);
    expect(await history.getJob(id(9))).toMatchObject({ status: 'completed', durationMs: 5 });
  });
});
