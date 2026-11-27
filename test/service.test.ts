import { JobError, JobService, parseSubmission } from '../src/jobs/service';
import { JobStore } from '../src/jobs/store';
import { admin, FakeQueue, mockRedis, other, resetRedis, user } from './helpers';

const redis = mockRedis();
const store = new JobStore(redis);
const queue = new FakeQueue();
const service = new JobService(store, queue as any);

const validationErrors = (body: unknown): string[] => {
  try {
    parseSubmission(body);
  } catch (e) {
    if (e instanceof JobError) return e.details ?? [e.message];
    throw e;
  }
  return [];
};

describe('parseSubmission', () => {
  it('normalizes a script job with defaults', () => {
    const spec = parseSubmission({ script: 'echo hi' });
    expect(spec).toMatchObject({ language: 'bash', script: 'echo hi', retries: 0, timeoutMs: 300000 });
  });

  it('accepts a command job', () => {
    const spec = parseSubmission({ command: 'node', args: ['-e', 'console.log(1)'], timeout: 5000, retries: 2 });
    expect(spec).toMatchObject({ command: 'node', args: ['-e', 'console.log(1)'], timeoutMs: 5000, retries: 2 });
  });

  it.each([
    [{}, /either "script" or "command"/],
    [{ script: 'x', command: 'node' }, /not both/],
    [{ command: 'node -v' }, /single executable name/],
    [{ command: '/bin/bash' }, /single executable name/],
    [{ command: 'curl' }, /allowed command list/],
    [{ script: 'x', language: 'cobol' }, /language/],
    [{ script: 'x', env: { LD_PRELOAD: '/x.so' } }, /reserved/],
    [{ script: 'x', env: { NODE_OPTIONS: '--require x' } }, /reserved/],
    [{ script: 'x', env: { 'BAD-NAME': '1' } }, /must match/],
    [{ script: 'x', timeout: 10 }, /timeout/],
    [{ script: 'x', retries: 0.5 }, /retries/],
    [{ script: 'x', retries: 99 }, /retries/],
    [{ script: 'x', unexpected: 1 }, /not allowed/],
    [{ script: 'x', args: ['a'] }, /args/],
  ])('rejects %j', (body, message) => {
    expect(validationErrors(body).join('\n')).toMatch(message);
  });

  it('enforces the script size limit in bytes, not characters', () => {
    // 'é' is 2 bytes in UTF-8: 60k chars = 120k bytes > 100k limit.
    expect(validationErrors({ script: 'é'.repeat(60_000) }).join()).toMatch(/maximum size/);
  });

  it('caps metadata size', () => {
    expect(validationErrors({ script: 'x', metadata: { blob: 'a'.repeat(9000) } }).join()).toMatch(/metadata/);
  });
});

describe('JobService', () => {
  beforeEach(async () => {
    await resetRedis(redis);
    queue.jobs.clear();
  });

  const submit = (principal = user) => service.submit(parseSubmission({ script: 'echo hi', retries: 2 }), principal);

  it('creates a record and enqueues with attempts = retries + 1', async () => {
    const rec = await submit();
    expect(rec.status).toBe('queued');
    expect(rec.maxAttempts).toBe(3);
    expect(queue.jobs.get(rec.id)?.attempts).toBe(3);
    expect(await store.get(rec.id)).toMatchObject({ owner: user.id });
  });

  it('marks the job failed if enqueueing fails', async () => {
    const broken = new JobService(store, { add: () => Promise.reject(new Error('redis down')) } as any);
    await expect(broken.submit(parseSubmission({ script: 'x' }), user)).rejects.toThrow('redis down');
    const { jobs } = await store.list({ page: 1, limit: 1 });
    expect(jobs[0]).toMatchObject({ status: 'failed', error: 'Could not enqueue job' });
  });

  it('hides other users\' jobs but lets admins see them', async () => {
    const rec = await submit();
    await expect(service.get(rec.id, other)).rejects.toMatchObject({ status: 404 });
    await expect(service.get(rec.id, admin)).resolves.toMatchObject({ id: rec.id });
    expect((await service.list(other, {})).jobs).toHaveLength(0);
    expect((await service.list(user, {})).jobs).toHaveLength(1);
    expect((await service.list(admin, {})).jobs).toHaveLength(1);
  });

  it('cancels a queued job immediately', async () => {
    const rec = await submit();
    expect(await service.cancel(rec.id, user)).toBe('cancelled');
    expect(queue.jobs.has(rec.id)).toBe(false);
    expect(await store.get(rec.id)).toMatchObject({ status: 'cancelled', cancelRequested: true });
  });

  it('signals running jobs instead of removing them', async () => {
    const rec = await submit();
    queue.jobs.get(rec.id)!.state = 'active';
    await store.update(rec.id, { status: 'running' });
    const published: string[] = [];
    const spy = jest.spyOn(redis, 'publish').mockImplementation(async (ch: any, msg: any) => {
      published.push(`${ch}:${msg}`);
      return 1;
    });
    expect(await service.cancel(rec.id, user)).toBe('cancelling');
    expect(published.some((p) => p.startsWith('tf:events:cancel') && p.includes(rec.id))).toBe(true);
    expect(await store.get(rec.id)).toMatchObject({ status: 'running', cancelRequested: true });
    spy.mockRestore();
  });

  it('refuses to cancel finished jobs', async () => {
    const rec = await submit();
    await store.update(rec.id, { status: 'completed' });
    await expect(service.cancel(rec.id, user)).rejects.toMatchObject({ status: 409 });
  });

  it('retries failed jobs as a new linked job', async () => {
    const rec = await submit();
    await store.update(rec.id, { status: 'failed' });
    const retry = await service.retry(rec.id, user);
    expect(retry.id).not.toBe(rec.id);
    expect(retry).toMatchObject({ retryOf: rec.id, script: 'echo hi', status: 'queued', maxAttempts: 3 });
  });

  it('does not retry completed or active jobs', async () => {
    const rec = await submit();
    await expect(service.retry(rec.id, user)).rejects.toMatchObject({ status: 409 });
    await store.update(rec.id, { status: 'completed' });
    await expect(service.retry(rec.id, user)).rejects.toMatchObject({ status: 409 });
  });

  it('validates list queries', async () => {
    await expect(service.list(user, { status: 'bogus' })).rejects.toMatchObject({ status: 400 });
    const res = await service.list(user, { page: '2', limit: '5' });
    expect(res.pagination).toMatchObject({ page: 2, limit: 5, total: 0, hasPrev: true, hasNext: false });
  });
});
