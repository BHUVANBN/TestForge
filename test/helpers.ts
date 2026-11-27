import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { setRedis } from '../src/queue/redis';
import { JobRecord, Principal } from '../src/utils/types';

export const USER_KEY = 'user-key-0123456789abcdef';
export const OTHER_KEY = 'other-key-0123456789abcdef';
export const ADMIN_KEY = 'admin-key-0123456789abcdef';

export function mockRedis(): Redis {
  const client = new RedisMock() as unknown as Redis;
  setRedis(client);
  return client;
}

export async function resetRedis(client: Redis): Promise<void> {
  await client.flushall();
}

export const user: Principal = { id: 'user-1', admin: false };
export const other: Principal = { id: 'user-2', admin: false };
export const admin: Principal = { id: 'admin', admin: true };

export function makeRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: overrides.id ?? '00000000-0000-4000-8000-000000000001',
    owner: 'user-1',
    status: 'queued',
    attempt: 0,
    maxAttempts: 1,
    retries: 0,
    timeoutMs: 10_000,
    language: 'bash',
    script: 'echo hi',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Minimal in-memory stand-in for QueueManager. */
export class FakeQueue {
  jobs = new Map<string, { state: string; attempts: number }>();
  paused = false;
  async add(jobId: string, attempts: number) {
    this.jobs.set(jobId, { state: 'waiting', attempts });
    return { id: jobId } as any;
  }
  async getJob(jobId: string) {
    return this.jobs.has(jobId) ? ({ id: jobId } as any) : undefined;
  }
  async removeIfPending(jobId: string) {
    const j = this.jobs.get(jobId);
    if (!j || !['waiting', 'delayed'].includes(j.state)) return false;
    this.jobs.delete(jobId);
    return true;
  }
  async removePending() {
    const ids = [...this.jobs.entries()].filter(([, j]) => j.state === 'waiting').map(([id]) => id);
    ids.forEach((id) => this.jobs.delete(id));
    return ids;
  }
  async getStats() {
    const count = (s: string) => [...this.jobs.values()].filter((j) => j.state === s).length;
    return { waiting: count('waiting'), active: count('active'), completed: 0, failed: 0, delayed: 0, paused: this.paused };
  }
  async pause() {
    this.paused = true;
  }
  async resume() {
    this.paused = false;
  }
  async ping() {
    return true;
  }
}
