/**
 * S3ArtifactStore against an in-memory fake (always) and a real S3-compatible
 * endpoint when S3_TEST_ENDPOINT is set, e.g. SeaweedFS:
 *   docker run -d -p 8490:8333 chrislusf/seaweedfs server -s3
 *   S3_TEST_ENDPOINT=http://127.0.0.1:8490 npm test
 */
import { S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { S3ArtifactStore, S3Like } from '../src/jobs/artifacts';

const read = async (s: Readable) => {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
};

class FakeS3 implements S3Like {
  objects = new Map<string, Buffer>();
  buckets = new Set<string>();
  calls: string[] = [];
  async send(cmd: any): Promise<any> {
    const name = cmd.constructor.name as string;
    const { Bucket, Key } = cmd.input;
    this.calls.push(name);
    const notFound = () => Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
    switch (name) {
      case 'HeadBucketCommand':
        if (!this.buckets.has(Bucket)) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
        return {};
      case 'CreateBucketCommand':
        this.buckets.add(Bucket);
        return {};
      case 'PutObjectCommand':
        this.objects.set(`${Bucket}/${Key}`, Buffer.from(cmd.input.Body));
        return {};
      case 'GetObjectCommand': {
        const data = this.objects.get(`${Bucket}/${Key}`);
        if (!data) throw notFound();
        return { Body: Object.assign(Readable.from([data]), { transformToString: async () => data.toString() }) };
      }
      case 'DeleteObjectsCommand':
        cmd.input.Delete.Objects.forEach((o: any) => this.objects.delete(`${Bucket}/${o.Key}`));
        return {};
      default:
        throw new Error(`unexpected ${name}`);
    }
  }
}

describe('S3ArtifactStore (fake S3)', () => {
  it('stores objects plus an index, and replaces a previous attempt', async () => {
    const s3 = new FakeS3();
    const store = new S3ArtifactStore({ client: s3, bucket: 'b', prefix: 'tf', createBucket: true });
    await store.save('job1', [
      { name: 'a.txt', data: Buffer.from('A') },
      { name: 'dir/b.bin', data: Buffer.from([0, 255]) },
      { name: 'c.txt', data: Buffer.from('C') },
    ]);
    expect(s3.calls.slice(0, 2)).toEqual(['HeadBucketCommand', 'CreateBucketCommand']);
    expect([...s3.objects.keys()].sort()).toEqual([
      'b/tf/jobs/job1/artifacts/0',
      'b/tf/jobs/job1/artifacts/1',
      'b/tf/jobs/job1/artifacts/2',
      'b/tf/jobs/job1/artifacts/index.json',
    ]);
    expect(await store.list('job1')).toEqual([
      { name: 'a.txt', size: 1 },
      { name: 'dir/b.bin', size: 2 },
      { name: 'c.txt', size: 1 },
    ]);
    expect(await read((await store.get('job1', 'dir/b.bin'))!.stream)).toEqual(Buffer.from([0, 255]));

    await store.save('job1', [{ name: 'only.txt', data: Buffer.from('x') }]);
    expect(s3.objects.has('b/tf/jobs/job1/artifacts/1')).toBe(false);
    expect(await store.list('job1')).toEqual([{ name: 'only.txt', size: 1 }]);
    expect(s3.calls.filter((c) => c === 'CreateBucketCommand')).toHaveLength(1);
  });

  it('returns empty / null for unknown jobs and names', async () => {
    const store = new S3ArtifactStore({ client: new FakeS3(), bucket: 'b' });
    expect(await store.list('nope')).toEqual([]);
    expect(await store.get('nope', 'x')).toBeNull();
  });
});

const endpoint = process.env.S3_TEST_ENDPOINT;
(endpoint ? describe : describe.skip)('S3ArtifactStore (real S3-compatible endpoint)', () => {
  it('round-trips binary artifacts', async () => {
    const client = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const store = new S3ArtifactStore({ client, bucket: `tf-test-${Date.now()}`, prefix: 'it', createBucket: true });
    const bin = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 256));
    await store.save('job-real', [
      { name: 'report.xml', data: Buffer.from('<testsuite/>') },
      { name: 'blob.bin', data: bin },
    ]);
    expect(await store.list('job-real')).toEqual([
      { name: 'report.xml', size: 12 },
      { name: 'blob.bin', size: 70_000 },
    ]);
    expect((await read((await store.get('job-real', 'blob.bin'))!.stream)).equals(bin)).toBe(true);
    expect(await store.get('job-real', 'missing')).toBeNull();
    client.destroy();
  });
});
