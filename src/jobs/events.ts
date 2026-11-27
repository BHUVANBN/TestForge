import type Redis from 'ioredis';
import { getRedis, redisKey } from '../queue/redis';
import { JobStatus } from '../utils/types';

/**
 * Cross-process messaging over Redis pub/sub. Workers and API servers may run
 * in different processes/hosts, so nothing here relies on in-memory state.
 */
export const channels = {
  status: () => redisKey('events', 'status'),
  logs: () => redisKey('events', 'logs'),
  cancel: () => redisKey('events', 'cancel'),
  batch: () => redisKey('events', 'batch'),
};

export interface BatchEvent {
  batchId: string;
  owner: string;
  status: string;
}

export interface StatusEvent {
  jobId: string;
  owner: string;
  status: JobStatus;
  attempt?: number;
  exitCode?: number | null;
  error?: string;
  durationMs?: number;
}

export interface LogEvent {
  jobId: string;
  owner: string;
  stream: 'stdout' | 'stderr';
  data: string;
}

export interface CancelEvent {
  jobId: string;
}

const publish = (client: Redis, channel: string, payload: object) =>
  client.publish(channel, JSON.stringify(payload)).catch(() => 0);

export const publishStatus = (e: StatusEvent, client: Redis = getRedis()) => publish(client, channels.status(), e);
export const publishLog = (e: LogEvent, client: Redis = getRedis()) => publish(client, channels.logs(), e);
export const publishCancel = (e: CancelEvent, client: Redis = getRedis()) => publish(client, channels.cancel(), e);
export const publishBatch = (e: BatchEvent, client: Redis = getRedis()) => publish(client, channels.batch(), e);
