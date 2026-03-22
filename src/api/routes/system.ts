import { Router, Request, Response } from 'express';
import os from 'os';
import QueueManager from '../../queue/manager';
import WorkerManager from '../../workers/manager';
import RedisConnection from '../../queue/redis';
import { logger } from '../../utils/logger';
import { register, queueWaitingGauge, queueActiveGauge, queueFailedGauge } from '../../utils/metrics';
import { SystemMetrics, HealthStatus } from '../../utils/types';
import config from '../../config';

const router = Router();
const queueManager = QueueManager.getInstance();
const workerManager = WorkerManager.getInstance();
const redisConnection = RedisConnection.getInstance();

/**
 * GET /health
 * Health check endpoint
 */
  router.get('/health', async (req: Request, res: Response) => {
  try {
    const redisHealthy = await redisConnection.healthCheck();
    const queueInstance = queueManager.getQueueInstance();
    const queueHealthy = await queueInstance.isPaused().then(() => true).catch(() => false);
    const workerInstance = workerManager.getWorkerInstance();
    const workerHealthy = workerInstance.isRunning();

    const checks = {
      redis: redisHealthy,
      queue: queueHealthy,
      workers: workerHealthy
    };

    const allHealthy = Object.values(checks).every(check => check);
    const status = allHealthy ? 'healthy' : 'degraded';

    const healthStatus: HealthStatus = {
      status,
      timestamp: new Date(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || require('../../../package.json').version || '1.0.0',
      checks,
      metrics: await getSystemMetrics()
    };

    return res.status(allHealthy ? 200 : 503).json({
      success: true,
      data: healthStatus
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Health check failed', { error: err.message });
    return res.status(503).json({
      success: false,
      error: 'Health check failed',
      status: 'unhealthy'
    });
  }
});

/**
 * GET /metrics
 * Get system metrics
 */
router.get('/metrics', async (req: Request, res: Response) => {
  try {
    const metrics = await getSystemMetrics();
    
    return res.json({
      success: true,
      data: metrics
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to get metrics', { error: err.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to get metrics'
    });
  }
});

/**
 * GET /queue/stats
 * Get queue statistics
 */
router.get('/queue/stats', async (req: Request, res: Response) => {
  try {
    const queueStats = await queueManager.getQueueStats();
    const workerStats = workerManager.getStats();
    
    return res.json({
      success: true,
      data: {
        queue: queueStats,
        workers: workerStats
      }
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to get queue stats', { error: err.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to get queue stats'
    });
  }
});

/**
 * POST /queue/pause
 * Pause the queue
 */
router.post('/queue/pause', async (req: Request, res: Response) => {
  try {
    await queueManager.pauseQueue();
    await workerManager.pause();
    
    logger.info('Queue paused via API');
    
    return res.json({
      success: true,
      message: 'Queue paused successfully'
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to pause queue', { error: err.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to pause queue'
    });
  }
});

/**
 * POST /queue/resume
 * Resume the queue
 */
router.post('/queue/resume', async (req: Request, res: Response) => {
  try {
    await queueManager.resumeQueue();
    await workerManager.resume();
    
    logger.info('Queue resumed via API');
    
    return res.json({
      success: true,
      message: 'Queue resumed successfully'
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to resume queue', { error: err.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to resume queue'
    });
  }
});

/**
 * DELETE /queue/clear
 * Clear the queue
 */
router.delete('/queue/clear', async (req: Request, res: Response) => {
  try {
    await queueManager.clearQueue();
    
    logger.info('Queue cleared via API');
    
    return res.json({
      success: true,
      message: 'Queue cleared successfully'
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to clear queue', { error: err.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to clear queue'
    });
  }
});

/**
 * GET /system/info
 * Get system information
 */
router.get('/info', async (req: Request, res: Response) => {
  try {
    const systemInfo = {
      nodeVersion: process.version,
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      cpuCount: os.cpus().length,
      loadAverage: os.loadavg(),
      uptime: os.uptime(),
      processUptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      pid: process.pid,
      config: {
        workers: {
          poolSize: config.workers.poolSize,
          timeout: config.workers.timeout
        },
        queue: {
          concurrency: config.queue.concurrency,
          attempts: config.queue.defaultJobOptions.attempts
        }
      }
    };
    
    return res.json({
      success: true,
      data: systemInfo
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to get system info', { error: err.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to get system info'
    });
  }
});

/**
 * Helper function to get system metrics
 */
async function getSystemMetrics(): Promise<SystemMetrics> {
  const queueStats = await queueManager.getQueueStats();
  const workerStats = workerManager.getStats();
  
  return {
    uptime: process.uptime(),
    timestamp: new Date(),
    jobs: {
      pending: queueStats.waiting,
      running: queueStats.active,
      completed: queueStats.completed,
      failed: queueStats.failed
    },
    workers: workerStats,
    memory: process.memoryUsage(),
    cpu: {
      usage: process.cpuUsage().user / 1000000, // Convert to seconds
      loadAverage: os.loadavg()
    }
  };
}

/**
 * GET /metrics/prometheus
 * Prometheus-compatible metrics endpoint
 */
router.get('/metrics/prometheus', async (req: Request, res: Response) => {
  try {
    // Update queue gauges before scraping
    const queueStats = await queueManager.getQueueStats();
    queueWaitingGauge.set(queueStats.waiting);
    queueActiveGauge.set(queueStats.active);
    queueFailedGauge.set(queueStats.failed);

    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).end('Error generating metrics');
  }
});

export default router;
