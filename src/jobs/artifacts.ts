import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type Redis from 'ioredis';
import { Readable } from 'stream';
import config from '../config';
import { getRedis, redisKey } from '../queue/redis';
import { Artifact, ArtifactMeta } from '../utils/types';

export interface ArtifactFile {
  meta: ArtifactMeta;
  stream: Readable;
}

/** Where job artifacts live. Lookups are by exact name from the job's index. */
export interface ArtifactRepository {
  save(jobId: string, artifacts: Artifact[]): Promise<ArtifactMeta[]>;
  list(jobId: string): Promise<ArtifactMeta[]>;
  get(jobId: string, name: string): Promise<ArtifactFile | null>;
}

/**
 * Artifacts in Redis with the same TTL as job records. Simple, no extra
 * infrastructure; bounded by ARTIFACT_MAX_BYTES (max 100 MiB) per job.
 */
export class ArtifactStore implements ArtifactRepository {
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

  async get(jobId: string, name: string): Promise<ArtifactFile | null> {
    const list = await this.list(jobId);
    const index = list.findIndex((m) => m.name === name);
    if (index < 0) return null;
    const data = await this.redis.getBuffer(this.fileKey(jobId, index));
    return data ? { meta: list[index], stream: Readable.from([data]) } : null;
  }
}

/** Minimal surface of S3Client we use (lets tests inject a fake). */
export interface S3Like {
  send(command: unknown): Promise<any>;
}

/**
 * Artifacts in S3 or any S3-compatible store (MinIO, R2, …). Objects are not
 * tied to Redis TTLs: set a bucket lifecycle rule to expire them.
 */
export class S3ArtifactStore implements ArtifactRepository {
  private readonly client: S3Like;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly createBucket: boolean;
  private bucketReady: Promise<void> | null = null;

  constructor(opts: { client?: S3Like; bucket?: string; prefix?: string; createBucket?: boolean } = {}) {
    const s3 = config.artifacts.s3;
    this.bucket = opts.bucket ?? s3.bucket ?? '';
    this.prefix = opts.prefix ?? s3.prefix;
    this.createBucket = opts.createBucket ?? s3.createBucket;
    this.client =
      opts.client ??
      new S3Client({
        region: s3.region,
        endpoint: s3.endpoint,
        forcePathStyle: s3.forcePathStyle,
        // Never wait forever on a stalled endpoint.
        requestHandler: { connectionTimeout: 5_000, requestTimeout: 60_000 },
        maxAttempts: 3,
        // Only send checksums when the API requires them: widest S3-compatible support.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        credentials:
          s3.accessKeyId && s3.secretAccessKey
            ? { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey }
            : undefined,
      });
  }

  private base(jobId: string) {
    return [this.prefix, 'jobs', jobId, 'artifacts'].filter(Boolean).join('/');
  }
  private indexKey = (jobId: string) => `${this.base(jobId)}/index.json`;
  private fileKey = (jobId: string, i: number) => `${this.base(jobId)}/${i}`;

  /** Create the bucket on first use when S3_CREATE_BUCKET=true (handy for self-hosted stores). */
  private ensureBucket(): Promise<void> {
    if (!this.createBucket) return Promise.resolve();
    this.bucketReady ??= (async () => {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch (err: any) {
        if (err?.$metadata?.httpStatusCode !== 404 && err?.name !== 'NotFound') throw err;
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      }
    })().catch((err) => {
      this.bucketReady = null;
      throw err;
    });
    return this.bucketReady;
  }

  async save(jobId: string, artifacts: Artifact[]): Promise<ArtifactMeta[]> {
    await this.ensureBucket();
    const previous = await this.list(jobId);
    const meta = artifacts.map((a) => ({ name: a.name, size: a.data.length }));
    for (let i = 0; i < artifacts.length; i++) {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.fileKey(jobId, i),
          Body: artifacts[i].data,
          ContentType: 'application/octet-stream',
        })
      );
    }
    // Index last, so readers never see entries whose objects aren't written yet.
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.indexKey(jobId),
        Body: JSON.stringify(meta),
        ContentType: 'application/json',
      })
    );
    const stale = previous.slice(artifacts.length).map((_, i) => ({ Key: this.fileKey(jobId, artifacts.length + i) }));
    if (stale.length) {
      await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: stale } }));
    }
    return meta;
  }

  async list(jobId: string): Promise<ArtifactMeta[]> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.indexKey(jobId) }));
      return JSON.parse(await res.Body.transformToString()) as ArtifactMeta[];
    } catch (err: any) {
      if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return [];
      throw err;
    }
  }

  async get(jobId: string, name: string): Promise<ArtifactFile | null> {
    const list = await this.list(jobId);
    const index = list.findIndex((m) => m.name === name);
    if (index < 0) return null;
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.fileKey(jobId, index) }));
      return { meta: list[index], stream: res.Body as Readable };
    } catch (err: any) {
      if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }
}

let instance: ArtifactRepository | null = null;
export const getArtifactStore = (): ArtifactRepository =>
  (instance ??= config.artifacts.store === 's3' ? new S3ArtifactStore() : new ArtifactStore());
export const setArtifactStore = (s: ArtifactRepository | null): void => {
  instance = s;
};
