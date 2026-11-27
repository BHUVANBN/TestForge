import { randomBytes } from 'crypto';
import Docker from 'dockerode';
import os from 'os';
import { PassThrough } from 'stream';
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
import { extractTar, readStreamCapped } from './artifacts';

const WORKDIR = '/workspace';
const ARTIFACTS_DIR = `${WORKDIR}/artifacts`;
const SCRIPT_ENV = 'TESTFORGE_SCRIPT';

/**
 * Container entrypoint. Runs the job as a child so SIGTERM is forwarded, then
 * prints a random completion marker and stays alive briefly so the worker can
 * read /workspace/artifacts from the tmpfs (which vanishes once the container
 * stops). On cancel/timeout it exits immediately instead.
 * $0 is the marker; in script mode $1 is the script path.
 */
const WRAPPER_PRELUDE = `mkdir -p "$TESTFORGE_ARTIFACTS" || exit 125`;
const WRAPPER_SCRIPT = `printf '%s' "$${SCRIPT_ENV}" > "$1" || exit 125; unset ${SCRIPT_ENV}; shift`;
const WRAPPER_RUN = [
  `"$@" </dev/null &`,
  `p=$!`,
  `trap 'k=1; kill -TERM "$p" 2>/dev/null' TERM INT`,
  `wait "$p"; c=$?`,
  `while kill -0 "$p" 2>/dev/null; do wait "$p"; c=$?; done`,
  `[ -n "\${k:-}" ] && exit "$c"`,
  // Reap anything the job left running (kill -1 spares this shell and init).
  `kill -KILL -1 2>/dev/null`,
  `printf '\\n%s:%s\\n' "$0" "$c"`,
  `exec sleep 600`,
].join('\n');

/**
 * Passes stdout through while watching for the completion marker. Holds back
 * a short tail so the marker itself never reaches the job's recorded output.
 */
export class MarkerFilter {
  private pending = Buffer.alloc(0);
  private finished = false;
  private readonly pattern: RegExp;
  private readonly holdback: number;

  constructor(
    marker: string,
    private readonly forward: (chunk: Buffer) => void,
    private readonly onMarker: (exitCode: number) => void
  ) {
    this.pattern = new RegExp(`\\n${marker}:(\\d+)\\n`);
    this.holdback = marker.length + 8;
  }

  push(chunk: Buffer): void {
    if (this.finished) return;
    this.pending = Buffer.concat([this.pending, chunk]);
    const m = this.pending.toString('latin1').match(this.pattern);
    if (m && m.index !== undefined) {
      this.finished = true;
      if (m.index > 0) this.forward(this.pending.subarray(0, m.index));
      this.pending = Buffer.alloc(0);
      this.onMarker(Number(m[1]));
      return;
    }
    if (this.pending.length > this.holdback) {
      this.forward(this.pending.subarray(0, this.pending.length - this.holdback));
      this.pending = this.pending.subarray(this.pending.length - this.holdback);
    }
  }

