import { UnrecoverableError } from 'bullmq';
import { JobStore } from '../src/jobs/store';
import { ExecutionResult, Executor, JobRecord } from '../src/utils/types';
import { listWorkers, WorkerManager } from '../src/workers/manager';
import { makeRecord, mockRedis, resetRedis } from './helpers';

const redis = mockRedis();
const store = new JobStore(redis);

const result = (overrides: Partial<ExecutionResult> = {}): ExecutionResult => ({
  outcome: 'completed',
  exitCode: 0,
  stdout: 'hello\n',
  stderr: '',
  truncated: false,
  durationMs: 42,
  ...overrides,
});

import { ArtifactStore } from '../src/jobs/artifacts';
const artifactStore = new ArtifactStore(redis);

function manager(
  outcome: Partial<ExecutionResult> | (() => Promise<ExecutionResult>),
  seen: JobRecord[] = [],
  kill: (reason: string) => Promise<void> = async () => undefined
) {
  return new WorkerManager({
    store,
    startWorker: false,
    artifacts: artifactStore,
    connect: () => (redis as any).duplicate(),
    executorFactory: (record) => {
      seen.push(record);
      const exec: Executor = {
        run: typeof outcome === 'function' ? outcome : async () => result(outcome),
        kill: kill as Executor['kill'],
      };
      return exec;
    },
  });
}

const bullJob = (jobId: string, attemptsMade = 1, attempts = 1) =>
  ({ data: { jobId }, attemptsMade, opts: { attempts } }) as any;

