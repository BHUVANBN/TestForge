import client from 'prom-client';

export const register = new client.Registry();
register.setDefaultLabels({ app: 'distributed-test-engine' });
client.collectDefaultMetrics({ register });

// --- Jobs (API side) ---
export const jobSubmittedCounter = new client.Counter({
  name: 'forge_jobs_submitted_total',
  help: 'Total test jobs accepted by the API',
  registers: [register],
});

// --- Jobs (worker side) ---
export const jobCompletedCounter = new client.Counter({
  name: 'forge_jobs_completed_total',
  help: 'Total job attempts finished, by outcome',
  labelNames: ['status'],
  registers: [register],
});

export const jobDurationHistogram = new client.Histogram({
  name: 'forge_job_duration_ms',
  help: 'Job attempt execution duration in milliseconds',
  buckets: [500, 1000, 2500, 5000, 10000, 30000, 60000, 120000, 300000, 900000],
  labelNames: ['status'],
  registers: [register],
});

export const workersActiveGauge = new client.Gauge({
  name: 'forge_workers_active',
  help: 'Job slots currently executing in this worker process',
  registers: [register],
});

export const workersIdleGauge = new client.Gauge({
  name: 'forge_workers_idle',
  help: 'Idle job slots in this worker process',
  registers: [register],
});

// --- Queue (sampled by API processes on scrape) ---
export const queueWaitingGauge = new client.Gauge({
  name: 'forge_queue_waiting',
  help: 'Jobs waiting in the queue',
  registers: [register],
});

export const queueActiveGauge = new client.Gauge({
  name: 'forge_queue_active',
  help: 'Jobs currently being processed',
  registers: [register],
});

export const queueFailedGauge = new client.Gauge({
  name: 'forge_queue_failed',
  help: 'Failed jobs retained in the queue',
  registers: [register],
});

// --- HTTP ---
export const httpRequestDuration = new client.Histogram({
  name: 'forge_http_request_duration_seconds',
  help: 'API request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});
