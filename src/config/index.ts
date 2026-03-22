import dotenv from 'dotenv';

dotenv.config();

export interface Config {
  server: {
    port: number;
    host: string;
    cors: {
      origin: string[];
      credentials: boolean;
    };
    rateLimit: {
      windowMs: number;
      max: number;
    };
  };
  redis: {
    host: string;
    port: number;
    password?: string;
    db: number;
    maxRetriesPerRequest: number | null;
    retryDelayOnFailover: number;
  };
  queue: {
    defaultJobOptions: {
      removeOnComplete: number;
      removeOnFail: number;
      attempts: number;
      backoff: {
        type: string;
        delay: number;
      };
    };
    concurrency: number;
    maxStalledCount: number;
    stalledInterval: number;
  };
  workers: {
    poolSize: number;
    timeout: number;
    killTimeout: number;
    maxMemoryMB: number;
    sandbox: boolean;
    allowedCommands: string[];
  };
  auth: {
    enabled: boolean;
    apiKeys: string[];
  };
  logging: {
    level: string;
    maxFiles: string;
    maxSize: string;
    datePattern: string;
    directory: string;
  };
  security: {
    maxScriptLength: number;
    maxExecutionTime: number;
    allowedFileExtensions: string[];
    blockedPatterns: string[];
  };
}

const config: Config = {
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    cors: {
      origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
      credentials: true,
    },
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes
      max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    },
  },
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0', 10),
    maxRetriesPerRequest: process.env.REDIS_MAX_RETRIES ? parseInt(process.env.REDIS_MAX_RETRIES, 10) : null,
    retryDelayOnFailover: parseInt(process.env.REDIS_RETRY_DELAY || '100', 10),
  },
  queue: {
    defaultJobOptions: {
      removeOnComplete: parseInt(process.env.QUEUE_REMOVE_ON_COMPLETE || '100', 10),
      removeOnFail: parseInt(process.env.QUEUE_REMOVE_ON_FAIL || '50', 10),
      attempts: parseInt(process.env.QUEUE_ATTEMPTS || '3', 10),
      backoff: {
        type: process.env.QUEUE_BACKOFF_TYPE || 'exponential',
        delay: parseInt(process.env.QUEUE_BACKOFF_DELAY || '2000', 10),
      },
    },
    concurrency: parseInt(process.env.QUEUE_CONCURRENCY || '5', 10),
    maxStalledCount: parseInt(process.env.QUEUE_MAX_STALLED_COUNT || '1', 10),
    stalledInterval: parseInt(process.env.QUEUE_STALLED_INTERVAL || '30000', 10),
  },
  workers: {
    poolSize: parseInt(process.env.WORKER_POOL_SIZE || '10', 10),
    timeout: parseInt(process.env.WORKER_TIMEOUT || '300000', 10), // 5 minutes
    killTimeout: parseInt(process.env.WORKER_KILL_TIMEOUT || '10000', 10), // 10 seconds
    maxMemoryMB: parseInt(process.env.WORKER_MAX_MEMORY_MB || '512', 10),
    sandbox: process.env.WORKER_SANDBOX === 'true',
    allowedCommands: process.env.WORKER_ALLOWED_COMMANDS?.split(',') || [
      'node', 'npm', 'python', 'python3', 'java', 'go', 'ruby', 'php', 'bash', 'sh'
    ],
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    maxFiles: process.env.LOG_MAX_FILES || '14d',
    maxSize: process.env.LOG_MAX_SIZE || '20m',
    datePattern: process.env.LOG_DATE_PATTERN || 'YYYY-MM-DD',
    directory: process.env.LOG_DIRECTORY || './logs',
  },
  security: {
    maxScriptLength: parseInt(process.env.SECURITY_MAX_SCRIPT_LENGTH || '100000', 10),
    maxExecutionTime: parseInt(process.env.SECURITY_MAX_EXECUTION_TIME || '600000', 10), // 10 minutes
    allowedFileExtensions: process.env.SECURITY_ALLOWED_EXTENSIONS?.split(',') || [
      '.js', '.ts', '.py', '.java', '.go', '.rb', '.php', '.sh'
    ],
    blockedPatterns: process.env.SECURITY_BLOCKED_PATTERNS?.split(',') || [
      'rm -rf', 'sudo', 'chmod 777', 'eval(', 'exec(', 'system(',
      'child_process', 'spawn', 'fork', '> /dev/', '2>&1'
    ],
  },
  auth: {
    enabled: process.env.API_AUTH_ENABLED === 'true',
    apiKeys: process.env.API_KEYS ? process.env.API_KEYS.split(',').map(k => k.trim()) : [],
  },
};

// Validate critical configuration
const requiredEnv = ['REDIS_HOST'];
for (const env of requiredEnv) {
  if (!process.env[env] && process.env.NODE_ENV === 'production') {
    console.warn(`[CONFIG WARNING] ${env} is not set in production. Using default: ${config.redis.host}`);
  }
}

export default config;
