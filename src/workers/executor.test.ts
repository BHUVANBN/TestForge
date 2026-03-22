/**
 * TestExecutor unit tests.
 *
 * child_process.spawn is mocked so no real commands run; only
 * the executor's internal logic (buffering, timeouts, kill sequence,
 * result shaping) is exercised.
 */

import { EventEmitter } from 'events';
import { JobData } from '../utils/types';

// ─── Mock child_process ───────────────────────────────────────────────────────
let mockChild: EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter;
  pid: number;
  killed: boolean;
  exitCode: number | null;
  kill: jest.Mock;
};

function createMockChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.pid = 12345;
  child.killed = false;
  child.exitCode = 0;
  child.kill = jest.fn((signal?: string) => {
    child.killed = true;
    // Simulate the process dying after a kill
    setImmediate(() => child.emit('exit', null, signal || 'SIGTERM'));
  });
  return child;
}

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

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
      killTimeout: 500,
      maxMemoryMB: 512,
      sandbox: false,
      allowedCommands: ['node', 'python3', 'bash', 'sh'],
    },
    security: {
      maxScriptLength: 100000,
      blockedPatterns: ['rm -rf', 'sudo'],
    },
  },
}));

import { spawn } from 'child_process';
import { TestExecutor } from './executor';

const baseJob: JobData = {
  id: 'test-id-001',
  script: '',
  command: 'node',
  args: ['-e', 'process.exit(0)'],
  timeout: 5000,
  createdAt: new Date(),
};

describe('TestExecutor', () => {
  let spawnMock: jest.Mock;

  beforeEach(() => {
    spawnMock = spawn as jest.Mock;
    mockChild = createMockChild();
    spawnMock.mockReturnValue(mockChild);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('execute() — happy path', () => {
    it('should resolve with a completed result when process exits 0', async () => {
      const executor = new TestExecutor({ ...baseJob });

      // Simulate stdout then process exit
      const promise = executor.execute();
      await new Promise(r => setTimeout(r, 10)); // let setup run

      mockChild.stdout.emit('data', Buffer.from('Hello World\n'));
      mockChild.emit('exit', 0, null);

      const result = await promise;

      expect(result.status).toBe('completed');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('Hello World\n');
      expect(result.stderr).toBe('');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should capture stderr output', async () => {
      const executor = new TestExecutor({ ...baseJob });

      const promise = executor.execute();
      await new Promise(r => setTimeout(r, 10));

      mockChild.stderr.emit('data', Buffer.from('some warning\n'));
      mockChild.emit('exit', 0, null);

      const result = await promise;
      expect(result.stderr).toBe('some warning\n');
    });
  });

  describe('execute() — failure cases', () => {
    it('should return a failed result when process exits non-zero', async () => {
      mockChild.exitCode = 1;
      const executor = new TestExecutor({ ...baseJob });

      const promise = executor.execute();
      await new Promise(r => setTimeout(r, 10));

      mockChild.emit('exit', 1, null);

      const result = await promise;
      expect(result.status).toBe('failed');
    });

    it('should return a failed result when process emits an error event', async () => {
      const executor = new TestExecutor({ ...baseJob });

      const promise = executor.execute();
      await new Promise(r => setTimeout(r, 10));

      mockChild.emit('error', new Error('ENOENT: command not found'));

      const result = await promise;
      expect(result.status).toBe('failed');
      expect(result.error).toContain('ENOENT');
    });
  });

  describe('security validation', () => {
    it('should reject blocked patterns in scripts', async () => {
      const executor = new TestExecutor({ ...baseJob, script: 'rm -rf /' });
      const result = await executor.execute();

      expect(result.status).toBe('failed');
      expect(result.error).toContain('blocked pattern');
    });

    it('should reject disallowed commands', async () => {
      const executor = new TestExecutor({ ...baseJob, command: 'curl' });
      const result = await executor.execute();

      expect(result.status).toBe('failed');
      expect(result.error).toContain('not allowed');
    });
  });

  describe('kill()', () => {
    it('isRunning should be false after kill', async () => {
      const executor = new TestExecutor({ ...baseJob });

      executor.execute(); // don't await — let it hang
      await new Promise(r => setTimeout(r, 10));

      expect(executor.isRunning()).toBe(true);
      executor.kill();
      expect(executor.isRunning()).toBe(false);
    });

    it('kill should be a no-op if already killed', () => {
      const executor = new TestExecutor({ ...baseJob });
      executor.kill(); // no process yet — should not throw
      executor.kill(); // second call — should not throw
    });
  });

  describe('getProcessId()', () => {
    it('should return null before execution starts', () => {
      const executor = new TestExecutor({ ...baseJob });
      expect(executor.getProcessId()).toBeNull();
    });
  });
});
