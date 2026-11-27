import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { Server as SocketIOServer } from 'socket.io';
import { io as connect, Socket } from 'socket.io-client';
import { attachRealtime } from '../src/api/realtime';
import { publishLog, publishStatus } from '../src/jobs/events';
import { JobService } from '../src/jobs/service';
import { JobStore } from '../src/jobs/store';
import { FakeQueue, makeRecord, mockRedis, OTHER_KEY, resetRedis, USER_KEY } from './helpers';
import { principalForKey } from '../src/api/middleware/auth';

const redis = mockRedis();
const store = new JobStore(redis);
const service = new JobService(store, new FakeQueue() as any);

let http: Server;
let io: SocketIOServer;
let close: () => Promise<void>;
let url: string;
const clients: Socket[] = [];

const client = (apiKey?: string) => {
  const s = connect(url, { auth: apiKey ? { apiKey } : {}, transports: ['websocket'], reconnection: false });
  clients.push(s);
  return s;
};
const once = <T>(s: Socket, event: string) => new Promise<T>((r) => s.once(event, r));

beforeAll(async () => {
  http = createServer();
  io = new SocketIOServer(http);
  close = attachRealtime(io, { service, subscriber: (redis as any).duplicate() });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(() => clients.splice(0).forEach((c) => c.close()));

afterAll(async () => {
  await close();
  io.close();
});

describe('realtime', () => {
  beforeEach(() => resetRedis(redis));

  it('rejects connections without a valid key', async () => {
    const err = await once<Error>(client(), 'connect_error');
    expect(err.message).toBe('unauthorized');
    const err2 = await once<Error>(client('wrong-key-wrong-key'), 'connect_error');
    expect(err2.message).toBe('unauthorized');
  });

  it('streams status and logs for jobs the user owns', async () => {
    const owner = principalForKey(USER_KEY)!;
    const rec = makeRecord({ owner: owner.id });
    await store.create(rec);

    const s = client(USER_KEY);
    await once(s, 'connect');
    s.emit('subscribe-job', rec.id);
    const state = await once<any>(s, 'job-state');
    expect(state.job).toMatchObject({ jobId: rec.id, status: 'queued' });

    const log = once<any>(s, 'job-log');
    await publishLog({ jobId: rec.id, owner: owner.id, stream: 'stdout', data: 'line 1\n' }, redis);
    expect(await log).toEqual({ jobId: rec.id, stream: 'stdout', data: 'line 1\n' });

    const status = once<any>(s, 'job-status');
    await publishStatus({ jobId: rec.id, owner: owner.id, status: 'completed', exitCode: 0 }, redis);
    expect(await status).toMatchObject({ jobId: rec.id, status: 'completed' });
  });

  it('refuses subscriptions to other users\' jobs', async () => {
    const owner = principalForKey(USER_KEY)!;
    const rec = makeRecord({ owner: owner.id });
    await store.create(rec);

    const intruder = client(OTHER_KEY);
    await once(intruder, 'connect');
    intruder.emit('subscribe-job', rec.id);
    expect(await once<any>(intruder, 'job-error')).toMatchObject({ error: 'Job not found' });

    let leaked = false;
    intruder.on('job-log', () => (leaked = true));
    await publishLog({ jobId: rec.id, owner: owner.id, stream: 'stdout', data: 'secret' }, redis);
    await new Promise((r) => setTimeout(r, 100));
    expect(leaked).toBe(false);
  });
});
