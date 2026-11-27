import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import config from '../config';
import QueueManager from '../queue/manager';
import { createLogger } from '../utils/logger';
import { jobSubmittedCounter } from '../utils/metrics';
import {
  isTerminal,
  JobOutput,
  JobRecord,
  JobSpec,
  JobStatus,
  JOB_STATUSES,
  Principal,
  PRIORITIES,
} from '../utils/types';
import { validateWebhookUrl } from '../webhooks';
import { publishCancel } from './events';
import { finalizeJob } from './lifecycle';
import { isReservedEnvName, LANGUAGES } from './runtimes';
import { getJobStore, JobStore } from './store';

const log = createLogger('jobs');

export class JobError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: string[]
  ) {
    super(message);
  }
}

const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function submitSchema(): Joi.ObjectSchema {
  return Joi.object({
    language: Joi.string().valid(...LANGUAGES),
    script: Joi.string().min(1),
    command: Joi.string()
      .pattern(COMMAND_NAME)
      .message('"command" must be a single executable name; pass parameters in "args"')
      .valid(...config.workers.allowedCommands)
      .messages({ 'any.only': '"command" is not in the allowed command list' }),
    args: Joi.array().items(Joi.string().max(8192)).max(256),
    env: Joi.object().pattern(Joi.string(), Joi.string().max(8192)).max(64),
    timeout: Joi.number().integer().min(1000).max(config.workers.maxTimeoutMs).default(config.workers.defaultTimeoutMs),
    retries: Joi.number().integer().min(0).max(config.queue.maxRetries).default(config.queue.defaultRetries),
    priority: Joi.string().valid(...PRIORITIES).default('normal'),
    webhookUrl: Joi.string().max(2048),
    metadata: Joi.object().unknown(true),
  })
    .xor('script', 'command')
    .oxor('script', 'args')
    .messages({
      'object.missing': 'Provide either "script" or "command"',
      'object.xor': 'Provide either "script" or "command", not both',
    });
}

export const listSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string().valid(...JOB_STATUSES),
});

/** Validate a submission body and return a normalized JobSpec. */
export function parseSubmission(body: unknown): JobSpec {
  const { error, value } = submitSchema().validate(body ?? {}, { abortEarly: false, stripUnknown: false });
  if (error) {
    throw new JobError(400, 'Validation failed', error.details.map((d) => d.message));
  }
  const problems: string[] = [];
  if (value.script !== undefined && Buffer.byteLength(value.script, 'utf8') > config.jobs.maxScriptBytes) {
    problems.push(`"script" exceeds the maximum size of ${config.jobs.maxScriptBytes} bytes`);
  }
  for (const name of Object.keys(value.env ?? {})) {
    if (!ENV_NAME.test(name)) problems.push(`environment variable name "${name}" must match ${ENV_NAME}`);
    else if (isReservedEnvName(name)) problems.push(`environment variable "${name}" is reserved and cannot be set`);
  }
  if (value.metadata !== undefined && Buffer.byteLength(JSON.stringify(value.metadata)) > 8192) {
    problems.push('"metadata" must be at most 8 KiB when serialized');
  }
  if (value.webhookUrl !== undefined) problems.push(...validateWebhookUrl(value.webhookUrl));
  if (problems.length) throw new JobError(400, 'Validation failed', problems);

  return {
    language: value.script !== undefined ? (value.language ?? 'bash') : value.language,
    script: value.script,
    command: value.command,
    args: value.args,
    env: value.env,
    timeoutMs: value.timeout,
    retries: value.retries,
    priority: value.priority,
    webhookUrl: value.webhookUrl,
    metadata: value.metadata,
  };
}

/** BullMQ: lower number = higher priority. Every job gets one so ordering is consistent. */
const BULL_PRIORITY = { high: 1, normal: 2, low: 3 } as const;

export class JobService {
  constructor(
    private readonly storeOverride?: JobStore,
    private readonly queueOverride?: QueueManager
  ) {}

  private get store(): JobStore {
    return this.storeOverride ?? getJobStore();
  }

  private get queue(): QueueManager {
    return this.queueOverride ?? QueueManager.getInstance();
  }

  /**
   * Enforce per-key quotas for `n` new jobs. Admins are exempt. Reserves the
   * daily allowance up front; the returned function gives it back on failure.
   */
  async reserveQuota(principal: Principal, n: number): Promise<() => Promise<void>> {
    const noop = async () => undefined;
    if (principal.admin) return noop;
    const { maxActiveJobs, maxJobsPerDay } = config.quotas;
    if (maxActiveJobs > 0) {
      const active = await this.store.countActive(principal.id);
      if (active + n > maxActiveJobs) {
        throw new JobError(429, 'Quota exceeded', [
          `at most ${maxActiveJobs} queued or running jobs per API key (currently ${active}, requested ${n})`,
        ]);
      }
    }
    if (maxJobsPerDay > 0) {
      const total = await this.store.incrementDaily(principal.id, n);
      if (total > maxJobsPerDay) {
        await this.store.decrementDaily(principal.id, n);
        throw new JobError(429, 'Quota exceeded', [`at most ${maxJobsPerDay} job submissions per API key per day`]);
      }
      return () => this.store.decrementDaily(principal.id, n);
    }
    return noop;
  }

