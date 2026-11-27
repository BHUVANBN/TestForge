import Redis, { RedisOptions } from 'ioredis';
import config from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('redis');
const connections = new Set<Redis>();
let shared: Redis | null = null;

const commonOptions = (): RedisOptions => ({
  tls: config.redis.tls ? {} : undefined,
  // Required by BullMQ; also lets commands queue while reconnecting instead of failing fast.
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy: (times) => Math.min(times * 200, 5000),
  reconnectOnError: (err) => err.message.includes('READONLY'),
});

export function redisOptions(): RedisOptions {
  return {
    ...commonOptions(),
    host: config.redis.host,
    port: config.redis.port,
    username: config.redis.username,
    password: config.redis.password,
    db: config.redis.db,
  };
}

/** Open a new dedicated connection (BullMQ classes and subscribers each need their own). */
export function createRedis(name: string): Redis {
  const client = config.redis.url
    ? new Redis(config.redis.url, commonOptions())
    : new Redis(redisOptions());
  client.on('error', (err) => log.error('Redis error', { connection: name, error: err.message }));
  client.on('reconnecting', (ms: number) => log.warn('Redis reconnecting', { connection: name, inMs: ms }));
  client.on('ready', () => log.debug('Redis ready', { connection: name }));
  client.on('end', () => connections.delete(client));
  connections.add(client);
  return client;
}

/** Shared connection for regular (non-blocking) commands. */
export function getRedis(): Redis {
  if (!shared) shared = createRedis('shared');
  return shared;
}

/** Test helper. */
export function setRedis(client: Redis): void {
  shared = client;
}

export function redisKey(...parts: string[]): string {
  return [config.redis.keyPrefix, ...parts].join(':');
}

export async function waitForRedis(timeoutMs = 15_000): Promise<void> {
  const client = getRedis();
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if ((await client.ping()) === 'PONG') return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Redis not reachable at ${config.redis.url ?? `${config.redis.host}:${config.redis.port}`}: ${
      lastError instanceof Error ? lastError.message : 'timeout'
    }`
  );
}

export async function redisHealthy(): Promise<boolean> {
  try {
    return (await getRedis().ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function closeAllRedis(): Promise<void> {
  await Promise.all(
    [...connections].map((c) =>
      c.quit().catch(() => {
        c.disconnect();
      })
    )
  );
  connections.clear();
  shared = null;
}
