import client from 'prom-client';
import { logger } from './logger';

// Central registry
export const register = new client.Registry();
register.setDefaultLabels({ app: 'distributed-test-engine' });
client.collectDefaultMetrics({ register });

// --- Job Counters ---
export const jobSubmittedCounter = new client.Counter({
  name: 'forge_jobs_submitted_total',
  help: 'Total test jobs submitted',
  registers: [register],
});

export const jobCompletedCounter = new client.Counter({
  name: 'forge_jobs_completed_total',
  help: 'Total test jobs completed by status',
  labelNames: ['status'],
  registers: [register],
});

// --- Job Duration ---
export const jobDurationHistogram = new client.Histogram({
  name: 'forge_job_duration_ms',
  help: 'Test job execution duration in milliseconds',
  buckets: [500, 1000, 2500, 5000, 10000, 30000, 60000, 120000, 300000],
  labelNames: ['status'],
  registers: [register],
});

// --- Worker Gauges ---
export const workersActiveGauge = new client.Gauge({
  name: 'forge_workers_active',
  help: 'Number of currently active workers',
  registers: [register],
});

export const workersIdleGauge = new client.Gauge({
  name: 'forge_workers_idle',
  help: 'Number of idle workers',
  registers: [register],
});

// --- Queue Gauges ---
export const queueWaitingGauge = new client.Gauge({
  name: 'forge_queue_waiting',
  help: 'Number of jobs waiting in queue',
  registers: [register],
});

export const queueActiveGauge = new client.Gauge({
  name: 'forge_queue_active',
  help: 'Number of jobs currently being processed',
  registers: [register],
});

export const queueFailedGauge = new client.Gauge({
  name: 'forge_queue_failed',
  help: 'Number of failed jobs in queue',
  registers: [register],
});

export const initMetrics = () => {
  logger.info('Prometheus metrics initialized');
};
