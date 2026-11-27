import dotenv from 'dotenv';
import Joi from 'joi';
import { LANGUAGES, Language } from '../jobs/runtimes';

dotenv.config();

export type EngineMode = 'api' | 'worker' | 'hybrid';
export type ExecutorKind = 'docker' | 'local';
export type PullPolicy = 'if-not-present' | 'always' | 'never';

export interface Config {
  env: 'development' | 'production' | 'test';
  mode: EngineMode;
  server: {
    port: number;
    host: string;
    trustProxy: boolean | number | string;
    corsOrigins: string[];
    bodyLimit: string;
    rateLimit: { windowMs: number; max: number; submitMax: number; store: 'redis' | 'memory' };
  };
  metrics: { enabled: boolean; port: number; host: string };
  redis: {
    url?: string;
    host: string;
    port: number;
    username?: string;
    password?: string;
    db: number;
    tls: boolean;
    keyPrefix: string;
  };
  queue: {
    name: string;
    defaultRetries: number;
    maxRetries: number;
    backoffDelayMs: number;
    stalledIntervalMs: number;
    maxStalledCount: number;
  };
  workers: {
    concurrency: number;
    executor: ExecutorKind;
    allowUnsafeLocal: boolean;
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
    killGraceMs: number;
    heartbeatIntervalMs: number;
    shutdownTimeoutMs: number;
    allowedCommands: string[];
    tempDir: string;
  };
  docker: {
    socketPath: string;
    runtime?: string;
    memoryMB: number;
    cpus: number;
    pidsLimit: number;
    tmpfsSizeMB: number;
    networkEnabled: boolean;
    pullPolicy: PullPolicy;
    user: string;
    images: Record<Language, string>;
  };
  jobs: {
    ttlSeconds: number;
    maxScriptBytes: number;
    maxOutputBytes: number;
    maxListScan: number;
  };
  auth: {
    enabled: boolean;
    apiKeys: string[];
    adminApiKeys: string[];
  };
  quotas: {
    /** Max queued + running jobs per API key (0 = unlimited). Admins are exempt. */
    maxActiveJobs: number;
    /** Max submissions per API key per UTC day (0 = unlimited). */
    maxJobsPerDay: number;
  };
  batches: { maxJobs: number };
  artifacts: {
    maxBytes: number;
    maxFiles: number;
    store: 'redis' | 's3';
    s3: {
      bucket?: string;
      region: string;
      endpoint?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      forcePathStyle: boolean;
      prefix: string;
      createBucket: boolean;
    };
  };
  history: {
    /** Postgres connection string; history is disabled when unset. */
    databaseUrl?: string;
    ssl: boolean;
    retentionDays: number;
  };
  webhooks: {
    secret?: string;
    globalUrls: string[];
    allowHttp: boolean;
    allowPrivateNetworks: boolean;
    timeoutMs: number;
    maxAttempts: number;
  };
  logging: {
    level: string;
    format: 'json' | 'pretty';
    toFile: boolean;
    directory: string;
    maxFiles: string;
    maxSize: string;
  };
}

