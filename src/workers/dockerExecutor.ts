import Docker from 'dockerode';
import { EventEmitter } from 'events';
import { createJobLogger } from '../utils/logger';
import { JobData, JobResult } from '../utils/types';
import config from '../config';

import { jobCompletedCounter, jobDurationHistogram } from '../utils/metrics';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export class DockerExecutor extends EventEmitter {
  private containerId: string | null = null;
  private jobData: JobData;
  private logger: ReturnType<typeof createJobLogger>;
  private startTime: Date | null = null;
  private killed: boolean = false;
  private stdoutBuffer: string[] = [];
  private stderrBuffer: string[] = [];

  constructor(jobData: JobData) {
    super();
    this.jobData = jobData;
    this.logger = createJobLogger(jobData.id);
  }

  public async execute(): Promise<JobResult> {
    this.startTime = new Date();
    this.logger.info('Starting Docker-isolated test execution', {
      command: this.jobData.command,
      args: this.jobData.args,
    });

    try {
      const result = await this.runInContainer();
      const duration = new Date().getTime() - this.startTime.getTime();
      jobCompletedCounter.inc({ status: result.status });
      jobDurationHistogram.observe({ status: result.status }, duration);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Docker execution failed', { error: err.message });
      jobCompletedCounter.inc({ status: 'failed' });
      return this.createFailedResult(err);
    } finally {
      await this.cleanup();
    }
  }

  private async runInContainer(): Promise<JobResult> {
    const image = this.resolveImage();
    const cmd = this.buildCommand();
    const memoryLimit = config.workers.maxMemoryMB * 1024 * 1024;
    const timeout = this.jobData.timeout || config.workers.timeout;

    this.logger.info('Pulling Docker image', { image });
    await this.pullImage(image);

    this.logger.info('Creating container', { image, cmd });
    const container = await docker.createContainer({
      Image: image,
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      Env: Object.entries(this.jobData.env || {}).map(([k, v]) => `${k}=${v}`),
      HostConfig: {
        Memory: memoryLimit,
        MemorySwap: memoryLimit,
        CpuQuota: 50000, // 50% of one CPU
        NetworkMode: 'none', // No network access by default
        AutoRemove: false,
        ReadonlyRootfs: false,
        SecurityOpt: ['no-new-privileges'],
      },
      NetworkingConfig: {},
    });

    this.containerId = container.id;

    const stream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });

    await container.start();

    // Gather output
    container.modem.demuxStream(stream, {
      write: (chunk: Buffer) => {
        const out = chunk.toString();
        this.stdoutBuffer.push(out);
        this.emit('stdout', out);
      }
    }, {
      write: (chunk: Buffer) => {
        const err = chunk.toString();
        this.stderrBuffer.push(err);
        this.emit('stderr', err);
      }
    });

    // Enforce timeout
    const timeoutHandle = setTimeout(async () => {
      this.logger.warn('Container timeout, stopping...');
      this.killed = true;
      await container.stop({ t: 2 }).catch(() => {});
    }, timeout);

    const data = await container.wait();
    clearTimeout(timeoutHandle);

    const exitCode: number = data.StatusCode;
    const endTime = new Date();
    const duration = endTime.getTime() - this.startTime!.getTime();

    if (this.killed) {
      return this.createKilledResult();
    }

    return {
      id: this.jobData.id,
      status: exitCode === 0 ? 'completed' : 'failed',
      startTime: this.startTime!,
      endTime,
      duration,
      exitCode,
      stdout: this.stdoutBuffer.join(''),
      stderr: this.stderrBuffer.join(''),
      error: exitCode !== 0 ? `Process exited with code ${exitCode}` : undefined,
      metadata: this.jobData.metadata,
      createdAt: this.jobData.createdAt,
      updatedAt: endTime,
    };
  }

  private resolveImage(): string {
    const command = this.jobData.command || 'bash';
    const imageMap: Record<string, string> = {
      node: 'node:18-alpine',
      npm: 'node:18-alpine',
      python: 'python:3.12-alpine',
      python3: 'python:3.12-alpine',
      java: 'eclipse-temurin:21-jre-alpine',
      go: 'golang:1.22-alpine',
      ruby: 'ruby:3.3-alpine',
      php: 'php:8.3-cli-alpine',
      bash: 'bash:5.2',
    };
    return imageMap[command] || 'bash:5.2';
  }

  private buildCommand(): string[] {
    if (this.jobData.script) {
      return ['bash', '-c', this.jobData.script];
    }
    const command = this.jobData.command || 'bash';
    const args = this.jobData.args || [];
    return [command, ...args];
  }

  private async pullImage(image: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err2: Error | null) => {
          if (err2) reject(err2);
          else resolve();
        });
      });
    });
  }

  private async cleanup(): Promise<void> {
    if (!this.containerId) return;
    try {
      const container = docker.getContainer(this.containerId);
      await container.remove({ force: true });
      this.logger.debug('Container removed', { containerId: this.containerId });
    } catch (error) {
      this.logger.warn('Failed to remove container', { containerId: this.containerId, error });
    }
  }

  public async kill(): Promise<void> {
    if (!this.containerId || this.killed) return;
    this.killed = true;
    try {
      const container = docker.getContainer(this.containerId);
      await container.stop({ t: 2 });
    } catch (error) {
      this.logger.warn('Failed to kill container', { error });
    }
  }

  public isRunning(): boolean {
    return this.containerId !== null && !this.killed;
  }

  private createFailedResult(error: Error): JobResult {
    const endTime = new Date();
    return {
      id: this.jobData.id,
      status: 'failed',
      startTime: this.startTime!,
      endTime,
      duration: endTime.getTime() - (this.startTime?.getTime() || endTime.getTime()),
      exitCode: 1,
      stdout: this.stdoutBuffer.join(''),
      stderr: this.stderrBuffer.join(''),
      error: error.message,
      metadata: this.jobData.metadata,
      createdAt: this.jobData.createdAt,
      updatedAt: endTime,
    };
  }

  private createKilledResult(): JobResult {
    const endTime = new Date();
    return {
      id: this.jobData.id,
      status: 'cancelled',
      startTime: this.startTime!,
      endTime,
      duration: endTime.getTime() - (this.startTime?.getTime() || endTime.getTime()),
      exitCode: undefined,
      stdout: this.stdoutBuffer.join(''),
      stderr: this.stderrBuffer.join(''),
      error: 'Container was killed due to timeout or cancellation',
      metadata: this.jobData.metadata,
      createdAt: this.jobData.createdAt,
      updatedAt: endTime,
    };
  }
}

export default DockerExecutor;
