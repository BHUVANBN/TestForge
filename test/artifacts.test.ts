import fs from 'fs';
import os from 'os';
import path from 'path';
import { ArtifactStore } from '../src/jobs/artifacts';
import { collectFromDirectory, extractTar, safeArtifactName } from '../src/workers/artifacts';
import { LocalExecutor } from '../src/workers/executor';
import { makeRecord, makeTar, mockRedis, resetRedis } from './helpers';

const limits = { maxBytes: 1000, maxFiles: 5 };

describe('artifact names', () => {
  it.each([
    ['report.xml', 'report.xml'],
    ['./logs//a.txt', 'logs/a.txt'],
    ['../etc/passwd', null],
    ['a/../../b', null],
    ['', null],
    ['bad\u0001name', null],
  ])('%j -> %j', (input, expected) => expect(safeArtifactName(input)).toBe(expected));
});

describe('extractTar', () => {
  it('extracts regular files and strips the top directory', () => {
    const res = extractTar(makeTar({ 'a.txt': 'A', 'dir/b.txt': 'BB' }), limits);
    expect(res.artifacts.map((a) => [a.name, a.data.toString()])).toEqual([
      ['a.txt', 'A'],
      ['dir/b.txt', 'BB'],
    ]);
    expect(res.truncated).toBe(false);
  });

  it('enforces size and count limits', () => {
    const big = extractTar(makeTar({ 'a.bin': 'x'.repeat(600), 'b.bin': 'y'.repeat(600) }), limits);
    expect(big.artifacts.map((a) => a.name)).toEqual(['a.bin']);
    expect(big.truncated).toBe(true);

    const many = extractTar(makeTar(Object.fromEntries([...Array(8)].map((_, i) => [`f${i}`, 'z']))), limits);
    expect(many.artifacts).toHaveLength(5);
    expect(many.truncated).toBe(true);
  });

  it('reports archives cut short', () => {
    const tar = makeTar({ 'a.txt': 'x'.repeat(2000) });
    expect(extractTar(tar.subarray(0, 1024), { maxBytes: 10_000, maxFiles: 5 }).truncated).toBe(true);
  });
});

describe('collectFromDirectory', () => {
  it('reads files recursively and never follows symlinks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-art-'));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'B');
    fs.symlinkSync('/etc/passwd', path.join(dir, 'leak'));
    const res = await collectFromDirectory(dir, limits);
    expect(res.artifacts.map((a) => a.name)).toEqual(['a.txt', 'sub/b.txt']);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('local executor artifacts', () => {
  it('collects files written to $TESTFORGE_ARTIFACTS', async () => {
    const res = await new LocalExecutor(
      makeRecord({ script: 'echo "<testsuite><testcase name=\\"t\\"/></testsuite>" > "$TESTFORGE_ARTIFACTS/junit.xml"' })
    ).run();
    expect(res.outcome).toBe('completed');
    expect(res.artifacts?.map((a) => a.name)).toEqual(['junit.xml']);
  });
});

describe('ArtifactStore', () => {
  const redis = mockRedis();
  const store = new ArtifactStore(redis);
  beforeEach(() => resetRedis(redis));

  it('saves, lists and fetches binary artifacts', async () => {
    const bin = Buffer.from([0, 1, 2, 255]);
    await store.save('job-1', [
      { name: 'a.bin', data: bin },
      { name: 'b.txt', data: Buffer.from('hi') },
    ]);
    expect(await store.list('job-1')).toEqual([
      { name: 'a.bin', size: 4 },
      { name: 'b.txt', size: 2 },
    ]);
    const file = await store.get('job-1', 'a.bin');
    const chunks: Buffer[] = [];
    for await (const c of file!.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(bin)).toBe(true);
    expect(await store.get('job-1', 'missing')).toBeNull();
  });
});
