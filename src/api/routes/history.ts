import { Router } from 'express';
import Joi from 'joi';
import { getHistory, HistoryStore } from '../../history';
import { JobError, summarize } from '../../jobs/service';
import { JOB_STATUSES } from '../../utils/types';
import { asyncHandler } from '../util';

const searchSchema = Joi.object({
  status: Joi.string().valid(...JOB_STATUSES),
  batchId: Joi.string().guid(),
  q: Joi.string().max(200),
  from: Joi.date().iso(),
  to: Joi.date().iso(),
  page: Joi.number().integer().min(1).max(10_000).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

function validate<T>(schema: Joi.ObjectSchema, input: unknown): T {
  const { error, value } = schema.validate(input ?? {}, { abortEarly: false });
  if (error) throw new JobError(400, 'Validation failed', error.details.map((d) => d.message));
  return value as T;
}

/** Long-term history (Postgres). Users see their own jobs; admins see everything. */
export function createHistoryRouter(opts: { history?: () => HistoryStore | null } = {}): Router {
  const router = Router();
  const history = () => {
    const h = (opts.history ?? getHistory)();
    if (!h) throw new JobError(404, 'Job history is not enabled on this server (set HISTORY_DATABASE_URL)');
    return h;
  };

  router.get(
    '/history/jobs',
    asyncHandler(async (req, res) => {
      const q = validate<any>(searchSchema, req.query);
      const { jobs, total } = await history().searchJobs({ ...q, owner: req.principal!.admin ? undefined : req.principal!.id });
      res.json({
        success: true,
        data: {
          jobs: jobs.map(summarize),
          pagination: { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) },
        },
      });
    })
  );

  router.get(
    '/history/batches',
    asyncHandler(async (req, res) => {
      const q = validate<any>(
        Joi.object({ page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(100).default(20) }),
        req.query
      );
      const { batches, total } = await history().listBatches({ ...q, owner: req.principal!.admin ? undefined : req.principal!.id });
      res.json({ success: true, data: { batches, pagination: { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) } } });
    })
  );

  router.get(
    '/history/stats',
    asyncHandler(async (req, res) => {
      const q = validate<{ days: number }>(Joi.object({ days: Joi.number().integer().min(1).max(365).default(30) }), req.query);
      res.json({ success: true, data: await history().stats({ days: q.days, owner: req.principal!.admin ? undefined : req.principal!.id }) });
    })
  );

  return router;
}
