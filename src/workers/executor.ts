import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { createJobLogger } from '../utils/logger';
import { JobData, JobResult } from '../utils/types';
import config from '../config';
import path from 'path';
import fs from 'fs/promises';

export class TestExecutor extends EventEmitter {
  private process: ChildProcess | null = null;
  private jobData: JobData;
  private logger: any;
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
    this.logger.info('Starting test execution', { 
      command: this.jobData.command,
      args: this.jobData.args,
      timeout: this.jobData.timeout || config.workers.timeout
    });

    let scriptPath: string | null = null;
    try {
      // Validate and prepare execution
      scriptPath = await this.prepareExecution();
      
      // Spawn the process
      this.process = await this.spawnProcess();
      
      // Setup process handlers
      this.setupProcessHandlers();
      
      // Wait for completion
      const result = await this.waitForCompletion();
      
      this.logger.info('Test execution completed', { 
        duration: result.duration,
        exitCode: result.exitCode
      });
      
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Test execution failed', { error: err.message });
      return this.createFailedResult(err);
    } finally {
      // Cleanup temporary script file
      if (scriptPath) {
        try {
          await fs.unlink(scriptPath);
          this.logger.debug('Temporary script file deleted', { scriptPath });
        } catch (error) {
          this.logger.warn('Failed to delete temporary script file', { scriptPath, error });
        }
      }
    }
  }

  private async prepareExecution(): Promise<string | null> {
    // Security validation
    if (this.jobData.script && this.jobData.script.length > config.security.maxScriptLength) {
      throw new Error(`Script exceeds maximum length of ${config.security.maxScriptLength} characters`);
    }

    // Check for blocked patterns with improved robustness
    const script = this.jobData.script || '';
    const normalizedScript = script.toLowerCase().replace(/\s+/g, '');
    
    for (const pattern of config.security.blockedPatterns) {
      const normalizedPattern = pattern.toLowerCase().replace(/\s+/g, '');
      if (normalizedScript.includes(normalizedPattern)) {
        throw new Error(`Script contains blocked pattern: ${pattern}`);
      }
    }

    // Validate command if provided
    if (this.jobData.command) {
      const baseCommand = this.jobData.command.trim().split(/\s+/)[0];
      
      if (!config.workers.allowedCommands.includes(baseCommand)) {
        throw new Error(`Command '${baseCommand}' is not allowed`);
      }
    }

    // Create temporary script file if script is provided
    if (this.jobData.script) {
      const tempDir = path.join(process.cwd(), 'temp');
      await fs.mkdir(tempDir, { recursive: true });
      
      const scriptPath = path.join(tempDir, `${this.jobData.id}.sh`);
      await fs.writeFile(scriptPath, this.jobData.script, 'utf8');
      await fs.chmod(scriptPath, '755');
      
      // Update job data to use script file
      this.jobData.command = 'bash';
      this.jobData.args = [scriptPath];
      return scriptPath;
    }

    return null;
  }

  private async spawnProcess(): Promise<ChildProcess> {
    const command = this.jobData.command || 'node';
    const args = this.jobData.args || [];
    const env = { ...process.env, ...this.jobData.env };

    this.logger.info('Spawning process', { command, args });

    const childProcess = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env,
      cwd: process.cwd(),
      detached: false,
      shell: false
    });

    // Basic resource limit monitoring

    const monitorInterval = setInterval(() => {
      // In a real system, we'd use something like 'usage' or 'pidusage' package
      // For this implementation, we monitor duration and basic child state
      if (this.killed || !childProcess.pid) {
        clearInterval(monitorInterval);
      }
    }, 2000);

    childProcess.on('exit', () => clearInterval(monitorInterval));

    return childProcess;
  }

  private setupProcessHandlers(): void {
    if (!this.process) return;

    // Handle stdout
    this.process.stdout?.on('data', (data: Buffer) => {
      const output = data.toString();
      this.stdoutBuffer.push(output);
      this.emit('stdout', output);
      this.logger.debug('stdout', { output: output.trim() });
    });

    // Handle stderr
    this.process.stderr?.on('data', (data: Buffer) => {
      const output = data.toString();
      this.stderrBuffer.push(output);
      this.emit('stderr', output);
      this.logger.debug('stderr', { output: output.trim() });
    });

    // Handle process exit
    this.process.on('exit', (code: number | null, signal: string | null) => {
      this.logger.info('Process exited', { code, signal, killed: this.killed });
      
      if (this.killed) {
        this.emit('killed');
      } else if (code !== 0) {
        this.emit('error', new Error(`Process exited with code ${code}`));
      } else {
        this.emit('completed');
      }
    });

    // Handle process error
    this.process.on('error', (error: Error) => {
      this.logger.error('Process error', { error: error.message });
      this.emit('error', error);
    });
  }

  private async waitForCompletion(): Promise<JobResult> {
    const timeout = this.jobData.timeout || config.workers.timeout;
    
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.logger.warn('Process timeout, killing...');
        this.kill();
        reject(new Error(`Process timed out after ${timeout}ms`));
      }, timeout);

      this.once('completed', () => {
        clearTimeout(timeoutId);
        resolve(this.createSuccessResult());
      });

      this.once('error', (error: Error) => {
        clearTimeout(timeoutId);
        resolve(this.createFailedResult(error));
      });

      this.once('killed', () => {
        clearTimeout(timeoutId);
        resolve(this.createKilledResult());
      });
    });
  }

  public kill(): void {
    if (!this.process || this.killed) return;

    this.killed = true;
    this.logger.info('Killing process');

    // Try graceful shutdown first
    this.process.kill('SIGTERM');

    // Force kill after timeout
    setTimeout(() => {
      if (this.process && !this.process.killed) {
        this.logger.warn('Force killing process');
        this.process.kill('SIGKILL');
      }
    }, config.workers.killTimeout);
  }

  private createSuccessResult(): JobResult {
    const endTime = new Date();
    const duration = this.startTime ? endTime.getTime() - this.startTime.getTime() : 0;

    return {
      id: this.jobData.id,
      status: 'completed',
      startTime: this.startTime!,
      endTime,
      duration,
      exitCode: this.process?.exitCode || 0,
      stdout: this.stdoutBuffer.join(''),
      stderr: this.stderrBuffer.join(''),
      metadata: this.jobData.metadata,
      createdAt: this.jobData.createdAt,
      updatedAt: endTime
    };
  }

  private createFailedResult(error: Error): JobResult {
    const endTime = new Date();
    const duration = this.startTime ? endTime.getTime() - this.startTime.getTime() : 0;

    return {
      id: this.jobData.id,
      status: 'failed',
      startTime: this.startTime!,
      endTime,
      duration,
      exitCode: this.process?.exitCode || 1,
      stdout: this.stdoutBuffer.join(''),
      stderr: this.stderrBuffer.join(''),
      error: error.message,
      metadata: this.jobData.metadata,
      createdAt: this.jobData.createdAt,
      updatedAt: endTime
    };
  }

  private createKilledResult(): JobResult {
    const endTime = new Date();
    const duration = this.startTime ? endTime.getTime() - this.startTime.getTime() : 0;

    return {
      id: this.jobData.id,
      status: 'cancelled',
      startTime: this.startTime!,
      endTime,
      duration,
      exitCode: undefined,
      stdout: this.stdoutBuffer.join(''),
      stderr: this.stderrBuffer.join(''),
      error: 'Process was killed',
      metadata: this.jobData.metadata,
      createdAt: this.jobData.createdAt,
      updatedAt: endTime
    };
  }

  public getProcessId(): number | null {
    return this.process?.pid || null;
  }

  public isRunning(): boolean {
    return this.process !== null && !this.process.killed && !this.killed;
  }
}
