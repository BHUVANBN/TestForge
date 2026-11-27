import type Redis from 'ioredis';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { channels, LogEvent, StatusEvent } from '../jobs/events';
import { getJobService, JobService, summarize } from '../jobs/service';
import { createRedis } from '../queue/redis';
import { createLogger } from '../utils/logger';
import { Principal } from '../utils/types';
import { principalForKey } from './middleware/auth';

const log = createLogger('realtime');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Socket.IO protocol
 *  client → server: subscribe-job(jobId), unsubscribe-job(jobId)
 *  server → client: job-state {job}, job-status {StatusEvent}, job-log {jobId, stream, data},
 *                   job-error {jobId, error}
 * Clients authenticate with `io({ auth: { apiKey } })`.
 */
export function attachRealtime(
  io: SocketIOServer,
  opts: { service?: JobService; subscriber?: Redis } = {}
): () => Promise<void> {
  const service = () => opts.service ?? getJobService();

  io.use((socket, next) => {
    const key =
      (socket.handshake.auth as Record<string, unknown> | undefined)?.apiKey ??
      socket.handshake.headers['x-api-key'];
    const principal = principalForKey(typeof key === 'string' ? key : undefined);
    if (!principal) return next(new Error('unauthorized'));
    socket.data.principal = principal;
    next();
  });

  io.on('connection', (socket: Socket) => {
    const principal = socket.data.principal as Principal;
    socket.join(`owner:${principal.id}`);
    if (principal.admin) socket.join('admins');

    socket.on('subscribe-job', async (jobId: unknown) => {
      if (typeof jobId !== 'string' || !UUID.test(jobId)) {
        socket.emit('job-error', { jobId, error: 'Invalid job id' });
        return;
      }
      try {
        const record = await service().get(jobId, principal);
        await socket.join(`job:${jobId}`);
        socket.emit('job-state', { jobId, job: summarize(record) });
      } catch {
        socket.emit('job-error', { jobId, error: 'Job not found' });
      }
    });

    socket.on('unsubscribe-job', (jobId: unknown) => {
      if (typeof jobId === 'string') void socket.leave(`job:${jobId}`);
    });
  });

  const subscriber = opts.subscriber ?? createRedis('api-events-sub');
  void subscriber.subscribe(channels.status(), channels.logs()).catch((err) =>
    log.error('Failed to subscribe to job events', { error: err.message })
  );
  subscriber.on('message', (channel: string, message: string) => {
    try {
      if (channel === channels.status()) {
        const e = JSON.parse(message) as StatusEvent;
        io.to(`job:${e.jobId}`).to(`owner:${e.owner}`).to('admins').emit('job-status', e);
      } else if (channel === channels.logs()) {
        const e = JSON.parse(message) as LogEvent;
        io.to(`job:${e.jobId}`).emit('job-log', { jobId: e.jobId, stream: e.stream, data: e.data });
      }
    } catch {
      /* ignore malformed */
    }
  });

  return async () => {
    await subscriber.quit().catch(() => undefined);
  };
}
