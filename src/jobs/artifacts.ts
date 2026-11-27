import type Redis from 'ioredis';
import config from '../config';
import { getRedis, redisKey } from '../queue/redis';
import { Artifact, ArtifactMeta } from '../utils/types';

/**
 * Job artifacts in Redis with the same TTL as job records. Bounded by
 * ARTIFACT_MAX_BYTES / ARTIFACT_MAX_FILES per job.
 */
export class ArtifactStore {
  constructor(private readonly redisClient?: Redis) {}

  private get redis(): Redis {
    return this.redisClient ?? getRedis();
  }

  private indexKey = (jobId: string) => redisKey('artifacts', jobId);
  private fileKey = (jobId: string, i: number) => redisKey('artifact', jobId, String(i));

  async save(jobId: string, artifacts: Artifact[]): Promise<ArtifactMeta[]> {
    const ttl = config.jobs.ttlSeconds;
    const meta = artifacts.map((a) => ({ name: a.name, size: a.data.length }));
    const multi = this.redis.multi();
    // Replace artifacts from a previous attempt.
    const previous = await this.list(jobId);
    previous.forEach((_, i) => multi.del(this.fileKey(jobId, i)));
    artifacts.forEach((a, i) => multi.set(this.fileKey(jobId, i), a.data, 'EX', ttl));
    multi.set(this.indexKey(jobId), JSON.stringify(meta), 'EX', ttl);
    await multi.exec();
    return meta;
  }

  async list(jobId: string): Promise<ArtifactMeta[]> {
    const raw = await this.redis.get(this.indexKey(jobId));
    return raw ? (JSON.parse(raw) as ArtifactMeta[]) : [];
  }

  async get(jobId: string, name: string): Promise<{ meta: ArtifactMeta; data: Buffer } | null> {
    const list = await this.list(jobId);
    const index = list.findIndex((m) => m.name === name);
    if (index < 0) return null;
    const data = await this.redis.getBuffer(this.fileKey(jobId, index));
    return data ? { meta: list[index], data } : null;
  }
}

let instance: ArtifactStore | null = null;
export const getArtifactStore = (): ArtifactStore => (instance ??= new ArtifactStore());
export const setArtifactStore = (s: ArtifactStore | null): void => {
  instance = s;
};
