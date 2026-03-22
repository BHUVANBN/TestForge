import APIServer from './api';
import { logger } from './utils/logger';
import fs from 'fs/promises';


async function ensureDirectories(): Promise<void> {
  const directories = [
    './logs',
    './logs/jobs',
    './temp'
  ];

  for (const dir of directories) {
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
      logger.info(`Created directory: ${dir}`);
    }
  }
}

async function main(): Promise<void> {
  try {
    logger.info('Starting Distributed Test Execution Engine');
    
    // Ensure necessary directories exist
    await ensureDirectories();
    
    const mode = process.env.ENGINE_MODE || 'hybrid'; // 'api', 'worker', or 'hybrid'
    
    if (mode === 'api' || mode === 'hybrid') {
      logger.info('Starting API Server...');
      const server = new APIServer();
      await server.start();
    }
    
    if (mode === 'worker' || mode === 'hybrid') {
      logger.info('Starting Worker Manager...');
      // WorkerManager is instantiated in APIServer and QueueManager usually, 
      // but in standalone worker mode we need to make sure it's active.
      const WorkerManager = (await import('./workers/manager')).default;
      WorkerManager.getInstance();
    }
    
    logger.info(`Distributed Test Execution Engine started in ${mode} mode`);
    
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to start application', { error: err.message });
    process.exit(1);
  }
}

// Handle top-level errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', { reason, promise });
  process.exit(1);
});

// Start the application
main();