  async submit(
    spec: JobSpec,
    principal: Principal,
    opts: { retryOf?: string; batchId?: string; skipQuota?: boolean; id?: string } = {}
  ): Promise<JobRecord> {
    const refund = opts.skipQuota ? async () => undefined : await this.reserveQuota(principal, 1);
    const record: JobRecord = {
      ...spec,
      id: opts.id ?? uuidv4(),
      owner: principal.id,
      status: 'queued',
      attempt: 0,
      maxAttempts: spec.retries + 1,
      createdAt: new Date().toISOString(),
      retryOf: opts.retryOf,
      batchId: opts.batchId,
    };
    try {
      await this.store.create(record);
    } catch (err) {
      await refund();
      throw err;
    }
    await this.store.addActive(principal.id, [record.id]);
    try {
      await this.queue.add(record.id, record.maxAttempts, BULL_PRIORITY[spec.priority ?? 'normal']);
    } catch (err) {
      await finalizeJob(record.id, 'failed', { error: 'Could not enqueue job' }, this.store);
      throw err;
    }
    jobSubmittedCounter.inc();
    log.info('Job submitted', {
      jobId: record.id,
      owner: principal.id,
      language: record.language,
      command: record.command,
      batchId: record.batchId,
    });
    return record;
  }

  /** Fetch a job the principal may see; 404 otherwise (don't leak existence). */
  async get(id: string, principal: Principal): Promise<JobRecord> {
    const record = await this.store.get(id);
    if (!record || (!principal.admin && record.owner !== principal.id)) {
      throw new JobError(404, 'Job not found');
    }
    return record;
  }

  async canAccess(id: string, principal: Principal): Promise<boolean> {
    try {
      await this.get(id, principal);
      return true;
    } catch {
      return false;
    }
  }

  async getOutput(id: string, principal: Principal): Promise<{ record: JobRecord; output: JobOutput | null }> {
    const record = await this.get(id, principal);
    return { record, output: await this.store.getOutput(id) };
  }

  async list(principal: Principal, query: unknown) {
    const { error, value } = listSchema.validate(query ?? {});
    if (error) throw new JobError(400, 'Validation failed', error.details.map((d) => d.message));
    const { jobs, total } = await this.store.list({
      owner: principal.admin ? undefined : principal.id,
      status: value.status as JobStatus | undefined,
      page: value.page,
      limit: value.limit,
    });
    return {
      jobs: jobs.map(summarize),
      pagination: {
        page: value.page,
        limit: value.limit,
        total,
        pages: Math.ceil(total / value.limit),
        hasNext: value.page * value.limit < total,
        hasPrev: value.page > 1,
      },
    };
  }

  /** Returns the resulting status: 'cancelled' (done) or 'cancelling' (running job signalled). */
  async cancel(id: string, principal: Principal): Promise<'cancelled' | 'cancelling'> {
    const record = await this.get(id, principal);
    if (isTerminal(record.status)) {
      throw new JobError(409, `Job already ${record.status}`);
    }
    // Workers check this flag before starting and after finishing an attempt.
    await this.store.update(id, { cancelRequested: true });

    const removed = await this.queue.removeIfPending(id);
    if (removed || !(await this.queue.getJob(id))) {
      await finalizeJob(id, 'cancelled', { error: 'Cancelled by user' }, this.store);
      return 'cancelled';
    }
    // Running: whichever worker holds it will kill it and record the outcome.
    await publishCancel({ jobId: id });
    return 'cancelling';
  }

  /** Re-run a finished job as a new job (keeps history of the original). */
  async retry(id: string, principal: Principal): Promise<JobRecord> {
    const record = await this.get(id, principal);
    if (!isTerminal(record.status) || record.status === 'completed') {
      throw new JobError(409, 'Only failed, timed-out or cancelled jobs can be retried');
    }
    return this.submit(specOf(record), principal, { retryOf: record.id });
  }
}

export function specOf(record: JobRecord): JobSpec {
  return {
    language: record.language,
    script: record.script,
    command: record.command,
    args: record.args,
    env: record.env,
    timeoutMs: record.timeoutMs,
    retries: record.retries,
    priority: record.priority,
    webhookUrl: record.webhookUrl,
    metadata: record.metadata,
  };
}

/** Public, list-friendly view of a job (no script body or env values). */
export function summarize(r: JobRecord) {
  return {
    jobId: r.id,
    status: r.status,
    language: r.language,
    command: r.command,
    priority: r.priority ?? 'normal',
    attempt: r.attempt,
    maxAttempts: r.maxAttempts,
    timeout: r.timeoutMs,
    exitCode: r.exitCode ?? null,
    duration: r.durationMs ?? null,
    error: r.error,
    submittedAt: r.createdAt,
    startedAt: r.startedAt,
    completedAt: r.finishedAt,
    retryOf: r.retryOf,
    batchId: r.batchId,
    tests: r.testReport
      ? { total: r.testReport.total, passed: r.testReport.passed, failed: r.testReport.failed, skipped: r.testReport.skipped }
      : undefined,
    artifactCount: r.artifactCount ?? 0,
    metadata: r.metadata,
  };
}

/** Full view for the job owner. Env values are redacted (may hold secrets). */
export function detail(r: JobRecord) {
  return {
    ...summarize(r),
    script: r.script,
    args: r.args,
    envKeys: Object.keys(r.env ?? {}),
    webhookUrl: r.webhookUrl,
    testReport: r.testReport,
    outputTruncated: r.outputTruncated ?? false,
    artifactsTruncated: r.artifactsTruncated ?? false,
    workerId: r.workerId,
  };
}

let instance: JobService | null = null;
export const getJobService = (): JobService => (instance ??= new JobService());
export const setJobService = (svc: JobService | null): void => {
  instance = svc;
};
