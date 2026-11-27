import { execSync } from 'child_process';
import fs from 'fs';
import { LocalExecutor } from '../src/workers/executor';
import { OutputCollector } from '../src/workers/output';
import { makeRecord } from './helpers';

const run = (overrides: Parameters<typeof makeRecord>[0], onOutput?: any) =>
  new LocalExecutor(makeRecord(overrides), onOutput).run();

const processAlive = (marker: string) => {
  try {
    return execSync(`pgrep -f "[${marker[0]}]${marker.slice(1)}"`, { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return false;
  }
};

describe('LocalExecutor', () => {
  it('runs a bash script and captures output', async () => {
    const res = await run({ script: 'echo out; echo err >&2' });
    expect(res).toMatchObject({ outcome: 'completed', exitCode: 0, stdout: 'out\n', stderr: 'err\n', truncated: false });
  });

  it('runs scripts with the right interpreter', async () => {
    const res = await run({ language: 'node', script: 'console.log(typeof process.version)' });
    expect(res.stdout).toBe('string\n');
    const py = await run({ language: 'python', script: 'print(1 + 1)' });
    expect(py.stdout).toBe('2\n');
  });

  it('reports non-zero exits as failures', async () => {
    const res = await run({ script: 'exit 3' });
    expect(res).toMatchObject({ outcome: 'failed', exitCode: 3, error: 'Process exited with code 3' });
  });

  it('runs commands with arguments without a shell', async () => {
    const res = await run({ script: undefined, language: undefined, command: 'echo', args: ['$HOME', '; rm -rf /'] });
    expect(res.stdout).toBe('$HOME ; rm -rf /\n');
  });

  it('reports missing commands', async () => {
    const res = await run({ script: undefined, command: 'definitely-not-a-command-xyz' });
    expect(res).toMatchObject({ outcome: 'failed', error: 'Command not found: definitely-not-a-command-xyz' });
  });

  it('does not hang on programs that read stdin', async () => {
    const res = await run({ script: 'cat; echo done', timeoutMs: 5000 });
    expect(res).toMatchObject({ outcome: 'completed', stdout: 'done\n' });
  });

  it('does not leak the worker environment', async () => {
    process.env.SUPER_SECRET_TEST_VALUE = 'leaked';
    const res = await run({ script: 'echo "[$SUPER_SECRET_TEST_VALUE][$USER_VAR][$TESTFORGE_JOB_ID]"', env: { USER_VAR: 'ok' } });
    delete process.env.SUPER_SECRET_TEST_VALUE;
    expect(res.stdout).toBe(`[][ok][${makeRecord().id}]\n`);
  });

  it('runs in a private, cleaned-up working directory', async () => {
    const res = await run({ script: 'pwd; touch artifact.txt' });
    const dir = res.stdout.trim();
    expect(dir).toContain('testforge-tests/job-');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('times out and kills the whole process group', async () => {
    const marker = `tf-timeout-${Date.now()}`;
    const started = Date.now();
    const res = await run({ script: `(exec -a ${marker} sleep 30) & sleep 30`, timeoutMs: 1000 });
    expect(res.outcome).toBe('timeout');
    expect(res.error).toMatch(/Timed out after 1000ms/);
    expect(Date.now() - started).toBeLessThan(5000);
    await new Promise((r) => setTimeout(r, 200));
    expect(processAlive(marker)).toBe(false);
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const started = Date.now();
    const res = await run({ script: "trap '' TERM; while true; do sleep 0.1; done", timeoutMs: 500 });
    expect(res.outcome).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(4000); // timeout + 1s kill grace
  });

  it('reaps background processes left behind after a normal exit', async () => {
    const marker = `tf-orphan-${Date.now()}`;
    const res = await run({ script: `(exec -a ${marker} sleep 30) & echo started` });
    expect(res.outcome).toBe('completed');
    await new Promise((r) => setTimeout(r, 200));
    expect(processAlive(marker)).toBe(false);
  });

  it('cancels a running job', async () => {
    const exec = new LocalExecutor(makeRecord({ script: 'echo begin; sleep 30' }));
    const pending = exec.run();
    await new Promise((r) => setTimeout(r, 300));
    await exec.kill('cancel');
    const res = await pending;
    expect(res).toMatchObject({ outcome: 'cancelled', error: 'Cancelled by user', stdout: 'begin\n' });
  });

  it('cancels before start without running anything', async () => {
    const exec = new LocalExecutor(makeRecord({ script: 'echo should-not-run' }));
    await exec.kill('cancel');
    const res = await exec.run();
    expect(res).toMatchObject({ outcome: 'cancelled', stdout: '' });
  });

  it('reports shutdown interruption distinctly', async () => {
    const exec = new LocalExecutor(makeRecord({ script: 'sleep 30' }));
    const pending = exec.run();
    await new Promise((r) => setTimeout(r, 200));
    await exec.kill('shutdown');
    expect((await pending).outcome).toBe('interrupted');
  });

  it('streams output chunks to the listener', async () => {
    const chunks: string[] = [];
    await run({ script: 'echo one; echo two >&2' }, (stream: string, data: string) => chunks.push(`${stream}:${data}`));
    expect(chunks.join('')).toContain('stdout:one');
    expect(chunks.join('')).toContain('stderr:two');
  });
});

describe('OutputCollector', () => {
  it('caps total output and marks truncation', () => {
    const out = new OutputCollector(10);
    out.push('stdout', 'abcdefgh');
    out.push('stderr', 'ijklmnop');
    out.push('stdout', 'more');
    out.finish();
    expect(out.truncated).toBe(true);
    expect(out.stdout).toBe('abcdefgh');
    expect(out.stderr).toMatch(/^ij\n\[testforge\] output truncated/);
  });

  it('decodes multi-byte characters split across chunks', () => {
    const out = new OutputCollector(1000);
    const bytes = Buffer.from('héllo');
    out.push('stdout', bytes.subarray(0, 2));
    out.push('stdout', bytes.subarray(2));
    out.finish();
    expect(out.stdout).toBe('héllo');
  });
});
