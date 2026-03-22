import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import path from 'path';
import { Server as SocketIOServer } from 'socket.io';
import type { Socket } from 'socket.io';
import { logger } from '../utils/logger';
import config from '../config';
import { initMetrics } from '../utils/metrics';
import RedisConnection from '../queue/redis';
import QueueManager from '../queue/manager';
import WorkerManager from '../workers/manager';

// Import routes
import jobsRouter from './routes/jobs';
import systemRouter from './routes/system';
import { apiKeyAuth } from './middleware/auth';

class APIServer {
  private app: express.Application;
  private server: any;
  private io: SocketIOServer;
  private redisConnection: RedisConnection;
  private queueManager: QueueManager;
  private workerManager: WorkerManager;

  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.io = new SocketIOServer(this.server, {
      cors: {
        origin: config.server.cors.origin,
        credentials: config.server.cors.credentials
      }
    });

    this.redisConnection = RedisConnection.getInstance();
    this.queueManager = QueueManager.getInstance();
    this.workerManager = WorkerManager.getInstance();

    initMetrics();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.setupErrorHandling();
  }

  private setupMiddleware(): void {
    // Security middleware (relax CSP for dashboard)
    this.app.use(helmet({ contentSecurityPolicy: false }));
    
    // Serve static dashboard
    this.app.use(express.static(path.join(process.cwd(), 'public')));
    
    // CORS middleware
    this.app.use(cors(config.server.cors));
    
    // Compression middleware
    this.app.use(compression());
    
    // Rate limiting
    const limiter = rateLimit({
      windowMs: config.server.rateLimit.windowMs,
      max: config.server.rateLimit.max,
      message: {
        success: false,
        error: 'Too many requests',
        message: 'Rate limit exceeded'
      },
      standardHeaders: true,
      legacyHeaders: false
    });
    this.app.use(limiter);
    
    // Body parsing middleware
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    
    // Request logging middleware
    this.app.use((req, res, next) => {
      const start = Date.now();
      
      res.on('finish', () => {
        const duration = Date.now() - start;
        logger.info('HTTP Request', {
          method: req.method,
          url: req.url,
          status: res.statusCode,
          duration,
          userAgent: req.get('User-Agent'),
          ip: req.ip
        });
      });
      
      next();
    });
  }

  private setupRoutes(): void {
    // API routes — protected by optional API key auth
    this.app.use('/api/v1', apiKeyAuth);
    this.app.use('/api/v1', jobsRouter);
    this.app.use('/api/v1', systemRouter);
    
    // Root endpoint - redirect to dashboard
    this.app.get('/', (req, res) => {
      res.redirect('/dashboard.html');
    });

    // API info endpoint
    this.app.get('/api', (req, res) => {
      res.json({
        success: true,
        message: 'Distributed Test Execution Engine API',
        version: process.env.npm_package_version || '1.0.0',
        dashboard: '/dashboard.html',
        prometheus: '/api/v1/metrics/prometheus',
        timestamp: new Date().toISOString(),
        endpoints: {
          jobs: {
            list: 'GET /api/v1/jobs',
            submit: 'POST /api/v1/submit-test',
            status: 'GET /api/v1/status/:jobId',
            logs: 'GET /api/v1/logs/:jobId',
            result: 'GET /api/v1/result/:jobId',
            cancel: 'DELETE /api/v1/jobs/:jobId',
            retry: 'POST /api/v1/jobs/:jobId/retry'
          },
          system: {
            health: 'GET /api/v1/health',
            metrics: 'GET /api/v1/metrics',
            prometheus: 'GET /api/v1/metrics/prometheus',
            queueStats: 'GET /api/v1/queue/stats',
            queuePause: 'POST /api/v1/queue/pause',
            queueResume: 'POST /api/v1/queue/resume',
            queueClear: 'DELETE /api/v1/queue/clear',
            info: 'GET /api/v1/info'
          }
        }
      });
    });
    
    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Route ${req.method} ${req.originalUrl} not found`
      });
    });
  }

  private setupWebSocket(): void {
    this.io.on('connection', (socket: Socket) => {
      logger.info('WebSocket client connected', { socketId: socket.id });
      
      // Join job-specific room for real-time updates
      socket.on('subscribe-job', async (jobId: string) => {
        socket.join(`job-${jobId}`);
        logger.debug('Client subscribed to job updates', { socketId: socket.id, jobId });
        
        // Push current state immediately so the client isn't waiting for an event
        try {
          const status = await this.queueManager.getJobStatus(jobId);
          const result = (status === 'completed' || status === 'failed') 
            ? await this.workerManager.getJobResult(jobId) 
            : null;
            
          socket.emit('job-state', { jobId, status, result });
        } catch (error) {
          logger.error('Failed to send initial job state via WS', { jobId, error });
        }
      });
      
      // Unsubscribe from job updates
      socket.on('unsubscribe-job', (jobId: string) => {
        socket.leave(`job-${jobId}`);
        logger.debug('Client unsubscribed from job updates', { socketId: socket.id, jobId });
      });
      
      // Handle disconnect
      socket.on('disconnect', () => {
        logger.info('WebSocket client disconnected', { socketId: socket.id });
      });
    });

    // Listen to queue events and broadcast to WebSocket clients
    this.queueManager.getQueueEvents().on('completed', ({ jobId, returnvalue }) => {
      this.io.to(`job-${jobId}`).emit('job-completed', { jobId, result: returnvalue });
    });

    this.queueManager.getQueueEvents().on('failed', ({ jobId, failedReason }) => {
      this.io.to(`job-${jobId}`).emit('job-failed', { jobId, error: failedReason });
    });

    this.queueManager.getQueueEvents().on('progress', ({ jobId, data }) => {
      this.io.to(`job-${jobId}`).emit('job-progress', { jobId, progress: data });
    });
  }

  private setupErrorHandling(): void {
    // Global error handler for Express
    this.app.use((error: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
      logger.error('Unhandled express error', {
        error: error.message,
        stack: error.stack,
        method: req.method,
        url: req.url,
        body: req.body
      });

      res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
      });
    });
  }

  public async start(): Promise<void> {
    try {
      // Connect to Redis
      await this.redisConnection.connect();
      logger.info('Redis connection established');

      // Start the server
      this.server.listen(config.server.port, config.server.host, () => {
        logger.info(`Server started on ${config.server.host}:${config.server.port}`);
        logger.info(`WebSocket server ready`);
      });

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to start server', { error: err.message });
      throw err;
    }
  }

  public async gracefulShutdown(): Promise<void> {
    logger.info('Starting graceful shutdown');

    try {
      // Close HTTP server
      if (this.server) {
        await new Promise<void>((resolve) => {
          this.server.close(() => {
            logger.info('HTTP server closed');
            resolve();
          });
        });
      }

      // Close WebSocket server
      if (this.io) {
        this.io.close();
        logger.info('WebSocket server closed');
      }

      // Shutdown worker manager
      await this.workerManager.gracefulShutdown();
      logger.info('Worker manager shutdown');

      // Close queue manager
      await this.queueManager.close();
      logger.info('Queue manager closed');

      // Close Redis connection
      await this.redisConnection.disconnect();
      logger.info('Redis connection closed');

      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Error during graceful shutdown', { error: err.message });
      process.exit(1);
    }
  }

  public getApp(): express.Application {
    return this.app;
  }

  public getServer(): any {
    return this.server;
  }

  public getIO(): SocketIOServer {
    return this.io;
  }
}

export default APIServer;