describe('WorkerManager.processJob', () => {
  beforeEach(() => resetRedis(redis));

  it('records successful runs and their output', async () => {
    const rec = makeRecord();
    await store.create(rec);
    const seen: JobRecord[] = [];
    await expect(manager({}, seen).processJob(bullJob(rec.id))).resolves.toEqual({ status: 'completed', exitCode: 0 });
    expect(seen[0]).toMatchObject({ id: rec.id, attempt: 1 });
    expect(await store.get(rec.id)).toMatchObject({ status: 'completed', exitCode: 0, durationMs: 42, attempt: 1 });
    expect((await store.get(rec.id))?.finishedAt).toBeDefined();
    expect(await store.getOutput(rec.id)).toEqual({ stdout: 'hello\n', stderr: '', truncated: false });
  });

  it('stores artifacts and the parsed test report', async () => {
    const rec = makeRecord();
    await store.create(rec);
    const junit = '<testsuite><testcase name="a"/><testcase name="b"><failure message="nope"/></testcase></testsuite>';
    await manager({ artifacts: [{ name: 'junit.xml', data: Buffer.from(junit) }] }).processJob(bullJob(rec.id));
    const saved = await store.get(rec.id);
    expect(saved).toMatchObject({ status: 'completed', artifactCount: 1, testReport: { format: 'junit', total: 2, failed: 1 } });
    expect(await artifactStore.list(rec.id)).toEqual([{ name: 'junit.xml', size: junit.length }]);
  });

  it('finishes the job even when artifact storage fails', async () => {
    const rec = makeRecord();
    await store.create(rec);
    const broken = new WorkerManager({
      store,
      startWorker: false,
      artifacts: { save: async () => { throw new Error('bucket unreachable'); }, list: async () => [], get: async () => null },
      executorFactory: () => ({ run: async () => result({ artifacts: [{ name: 'a', data: Buffer.from('x') }] }), kill: async () => undefined }),
    });
    await expect(broken.processJob(bullJob(rec.id))).resolves.toEqual({ status: 'completed', exitCode: 0 });
    expect(await store.get(rec.id)).toMatchObject({
      status: 'completed',
      artifactCount: 0,
      artifactsError: 'Artifacts could not be stored: bucket unreachable',
    });
  });

  it('records unexpected infrastructure errors instead of leaving the job running', async () => {
    const rec = makeRecord();
    await store.create(rec);
    const mgr = manager({});
    const spy = jest.spyOn(store, 'saveOutput').mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(mgr.processJob(bullJob(rec.id))).rejects.toThrow('ECONNREFUSED');
    spy.mockRestore();
    expect(await store.get(rec.id)).toMatchObject({ status: 'failed', error: 'Internal error: connect ECONNREFUSED' });
  });

  it('reconciles records whose queue job is gone or finished', async () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const lost = makeRecord({ id: '00000000-0000-4000-8000-0000000000a1', status: 'running', startedAt: old, createdAt: old });
    const active = makeRecord({ id: '00000000-0000-4000-8000-0000000000a2', status: 'running', startedAt: old, createdAt: old });
    const fresh = makeRecord({ id: '00000000-0000-4000-8000-0000000000a3', status: 'running', startedAt: new Date().toISOString() });
    const cancelled = makeRecord({ id: '00000000-0000-4000-8000-0000000000a4', status: 'queued', cancelRequested: true, createdAt: old });
    for (const r of [lost, active, fresh, cancelled]) await store.create(r);
    const states: Record<string, any> = {
      [lost.id]: { getState: async () => 'failed', failedReason: 'connect ECONNREFUSED' },
      [active.id]: { getState: async () => 'active' },
    };
    const mgr = new WorkerManager({ store, startWorker: false, queue: { getJob: async (id: string) => states[id] } as any });
    expect(await mgr.reconcile()).toBe(2);
    expect(await store.get(lost.id)).toMatchObject({ status: 'failed', error: 'Job was lost by its worker: connect ECONNREFUSED' });
    expect((await store.get(active.id))?.status).toBe('running');
    expect((await store.get(fresh.id))?.status).toBe('running');
    expect((await store.get(cancelled.id))?.status).toBe('cancelled');
  });

  it('never displays more attempts than allowed (re-run after shutdown)', async () => {
    const rec = makeRecord();
    await store.create(rec);
    const seen: JobRecord[] = [];
    await manager({}, seen).processJob(bullJob(rec.id, 2, 1));
    expect(seen[0].attempt).toBe(1);
  });

  it('marks retrying and throws so BullMQ retries', async () => {
    const rec = makeRecord({ maxAttempts: 3 });
    await store.create(rec);
    await expect(manager({ outcome: 'failed', exitCode: 1, error: 'exit 1' }).processJob(bullJob(rec.id, 1, 3))).rejects.toThrow(
      'exit 1'
    );
    expect(await store.get(rec.id)).toMatchObject({ status: 'retrying', attempt: 1, exitCode: 1 });
  });

  it('marks the final failed attempt as failed', async () => {
    const rec = makeRecord({ maxAttempts: 3 });
    await store.create(rec);
    await expect(manager({ outcome: 'failed', exitCode: 1, error: 'exit 1' }).processJob(bullJob(rec.id, 3, 3))).rejects.toThrow();
    expect(await store.get(rec.id)).toMatchObject({ status: 'failed', attempt: 3 });
  });

  it('records timeouts', async () => {
    const rec = makeRecord();
    await store.create(rec);
    await expect(manager({ outcome: 'timeout', exitCode: null, error: 'Timed out' }).processJob(bullJob(rec.id))).rejects.toThrow();
    expect((await store.get(rec.id))?.status).toBe('timeout');
  });

  it('skips jobs cancelled before they started, without retrying', async () => {
    const rec = makeRecord({ cancelRequested: true });
    await store.create(rec);
    const seen: JobRecord[] = [];
    await expect(manager({}, seen).processJob(bullJob(rec.id))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(seen).toHaveLength(0);
    expect((await store.get(rec.id))?.status).toBe('cancelled');
  });

  it('honours a cancel that raced with completion', async () => {
    const rec = makeRecord();
    await store.create(rec);
    const mgr = manager(async () => {
      await store.update(rec.id, { cancelRequested: true });
      return result();
    });
    await expect(mgr.processJob(bullJob(rec.id))).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await store.get(rec.id))?.status).toBe('cancelled');
  });

  it('treats executor crashes as failed attempts', async () => {
    const rec = makeRecord();
    await store.create(rec);
    const mgr = manager(async () => {
      throw new Error('boom');
    });
    await expect(mgr.processJob(bullJob(rec.id))).rejects.toThrow('boom');
    expect(await store.get(rec.id)).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('drops jobs whose record expired', async () => {
    await expect(manager({}).processJob(bullJob('00000000-0000-4000-8000-00000000dead'))).rejects.toBeInstanceOf(
      UnrecoverableError
    );
  });

  it('re-queues (never resolves) when interrupted by shutdown', async () => {
    const rec = makeRecord();
    await store.create(rec);
    const p = manager({ outcome: 'interrupted' }).processJob(bullJob(rec.id));
    const settled = await Promise.race([p.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 100))]);
    expect(settled).toBe('pending');
    expect((await store.get(rec.id))?.status).toBe('queued');
  });
});

describe('worker heartbeats', () => {
  beforeEach(() => resetRedis(redis));

  it('publishes and lists live workers', async () => {
    const mgr = manager({});
    await mgr.start();
    const workers = await listWorkers(redis);
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({ id: mgr.id, executor: 'local', active: 0 });
    await mgr.close();
    expect(await listWorkers(redis)).toHaveLength(0);
  });
});

describe('cross-process cancellation', () => {
  beforeEach(() => resetRedis(redis));

  it('kills the running executor when a cancel event is published', async () => {
    const rec = makeRecord();
    await store.create(rec);
    let finish: (r: ExecutionResult) => void = () => undefined;
    const kills: string[] = [];
    const mgr = manager(
      () => new Promise<ExecutionResult>((r) => (finish = r)),
      [],
      async (reason) => {
        kills.push(reason);
        finish(result({ outcome: 'cancelled', exitCode: null }));
      }
    );
    await mgr.start();
    const pending = mgr.processJob(bullJob(rec.id));
    await new Promise((r) => setTimeout(r, 50));
    const { publishCancel } = await import('../src/jobs/events');
    await publishCancel({ jobId: rec.id }, redis);
    await expect(pending).rejects.toBeInstanceOf(UnrecoverableError);
    expect(kills).toEqual(['cancel']);
    expect((await store.get(rec.id))?.status).toBe('cancelled');
    await mgr.close();
  });
});
