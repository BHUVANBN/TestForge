import type Redis from 'ioredis';
import type { IncrementResponse, Options, Store } from 'express-rate-limit';
import { getRedis, redisKey } from '../queue/redis';

/** Fixed-window counter: INCR + set expiry on first hit, atomically. */
const INCREMENT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }`;

/**
 * express-rate-limit store shared by every API instance through Redis, so
 * limits hold no matter which replica a request lands on.
 */
export class RedisRateLimitStore implements Store {
  windowMs = 60_000;
  readonly localKeys = false;

  constructor(
    readonly prefix: string,
    private readonly client: () => Redis = getRedis
  ) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private key(key: string): string {
    return redisKey('ratelimit', this.prefix, key);
  }

  async get(key: string): Promise<IncrementResponse | undefined> {
    const [hits, ttl] = await Promise.all([this.client().get(this.key(key)), this.client().pttl(this.key(key))]);
    if (hits === null) return undefined;
    return { totalHits: Number(hits), resetTime: new Date(Date.now() + Math.max(ttl, 0)) };
  }

  async increment(key: string): Promise<IncrementResponse> {
    const [hits, ttl] = (await this.client().eval(INCREMENT, 1, this.key(key), this.windowMs)) as [number, number];
    return { totalHits: Number(hits), resetTime: new Date(Date.now() + Number(ttl)) };
  }

  async decrement(key: string): Promise<void> {
    await this.client().decr(this.key(key));
  }

  async resetKey(key: string): Promise<void> {
    await this.client().del(this.key(key));
  }
}
