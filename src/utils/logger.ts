import path from 'path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import config from '../config';

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const prettyFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf((info) => {
    const { timestamp, level, message, component, jobId, stack, ...rest } = info as Record<string, unknown>;
    const prefix = [component && `[${component}]`, jobId && `job=${jobId}`].filter(Boolean).join(' ');
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    return `${timestamp} ${level}${prefix ? ' ' + prefix : ''} ${message}${extra}${stack ? `\n${stack}` : ''}`;
  })
);

function buildLogger(): winston.Logger {
  const silent = config.logging.level === 'silent';
  const level = silent ? 'error' : config.logging.level;

  // Containers should log to stdout; the platform handles collection/rotation.
  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: config.logging.format === 'json' ? jsonFormat : prettyFormat,
    }),
  ];

  if (config.logging.toFile) {
    transports.push(
      new DailyRotateFile({
        filename: path.join(config.logging.directory, 'application-%DATE%.log'),
        maxSize: config.logging.maxSize,
        maxFiles: config.logging.maxFiles,
        format: jsonFormat,
      })
    );
  }

  return winston.createLogger({ level, silent, defaultMeta: { component: 'main' }, transports });
}

let root: winston.Logger | null = null;

function getRoot(): winston.Logger {
  if (!root) root = buildLogger();
  return root;
}

/**
 * Lazily created so importing a module never forces config to load
 * (config errors are reported cleanly at startup instead).
 */
export const logger: winston.Logger = new Proxy({} as winston.Logger, {
  get: (_t, prop: string) => {
    const target = getRoot() as any;
    const value = target[prop];
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

export const createLogger = (component: string): winston.Logger => getRoot().child({ component });

/** Child logger tagged with the job id. Children share the root transports: no per-job file handles. */
export const createJobLogger = (jobId: string): winston.Logger => getRoot().child({ component: 'worker', jobId });

export default createLogger;
