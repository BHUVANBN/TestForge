import http from 'http';
import config from './config';
import QueueManager from './queue/manager';
import { createLogger } from './utils/logger';
import { queueActiveGauge, queueFailedGauge, queueWaitingGauge, register } from './utils/metrics';

const log = createLogger('metrics');

export async function updateQueueGauges(queue: QueueManager): Promise<void> {
  const stats = await queue.getStats();
  queueWaitingGauge.set(stats.waiting);
  queueActiveGauge.set(stats.active);
  queueFailedGauge.set(stats.failed);
}

/**
 * Internal-only HTTP listener for Prometheus scrapes and container health
 * checks. Keep METRICS_PORT off the public network.
 */
export function startMetricsServer(opts: {
  sampleQueue: boolean;
  health: () => Promise<boolean>;
}): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/metrics') {
        if (opts.sampleQueue) await updateQueueGauges(QueueManager.getInstance()).catch(() => undefined);
        res.writeHead(200, { 'Content-Type': register.contentType });
        res.end(await register.metrics());
      } else if (req.url === '/health') {
        const ok = await opts.health();
        res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: ok ? 'ok' : 'unhealthy' }));
      } else {
        res.writeHead(404).end();
      }
    } catch (err) {
      log.error('Metrics endpoint failed', { error: err instanceof Error ? err.message : String(err) });
      res.writeHead(500).end();
    }
  });
  server.listen(config.metrics.port, config.metrics.host, () =>
    log.info(`Metrics listening on ${config.metrics.host}:${config.metrics.port}`)
  );
  return server;
}
