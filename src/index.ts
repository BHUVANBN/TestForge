import type { Server } from 'http';
import config, { loadConfig, setConfig } from './config';
import { createLogger } from './utils/logger';

async function main(): Promise<void> {
  // Validate configuration first so misconfiguration fails fast with a clear message.
  try {
    setConfig(loadConfig());
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(78); // EX_CONFIG
  }

  const log = createLogger('main');
  const { waitForRedis, closeAllRedis, redisHealthy } = await import('./queue/redis');
  const { startMetricsServer } = await import('./metricsServer');

  const mode = config.mode;
  const runApi = mode === 'api' || mode === 'hybrid';
  const runWorker = mode === 'worker' || mode === 'hybrid';
  log.info('Starting TestForge', { mode, executor: runWorker ? config.workers.executor : undefined });

  await waitForRedis();

  let api: import('./api').APIServer | null = null;
  let worker: import('./workers/manager').WorkerManager | null = null;
  let metrics: Server | null = null;

  if (runWorker) {
    if (config.workers.executor === 'docker') {
      const { dockerAvailable } = await import('./workers/dockerExecutor');
      if (!(await dockerAvailable())) {
        throw new Error(
          `Docker is not reachable at ${config.docker.socketPath}. Mount the Docker socket into the worker, ` +
            'or set WORKER_EXECUTOR=local for local development.'
        );
      }
    }
    const { WorkerManager } = await import('./workers/manager');
    worker = new WorkerManager();
    await worker.start();
  }

  if (runApi) {
    const { APIServer } = await import('./api');
    api = new APIServer();
    await api.start();
  }

  if (config.metrics.enabled) {
    metrics = startMetricsServer({
      sampleQueue: runApi,
      health: async () => (await redisHealthy()) && (!worker || worker.isRunning()),
    });
  }

  let shuttingDown = false;
  const shutdown = async (reason: string, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down', { reason });
    const hardDeadline = setTimeout(() => {
      log.error('Shutdown did not finish in time; forcing exit');
      process.exit(1);
    }, config.workers.shutdownTimeoutMs + 15_000);
    hardDeadline.unref();
    try {
      await api?.close();
      await worker?.close();
      await new Promise<void>((r) => (metrics ? metrics.close(() => r()) : r()));
      const QueueManager = (await import('./queue/manager')).default;
      await QueueManager.getInstance().close().catch(() => undefined);
      await closeAllRedis();
      log.info('Shutdown complete');
    } catch (err) {
      log.error('Error during shutdown', { error: err instanceof Error ? err.message : String(err) });
      code = code || 1;
    }
    process.exit(code);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', { error: err.message, stack: err.stack });
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection', { reason: reason instanceof Error ? reason.stack : String(reason) });
  });

  log.info(`TestForge started in ${mode} mode`);
}

main().catch((err) => {
  console.error('Failed to start TestForge:', err instanceof Error ? err.message : err);
  process.exit(1);
});
