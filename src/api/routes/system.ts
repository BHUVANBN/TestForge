import { Router } from 'express';
import os from 'os';
import config from '../../config';
import { finalizeJob } from '../../jobs/lifecycle';
import { getHistory, HistoryStore } from '../../history';
import { getJobStore, JobStore } from '../../jobs/store';
import QueueManager from '../../queue/manager';
import { redisHealthy } from '../../queue/redis';
import { createLogger } from '../../utils/logger';
import { register } from '../../utils/metrics';
import { WorkerHeartbeat, WorkerStats } from '../../utils/types';
import { listWorkers } from '../../workers/manager';
import { requireAdmin } from '../middleware/auth';
import { asyncHandler } from '../util';
import { VERSION } from '../../version';
import { updateQueueGauges } from '../../metricsServer';

const log = createLogger('system');

export interface SystemDeps {
  queue?: () => QueueManager;
  store?: () => JobStore;
  redisHealthy?: () => Promise<boolean>;
  listWorkers?: () => Promise<WorkerHeartbeat[]>;
  history?: () => HistoryStore | null;
}

const resolve = (deps: SystemDeps) => ({
  queue: deps.queue ?? (() => QueueManager.getInstance()),
  store: deps.store ?? getJobStore,
  redisHealthy: deps.redisHealthy ?? redisHealthy,
  listWorkers: deps.listWorkers ?? (() => listWorkers()),
  history: deps.history ?? getHistory,
});

export function aggregateWorkers(workers: WorkerHeartbeat[]): WorkerStats {
  const finished = workers.reduce((n, w) => n + w.completed + w.failed, 0);
  const weighted = workers.reduce((n, w) => n + w.averageExecutionTime * (w.completed + w.failed), 0);
  const total = workers.reduce((n, w) => n + w.concurrency, 0);
  const active = workers.reduce((n, w) => n + w.active, 0);
  return {
    instances: workers.length,
    total,
    active,
    idle: Math.max(0, total - active),
    completed: workers.reduce((n, w) => n + w.completed, 0),
    failed: workers.reduce((n, w) => n + w.failed, 0),
    averageExecutionTime: finished ? Math.round(weighted / finished) : 0,
  };
}

/** Unauthenticated: liveness/readiness for load balancers and orchestrators. */
export function createHealthRouter(deps: SystemDeps = {}): Router {
  const d = resolve(deps);
  const router = Router();

  router.get(
    '/health',
    asyncHandler(async (_req, res) => {
      const [redis, workers] = await Promise.all([
        d.redisHealthy(),
        d.listWorkers().catch(() => [] as WorkerHeartbeat[]),
      ]);
      const queue = redis ? await d.queue().ping() : false;
      const history = d.history();
      const checks: Record<string, { healthy: boolean; message?: string }> = {
        redis: { healthy: redis },
        queue: { healthy: queue },
        workers: {
          healthy: workers.length > 0,
          message: workers.length ? `${workers.length} worker(s) online` : 'No workers online: jobs will wait in the queue',
        },
      };
      if (history) {
        const ok = await history.ping();
        checks.history = { healthy: ok, message: ok ? 'Postgres reachable' : 'Postgres unreachable: history writes are queued and retried' };
      }
      const ready = redis && queue;
      res.status(ready ? 200 : 503).json({
        success: ready,
        data: {
          status: !ready ? 'unhealthy' : workers.length ? 'healthy' : 'degraded',
          version: VERSION,
          timestamp: new Date().toISOString(),
          checks,
        },
      });
    })
  );

  return router;
}

/** Authenticated system endpoints; mutating/introspective ones need an admin key. */
export function createSystemRouter(deps: SystemDeps = {}): Router {
  const d = resolve(deps);
  const router = Router();

  router.get(
    '/queue/stats',
    asyncHandler(async (_req, res) => {
      const [queue, workers] = await Promise.all([d.queue().getStats(), d.listWorkers()]);
      res.json({ success: true, data: { queue, workers: aggregateWorkers(workers) } });
    })
  );

  router.get(
    '/workers',
    requireAdmin,
    asyncHandler(async (_req, res) => {
      res.json({ success: true, data: await d.listWorkers() });
    })
  );

  router.get(
    '/metrics',
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const [queue, workers] = await Promise.all([d.queue().getStats(), d.listWorkers()]);
      res.json({
        success: true,
        data: {
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
          queue,
          workers: aggregateWorkers(workers),
          memory: process.memoryUsage(),
          cpu: { loadAverage: os.loadavg() },
        },
      });
    })
  );

  router.get(
    '/metrics/prometheus',
    requireAdmin,
    asyncHandler(async (_req, res) => {
      await updateQueueGauges(d.queue()).catch(() => undefined);
      res.set('Content-Type', register.contentType).end(await register.metrics());
    })
  );

  router.get('/info', requireAdmin, (_req, res) => {
    res.json({
      success: true,
      data: {
        version: VERSION,
        nodeVersion: process.version,
        platform: os.platform(),
        arch: os.arch(),
        cpuCount: os.cpus().length,
        processUptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        config: {
          mode: config.mode,
          executor: config.workers.executor,
          concurrency: config.workers.concurrency,
          defaultTimeoutMs: config.workers.defaultTimeoutMs,
          maxTimeoutMs: config.workers.maxTimeoutMs,
          maxRetries: config.queue.maxRetries,
          maxScriptBytes: config.jobs.maxScriptBytes,
          maxOutputBytes: config.jobs.maxOutputBytes,
          networkEnabled: config.docker.networkEnabled,
        },
      },
    });
  });

  router.post(
    '/queue/pause',
    requireAdmin,
    asyncHandler(async (req, res) => {
      await d.queue().pause();
      log.info('Queue paused', { by: req.principal?.id });
      res.json({ success: true, message: 'Queue paused: workers finish running jobs but take no new ones' });
    })
  );

  router.post(
    '/queue/resume',
    requireAdmin,
    asyncHandler(async (req, res) => {
      await d.queue().resume();
      log.info('Queue resumed', { by: req.principal?.id });
      res.json({ success: true, message: 'Queue resumed' });
    })
  );

  router.delete(
    '/queue/clear',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const removed = await d.queue().removePending();
      const store = d.store();
      for (const id of removed) {
        await store.update(id, { cancelRequested: true });
        await finalizeJob(id, 'cancelled', { error: 'Removed by administrator' }, store);
      }
      log.warn('Queue cleared', { by: req.principal?.id, removed: removed.length });
      res.json({ success: true, data: { removed: removed.length }, message: `Removed ${removed.length} pending job(s)` });
    })
  );

  return router;
}
