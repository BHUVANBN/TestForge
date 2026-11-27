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
  jobs = new Map<string, { state: string; attempts: number; priority?: number }>();
  paused = false;
  async add(jobId: string, attempts: number, priority?: number) {
    this.jobs.set(jobId, { state: 'waiting', attempts, priority });
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

/** Build a tar archive the way `docker cp` returns it (top-level "artifacts/"). */
export function makeTar(files: Record<string, string | Buffer>, root = 'artifacts/'): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: string) => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(type, 156);
    h.write('ustar\0' + '00', 257);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return h;
  };
  blocks.push(header(root, 0, '5'));
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    blocks.push(header(`${root}${name}`, data.length, '0'));
    blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

