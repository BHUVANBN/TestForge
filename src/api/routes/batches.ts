import { RequestHandler, Router } from 'express';
import { BatchService, getBatchService } from '../../jobs/batches';
import { asyncHandler } from '../util';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createBatchesRouter(opts: { service?: BatchService; submitLimiter?: RequestHandler } = {}): Router {
  const router = Router();
  const svc = () => opts.service ?? getBatchService();
  const limit: RequestHandler = opts.submitLimiter ?? ((_req, _res, next) => next());

  router.param('batchId', (_req, res, next, id: string) => {
    if (!UUID.test(id)) {
      res.status(404).json({ success: false, error: 'Batch not found' });
      return;
    }
    next();
  });

  router.post(
    '/batches',
    limit,
    asyncHandler(async (req, res) => {
      const result = await svc().create(req.body, req.principal!);
      res.status(201).location(`/api/v1/batches/${result.batchId}`).json({ success: true, data: result });
    })
  );

  router.get(
    '/batches',
    asyncHandler(async (req, res) => {
      res.json({ success: true, data: await svc().list(req.principal!, req.query) });
    })
  );

  router.get(
    '/batches/:batchId',
    asyncHandler(async (req, res) => {
      res.json({ success: true, data: await svc().get(req.params.batchId, req.principal!) });
    })
  );

  router.delete(
    '/batches/:batchId',
    asyncHandler(async (req, res) => {
      res.json({ success: true, data: await svc().cancel(req.params.batchId, req.principal!) });
    })
  );

  return router;
}
