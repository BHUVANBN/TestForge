import Redis from 'ioredis';
import config from '../config';
import { logger } from '../utils/logger';

class RedisConnection {
  private static instance: RedisConnection;
  private client: Redis;
  private isConnected: boolean = false;

  private constructor() {
    this.client = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
      maxRetriesPerRequest: config.redis.maxRetriesPerRequest,
      lazyConnect: true,
      reconnectOnError: (err: Error) => {
        const targetError = 'READONLY';
        return err.message.includes(targetError);
      },
    });

    this.setupEventHandlers();
  }

  public static getInstance(): RedisConnection {
    if (!RedisConnection.instance) {
      RedisConnection.instance = new RedisConnection();
    }
    return RedisConnection.instance;
  }

  private setupEventHandlers(): void {
    this.client.on('connect', () => {
      logger.info('Redis connection established');
      this.isConnected = true;
    });

    this.client.on('ready', () => {
      logger.info('Redis client ready');
    });

    this.client.on('error', (error) => {
      logger.error('Redis connection error', { error: error.message });
      this.isConnected = false;
    });

    this.client.on('close', () => {
      logger.warn('Redis connection closed');
      this.isConnected = false;
    });

    this.client.on('reconnecting', (ms: number) => {
      logger.info(`Redis reconnecting in ${ms}ms`);
    });
  }

  private waitForReady(timeoutMs: number = 5000): Promise<void> {
    if (this.client.status === 'ready') {
      this.isConnected = true;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for Redis ready state (status=${this.client.status})`));
      }, timeoutMs);

      const onReady = () => {
        cleanup();
        this.isConnected = true;
        resolve();
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const cleanup = () => {
        clearTimeout(timeoutId);
        this.client.off('ready', onReady);
        this.client.off('error', onError);
      };

      this.client.on('ready', onReady);
      this.client.on('error', onError);
    });
  }

  public async connect(): Promise<void> {
    try {
      if (this.client.status === 'ready') {
        this.isConnected = true;
        return;
      }

      if (this.client.status === 'connecting' || this.client.status === 'connect') {
        await this.waitForReady();
        return;
      }

      await this.client.connect();
      await this.waitForReady();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to connect to Redis', {
        error: err.message,
        host: config.redis.host,
        port: config.redis.port,
        status: this.client.status,
      });
      throw err;
    }
  }

  public async disconnect(): Promise<void> {
    try {
      await this.client.disconnect();
      this.isConnected = false;
      logger.info('Redis connection closed');
    } catch (error) {
      logger.error('Error closing Redis connection', { error });
      throw error;
    }
  }

  public getClient(): Redis {
    return this.client;
  }

  public isConnectionActive(): boolean {
    return this.isConnected && this.client.status === 'ready';
  }

  public async ping(): Promise<string> {
    try {
      const result = await this.client.ping();
      return result;
    } catch (error) {
      logger.error('Redis ping failed', { error });
      throw error;
    }
  }

  public async healthCheck(): Promise<boolean> {
    try {
      const pong = await this.ping();
      return pong === 'PONG';
    } catch (error) {
      return false;
    }
  }
}

export default RedisConnection;
