import { EventEmitter } from 'events';
import config from '../src/config';
import { DockerExecutor, ensureImage, MarkerFilter, removeOrphanContainers } from '../src/workers/dockerExecutor';
import { makeRecord, makeTar } from './helpers';

interface FakeOpts {
  /** Exit code reported through the completion marker (normal finish). */
  markerExit?: number;
  /** Container exits without the marker (e.g. wrapper killed) with this code. */
  exitCode?: number;
  /** Never finish on its own (timeout / cancel tests). */
  hang?: boolean;
  imagePresent?: boolean;
  stdout?: string;
  stderr?: string;
  artifacts?: Record<string, string>;
}

function fakeDocker(opts: FakeOpts = {}) {
  const stream = new EventEmitter();
  let out: any;
  let err: any;
  let marker = '';
  let resolveWait: (v: { StatusCode: number }) => void = () => undefined;
  const container = {
    id: 'abc123def4567890',
    modem: {
      demuxStream: (s: any, o: any, e: any) => {
        if (s.isExec) {
          // `tar -cf - -C /workspace/artifacts .` output
          setTimeout(() => {
            if (opts.artifacts) o.write(makeTar(opts.artifacts, './'));
            s.emit('end');
          }, 1);
          return;
        }
        out = o;
        err = e;
      },
    },
    attach: jest.fn(async () => stream),
    start: jest.fn(async () => {
      setTimeout(() => {
        if (opts.stdout) out.write(Buffer.from(opts.stdout));
        if (opts.stderr) err.write(Buffer.from(opts.stderr));
        if (opts.hang) return;
        if (opts.markerExit !== undefined) {
          // Split the marker across chunks to exercise the hold-back buffer.
          const m = Buffer.from(`\n${marker}:${opts.markerExit}\n`);
          out.write(m.subarray(0, 10));
          out.write(m.subarray(10));
        } else {
          stream.emit('end');
          resolveWait({ StatusCode: opts.exitCode ?? 0 });
        }
      }, 5);
    }),
    wait: jest.fn(() => new Promise((r) => (resolveWait = r))),
    stop: jest.fn(async () => {
      stream.emit('end');
      resolveWait({ StatusCode: 143 });
    }),
    kill: jest.fn(async () => resolveWait({ StatusCode: 137 })),
    exec: jest.fn(async () => ({
      start: async () => Object.assign(new EventEmitter(), { isExec: true, destroy: () => undefined }),
    })),
    remove: jest.fn(async () => undefined),
  };
  const docker = {
    createContainer: jest.fn(async (spec: any) => {
      marker = spec.Cmd[3];
      return container;
    }),
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
    const spec = exec.containerOptions('__MARK__');
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
    expect(spec.Env).toEqual(
      expect.arrayContaining(['FOO=bar', 'TESTFORGE_SCRIPT=print(1)', 'HOME=/workspace', 'TESTFORGE_ARTIFACTS=/workspace/artifacts'])
    );
    expect(spec.Env?.some((e) => e.startsWith('PATH='))).toBe(false);
    expect(spec.Cmd?.slice(0, 2)).toEqual(['sh', '-c']);
    expect(spec.Cmd?.slice(3)).toEqual(['__MARK__', '/workspace/script.py', 'python3', '/workspace/script.py']);
    expect(spec.Labels?.['testforge.job']).toBe(makeRecord().id);
  });

  it('runs commands through the wrapper with an image picked from the command', () => {
    const { docker } = fakeDocker();
    const exec = new DockerExecutor(makeRecord({ script: undefined, language: undefined, command: 'npm', args: ['test'] }), undefined, docker);
    expect(exec.command('__M__').slice(3)).toEqual(['__M__', 'npm', 'test']);
    expect(exec.image()).toBe(config.docker.images.node);
  });

  it('uses a fresh unpredictable marker per run', () => {
    const exec = new DockerExecutor(makeRecord(), undefined, fakeDocker().docker);
    const a = exec.containerOptions().Cmd![3];
    const b = exec.containerOptions().Cmd![3];
    expect(a).toMatch(/^__TESTFORGE_DONE_[0-9a-f]{24}__$/);
    expect(a).not.toBe(b);
  });

  it('collects output, hides the marker and gathers artifacts', async () => {
    const { docker, container } = fakeDocker({
      markerExit: 0,
      stdout: 'ok',
      stderr: 'warn\n',
      artifacts: { 'report.xml': '<testsuite/>', 'logs/app.log': 'hello' },
    });
    const res = await new DockerExecutor(makeRecord(), undefined, docker).run();
    expect(res).toMatchObject({ outcome: 'completed', exitCode: 0, stdout: 'ok', stderr: 'warn\n', artifactsTruncated: false });
    expect(res.artifacts?.map((a) => [a.name, a.data.toString()])).toEqual([
      ['report.xml', '<testsuite/>'],
      ['logs/app.log', 'hello'],
    ]);
    expect(container.exec).toHaveBeenCalledWith(expect.objectContaining({ Cmd: ['tar', '-cf', '-', '-C', '/workspace/artifacts', '.'] }));
    expect(container.kill).toHaveBeenCalled();
    expect(container.remove).toHaveBeenCalledWith({ force: true });
  });

  it('reports the job exit code from the marker', async () => {
    const res = await new DockerExecutor(makeRecord(), undefined, fakeDocker({ markerExit: 3 }).docker).run();
    expect(res).toMatchObject({ outcome: 'failed', exitCode: 3, error: 'Process exited with code 3', artifacts: [] });
  });

  it('handles containers that exit without the marker (OOM etc.)', async () => {
    const oom = await new DockerExecutor(makeRecord(), undefined, fakeDocker({ exitCode: 137 }).docker).run();
    expect(oom.error).toMatch(/memory limit/);
    const { docker, container } = fakeDocker({ exitCode: 0, stdout: 'partial' });
    const res = await new DockerExecutor(makeRecord(), undefined, docker).run();
    expect(res).toMatchObject({ outcome: 'completed', stdout: 'partial' });
    expect(container.exec).not.toHaveBeenCalled();
  });

  it('stops the container on timeout', async () => {
    const { docker, container } = fakeDocker({ hang: true });
    const res = await new DockerExecutor(makeRecord({ timeoutMs: 100 }), undefined, docker).run();
    expect(res.outcome).toBe('timeout');
    expect(container.stop).toHaveBeenCalled();
    expect(container.remove).toHaveBeenCalled();
  });

  it('cancels a running container', async () => {
    const { docker, container } = fakeDocker({ hang: true });
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

describe('MarkerFilter', () => {
  const MARK = '__TESTFORGE_DONE_0123456789abcdef01234567__';

  it('passes output through and stops at the marker', () => {
    const out: string[] = [];
    let code: number | null = null;
    const f = new MarkerFilter(MARK, (b) => out.push(b.toString()), (c) => (code = c));
    const text = `line one\nline two\n${MARK}:7\nignored`;
    for (let i = 0; i < text.length; i += 5) f.push(Buffer.from(text.slice(i, i + 5)));
    expect(out.join('')).toBe('line one\nline two');
    expect(code).toBe(7);
  });

  it('flushes held-back output when no marker arrives', () => {
    const out: string[] = [];
    const f = new MarkerFilter(MARK, (b) => out.push(b.toString()), () => undefined);
    f.push(Buffer.from('short'));
    expect(out.join('')).toBe('');
    f.flush();
    expect(out.join('')).toBe('short');
  });

  it('ignores a forged marker with the wrong nonce', () => {
    let code: number | null = null;
    const out: string[] = [];
    const f = new MarkerFilter(MARK, (b) => out.push(b.toString()), (c) => (code = c));
    f.push(Buffer.from('\n__TESTFORGE_DONE_ffffffffffffffffffffffff__:0\n'));
    f.flush();
    expect(code).toBeNull();
    expect(out.join('')).toContain('ffff');
  });
});
