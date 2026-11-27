import { ChildProcess, spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import config from '../config';
import { RUNTIMES } from '../jobs/runtimes';
import { createJobLogger } from '../utils/logger';
import {
  ExecutionOutcome,
  ExecutionResult,
  Executor,
  JobRecord,
  KillReason,
  OutputListener,
} from '../utils/types';
import { OutputCollector } from './output';
import { collectFromDirectory } from './artifacts';

export const OUTCOME_FOR_KILL: Record<KillReason, ExecutionOutcome> = {
  cancel: 'cancelled',
  timeout: 'timeout',
  shutdown: 'interrupted',
};

/** argv for a job: either `<interpreter> <scriptFile>` or `<command> ...args`. */
export function buildArgv(record: JobRecord, scriptPath: string): string[] {
  if (record.script !== undefined) {
    const runtime = RUNTIMES[record.language ?? 'bash'];
    return [...runtime.interpreter, scriptPath];
  }
  if (!record.command) throw new Error('Job has neither a script nor a command');
  return [record.command, ...(record.args ?? [])];
}

export function jobEnvironment(record: JobRecord, home: string, artifactsDir: string): Record<string, string> {
  return {
    HOME: home,
    TESTFORGE_ARTIFACTS: artifactsDir,
    TMPDIR: home,
    LANG: 'C.UTF-8',
    CI: 'true',
    TESTFORGE: 'true',
    TESTFORGE_JOB_ID: record.id,
    ...(record.env ?? {}),
  };
}

/**
 * Runs a job as a child process on the worker host.
 *
 * NOT a security boundary: jobs run with the worker's privileges. Intended for
 * local development and fully trusted submitters. Production uses DockerExecutor.
 */
export class LocalExecutor implements Executor {
  private child: ChildProcess | null = null;
  private exited = false;
  private killReason: KillReason | null = null;
  private readonly log;

  constructor(
    private readonly record: JobRecord,
    private readonly onOutput?: OutputListener
  ) {
    this.log = createJobLogger(record.id);
  }

  async run(): Promise<ExecutionResult> {
    const started = Date.now();
    const output = new OutputCollector(config.jobs.maxOutputBytes, this.onOutput);
    const baseDir = path.resolve(config.workers.tempDir);
    await fs.mkdir(baseDir, { recursive: true });
    const workDir = await fs.mkdtemp(path.join(baseDir, `job-${this.record.id}-`));

    try {
      let scriptPath = '';
      if (this.record.script !== undefined) {
        scriptPath = path.join(workDir, RUNTIMES[this.record.language ?? 'bash'].fileName);
        await fs.writeFile(scriptPath, this.record.script, { mode: 0o600 });
      }
      const argv = buildArgv(this.record, scriptPath);
      const artifactsDir = path.join(workDir, 'artifacts');
      await fs.mkdir(artifactsDir);
      if (this.killReason) return this.result(output, started, null, null);
      const result = await this.spawnAndWait(argv, workDir, output, started);
      if (result.outcome === 'interrupted') return result;
      const collected = await collectFromDirectory(artifactsDir, config.artifacts);
      return { ...result, artifacts: collected.artifacts, artifactsTruncated: collected.truncated };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('Local execution failed', { error: message });
      return { ...this.result(output, started, null, null), outcome: 'failed', error: message };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private spawnAndWait(
    argv: string[],
    workDir: string,
    output: OutputCollector,
    started: number
  ): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      const [cmd, ...args] = argv;
      this.log.info('Spawning process', { cmd, args: args.length });

      const env = {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        ...jobEnvironment(this.record, workDir, path.join(workDir, 'artifacts')),
      };
      const child = spawn(cmd, args, {
        cwd: workDir,
        env,
        // Own process group so the whole tree can be signalled.
        detached: true,
        // No stdin: interactive programs get EOF instead of hanging.
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      this.child = child;

      const timer = setTimeout(() => void this.kill('timeout'), this.record.timeoutMs);
      let settled = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null, error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        output.finish();
        const res = this.result(output, started, code, signal);
        resolve(error && res.outcome === 'failed' ? { ...res, error } : res);
      };

      child.stdout?.on('data', (d: Buffer) => output.push('stdout', d));
      child.stderr?.on('data', (d: Buffer) => output.push('stderr', d));

      child.on('error', (err) => {
        this.exited = true;
        const msg = (err as NodeJS.ErrnoException).code === 'ENOENT' ? `Command not found: ${cmd}` : err.message;
        finish(null, null, msg);
      });

      child.on('exit', (code, signal) => {
        this.exited = true;
        // Reap anything the job left running in the background.
        this.signalGroup('SIGKILL');
        // Give the pipes a moment to drain, but never wait on leaked descriptors.
        const drain = setTimeout(() => finish(code, signal), 1000);
        child.once('close', () => {
          clearTimeout(drain);
          finish(code, signal);
        });
      });
    });
  }

  private result(
    output: OutputCollector,
    started: number,
    code: number | null,
    signal: NodeJS.Signals | null
  ): ExecutionResult {
    let outcome: ExecutionOutcome;
    let error: string | undefined;
    if (this.killReason) {
      outcome = OUTCOME_FOR_KILL[this.killReason];
      error =
        this.killReason === 'timeout'
          ? `Timed out after ${this.record.timeoutMs}ms`
          : this.killReason === 'cancel'
            ? 'Cancelled by user'
            : 'Interrupted by worker shutdown';
    } else if (code === 0) {
      outcome = 'completed';
    } else {
      outcome = 'failed';
      error = signal ? `Process terminated by signal ${signal}` : `Process exited with code ${code}`;
    }
    return {
      outcome,
      exitCode: code,
      stdout: output.stdout,
      stderr: output.stderr,
      truncated: output.truncated,
      durationMs: Date.now() - started,
      error,
    };
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      /* group already gone */
    }
  }

  async kill(reason: KillReason): Promise<void> {
    if (this.killReason) return;
    this.killReason = reason;
    if (!this.child || this.exited) return;
    this.log.info('Stopping process group', { reason });
    this.signalGroup('SIGTERM');
    const escalate = setTimeout(() => {
      if (!this.exited) {
        this.log.warn('Process ignored SIGTERM, sending SIGKILL');
        this.signalGroup('SIGKILL');
      }
    }, config.workers.killGraceMs);
    this.child.once('exit', () => clearTimeout(escalate));
  }
}