const list = (value: string | undefined, fallback: string[] = []): string[] =>
  value === undefined
    ? fallback
    : value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const int = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid numeric configuration value: "${value}"`);
  }
  return n;
};

const parseTrustProxy = (value: string | undefined): boolean | number | string => {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  const n = Number(value);
  return Number.isInteger(n) ? n : value;
};

const DEFAULT_IMAGES: Record<Language, string> = {
  bash: 'bash:5.2',
  sh: 'alpine:3.20',
  node: 'node:22-alpine',
  python: 'python:3.12-alpine',
  ruby: 'ruby:3.3-alpine',
  php: 'php:8.3-cli-alpine',
  go: 'golang:1.23-alpine',
  java: 'eclipse-temurin:21-jdk-alpine',
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = (env.NODE_ENV || 'development') as Config['env'];
  const isProd = nodeEnv === 'production';

  const images = { ...DEFAULT_IMAGES };
  for (const lang of LANGUAGES) {
    const override = env[`RUNTIME_IMAGE_${lang.toUpperCase()}`];
    if (override) images[lang] = override;
  }

  const cfg: Config = {
    env: nodeEnv,
    mode: (env.ENGINE_MODE || 'hybrid') as EngineMode,
    server: {
      port: int(env.PORT, 3000),
      host: env.HOST || '0.0.0.0',
      trustProxy: parseTrustProxy(env.TRUST_PROXY),
      corsOrigins: list(env.CORS_ORIGIN, []),
      bodyLimit: env.BODY_LIMIT || '1mb',
      rateLimit: {
        windowMs: int(env.RATE_LIMIT_WINDOW_MS, 60_000),
        max: int(env.RATE_LIMIT_MAX, 600),
        submitMax: int(env.SUBMIT_RATE_LIMIT_MAX, 60),
        store: (env.RATE_LIMIT_STORE || 'redis') as 'redis' | 'memory',
      },
    },
    metrics: {
      enabled: bool(env.METRICS_ENABLED, true),
      port: int(env.METRICS_PORT, 9100),
      host: env.METRICS_HOST || '0.0.0.0',
    },
    redis: {
      url: env.REDIS_URL || undefined,
      host: env.REDIS_HOST || '127.0.0.1',
      port: int(env.REDIS_PORT, 6379),
      username: env.REDIS_USERNAME || undefined,
      password: env.REDIS_PASSWORD || undefined,
      db: int(env.REDIS_DB, 0),
      tls: bool(env.REDIS_TLS, false),
      keyPrefix: env.REDIS_KEY_PREFIX || 'tf',
    },
    queue: {
      name: env.QUEUE_NAME || 'test-execution',
      defaultRetries: int(env.QUEUE_DEFAULT_RETRIES, 0),
      maxRetries: int(env.QUEUE_MAX_RETRIES, 5),
      backoffDelayMs: int(env.QUEUE_BACKOFF_DELAY, 2000),
      stalledIntervalMs: int(env.QUEUE_STALLED_INTERVAL, 30_000),
      maxStalledCount: int(env.QUEUE_MAX_STALLED_COUNT, 2),
    },
    workers: {
      concurrency: int(env.WORKER_CONCURRENCY ?? env.QUEUE_CONCURRENCY, 4),
      executor: (env.WORKER_EXECUTOR || 'docker') as ExecutorKind,
      allowUnsafeLocal: bool(env.WORKER_ALLOW_UNSAFE_LOCAL, false),
      defaultTimeoutMs: int(env.WORKER_TIMEOUT, 300_000),
      maxTimeoutMs: int(env.SECURITY_MAX_EXECUTION_TIME, 1_800_000),
      killGraceMs: int(env.WORKER_KILL_TIMEOUT, 5_000),
      heartbeatIntervalMs: int(env.WORKER_HEARTBEAT_INTERVAL, 10_000),
      shutdownTimeoutMs: int(env.SHUTDOWN_TIMEOUT, 25_000),
      allowedCommands: list(env.WORKER_ALLOWED_COMMANDS, [
        'node', 'npm', 'npx', 'python', 'python3', 'pip', 'bash', 'sh',
        'ruby', 'php', 'go', 'java', 'echo', 'true', 'false', 'sleep',
      ]),
      tempDir: env.WORKER_TEMP_DIR || './temp',
    },
    docker: {
      socketPath: env.DOCKER_SOCKET || '/var/run/docker.sock',
      runtime: env.DOCKER_RUNTIME || undefined,
      memoryMB: int(env.WORKER_MAX_MEMORY_MB, 512),
      cpus: int(env.WORKER_CPUS, 1),
      pidsLimit: int(env.WORKER_PIDS_LIMIT, 256),
      tmpfsSizeMB: int(env.WORKER_TMPFS_MB, 256),
      networkEnabled: bool(env.WORKER_NETWORK_ENABLED, false),
      pullPolicy: (env.DOCKER_PULL_POLICY || 'if-not-present') as PullPolicy,
      user: env.DOCKER_JOB_USER || '65534:65534',
      images,
    },
    jobs: {
      ttlSeconds: int(env.JOB_TTL_SECONDS, 7 * 24 * 3600),
      maxScriptBytes: int(env.SECURITY_MAX_SCRIPT_BYTES ?? env.SECURITY_MAX_SCRIPT_LENGTH, 100_000),
      maxOutputBytes: int(env.MAX_OUTPUT_BYTES, 1024 * 1024),
      maxListScan: int(env.JOB_LIST_MAX_SCAN, 2000),
    },
    auth: {
      enabled: bool(env.API_AUTH_ENABLED, true),
      apiKeys: list(env.API_KEYS),
      adminApiKeys: list(env.ADMIN_API_KEYS),
    },
    quotas: {
      maxActiveJobs: int(env.QUOTA_MAX_ACTIVE_JOBS, 100),
      maxJobsPerDay: int(env.QUOTA_MAX_JOBS_PER_DAY, 0),
    },
    batches: { maxJobs: int(env.BATCH_MAX_JOBS, 100) },
    artifacts: {
      maxBytes: int(env.ARTIFACT_MAX_BYTES, 10 * 1024 * 1024),
      maxFiles: int(env.ARTIFACT_MAX_FILES, 50),
      store: (env.ARTIFACT_STORE || 'redis') as 'redis' | 's3',
      s3: {
        bucket: env.S3_BUCKET || undefined,
        region: env.S3_REGION || 'us-east-1',
        endpoint: env.S3_ENDPOINT || undefined,
        accessKeyId: env.S3_ACCESS_KEY_ID || undefined,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY || undefined,
        forcePathStyle: bool(env.S3_FORCE_PATH_STYLE, !!env.S3_ENDPOINT),
        createBucket: bool(env.S3_CREATE_BUCKET, false),
        prefix: (env.S3_PREFIX ?? 'testforge').replace(/^\/+|\/+$/g, ''),
      },
    },
    history: {
      databaseUrl: env.HISTORY_DATABASE_URL || undefined,
      ssl: bool(env.HISTORY_DATABASE_SSL, false),
      retentionDays: int(env.HISTORY_RETENTION_DAYS, 365),
    },
    webhooks: {
      secret: env.WEBHOOK_SECRET || undefined,
      globalUrls: list(env.WEBHOOK_URLS),
      allowHttp: bool(env.WEBHOOK_ALLOW_HTTP, false),
      allowPrivateNetworks: bool(env.WEBHOOK_ALLOW_PRIVATE_NETWORKS, false),
      timeoutMs: int(env.WEBHOOK_TIMEOUT, 10_000),
      maxAttempts: int(env.WEBHOOK_MAX_ATTEMPTS, 8),
    },
    logging: {
      level: env.LOG_LEVEL || (nodeEnv === 'test' ? 'silent' : 'info'),
      format: (env.LOG_FORMAT || (isProd ? 'json' : 'pretty')) as 'json' | 'pretty',
      toFile: bool(env.LOG_TO_FILE, false),
      directory: env.LOG_DIRECTORY || './logs',
      maxFiles: env.LOG_MAX_FILES || '14d',
      maxSize: env.LOG_MAX_SIZE || '20m',
    },
  };

  validateConfig(cfg);
  return cfg;
}

const schema = Joi.object({
  env: Joi.string().valid('development', 'production', 'test'),
  mode: Joi.string().valid('api', 'worker', 'hybrid'),
  server: Joi.object({
    port: Joi.number().port(),
    rateLimit: Joi.object({
      store: Joi.string().valid('redis', 'memory'),
      windowMs: Joi.number().integer().min(1000),
      max: Joi.number().integer().min(1),
      submitMax: Joi.number().integer().min(1),
    }).unknown(),
  }).unknown(),
  metrics: Joi.object({ port: Joi.number().port() }).unknown(),
  redis: Joi.object({ port: Joi.number().port(), db: Joi.number().integer().min(0) }).unknown(),
  queue: Joi.object({
    defaultRetries: Joi.number().integer().min(0),
    maxRetries: Joi.number().integer().min(0).max(20),
  }).unknown(),
  workers: Joi.object({
    concurrency: Joi.number().integer().min(1).max(256),
    executor: Joi.string().valid('docker', 'local'),
    defaultTimeoutMs: Joi.number().integer().min(1000),
    maxTimeoutMs: Joi.number().integer().min(1000),
  }).unknown(),
  docker: Joi.object({
    memoryMB: Joi.number().integer().min(16),
    cpus: Joi.number().greater(0),
    pidsLimit: Joi.number().integer().min(8),
    pullPolicy: Joi.string().valid('if-not-present', 'always', 'never'),
  }).unknown(),
  jobs: Joi.object({
    ttlSeconds: Joi.number().integer().min(60),
    // Scripts travel to sandboxes as a single env var; Linux caps one at 128 KiB.
    maxScriptBytes: Joi.number().integer().min(1).max(120_000),
    maxOutputBytes: Joi.number().integer().min(1024),
  }).unknown(),
  logging: Joi.object({
    format: Joi.string().valid('json', 'pretty'),
  }).unknown(),
  quotas: Joi.object({
    maxActiveJobs: Joi.number().integer().min(0),
    maxJobsPerDay: Joi.number().integer().min(0),
  }),
  batches: Joi.object({ maxJobs: Joi.number().integer().min(1).max(1000) }),
  artifacts: Joi.object({
    maxBytes: Joi.number().integer().min(0).max(1024 * 1024 * 1024),
    maxFiles: Joi.number().integer().min(0).max(1000),
    store: Joi.string().valid('redis', 's3'),
  }).unknown(),
  history: Joi.object({
    databaseUrl: Joi.string().uri({ scheme: ['postgres', 'postgresql'] }),
    retentionDays: Joi.number().integer().min(1),
  }).unknown(),
  webhooks: Joi.object({
    timeoutMs: Joi.number().integer().min(1000),
    maxAttempts: Joi.number().integer().min(1).max(20),
  }).unknown(),
}).unknown();

export function validateConfig(cfg: Config): void {
  const { error } = schema.validate(cfg, { abortEarly: false });
  const problems = error ? error.details.map((d) => d.message) : [];

  if (cfg.queue.defaultRetries > cfg.queue.maxRetries) {
    problems.push('QUEUE_DEFAULT_RETRIES must not exceed QUEUE_MAX_RETRIES');
  }
  if (cfg.workers.defaultTimeoutMs > cfg.workers.maxTimeoutMs) {
    problems.push('WORKER_TIMEOUT must not exceed SECURITY_MAX_EXECUTION_TIME');
  }
  if (cfg.auth.enabled && cfg.auth.apiKeys.length + cfg.auth.adminApiKeys.length === 0) {
    problems.push(
      'API auth is enabled but no keys are configured: set API_KEYS / ADMIN_API_KEYS, or API_AUTH_ENABLED=false for local development'
    );
  }
  for (const key of [...cfg.auth.apiKeys, ...cfg.auth.adminApiKeys]) {
    if (key.length < 16) {
      problems.push('API keys must be at least 16 characters long');
      break;
    }
  }
  if (cfg.artifacts.store === 'redis' && cfg.artifacts.maxBytes > 100 * 1024 * 1024) {
    problems.push('ARTIFACT_MAX_BYTES above 100 MiB requires ARTIFACT_STORE=s3 (artifacts would live in Redis memory)');
  }
  if (cfg.artifacts.store === 's3' && !cfg.artifacts.s3.bucket) {
    problems.push('ARTIFACT_STORE=s3 requires S3_BUCKET');
  }
  if (cfg.workers.executor === 'local' && cfg.env === 'production' && !cfg.workers.allowUnsafeLocal) {
    problems.push(
      'WORKER_EXECUTOR=local runs untrusted code directly on the host and is refused in production. ' +
        'Use WORKER_EXECUTOR=docker, or set WORKER_ALLOW_UNSAFE_LOCAL=true if every job submitter is fully trusted'
    );
  }

  if (problems.length) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

let cached: Config | null = null;

function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper: replace the active configuration. */
export function setConfig(cfg: Config): void {
  cached = cfg;
}

// Lazily-evaluated proxy so a bad config surfaces as a clear startup error
// rather than an import-time crash, and tests can swap config with setConfig().
const config = new Proxy({} as Config, {
  get: (_t, prop: string) => (getConfig() as any)[prop],
}) as Config;

export default config;
