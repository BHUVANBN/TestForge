import { Request, Response, NextFunction } from 'express';
import config from '../../config';
import { logger } from '../../utils/logger';

/**
 * API Key authentication middleware.
 * When API_AUTH_ENABLED=true, every request must carry one of the configured
 * API keys in the `X-API-Key` header or the `api_key` query parameter.
 * The health endpoint is always exempted so monitoring tools work without keys.
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  // Auth disabled — skip
  if (!config.auth.enabled || config.auth.apiKeys.length === 0) {
    return next();
  }

  // Health check is always public
  if (req.path === '/health') {
    return next();
  }

  const key = (req.headers['x-api-key'] as string) || (req.query['api_key'] as string);

  if (!key) {
    logger.warn('API request rejected: missing API key', { path: req.path, ip: req.ip });
    res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'An API key is required. Provide it via the X-API-Key header or api_key query parameter.'
    });
    return;
  }

  if (!config.auth.apiKeys.includes(key)) {
    logger.warn('API request rejected: invalid API key', { path: req.path, ip: req.ip });
    res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'The provided API key is not valid.'
    });
    return;
  }

  next();
}
