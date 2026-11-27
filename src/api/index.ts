import compression from 'compression';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { createServer, Server as HttpServer } from 'http';
import path from 'path';
import { Server as SocketIOServer } from 'socket.io';
import config from '../config';
import { JobError, JobService } from '../jobs/service';
import { createLogger } from '../utils/logger';
import { httpRequestDuration } from '../utils/metrics';
import { VERSION } from '../version';
import { apiKeyAuth } from './middleware/auth';
import { attachRealtime } from './realtime';
import { createJobsRouter } from './routes/jobs';
import { createHealthRouter, createSystemRouter, SystemDeps } from './routes/system';

const log = createLogger('api');

export interface AppOptions {
  jobs?: JobService;
  system?: SystemDeps;
}

const clientKey = (req: Request): string => req.principal?.id ?? req.ip ?? 'unknown';

export function createApp(opts: AppOptions = {}): express.Application {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.server.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    })
  );
  app.use(compression());

  // Request logging + metrics. Logs the path only: never query strings or bodies.
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      httpRequestDuration.observe({ method: req.method, route, status: String(res.statusCode) }, seconds);
      if (req.path.startsWith('/api')) {
        log.http('request', {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Math.round(seconds * 1000),
          principal: req.principal?.id,
        });
      }
    });
    next();
  });

  app.use(express.static(path.join(__dirname, '..', '..', 'public'), { maxAge: '1h', index: false }));
  app.get('/', (_req, res) => res.redirect('/dashboard.html'));
  app.get('/favicon.ico', (_req, res) => res.redirect(301, '/favicon.svg'));

  app.get('/api', (_req, res) => {
    res.json({
      success: true,
      message: 'TestForge distributed test execution engine',
      version: VERSION,
      dashboard: '/dashboard.html',
    });
  });

  const api = express.Router();
  api.use(cors({ origin: config.server.corsOrigins.length ? config.server.corsOrigins : false }));
  api.use(createHealthRouter(opts.system));
  api.use(express.json({ limit: config.server.bodyLimit }));
  api.use(apiKeyAuth);
  api.use(
    rateLimit({
      windowMs: config.server.rateLimit.windowMs,
      limit: config.server.rateLimit.max,
      keyGenerator: clientKey,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { success: false, error: 'Too many requests', message: 'Rate limit exceeded' },
    })
  );
  const submitLimiter = rateLimit({
    windowMs: config.server.rateLimit.windowMs,
    limit: config.server.rateLimit.submitMax,
    keyGenerator: clientKey,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, error: 'Too many submissions', message: 'Job submission rate limit exceeded' },
  });
  api.use(createJobsRouter({ service: opts.jobs, submitLimiter }));
  api.use(createSystemRouter(opts.system));
  app.use('/api/v1', api);

  app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Not Found', message: `Route ${req.method} ${req.path} not found` });
  });

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof JobError) {
      res.status(err.status).json({ success: false, error: err.message, details: err.details });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ success: false, error: 'Invalid JSON body' });
      return;
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ success: false, error: 'Request body too large' });
      return;
    }
    log.error('Unhandled request error', { method: req.method, path: req.path, error: err?.message, stack: err?.stack });
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  });

  return app;
}

export class APIServer {
  readonly app: express.Application;
  readonly server: HttpServer;
  readonly io: SocketIOServer;
  private closeRealtime: (() => Promise<void>) | null = null;

  constructor(opts: AppOptions = {}) {
    this.app = createApp(opts);
    this.server = createServer(this.app);
    this.server.headersTimeout = 65_000;
    this.server.keepAliveTimeout = 61_000;
    this.io = new SocketIOServer(this.server, {
      cors: { origin: config.server.corsOrigins.length ? config.server.corsOrigins : false },
      maxHttpBufferSize: 64 * 1024,
    });
  }

  async start(): Promise<void> {
    this.closeRealtime = attachRealtime(this.io);
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(config.server.port, config.server.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    log.info(`API listening on http://${config.server.host}:${config.server.port}`, {
      auth: config.auth.enabled ? 'enabled' : 'DISABLED',
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.io.close(() => resolve());
      // io.close() also closes the HTTP server; make sure idle keep-alives go too.
      this.server.closeIdleConnections?.();
    });
    await this.closeRealtime?.();
    log.info('API server closed');
  }
}

export default APIServer;
