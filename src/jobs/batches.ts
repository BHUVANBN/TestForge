import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import config from '../config';
import { createLogger } from '../utils/logger';
import { BatchRecord, isTerminal, JobSpec, Principal } from '../utils/types';
import { validateWebhookUrl } from '../webhooks';
import { batchSummary } from './lifecycle';
import { LANGUAGES } from './runtimes';
import { getJobService, JobError, JobService, parseSubmission } from './service';
import { getJobStore, JobStore } from './store';

const log = createLogger('batches');

const batchSchema = () =>
  Joi.object({
    name: Joi.string().max(200),
    webhookUrl: Joi.string().max(2048),
    jobs: Joi.array().items(Joi.object().unknown(true)).min(1).max(config.batches.maxJobs),
    matrix: Joi.object({
      base: Joi.object().unknown(true).required(),
      axes: Joi.object({
        language: Joi.array().items(Joi.string().valid(...LANGUAGES)).min(1).unique(),
        env: Joi.object().pattern(Joi.string(), Joi.array().items(Joi.string().max(8192)).min(1).unique()),
      })
        .or('language', 'env')
        .required(),
    }),
  })
    .xor('jobs', 'matrix')
    .messages({ 'object.missing': 'Provide either "jobs" or "matrix"' });

type Combo = { language?: string; env: Record<string, string> };

/** Cartesian product of the matrix axes. */
export function expandMatrix(axes: { language?: string[]; env?: Record<string, string[]> }): Combo[] {
  let combos: Combo[] = (axes.language ?? [undefined]).map((language) => ({ language, env: {} }));
  for (const [key, values] of Object.entries(axes.env ?? {})) {
    combos = combos.flatMap((c) => values.map((v) => ({ language: c.language, env: { ...c.env, [key]: v } })));
  }
  return combos;
}

/** Validate a batch body into job specs (every job is validated like a single submission). */
export function parseBatch(body: unknown): { name?: string; webhookUrl?: string; specs: JobSpec[] } {
  const { error, value } = batchSchema().validate(body ?? {}, { abortEarly: false });
  if (error) throw new JobError(400, 'Validation failed', error.details.map((d) => d.message));

  let bodies: Record<string, unknown>[];
  if (value.jobs) {
    bodies = value.jobs;
  } else {
    const combos = expandMatrix(value.matrix.axes);
    if (combos.length > config.batches.maxJobs) {
      throw new JobError(400, 'Validation failed', [
        `matrix expands to ${combos.length} jobs; the maximum is ${config.batches.maxJobs}`,
      ]);
    }
    const base = value.matrix.base as Record<string, any>;
    bodies = combos.map((combo) => {
      const matrix: Record<string, string> = { ...combo.env };
      if (combo.language) matrix.language = combo.language;
      return {
        ...base,
        ...(combo.language ? { language: combo.language } : {}),
        env: { ...(base.env ?? {}), ...combo.env },
        metadata: { ...(base.metadata ?? {}), matrix },
      };
    });
  }

  const problems: string[] = [];
  if (value.webhookUrl) problems.push(...validateWebhookUrl(value.webhookUrl));
  const specs: JobSpec[] = [];
  bodies.forEach((b, i) => {
    try {
      specs.push(parseSubmission(b));
    } catch (err) {
      if (err instanceof JobError) (err.details ?? [err.message]).forEach((d) => problems.push(`jobs[${i}]: ${d}`));
      else throw err;
    }
  });
  if (problems.length) throw new JobError(400, 'Validation failed', problems.slice(0, 50));
  return { name: value.name, webhookUrl: value.webhookUrl, specs };
}

export class BatchService {
  constructor(
    private readonly storeOverride?: JobStore,
    private readonly jobsOverride?: JobService
  ) {}

  private get store() {
    return this.storeOverride ?? getJobStore();
  }

  private get jobs() {
    return this.jobsOverride ?? getJobService();
  }

  async create(body: unknown, principal: Principal) {
    const { name, webhookUrl, specs } = parseBatch(body);
    await this.jobs.reserveQuota(principal, specs.length);

    const ids = specs.map(() => uuidv4());
    const batch: BatchRecord = {
      id: uuidv4(),
      owner: principal.id,
      name,
      webhookUrl,
      jobIds: ids,
      total: specs.length,
      finished: 0,
      createdAt: new Date().toISOString(),
    };
    // The batch must exist before any of its jobs can finish.
    await this.store.createBatch(batch);

    for (let i = 0; i < specs.length; i++) {
      try {
        await this.jobs.submit(specs[i], principal, { batchId: batch.id, skipQuota: true, id: ids[i] });
      } catch (err) {
        await this.store.updateBatch(batch.id, { total: i, jobIds: ids.slice(0, i) });
        log.error('Batch submission aborted', { batchId: batch.id, submitted: i, error: (err as Error).message });
        throw new JobError(503, `Batch partially submitted (${i} of ${specs.length} jobs); see batch ${batch.id}`);
      }
    }
    log.info('Batch submitted', { batchId: batch.id, jobs: specs.length, owner: principal.id });
    return { batchId: batch.id, jobIds: ids, total: specs.length };
  }

  async getRecord(id: string, principal: Principal): Promise<BatchRecord> {
    const batch = await this.store.getBatch(id);
    if (!batch || (!principal.admin && batch.owner !== principal.id)) throw new JobError(404, 'Batch not found');
    return batch;
  }

  async get(id: string, principal: Principal) {
    return batchSummary(await this.getRecord(id, principal), this.store);
  }

  async list(principal: Principal, query: { page?: unknown; limit?: unknown }) {
    const { error, value } = Joi.object({
      page: Joi.number().integer().min(1).default(1),
      limit: Joi.number().integer().min(1).max(100).default(20),
    }).validate(query ?? {});
    if (error) throw new JobError(400, 'Validation failed', error.details.map((d) => d.message));
    const { batches, total } = await this.store.listBatches({
      owner: principal.admin ? undefined : principal.id,
      page: value.page,
      limit: value.limit,
    });
    const summaries = await Promise.all(batches.map((b) => batchSummary(b, this.store)));
    return {
      batches: summaries.map(({ jobs: _jobs, ...rest }) => rest),
      pagination: { page: value.page, limit: value.limit, total, pages: Math.ceil(total / value.limit) },
    };
  }

  async cancel(id: string, principal: Principal) {
    const batch = await this.getRecord(id, principal);
    const records = await this.store.getMany(batch.jobIds);
    let cancelled = 0;
    let cancelling = 0;
    for (const r of records) {
      if (!r || isTerminal(r.status)) continue;
      try {
        const res = await this.jobs.cancel(r.id, principal);
        if (res === 'cancelled') cancelled++;
        else cancelling++;
      } catch {
        /* finished meanwhile */
      }
    }
    return { batchId: id, cancelled, cancelling };
  }
}

let instance: BatchService | null = null;
export const getBatchService = (): BatchService => (instance ??= new BatchService());
export const setBatchService = (svc: BatchService | null): void => {
  instance = svc;
};