  flush(): void {
    if (!this.finished && this.pending.length) this.forward(this.pending);
    this.pending = Buffer.alloc(0);
  }
}
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

  /** Container argv. `marker` must be unpredictable to the job. */
  command(marker: string): string[] {
    if (this.record.script !== undefined) {
      const runtime = RUNTIMES[this.record.language ?? 'bash'];
      const file = `${WORKDIR}/${runtime.fileName}`;
      // The script arrives via an env var (no bind mounts needed) and is
      // written to the tmpfs workspace before running.
      const body = [WRAPPER_PRELUDE, WRAPPER_SCRIPT, WRAPPER_RUN].join('\n');
      return ['sh', '-c', body, marker, file, ...runtime.interpreter, file];
    }
    if (!this.record.command) throw new Error('Job has neither a script nor a command');
    const body = [WRAPPER_PRELUDE, WRAPPER_RUN].join('\n');
    return ['sh', '-c', body, marker, this.record.command, ...(this.record.args ?? [])];
  }

  containerOptions(marker = newMarker()): Docker.ContainerCreateOptions {
    const memory = config.docker.memoryMB * 1024 * 1024;
    const tmpfs = `rw,exec,nosuid,nodev,size=${config.docker.tmpfsSizeMB}m,mode=1777`;
    const env = Object.entries(jobEnvironment(this.record, WORKDIR, ARTIFACTS_DIR)).map(([k, v]) => `${k}=${v}`);
    if (this.record.script !== undefined) env.push(`${SCRIPT_ENV}=${this.record.script}`);

    return {
      Image: this.image(),
      Cmd: this.command(marker),
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

      const marker = newMarker();
      const container = await this.docker.createContainer(this.containerOptions(marker));
      this.container = container;
      if (this.killReason) return this.result(output, started, null);

      let markerSeen: (code: number) => void = () => undefined;
      const finished = new Promise<number>((resolve) => (markerSeen = resolve));
      const stdout = new MarkerFilter(marker, (chunk) => output.push('stdout', chunk), (code) => markerSeen(code));

      const stream = await container.attach({ stream: true, stdout: true, stderr: true });
      const streamEnded = new Promise<void>((resolve) => {
        stream.on('end', resolve);
        stream.on('close', resolve);
        stream.on('error', () => resolve());
      });
      container.modem.demuxStream(
        stream,
        { write: (chunk: Buffer) => stdout.push(chunk) } as unknown as NodeJS.WritableStream,
        { write: (chunk: Buffer) => output.push('stderr', chunk) } as unknown as NodeJS.WritableStream
      );

      await container.start();
      // Measure execution only, not image pulls or container creation.
      started = Date.now();
      this.log.info('Container started', { image, container: container.id.slice(0, 12) });
      timer = setTimeout(() => void this.kill('timeout'), this.record.timeoutMs);

      const end = await Promise.race([
        finished.then((code) => ({ via: 'marker' as const, code })),
        container.wait().then((r: { StatusCode: number }) => ({ via: 'exit' as const, code: r.StatusCode })),
      ]);
      clearTimeout(timer);
      const durationMs = Date.now() - started;

      let artifacts: Awaited<ReturnType<typeof this.collectArtifacts>> = { artifacts: [], truncated: false };
      if (end.via === 'marker') {
        artifacts = await this.collectArtifacts(container);
        await container.kill().catch(() => undefined);
      } else {
        await Promise.race([streamEnded, delay(1000)]);
        stdout.flush();
      }
      output.finish();
      return {
        ...this.result(output, Date.now() - durationMs, end.code),
        artifacts: artifacts.artifacts,
        artifactsTruncated: artifacts.truncated,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('Docker execution failed', { error: message });
      return { ...this.result(output, started, null), outcome: 'failed', error: `Sandbox error: ${message}` };
    } finally {
      if (timer) clearTimeout(timer);
      await this.remove();
    }
  }

  /**
   * Copy /workspace/artifacts out of the still-running container. Docker's
   * archive API can't see tmpfs mounts, so run `tar` inside the container
   * (same mount namespace, same unprivileged user). Requires tar in the image
   * (all default Alpine-based runtimes have it).
   */
  private async collectArtifacts(container: Docker.Container) {
    const limits = config.artifacts;
    if (limits.maxFiles === 0 || limits.maxBytes === 0) return { artifacts: [], truncated: false };
    try {
      const exec = await container.exec({
        Cmd: ['tar', '-cf', '-', '-C', ARTIFACTS_DIR, '.'],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      const tarOut = new PassThrough();
      container.modem.demuxStream(stream, tarOut, new PassThrough());
      stream.on('end', () => tarOut.end());
      stream.on('close', () => tarOut.end());
      stream.on('error', (e: Error) => tarOut.destroy(e));
      // tar adds 512-byte headers + padding per file.
      const capped = readStreamCapped(tarOut, limits.maxBytes + (limits.maxFiles + 2) * 1536);
      const timeout = delay(30_000).then(() => {
        throw new Error('timed out reading artifacts');
      });
      const { data, truncated } = await Promise.race([capped, timeout]);
      (stream as any).destroy?.();
      const res = extractTar(data, limits, './');
      return { artifacts: res.artifacts, truncated: res.truncated || truncated };
    } catch (err: any) {
      this.log.warn('Could not collect artifacts', { error: err?.message });
      return { artifacts: [], truncated: false };
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
const newMarker = () => `__TESTFORGE_DONE_${randomBytes(12).toString('hex')}__`;
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
