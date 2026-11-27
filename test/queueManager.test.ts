import { QueueManager } from '../src/queue/manager';

function fakeJob(id: string, state: string, removeFails = false) {
  return {
    id,
    getState: jest.fn(async () => state),
    remove: jest.fn(async () => {
      if (removeFails) throw new Error('locked');
    }),
  };
}

function fakeQueue(jobs: ReturnType<typeof fakeJob>[]) {
  let pending = [...jobs];
  return {
    add: jest.fn(async (_name: string, data: any, opts: any) => ({ id: opts.jobId, data, opts })),
    getJob: jest.fn(async (id: string) => jobs.find((j) => j.id === id)),
    getJobs: jest.fn(async () => {
      const batch = pending;
      pending = [];
      return batch;
    }),
    getJobCounts: jest.fn(async () => ({ waiting: 2, active: 1, completed: 3, failed: 4, delayed: 5 })),
    isPaused: jest.fn(async () => true),
    clean: jest.fn(async () => []),
    pause: jest.fn(),
    resume: jest.fn(),
    close: jest.fn(),
    client: Promise.resolve({ ping: async () => 'PONG' }),
  };
}

describe('QueueManager', () => {
  it('enqueues with the job id, attempts and exponential backoff', async () => {
    const q = fakeQueue([]);
    await new QueueManager(q as any).add('job-1', 3);
    expect(q.add).toHaveBeenCalledWith(
      'execute-test',
      { jobId: 'job-1' },
      expect.objectContaining({ jobId: 'job-1', attempts: 3, backoff: expect.objectContaining({ type: 'exponential' }) })
    );
  });

  it('removes only jobs that have not started', async () => {
    const waiting = fakeJob('w', 'waiting');
    const delayed = fakeJob('d', 'delayed');
    const active = fakeJob('a', 'active');
    const racing = fakeJob('r', 'waiting', true);
    const mgr = new QueueManager(fakeQueue([waiting, delayed, active, racing]) as any);
    expect(await mgr.removeIfPending('w')).toBe(true);
    expect(await mgr.removeIfPending('d')).toBe(true);
    expect(await mgr.removeIfPending('a')).toBe(false);
    expect(active.remove).not.toHaveBeenCalled();
    expect(await mgr.removeIfPending('r')).toBe(false);
    expect(await mgr.removeIfPending('missing')).toBe(false);
  });

  it('reports stats including the paused flag', async () => {
    const mgr = new QueueManager(fakeQueue([]) as any);
    expect(await mgr.getStats()).toEqual({ waiting: 2, active: 1, completed: 3, failed: 4, delayed: 5, paused: true });
    expect(await mgr.ping()).toBe(true);
  });

  it('clears pending jobs and returns their ids', async () => {
    const q = fakeQueue([fakeJob('a', 'waiting'), fakeJob('b', 'waiting', true)]);
    const removed = await new QueueManager(q as any).removePending();
    expect(removed).toEqual(['a']);
    expect(q.clean).toHaveBeenCalledTimes(2);
  });
});
