/**
 * RedisConnection unit tests.
 */

// ─── Mock ioredis ─────────────────────────────────────────────────────────────

import { EventEmitter } from 'events';

class MockRedis extends EventEmitter {
  public status: string = 'wait';
  public connect = jest.fn().mockImplementation(() => {
    this.status = 'ready';
    this.emit('connect');
    this.emit('ready');
    return Promise.resolve();
  });
  public disconnect = jest.fn().mockImplementation(() => {
    this.status = 'end';
    this.emit('close');
    return Promise.resolve();
  });
  public ping = jest.fn().mockResolvedValue('PONG');
  public get = jest.fn().mockResolvedValue(null);
  public setex = jest.fn().mockResolvedValue('OK');
}

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => new MockRedis()),
}));

jest.mock('../config', () => ({
  __esModule: true,
  default: {
    redis: {
      host: '127.0.0.1',
      port: 6379,
      password: undefined,
      db: 0,
      maxRetriesPerRequest: null,
      retryDelayOnFailover: 100,
    },
  },
}));

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

// Reset singleton between tests
beforeEach(() => {
  const mod = require('./redis');
  (mod.default as any).instance = undefined;
  jest.clearAllMocks();
});

import RedisConnection from './redis';

describe('RedisConnection', () => {
  describe('getInstance()', () => {
    it('should return the same singleton instance', () => {
      const a = RedisConnection.getInstance();
      const b = RedisConnection.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('connect()', () => {
    it('should connect and set isConnected', async () => {
      const rc = RedisConnection.getInstance();
      await rc.connect();
      expect(rc.isConnectionActive()).toBe(true);
    });

    it('should be idempotent when already ready', async () => {
      const rc = RedisConnection.getInstance();
      await rc.connect();
      await rc.connect(); // second call — should not throw
      expect(rc.isConnectionActive()).toBe(true);
    });
  });

  describe('healthCheck()', () => {
    it('should return true when ping returns PONG', async () => {
      const rc = RedisConnection.getInstance();
      await rc.connect();
      const healthy = await rc.healthCheck();
      expect(healthy).toBe(true);
    });

    it('should return false when ping throws', async () => {
      const rc = RedisConnection.getInstance();
      await rc.connect();
      const client = rc.getClient() as any;
      client.ping.mockRejectedValueOnce(new Error('Connection refused'));
      const healthy = await rc.healthCheck();
      expect(healthy).toBe(false);
    });
  });

  describe('getClient()', () => {
    it('should return the underlying ioredis client', async () => {
      const rc = RedisConnection.getInstance();
      await rc.connect();
      const client = rc.getClient();
      expect(client).toBeDefined();
      expect(typeof client.ping).toBe('function');
    });
  });
});
