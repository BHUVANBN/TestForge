import { JobStore } from '../src/jobs/store';
import { makeRecord, mockRedis, resetRedis } from './helpers';

const redis = mockRedis();
const store = new JobStore(redis);

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('JobStore', () => {
  beforeEach(() => resetRedis(redis));

  it('round-trips records with types preserved', async () => {
    const rec = makeRecord({ env: { A: '1' }, metadata: { n: 2, nested: { ok: true } }, args: ['x'] });
    await store.create(rec);
    expect(await store.get(rec.id)).toEqual(rec);
    expect(await redis.ttl(`tf:job:${rec.id}`)).toBeGreaterThan(0);
  });

  it('returns null for unknown jobs', async () => {
    expect(await store.get(id(999))).toBeNull();
  });

  it('applies partial updates and unsets undefined fields', async () => {
    const rec = makeRecord({ error: 'old' });
    await store.create(rec);
    await store.update(rec.id, { status: 'running', attempt: 1, error: undefined });
    const got = await store.get(rec.id);
    expect(got?.status).toBe('running');
    expect(got?.attempt).toBe(1);
    expect(got?.error).toBeUndefined();
    expect(got?.script).toBe('echo hi');
  });

  it('does not resurrect expired/deleted records on update', async () => {
    await store.update(id(5), { status: 'completed' });
    expect(await store.get(id(5))).toBeNull();
  });

  it('stores output separately', async () => {
    await store.saveOutput(id(1), { stdout: 'out', stderr: 'err', truncated: false });
    expect(await store.getOutput(id(1))).toEqual({ stdout: 'out', stderr: 'err', truncated: false });
    expect(await store.getOutput(id(2))).toBeNull();
  });

  it('lists newest first, per owner, with pagination', async () => {
    const now = Date.now();
    for (let i = 1; i <= 5; i++) {
      await store.create(
        makeRecord({ id: id(i), owner: i % 2 ? 'alice' : 'bob', createdAt: new Date(now - (10 - i) * 1000).toISOString() })
      );
    }
    const all = await store.list({ page: 1, limit: 10 });
    expect(all.total).toBe(5);
    expect(all.jobs.map((j) => j.id)).toEqual([id(5), id(4), id(3), id(2), id(1)]);

    const alice = await store.list({ owner: 'alice', page: 1, limit: 2 });
    expect(alice.total).toBe(3);
    expect(alice.jobs.map((j) => j.id)).toEqual([id(5), id(3)]);
    const page2 = await store.list({ owner: 'alice', page: 2, limit: 2 });
    expect(page2.jobs.map((j) => j.id)).toEqual([id(1)]);
  });

  it('filters by status', async () => {
    const now = Date.now();
    await store.create(makeRecord({ id: id(1), createdAt: new Date(now - 2000).toISOString(), status: 'failed' }));
    await store.create(makeRecord({ id: id(2), createdAt: new Date(now - 1000).toISOString(), status: 'completed' }));
    await store.create(makeRecord({ id: id(3), createdAt: new Date(now).toISOString(), status: 'failed' }));
    const res = await store.list({ status: 'failed', page: 1, limit: 10 });
    expect(res.total).toBe(2);
    expect(res.jobs.map((j) => j.id)).toEqual([id(3), id(1)]);
  });

  it('drops index entries older than the TTL', async () => {
    await store.create(makeRecord({ id: id(8), createdAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() }));
    expect(await redis.zcard('tf:jobs:all')).toBe(0);
  });

  it('prunes index entries whose records expired', async () => {
    const rec = makeRecord({ id: id(7) });
    await store.create(rec);
    await redis.del(`tf:job:${rec.id}`);
    const res = await store.list({ page: 1, limit: 10 });
    expect(res.jobs).toEqual([]);
    expect(await redis.zcard('tf:jobs:all')).toBe(0);
  });
});
