import { createHash, timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import config from '../../config';
import { createLogger } from '../../utils/logger';
import { Principal } from '../../utils/types';

declare module 'express-serve-static-core' {
  interface Request {
    principal?: Principal;
  }
}

const log = createLogger('auth');

/** Used when auth is disabled (local development only). */
export const ANONYMOUS: Principal = Object.freeze({ id: 'anonymous', admin: true });

const digest = (key: string): Buffer => createHash('sha256').update(key).digest();

interface KeyEntry {
  digest: Buffer;
  principal: Principal;
}

let table: { source: string; entries: KeyEntry[] } | null = null;

function keyTable(): KeyEntry[] {
  const source = JSON.stringify([config.auth.apiKeys, config.auth.adminApiKeys]);
  if (table?.source !== source) {
    const make = (key: string, admin: boolean): KeyEntry => {
      const d = digest(key);
      // Stable, non-reversible identity for job ownership. Never log raw keys.
      return { digest: d, principal: { id: `key_${d.toString('hex').slice(0, 16)}`, admin } };
    };
    table = {
      source,
      entries: [
        ...config.auth.adminApiKeys.map((k) => make(k, true)),
        ...config.auth.apiKeys.map((k) => make(k, false)),
      ],
    };
  }
  return table.entries;
}

/** Resolve an API key to a principal using constant-time comparison. */
export function principalForKey(key: string | undefined | null): Principal | null {
  if (!config.auth.enabled) return ANONYMOUS;
  if (!key) return null;
  const d = digest(key);
  let match: Principal | null = null;
  for (const entry of keyTable()) {
    // Compare against every entry so timing doesn't reveal which matched.
    if (timingSafeEqual(entry.digest, d) && !match) match = entry.principal;
  }
  return match;
}

export function extractKey(req: Request): string | undefined {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header) return header;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return undefined;
}

/**
 * API key authentication. Keys are accepted only in headers (`X-API-Key` or
 * `Authorization: Bearer`) so they never end up in URLs, proxies or logs.
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.auth.enabled) {
    req.principal = ANONYMOUS;
    return next();
  }
  const key = extractKey(req);
  if (!key) {
    res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'An API key is required in the X-API-Key header (or Authorization: Bearer <key>).',
    });
    return;
  }
  const principal = principalForKey(key);
  if (!principal) {
    log.warn('Rejected invalid API key', { path: req.path, ip: req.ip });
    res.status(403).json({ success: false, error: 'Forbidden', message: 'The provided API key is not valid.' });
    return;
  }
  req.principal = principal;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.principal?.admin) {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'This endpoint requires an admin API key.' });
    return;
  }
  next();
}
