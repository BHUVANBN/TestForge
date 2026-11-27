import type Redis from 'ioredis';
import config from '../config';
import { getRedis, redisKey } from '../queue/redis';
import { JobOutput, JobRecord, JobStatus } from '../utils/types';

/**
 * Durable job records in Redis.
 *
 * Each record is a hash with one JSON-encoded value per field, so concurrent
 * partial updates from the API (cancel) and workers (progress) never clobber
 * each other. Sorted sets index jobs by creation time, globally and per owner.
 */
export class JobStore {
  constructor(private readonly redisClient?: Redis) {}

  private get redis(): Redis {
    return this.redisClient ?? getRedis();
  }

  private recordKey = (id: string) => redisKey('job', id);
  private outputKey = (id: string) => redisKey('job-output', id);
  private allIndex = () => redisKey('jobs', 'all');
  private ownerIndex = (owner: string) => redisKey('jobs', 'owner', owner);

  async create(record: JobRecord): Promise<void> {
    const ttl = config.jobs.ttlSeconds;
    const score = Date.parse(record.createdAt);
    const cutoff = Date.now() - ttl * 1000;
    await this.redis
      .multi()
      .hset(this.recordKey(record.id), encode(record))
      .expire(this.recordKey(record.id), ttl)
      .zadd(this.allIndex(), score, record.id)
      .zadd(this.ownerIndex(record.owner), score, record.id)
      // Index entries older than the TTL point at expired records.
      .zremrangebyscore(this.allIndex(), '-inf', cutoff)
      .zremrangebyscore(this.ownerIndex(record.owner), '-inf', cutoff)
      .exec();
  }

  async get(id: string): Promise<JobRecord | null> {
    const raw = await this.redis.hgetall(this.recordKey(id));
    if (!raw || Object.keys(raw).length === 0) return null;
    return decode(raw) as unknown as JobRecord;
  }

  async getMany(ids: string[]): Promise<Array<JobRecord | null>> {
    if (ids.length === 0) return [];
    const pipeline = this.redis.pipeline();
    ids.forEach((id) => pipeline.hgetall(this.recordKey(id)));
    const results = (await pipeline.exec()) ?? [];
    return results.map(([err, raw]) => {
      if (err || !raw || Object.keys(raw as object).length === 0) return null;
      return decode(raw as Record<string, string>) as unknown as JobRecord;
    });
  }

  /** Partial update. Ignored if the record no longer exists. */
  async update(id: string, patch: Partial<JobRecord>): Promise<void> {
    const key = this.recordKey(id);
    const set: Record<string, string> = {};
    const unset: string[] = [];
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) unset.push(field);
      else set[field] = JSON.stringify(value);
    }
    // Lua keeps "only if it still exists" atomic so updates never resurrect expired jobs.
    await this.redis.eval(
      `if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
       for i = 1, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
       return 1`,
      1,
      key,
      ...Object.entries(set).flat()
    );
    if (unset.length) await this.redis.hdel(key, ...unset);
  }

  async saveOutput(id: string, output: JobOutput): Promise<void> {
    await this.redis.set(this.outputKey(id), JSON.stringify(output), 'EX', config.jobs.ttlSeconds);
  }

  async getOutput(id: string): Promise<JobOutput | null> {
    const raw = await this.redis.get(this.outputKey(id));
    return raw ? (JSON.parse(raw) as JobOutput) : null;
  }

  /**
   * Newest-first listing. With a status filter we scan up to
   * `jobs.maxListScan` recent jobs and filter in memory.
   */
  async list(opts: {
    owner?: string;
    status?: JobStatus;
    page: number;
    limit: number;
  }): Promise<{ jobs: JobRecord[]; total: number }> {
    const index = opts.owner ? this.ownerIndex(opts.owner) : this.allIndex();
    const start = (opts.page - 1) * opts.limit;

    if (!opts.status) {
      const [ids, total] = await Promise.all([
        this.redis.zrevrange(index, start, start + opts.limit - 1),
        this.redis.zcard(index),
      ]);
      const records = await this.getMany(ids);
      await this.pruneMissing(index, ids, records);
      return { jobs: records.filter(isRecord), total };
    }

    const ids = await this.redis.zrevrange(index, 0, config.jobs.maxListScan - 1);
    const records = await this.getMany(ids);
    await this.pruneMissing(index, ids, records);
    const matching = records.filter(isRecord).filter((r) => r.status === opts.status);
    return { jobs: matching.slice(start, start + opts.limit), total: matching.length };
  }

  private async pruneMissing(index: string, ids: string[], records: Array<JobRecord | null>) {
    const missing = ids.filter((_, i) => records[i] === null);
    if (missing.length) await this.redis.zrem(index, ...missing);
  }
}

const isRecord = (r: JobRecord | null): r is JobRecord => r !== null;

function encode(obj: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = JSON.stringify(v);
  }
  return out;
}

function decode(raw: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    try {
      out[k] = JSON.parse(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

let instance: JobStore | null = null;
export const getJobStore = (): JobStore => (instance ??= new JobStore());
export const setJobStore = (store: JobStore): void => {
  instance = store;
};
