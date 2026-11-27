import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { detail, getJobService, JobError, JobService, parseSubmission, summarize } from '../../jobs/service';
import { asyncHandler } from '../util';
import { ArtifactRepository, getArtifactStore } from '../../jobs/artifacts';

/** Report artifact-storage outages as 503 rather than a generic 500. */
async function storage<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new JobError(503, 'Artifact storage is temporarily unavailable', [err instanceof Error ? err.message : String(err)]);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createJobsRouter(
  opts: { service?: JobService; submitLimiter?: RequestHandler; artifacts?: ArtifactRepository } = {}
): Router {
  const router = Router();
  const svc = () => opts.service ?? getJobService();
  const limit: RequestHandler = opts.submitLimiter ?? ((_req, _res, next) => next());
  const artifacts = () => opts.artifacts ?? getArtifactStore();

  router.param('jobId', (req: Request, res: Response, next: NextFunction, id: string) => {
    if (!UUID.test(id)) {
      res.status(404).json({ success: false, error: 'Job not found' });
      return;
    }
    next();
  });

  const submit = asyncHandler(async (req, res) => {
    const spec = parseSubmission(req.body);
    const record = await svc().submit(spec, req.principal!);
    res.status(201).location(`/api/v1/jobs/${record.id}`).json({
      success: true,
      data: { jobId: record.id, status: record.status, submittedAt: record.createdAt },
    });
  });

  router.post('/jobs', limit, submit);
  /** @deprecated alias of POST /jobs */
  router.post('/submit-test', limit, submit);

  router.get(
    '/jobs',
    asyncHandler(async (req, res) => {
      res.json({ success: true, data: await svc().list(req.principal!, req.query) });
    })
  );

  router.get(
    '/jobs/:jobId',
    asyncHandler(async (req, res) => {
      res.json({ success: true, data: detail(await svc().get(req.params.jobId, req.principal!)) });
    })
  );

  router.get(
    '/status/:jobId',
    asyncHandler(async (req, res) => {
      const { record, output } = await svc().getOutput(req.params.jobId, req.principal!);
      res.json({
        success: true,
        data: {
          ...summarize(record),
          attemptsMade: record.attempt,
          result: output
            ? {
                exitCode: record.exitCode ?? null,
                duration: record.durationMs ?? null,
                error: record.error,
                stdout: output.stdout.slice(0, 4000),
                stderr: output.stderr.slice(0, 4000),
              }
            : null,
        },
      });
    })
  );

  router.get(
    '/logs/:jobId',
    asyncHandler(async (req, res) => {
      const { record, output } = await svc().getOutput(req.params.jobId, req.principal!);
      res.json({
        success: true,
        data: {
          jobId: record.id,
          status: record.status,
          logs: { stdout: output?.stdout ?? '', stderr: output?.stderr ?? '' },
          truncated: output?.truncated ?? false,
          available: output !== null,
        },
      });
    })
  );

  router.get(
    '/result/:jobId',
    asyncHandler(async (req, res) => {
      const { record, output } = await svc().getOutput(req.params.jobId, req.principal!);
      res.json({ success: true, data: { ...detail(record), output } });
    })
  );

  router.get(
    '/jobs/:jobId/report',
    asyncHandler(async (req, res) => {
      const record = await svc().get(req.params.jobId, req.principal!);
      res.json({ success: true, data: record.testReport ?? null });
    })
  );

  router.get(
    '/jobs/:jobId/artifacts',
    asyncHandler(async (req, res) => {
      const record = await svc().get(req.params.jobId, req.principal!);
      const list = await storage(() => artifacts().list(record.id));
      res.json({ success: true, data: { artifacts: list, truncated: record.artifactsTruncated ?? false } });
    })
  );

  // Artifact names may contain slashes, so match the rest of the path.
  router.get(
    /^\/jobs\/([0-9a-f-]{36})\/artifacts\/(.+)$/i,
    asyncHandler(async (req, res) => {
      const jobId = req.params[0];
      const name = req.params[1]; // already URL-decoded by Express
      const record = await svc().get(jobId, req.principal!);
      const file = await storage(() => artifacts().get(record.id, name));
      if (!file) {
        res.status(404).json({ success: false, error: 'Artifact not found' });
        return;
      }
      const filename = (name.split('/').pop() || 'artifact').replace(/[^\w.-]/g, '_');
      // Always a download, never rendered: artifacts are untrusted job output.
      res.status(200).set({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(file.meta.size),
        'Cache-Control': 'private, no-store',
      });
      file.stream.on('error', (err) => res.destroy(err));
      file.stream.pipe(res);
    })
  );

  router.delete(
    '/jobs/:jobId',
    asyncHandler(async (req, res) => {
      const status = await svc().cancel(req.params.jobId, req.principal!);
      res.status(status === 'cancelled' ? 200 : 202).json({
        success: true,
        data: { jobId: req.params.jobId, status },
        message: status === 'cancelled' ? 'Job cancelled' : 'Cancellation requested; the running job is being stopped',
      });
    })
  );

  router.post(
    '/jobs/:jobId/retry',
    limit,
    asyncHandler(async (req, res) => {
      const record = await svc().retry(req.params.jobId, req.principal!);
      res.status(201).json({
        success: true,
        data: { jobId: record.id, retryOf: record.retryOf, status: record.status, submittedAt: record.createdAt },
        message: 'Job re-submitted',
      });
    })
  );

  return router;
}

export { JobError };
export default createJobsRouter;
