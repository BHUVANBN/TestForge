import { Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { createHmac, randomUUID } from 'crypto';
import dns from 'dns';
import http from 'http';
import https from 'https';
import type Redis from 'ioredis';
import net from 'net';
import config from '../config';
import { createRedis } from '../queue/redis';
import { createLogger } from '../utils/logger';

const log = createLogger('webhooks');

export type WebhookEvent = 'job.finished' | 'batch.finished';

export interface WebhookDelivery {
  id: string;
  url: string;
  event: WebhookEvent;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------- SSRF guard

const blocked = new net.BlockList();
for (const [net4, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net4, prefix, 'ipv4');
}
for (const [net6, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  blocked.addSubnet(net6, prefix, 'ipv6');
}

/** True for loopback, private, link-local (incl. cloud metadata), CGNAT, multicast and reserved ranges. */
export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true;
}

/** Validate a user-supplied webhook URL. Returns problems (empty = OK). */
export function validateWebhookUrl(raw: string): string[] {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return ['"webhookUrl" must be an absolute URL'];
  }
  const problems: string[] = [];
  if (raw.length > 2048) problems.push('"webhookUrl" is too long');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && config.webhooks.allowHttp)) {
    problems.push(`"webhookUrl" must use https${config.webhooks.allowHttp ? ' or http' : ''}`);
  }
  if (url.username || url.password) problems.push('"webhookUrl" must not contain credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!config.webhooks.allowPrivateNetworks) {
    if (net.isIP(host) && isPrivateAddress(host)) problems.push('"webhookUrl" points to a private network address');
    if (/^(localhost|.*\.localhost|.*\.internal|.*\.local)$/i.test(host)) {
      problems.push('"webhookUrl" points to an internal host name');
    }
  }
  return problems;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void;

/** DNS lookup that refuses private addresses at connect time (defeats DNS rebinding). */
function guardedLookup(hostname: string, options: any, callback: LookupCallback): void {
  const opts = typeof options === 'object' && options ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses: dns.LookupAddress[]) => {
    if (err) return callback(err);
    const allowed = config.webhooks.allowPrivateNetworks ? addresses : addresses.filter((a) => !isPrivateAddress(a.address));
    if (allowed.length === 0) {
      return callback(Object.assign(new Error(`Refusing to deliver webhook to private address for ${hostname}`), { code: 'EPRIVATE' }));
    }
    if (opts.all) return callback(null, allowed);
    callback(null, allowed[0].address, allowed[0].family);
  });
}

// ---------------------------------------------------------------- signing + delivery

export function signPayload(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

class PermanentError extends Error {}

export async function deliver(d: WebhookDelivery): Promise<number> {
  const problems = validateWebhookUrl(d.url);
  if (problems.length && !config.webhooks.globalUrls.includes(d.url)) throw new PermanentError(problems.join('; '));

  const url = new URL(d.url);
  const body = JSON.stringify({ id: d.id, event: d.event, createdAt: new Date().toISOString(), ...d.payload });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
    'User-Agent': 'TestForge-Webhook/1',
    'X-TestForge-Event': d.event,
    'X-TestForge-Delivery': d.id,
    'X-TestForge-Timestamp': timestamp,
  };
  if (config.webhooks.secret) headers['X-TestForge-Signature'] = signPayload(config.webhooks.secret, timestamp, body);

  // Admin-configured global URLs are trusted to reach internal services.
  const trusted = config.webhooks.globalUrls.includes(d.url) || config.webhooks.allowPrivateNetworks;
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise<number>((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: 'POST',
        headers,
        timeout: config.webhooks.timeoutMs,
        lookup: trusted ? undefined : (guardedLookup as any),
      },
      (res) => {
        res.resume(); // discard body
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) resolve(status);
        else if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
          reject(new PermanentError(`Webhook endpoint answered ${status}`));
        } else reject(new Error(`Webhook endpoint answered ${status}`));
      }
    );
    req.on('timeout', () => req.destroy(new Error('Webhook request timed out')));
    req.on('error', (err: NodeJS.ErrnoException) =>
      reject(err.code === 'EPRIVATE' ? new PermanentError(err.message) : err)
    );
    req.end(body);
  });
}

// ---------------------------------------------------------------- queue

const queueName = () => `${config.queue.name}-webhooks`;
let queue: Queue<WebhookDelivery> | null = null;

function getQueue(): Queue<WebhookDelivery> {
  queue ??= new Queue<WebhookDelivery>(queueName(), {
    connection: createRedis('webhook-queue'),
    defaultJobOptions: {
      attempts: config.webhooks.maxAttempts,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
    },
  });
  return queue;
}

export type Enqueue = (url: string, event: WebhookEvent, payload: Record<string, unknown>) => Promise<void>;

let enqueueOverride: Enqueue | null = null;
/** Test hook. */
export const setWebhookEnqueue = (fn: Enqueue | null): void => {
  enqueueOverride = fn;
};

/** Queue a delivery to `url` plus every admin-configured global URL. */
export async function enqueueWebhooks(
  url: string | undefined,
  event: WebhookEvent,
  payload: Record<string, unknown>
): Promise<void> {
  const targets = [...new Set([...(url ? [url] : []), ...config.webhooks.globalUrls])];
  await Promise.all(
    targets.map(async (target) => {
      try {
        if (enqueueOverride) return await enqueueOverride(target, event, payload);
        const id = randomUUID();
        await getQueue().add(event, { id, url: target, event, payload }, { jobId: id });
      } catch (err) {
        log.error('Failed to queue webhook', { event, error: err instanceof Error ? err.message : String(err) });
      }
    })
  );
}

export function startWebhookWorker(connect: (name: string) => Redis = createRedis): Worker<WebhookDelivery> {
  const worker = new Worker<WebhookDelivery>(
    queueName(),
    async (job: Job<WebhookDelivery>) => {
      try {
        const status = await deliver(job.data);
        log.info('Webhook delivered', { event: job.data.event, host: new URL(job.data.url).host, status });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('Webhook delivery failed', {
          event: job.data.event,
          host: safeHost(job.data.url),
          attempt: job.attemptsMade,
          error: message,
        });
        throw err instanceof PermanentError ? new UnrecoverableError(message) : err;
      }
    },
    { connection: connect('webhook-worker'), concurrency: 10 }
  );
  worker.on('error', (err) => log.error('Webhook worker error', { error: err.message }));
  return worker;
}

const safeHost = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
};

export async function closeWebhookQueue(): Promise<void> {
  await queue?.close();
  queue = null;
}
