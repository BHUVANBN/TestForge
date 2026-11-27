import Docker from 'dockerode';
import os from 'os';
import config from '../config';
import { languageForCommand, RUNTIMES } from '../jobs/runtimes';
import { createJobLogger, createLogger } from '../utils/logger';
import {
  ExecutionOutcome,
  ExecutionResult,
  Executor,
  JobRecord,
  KillReason,
  OutputListener,
} from '../utils/types';
import { jobEnvironment, OUTCOME_FOR_KILL } from './executor';
import { OutputCollector } from './output';

const WORKDIR = '/workspace';
const SCRIPT_ENV = 'TESTFORGE_SCRIPT';
export const MANAGED_LABEL = 'testforge.managed';
export const WORKER_LABEL = 'testforge.worker';
export const JOB_LABEL = 'testforge.job';

export const workerName = (): string => process.env.WORKER_NAME || os.hostname();

let dockerClient: Docker | null = null;
export const getDocker = (): Docker =>
  (dockerClient ??= new Docker({ socketPath: config.docker.socketPath }));
export const setDocker = (client: Docker | null): void => {
  dockerClient = client;
};

/**
 * Runs each job in a fresh, locked-down container:
 * no network, read-only root fs, all capabilities dropped, unprivileged user,
 * memory/CPU/PID limits, and an init process so signals and zombies are handled.
 */
export class DockerExecutor implements Executor {
  private container: Docker.Container | null = null;
  private killReason: KillReason | null = null;
  private readonly log;

  constructor(
    private readonly record: JobRecord,
    private readonly onOutput?: OutputListener,
    private readonly docker: Docker = getDocker()
  ) {
    this.log = createJobLogger(record.id);
  }

  image(): string {
    const language = this.record.language ?? (this.record.command ? languageForCommand(this.record.command) : 'bash');
    return config.docker.images[language];
  }

  command(): string[] {
    if (this.record.script !== undefined) {
      const runtime = RUNTIMES[this.record.language ?? 'bash'];
      const file = `${WORKDIR}/${runtime.fileName}`;
      // The script arrives via an env var (no bind mounts / archive uploads needed),
      // is written to the tmpfs workspace, removed from the environment, then exec'd.
      return [
        'sh',
        '-c',
        `printf '%s' "$${SCRIPT_ENV}" > "$1" && unset ${SCRIPT_ENV} && shift && exec "$@"`,
        'testforge',
        file,
        ...runtime.interpreter,
        file,
      ];
    }
    if (!this.record.command) throw new Error('Job has neither a script nor a command');
    return [this.record.command, ...(this.record.args ?? [])];
  }

