import { createLogger } from '../utils/logger';
import { BatchRecord, JobRecord } from '../utils/types';
import { enqueueWebhooks } from '../webhooks';
import { publishBatch, publishStatus } from './events';
import { getJobStore, JobStore } from './store';

const log = createLogger('lifecycle');

export type TerminalStatus = 'completed' | 'failed' | 'timeout' | 'cancelled';

/**
 * The single path for a job reaching a terminal state, wherever it happens
 * (worker, API cancel, admin clear). Updates the record and publishes the
 * status every time, but quota release, webhooks and batch accounting run
 * exactly once per job, even if two processes race to finish it.
 */
export async function finalizeJob(
  id: string,
  status: TerminalStatus,
  details: Partial<JobRecord> = {},
  store: JobStore = getJobStore()
): Promise<JobRecord | null> {
  await store.update(id, { ...details, status, finishedAt: new Date().toISOString() });
  const record = await store.get(id);
  if (!record) return null;

  void publishStatus({
    jobId: id,
    owner: record.owner,
    status,
    exitCode: record.exitCode,
    error: record.error,
    durationMs: record.durationMs,
  });

  if (!(await store.claimFinalization(id))) return record;

  await store.releaseActive(record.owner, id).catch(() => undefined);
  await enqueueWebhooks(record.webhookUrl, 'job.finished', { job: jobPayload(record) });

  if (record.batchId && (await store.recordBatchJobFinished(record.batchId))) {
    await store.updateBatch(record.batchId, { finishedAt: new Date().toISOString() });
    const batch = await store.getBatch(record.batchId);
    if (batch) {
      const summary = await batchSummary(batch, store);
      void publishBatch({ batchId: batch.id, owner: batch.owner, status: summary.status });
      await enqueueWebhooks(batch.webhookUrl, 'batch.finished', { batch: summary });
      log.info('Batch finished', { batchId: batch.id, status: summary.status });
    }
  }
  return record;
}

/** Webhook view of a job: no script body or env values. */
export function jobPayload(r: JobRecord) {
  return {
    id: r.id,
    status: r.status,
    language: r.language,
    command: r.command,
    exitCode: r.exitCode ?? null,
    durationMs: r.durationMs ?? null,
    error: r.error,
    attempt: r.attempt,
    maxAttempts: r.maxAttempts,
    priority: r.priority ?? 'normal',
    batchId: r.batchId,
    retryOf: r.retryOf,
    metadata: r.metadata,
    testReport: r.testReport,
    artifactCount: r.artifactCount ?? 0,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}

export type BatchStatus = 'queued' | 'running' | 'completed' | 'failed';

export async function batchSummary(batch: BatchRecord, store: JobStore = getJobStore()) {
  const jobs = (await store.getMany(batch.jobIds)).filter((j): j is JobRecord => !!j);
  const counts: Record<string, number> = {};
  for (const j of jobs) counts[j.status] = (counts[j.status] ?? 0) + 1;
  const finished = (counts.completed ?? 0) + (counts.failed ?? 0) + (counts.timeout ?? 0) + (counts.cancelled ?? 0);
  const done = finished >= batch.total || !!batch.finishedAt;
  let status: BatchStatus;
  if (done) status = (counts.completed ?? 0) === batch.total ? 'completed' : 'failed';
  else status = jobs.some((j) => j.status !== 'queued') ? 'running' : 'queued';

  const tests = jobs.reduce(
    (acc, j) => {
      if (!j.testReport) return acc;
      acc.total += j.testReport.total;
      acc.passed += j.testReport.passed;
      acc.failed += j.testReport.failed;
      acc.skipped += j.testReport.skipped;
      return acc;
    },
    { total: 0, passed: 0, failed: 0, skipped: 0 }
  );

  return {
    id: batch.id,
    name: batch.name,
    status,
    total: batch.total,
    finished,
    counts,
    tests: tests.total ? tests : undefined,
    createdAt: batch.createdAt,
    finishedAt: batch.finishedAt,
    jobs: jobs.map((j) => ({
      jobId: j.id,
      status: j.status,
      language: j.language,
      command: j.command,
      exitCode: j.exitCode ?? null,
      duration: j.durationMs ?? null,
      matrix: (j.metadata as Record<string, unknown> | undefined)?.matrix,
      tests: j.testReport
        ? { total: j.testReport.total, passed: j.testReport.passed, failed: j.testReport.failed, skipped: j.testReport.skipped }
        : undefined,
    })),
  };
}
