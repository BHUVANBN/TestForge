import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import config from '../config';
import QueueManager from '../queue/manager';
import { createLogger } from '../utils/logger';
import { jobSubmittedCounter } from '../utils/metrics';
import { isTerminal, JobOutput, JobRecord, JobSpec, JobStatus, JOB_STATUSES, Principal } from '../utils/types';
import { publishCancel, publishStatus } from './events';
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
  if (problems.length) throw new JobError(400, 'Validation failed', problems);

  return {
    language: value.script !== undefined ? (value.language ?? 'bash') : value.language,
    script: value.script,
    command: value.command,
    args: value.args,
    env: value.env,
    timeoutMs: value.timeout,
    retries: value.retries,
    metadata: value.metadata,
  };
}

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

  async submit(spec: JobSpec, principal: Principal, retryOf?: string): Promise<JobRecord> {
    const record: JobRecord = {
      ...spec,
      id: uuidv4(),
      owner: principal.id,
      status: 'queued',
      attempt: 0,
      maxAttempts: spec.retries + 1,
      createdAt: new Date().toISOString(),
      retryOf,
    };
    await this.store.create(record);
    try {
      await this.queue.add(record.id, record.maxAttempts);
    } catch (err) {
      await this.store.update(record.id, {
        status: 'failed',
        error: 'Could not enqueue job',
        finishedAt: new Date().toISOString(),
      });
      throw err;
    }
    jobSubmittedCounter.inc();
    log.info('Job submitted', { jobId: record.id, owner: principal.id, language: record.language, command: record.command });
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
      await this.store.update(id, {
        status: 'cancelled',
        error: 'Cancelled by user',
        finishedAt: new Date().toISOString(),
      });
      void publishStatus({ jobId: id, owner: record.owner, status: 'cancelled', error: 'Cancelled by user' });
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
    const spec: JobSpec = {
      language: record.language,
      script: record.script,
      command: record.command,
      args: record.args,
      env: record.env,
      timeoutMs: record.timeoutMs,
      retries: record.retries,
      metadata: record.metadata,
    };
    return this.submit(spec, principal, record.id);
  }
}

/** Public, list-friendly view of a job (no script body or env values). */
export function summarize(r: JobRecord) {
  return {
    jobId: r.id,
    status: r.status,
    language: r.language,
    command: r.command,
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
    outputTruncated: r.outputTruncated ?? false,
    workerId: r.workerId,
  };
}

let instance: JobService | null = null;
export const getJobService = (): JobService => (instance ??= new JobService());
export const setJobService = (svc: JobService | null): void => {
  instance = svc;
};