  containerOptions(): Docker.ContainerCreateOptions {
    const memory = config.docker.memoryMB * 1024 * 1024;
    const tmpfs = `rw,exec,nosuid,nodev,size=${config.docker.tmpfsSizeMB}m,mode=1777`;
    const env = Object.entries(jobEnvironment(this.record, WORKDIR)).map(([k, v]) => `${k}=${v}`);
    if (this.record.script !== undefined) env.push(`${SCRIPT_ENV}=${this.record.script}`);

    return {
      Image: this.image(),
      Cmd: this.command(),
      Env: env,
      WorkingDir: WORKDIR,
      User: config.docker.user,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: false,
      Tty: false,
      Labels: {
        [MANAGED_LABEL]: 'true',
        [WORKER_LABEL]: workerName(),
        [JOB_LABEL]: this.record.id,
      },
      HostConfig: {
        Init: true,
        Memory: memory,
        MemorySwap: memory,
        NanoCpus: Math.round(config.docker.cpus * 1e9),
        PidsLimit: config.docker.pidsLimit,
        NetworkMode: config.docker.networkEnabled ? 'bridge' : 'none',
        ReadonlyRootfs: true,
        Tmpfs: { [WORKDIR]: tmpfs, '/tmp': tmpfs },
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 1024 }],
        AutoRemove: false,
        ...(config.docker.runtime ? { Runtime: config.docker.runtime } : {}),
      },
    };
  }

  async run(): Promise<ExecutionResult> {
    let started = Date.now();
    const output = new OutputCollector(config.jobs.maxOutputBytes, this.onOutput);
    let timer: NodeJS.Timeout | undefined;

    try {
      if (this.killReason) return this.result(output, started, null);
      const image = this.image();
      await ensureImage(this.docker, image);

      const container = await this.docker.createContainer(this.containerOptions());
      this.container = container;
      if (this.killReason) return this.result(output, started, null);

      const stream = await container.attach({ stream: true, stdout: true, stderr: true });
      const streamEnded = new Promise<void>((resolve) => {
        stream.on('end', resolve);
        stream.on('close', resolve);
        stream.on('error', () => resolve());
      });
      container.modem.demuxStream(
        stream,
        { write: (chunk: Buffer) => output.push('stdout', chunk) } as unknown as NodeJS.WritableStream,
        { write: (chunk: Buffer) => output.push('stderr', chunk) } as unknown as NodeJS.WritableStream
      );

      await container.start();
      // Measure execution only, not image pulls or container creation.
      started = Date.now();
      this.log.info('Container started', { image, container: container.id.slice(0, 12) });
      timer = setTimeout(() => void this.kill('timeout'), this.record.timeoutMs);

      const { StatusCode } = (await container.wait()) as { StatusCode: number };
      clearTimeout(timer);
      await Promise.race([streamEnded, delay(1000)]);
      output.finish();
      return this.result(output, started, StatusCode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('Docker execution failed', { error: message });
      return { ...this.result(output, started, null), outcome: 'failed', error: `Sandbox error: ${message}` };
    } finally {
      if (timer) clearTimeout(timer);
      await this.remove();
    }
  }

  private result(output: OutputCollector, started: number, code: number | null): ExecutionResult {
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
      error = code === 137 ? 'Process killed (exit 137): likely exceeded the memory limit' : `Process exited with code ${code}`;
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

  async kill(reason: KillReason): Promise<void> {
    if (this.killReason) return;
    this.killReason = reason;
    if (!this.container) return;
    this.log.info('Stopping container', { reason });
    try {
      await this.container.stop({ t: Math.max(1, Math.ceil(config.workers.killGraceMs / 1000)) });
    } catch (err: any) {
      // 304 = already stopped, 404 = already removed
      if (err?.statusCode !== 304 && err?.statusCode !== 404) {
        this.log.warn('Failed to stop container', { error: err?.message });
      }
    }
  }

  private async remove(): Promise<void> {
    if (!this.container) return;
    try {
      await this.container.remove({ force: true });
    } catch (err: any) {
      if (err?.statusCode !== 404) this.log.warn('Failed to remove container', { error: err?.message });
    }
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pulling = new Map<string, Promise<void>>();

export async function ensureImage(docker: Docker, image: string): Promise<void> {
  const policy = config.docker.pullPolicy;
  if (policy !== 'always') {
    try {
      await docker.getImage(image).inspect();
      return;
    } catch (err: any) {
      if (err?.statusCode !== 404) throw err;
      if (policy === 'never') throw new Error(`Image ${image} is not present and DOCKER_PULL_POLICY=never`);
    }
  }
  // De-duplicate concurrent pulls of the same image.
  let p = pulling.get(image);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err2: Error | null) => (err2 ? reject(err2) : resolve()));
      });
    }).finally(() => pulling.delete(image));
    pulling.set(image, p);
  }
  await p;
}

/** Remove containers this worker left behind (e.g. after a crash). */
export async function removeOrphanContainers(docker: Docker = getDocker()): Promise<number> {
  const log = createLogger('docker');
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`${MANAGED_LABEL}=true`, `${WORKER_LABEL}=${workerName()}`] },
  });
  await Promise.all(
    containers.map((c) => docker.getContainer(c.Id).remove({ force: true }).catch(() => undefined))
  );
  if (containers.length) log.warn('Removed orphaned job containers', { count: containers.length });
  return containers.length;
}

export async function dockerAvailable(docker: Docker = getDocker()): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

export default DockerExecutor;
