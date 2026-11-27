import { EventEmitter } from 'events';
import config from '../src/config';
import { DockerExecutor, ensureImage, removeOrphanContainers } from '../src/workers/dockerExecutor';
import { makeRecord } from './helpers';

function fakeDocker(opts: { exitCode?: number; waitMs?: number; imagePresent?: boolean; stdout?: string; stderr?: string } = {}) {
  const stream = new EventEmitter();
  let resolveWait: (v: { StatusCode: number }) => void = () => undefined;
  const container = {
    id: 'abc123def4567890',
    modem: {
      demuxStream: (_s: unknown, out: any, err: any) => {
        setTimeout(() => {
          if (opts.stdout) out.write(Buffer.from(opts.stdout));
          if (opts.stderr) err.write(Buffer.from(opts.stderr));
        }, 5);
      },
    },
    attach: jest.fn(async () => stream),
    start: jest.fn(async () => {
      if (opts.waitMs !== undefined && opts.waitMs >= 0) {
        setTimeout(() => {
          stream.emit('end');
          resolveWait({ StatusCode: opts.exitCode ?? 0 });
        }, opts.waitMs);
      }
    }),
    wait: jest.fn(() => new Promise((r) => (resolveWait = r))),
    stop: jest.fn(async () => {
      stream.emit('end');
      resolveWait({ StatusCode: 143 });
    }),
    remove: jest.fn(async () => undefined),
  };
  const docker = {
    createContainer: jest.fn(async () => container),
    getImage: jest.fn(() => ({
      inspect: opts.imagePresent === false ? jest.fn().mockRejectedValue({ statusCode: 404 }) : jest.fn().mockResolvedValue({}),
    })),
    pull: jest.fn((_img: string, cb: any) => cb(null, new EventEmitter())),
    modem: { followProgress: jest.fn((_s: unknown, done: any) => done(null)) },
    listContainers: jest.fn(async () => [{ Id: 'orphan1' }]),
    getContainer: jest.fn(() => ({ remove: jest.fn(async () => undefined) })),
  };
  return { docker: docker as any, container };
}

describe('DockerExecutor', () => {
  it('builds a locked-down container spec', () => {
    const { docker } = fakeDocker();
    const exec = new DockerExecutor(makeRecord({ language: 'python', script: 'print(1)', env: { FOO: 'bar' } }), undefined, docker);
    const spec = exec.containerOptions();
    expect(spec.Image).toBe(config.docker.images.python);
    expect(spec.User).toBe('65534:65534');
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Init: true,
      PidsLimit: config.docker.pidsLimit,
      Memory: config.docker.memoryMB * 1024 * 1024,
    });
    expect(spec.HostConfig?.Binds).toBeUndefined();
    expect(spec.HostConfig?.Privileged).toBeUndefined();
    expect(spec.Env).toEqual(expect.arrayContaining(['FOO=bar', 'TESTFORGE_SCRIPT=print(1)', 'HOME=/workspace']));
    expect(spec.Env?.some((e) => e.startsWith('PATH='))).toBe(false);
    expect(spec.Cmd?.slice(-3)).toEqual(['/workspace/script.py', 'python3', '/workspace/script.py']);
    expect(spec.Labels?.['testforge.job']).toBe(makeRecord().id);
  });

  it('runs commands directly with an image picked from the command', () => {
    const { docker } = fakeDocker();
    const exec = new DockerExecutor(makeRecord({ script: undefined, language: undefined, command: 'npm', args: ['test'] }), undefined, docker);
    expect(exec.command()).toEqual(['npm', 'test']);
    expect(exec.image()).toBe(config.docker.images.node);
  });

  it('collects output and maps exit codes', async () => {
    const { docker, container } = fakeDocker({ exitCode: 0, waitMs: 20, stdout: 'ok\n', stderr: 'warn\n' });
    const res = await new DockerExecutor(makeRecord(), undefined, docker).run();
    expect(res).toMatchObject({ outcome: 'completed', exitCode: 0, stdout: 'ok\n', stderr: 'warn\n' });
    expect(container.remove).toHaveBeenCalledWith({ force: true });
  });

  it('reports failures and OOM kills', async () => {
    const failed = await new DockerExecutor(makeRecord(), undefined, fakeDocker({ exitCode: 2, waitMs: 10 }).docker).run();
    expect(failed).toMatchObject({ outcome: 'failed', exitCode: 2 });
    const oom = await new DockerExecutor(makeRecord(), undefined, fakeDocker({ exitCode: 137, waitMs: 10 }).docker).run();
    expect(oom.error).toMatch(/memory limit/);
  });

  it('stops the container on timeout', async () => {
    const { docker, container } = fakeDocker({ waitMs: -1 });
    const res = await new DockerExecutor(makeRecord({ timeoutMs: 100 }), undefined, docker).run();
    expect(res.outcome).toBe('timeout');
    expect(container.stop).toHaveBeenCalled();
    expect(container.remove).toHaveBeenCalled();
  });

  it('cancels a running container', async () => {
    const { docker, container } = fakeDocker({ waitMs: -1 });
    const exec = new DockerExecutor(makeRecord(), undefined, docker);
    const pending = exec.run();
    await new Promise((r) => setTimeout(r, 20));
    await exec.kill('cancel');
    expect((await pending).outcome).toBe('cancelled');
    expect(container.stop).toHaveBeenCalled();
  });

  it('turns daemon errors into failed results', async () => {
    const { docker } = fakeDocker();
    docker.createContainer.mockRejectedValue(new Error('no space left'));
    const res = await new DockerExecutor(makeRecord(), undefined, docker).run();
    expect(res).toMatchObject({ outcome: 'failed', error: 'Sandbox error: no space left' });
  });

  it('pulls images only when missing', async () => {
    const present = fakeDocker();
    await ensureImage(present.docker, 'bash:5.2');
    expect(present.docker.pull).not.toHaveBeenCalled();
    const missing = fakeDocker({ imagePresent: false });
    await ensureImage(missing.docker, 'bash:5.2');
    expect(missing.docker.pull).toHaveBeenCalledTimes(1);
  });

  it('removes orphaned containers from a previous run', async () => {
    const { docker } = fakeDocker();
    expect(await removeOrphanContainers(docker)).toBe(1);
    expect(docker.listContainers.mock.calls[0][0].filters.label).toContain('testforge.managed=true');
  });
});
