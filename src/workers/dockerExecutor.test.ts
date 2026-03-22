/**
 * DockerExecutor unit tests.
 */

import { EventEmitter } from 'events';
import { JobData } from '../utils/types';

// ─── Mock Dockerode ────────────────────────────────────────────────────────────

const mockDemuxStream = jest.fn();
const mockRun = jest.fn();
const mockListImages = jest.fn().mockResolvedValue([]);
const mockPull = jest.fn().mockResolvedValue(new EventEmitter());
const mockKill = jest.fn().mockResolvedValue(true);
const mockRemove = jest.fn().mockResolvedValue(true);

jest.mock('dockerode', () => {
  return jest.fn().mockImplementation(() => ({
    run: mockRun,
    listImages: mockListImages,
    pull: mockPull,
    modem: {
      demuxStream: mockDemuxStream,
    },
    getContainer: jest.fn().mockReturnValue({
      kill: mockKill,
      remove: mockRemove,
    }),
  }));
});

jest.mock('../utils/logger', () => ({
  createJobLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  __esModule: true,
  default: {
    workers: {
      timeout: 5000,
      maxMemoryMB: 512,
      docker: {
        images: {
          node: 'node:18-alpine',
          python: 'python:3.11-alpine',
          bash: 'alpine:latest',
        },
        network: 'testforge-network',
        memoryLimitMB: 512,
        cpuLimit: 1,
      },
      allowedCommands: ['node', 'python', 'bash'],
    },
    security: {
      maxScriptLength: 100000,
      blockedPatterns: ['rm -rf'],
    },
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

import { DockerExecutor } from './dockerExecutor';

const baseJob: JobData = {
  id: 'docker-job-123',
  script: '',
  command: 'node',
  args: ['-v'],
  timeout: 5000,
  createdAt: new Date(),
};

describe('DockerExecutor', () => {
  let executor: DockerExecutor;

  beforeEach(() => {
    executor = new DockerExecutor(baseJob);
    jest.clearAllMocks();
  });

  describe('execute()', () => {
    it('should complete successfully when docker run exits with code 0', async () => {
      // Mock docker.run resolving with data, container, and stream
      mockRun.mockResolvedValueOnce([{ StatusCode: 0 }, { id: 'cid-123' }, new EventEmitter()]);
      
      const result = await executor.execute();
      
      expect(result.status).toBe('completed');
      expect(result.exitCode).toBe(0);
      expect(mockRun).toHaveBeenCalledWith(
        'node:18-alpine',
        ['node', '-v'],
        expect.any(Object),
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should fail when docker run exits with non-zero code', async () => {
      mockRun.mockResolvedValueOnce([{ StatusCode: 1 }, { id: 'cid-123' }, new EventEmitter()]);
      
      const result = await executor.execute();
      
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
    });

    it('should catch docker run errors', async () => {
      mockRun.mockRejectedValueOnce(new Error('Docker daemon not running'));
      
      const result = await executor.execute();
      
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Docker daemon not running');
    });

    it('should reject blocked security patterns in scripts', async () => {
      const secExecutor = new DockerExecutor({ ...baseJob, script: 'rm -rf /' });
      const result = await secExecutor.execute();
      
      expect(result.status).toBe('failed');
      expect(result.error).toContain('blocked pattern');
      expect(mockRun).not.toHaveBeenCalled();
    });

    it('should reject unallowed commands', async () => {
      const secExecutor = new DockerExecutor({ ...baseJob, command: 'curl' });
      const result = await secExecutor.execute();
      
      expect(result.status).toBe('failed');
      expect(result.error).toContain('not allowed');
    });
  });

  describe('kill()', () => {
    it('should kill and remove the container if running', async () => {
      mockRun.mockReturnValueOnce(new Promise(() => {})); // Hangs
      
      const secExecutor = new DockerExecutor({ ...baseJob });
      secExecutor.execute();
      
      // Advance to where container is running
      await new Promise(r => setTimeout(r, 20));
      
      secExecutor.kill();
      
      expect(secExecutor.isRunning()).toBe(false);
      // Wait for async kill to resolve in background
      await new Promise(r => setTimeout(r, 20));
      expect(mockKill).toHaveBeenCalled();
    });

    it('should be a no-op if no container id is present', () => {
      expect(() => executor.kill()).not.toThrow();
    });
  });


});
