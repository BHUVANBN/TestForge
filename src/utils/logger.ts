import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import config from '../config';

// Custom format for structured logging
const customFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss.SSS'
  }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf((info: winston.Logform.TransformableInfo) => {
    const { timestamp, level, message, ...rest } = info;
    const logEntry: Record<string, unknown> = {
      timestamp,
      level,
      message: typeof message === 'string' ? message : JSON.stringify(message),
      ...rest,
    };
    return JSON.stringify(logEntry);
  })
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({
    format: 'HH:mm:ss'
  }),
  winston.format.printf(({ timestamp, level, message, jobId, component }: winston.Logform.TransformableInfo) => {
    const prefix: string[] = [];
    if (component) prefix.push(`[${component}]`);
    if (jobId) prefix.push(`Job:${jobId}`);
    return `${timestamp} ${level}${prefix.length ? ' ' + prefix.join(' ') : ''} ${message}`;
  })
);

// Create main logger
const createLogger = (component?: string) => {
  const transports: winston.transport[] = [];

  // Console transport for development
  if (process.env.NODE_ENV !== 'production') {
    transports.push(
      new winston.transports.Console({
        format: consoleFormat,
        level: config.logging.level
      })
    );
  }

  // File transport for all logs
  transports.push(
    new DailyRotateFile({
      filename: path.join(config.logging.directory, 'application-%DATE%.log'),
      datePattern: config.logging.datePattern,
      maxSize: config.logging.maxSize,
      maxFiles: config.logging.maxFiles,
      format: customFormat,
      level: config.logging.level
    })
  );

  // Error-specific file transport
  transports.push(
    new DailyRotateFile({
      filename: path.join(config.logging.directory, 'error-%DATE%.log'),
      datePattern: config.logging.datePattern,
      maxSize: config.logging.maxSize,
      maxFiles: config.logging.maxFiles,
      format: customFormat,
      level: 'error'
    })
  );

  return winston.createLogger({
    level: config.logging.level,
    format: customFormat,
    defaultMeta: { component },
    transports,
    // Handle uncaught exceptions and rejections
    exceptionHandlers: [
      new DailyRotateFile({
        filename: path.join(config.logging.directory, 'exceptions-%DATE%.log'),
        datePattern: config.logging.datePattern,
        maxSize: config.logging.maxSize,
        maxFiles: config.logging.maxFiles
      })
    ],
    rejectionHandlers: [
      new DailyRotateFile({
        filename: path.join(config.logging.directory, 'rejections-%DATE%.log'),
        datePattern: config.logging.datePattern,
        maxSize: config.logging.maxSize,
        maxFiles: config.logging.maxFiles
      })
    ]
  });
};

// Job-specific logger factory
export const createJobLogger = (jobId: string) => {
  const jobTransports: winston.transport[] = [];

  // Job-specific log file
  jobTransports.push(
    new DailyRotateFile({
      filename: path.join(config.logging.directory, `jobs/${jobId}-%DATE%.log`),
      datePattern: config.logging.datePattern,
      maxSize: config.logging.maxSize,
      maxFiles: config.logging.maxFiles, // Use config instead of hardcoded 7d
      format: customFormat,
      level: config.logging.level
    })
  );

  // Console transport for development
  if (process.env.NODE_ENV !== 'production') {
    jobTransports.push(
      new winston.transports.Console({
        format: consoleFormat,
        level: config.logging.level
      })
    );
  }

  return winston.createLogger({
    level: config.logging.level,
    format: customFormat,
    defaultMeta: { jobId, component: 'worker' },
    transports: jobTransports
  });
};

// Export default logger instance
export const logger = createLogger('main');

// Export logger factory function
export default createLogger;
