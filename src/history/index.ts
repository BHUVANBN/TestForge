import { Job, Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { Pool } from 'pg';
import config from '../config';
import { createRedis } from '../queue/redis';
import { createLogger } from '../utils/logger';
import { JobRecord, JobStatus, Priority, TestReport } from '../utils/types';

const log = createLogger('history');

/** The slice of pg.Pool we use (lets tests inject a fake). */
export interface PoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
  end?(): Promise<void>;
}

const MIGRATION = `
CREATE TABLE IF NOT EXISTS tf_jobs (
  id            uuid PRIMARY KEY,
  owner         text NOT NULL,
  status        text NOT NULL,
  language      text,
  command       text,
  args          jsonb,
  script        text,
  env_keys      text[] NOT NULL DEFAULT '{}',
  priority      text NOT NULL DEFAULT 'normal',
  timeout_ms    integer,
  retries       integer,
  attempt       integer,
  max_attempts  integer,
  exit_code     integer,
  duration_ms   integer,
  error         text,
  batch_id      uuid,
  retry_of      uuid,
  worker_id     text,
  metadata      jsonb,
  test_report   jsonb,
  tests_total   integer,
  tests_passed  integer,
  tests_failed  integer,
  tests_skipped integer,
  artifact_count integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL,
  started_at    timestamptz,
  finished_at   timestamptz,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tf_jobs_owner_created ON tf_jobs (owner, created_at DESC);
CREATE INDEX IF NOT EXISTS tf_jobs_created ON tf_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS tf_jobs_status_created ON tf_jobs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS tf_jobs_batch ON tf_jobs (batch_id) WHERE batch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tf_batches (
  id          uuid PRIMARY KEY,
  owner       text NOT NULL,
  name        text,
  status      text NOT NULL,
  total       integer NOT NULL,
  summary     jsonb NOT NULL,
  created_at  timestamptz NOT NULL,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS tf_batches_owner_created ON tf_batches (owner, created_at DESC);
`;

export interface HistorySearch {
  owner?: string;
  status?: JobStatus;
  batchId?: string;
  q?: string;
  from?: Date;
  to?: Date;
  page: number;
  limit: number;
}

export interface BatchHistory {
  id: string;
  owner: string;
  name?: string;
  status: string;
  total: number;
  createdAt: string;
  finishedAt?: string;
  summary: Record<string, unknown>;
}

const iso = (d: unknown): string | undefined => (d ? new Date(d as string).toISOString() : undefined);
const num = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));

/** Map a row back to the JobRecord shape the rest of the system uses. */
export function rowToRecord(row: any): JobRecord & { archived: true; envKeys: string[] } {
  return {
    id: row.id,
    owner: row.owner,
    status: row.status,
    language: row.language ?? undefined,
    command: row.command ?? undefined,
    args: row.args ?? undefined,
    script: row.script ?? undefined,
    priority: (row.priority as Priority) ?? 'normal',
    timeoutMs: num(row.timeout_ms) ?? 0,
    retries: num(row.retries) ?? 0,
    attempt: num(row.attempt) ?? 0,
    maxAttempts: num(row.max_attempts) ?? 1,
    exitCode: row.exit_code ?? null,
    durationMs: num(row.duration_ms),
    error: row.error ?? undefined,
    batchId: row.batch_id ?? undefined,
    retryOf: row.retry_of ?? undefined,
    workerId: row.worker_id ?? undefined,
    metadata: row.metadata ?? undefined,
    testReport: (row.test_report as TestReport) ?? undefined,
    artifactCount: num(row.artifact_count) ?? 0,
    createdAt: iso(row.created_at)!,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    archived: true,
    envKeys: row.env_keys ?? [],
  };
}

/**
 * Long-term job history in Postgres. Redis keeps live state and recent
 * output; this keeps every finished job (minus env values and output) for
 * HISTORY_RETENTION_DAYS, for search, trends and audits.
 */
export class HistoryStore {
  private readonly pool: PoolLike;

  constructor(pool?: PoolLike) {
    this.pool =
      pool ??
      new Pool({
        connectionString: config.history.databaseUrl,
        ssl: config.history.ssl ? { rejectUnauthorized: true } : undefined,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        query_timeout: 15_000,
        statement_timeout: 15_000,
      });
  }

  async migrate(): Promise<void> {
    // Serialize concurrent migrations from several processes starting at once.
    await this.pool.query('SELECT pg_advisory_lock(727001)');
    try {
      await this.pool.query(MIGRATION);
    } finally {
      await this.pool.query('SELECT pg_advisory_unlock(727001)');
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async recordJob(r: JobRecord): Promise<void> {
    const t = r.testReport;
    const values = [
      r.id, r.owner, r.status, r.language ?? null, r.command ?? null,
      r.args ? JSON.stringify(r.args) : null, r.script ?? null, Object.keys(r.env ?? {}),
      r.priority ?? 'normal', r.timeoutMs ?? null, r.retries ?? null, r.attempt ?? null, r.maxAttempts ?? null,
      r.exitCode ?? null, r.durationMs ?? null, r.error ?? null, r.batchId ?? null, r.retryOf ?? null,
      r.workerId ?? null, r.metadata ? JSON.stringify(r.metadata) : null, t ? JSON.stringify(t) : null,
      t?.total ?? null, t?.passed ?? null, t?.failed ?? null, t?.skipped ?? null, r.artifactCount ?? 0,
      r.createdAt, r.startedAt ?? null, r.finishedAt ?? null,
    ];
    const cols = [
      'id', 'owner', 'status', 'language', 'command', 'args', 'script', 'env_keys', 'priority', 'timeout_ms',
      'retries', 'attempt', 'max_attempts', 'exit_code', 'duration_ms', 'error', 'batch_id', 'retry_of',
      'worker_id', 'metadata', 'test_report', 'tests_total', 'tests_passed', 'tests_failed', 'tests_skipped',
      'artifact_count', 'created_at', 'started_at', 'finished_at',
    ];
    await this.pool.query(
      `INSERT INTO tf_jobs (${cols.join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (id) DO UPDATE SET ${cols
         .filter((c) => c !== 'id')
         .map((c) => `${c} = EXCLUDED.${c}`)
         .join(', ')}, recorded_at = now()`,
      values
    );
  }

  async recordBatch(b: BatchHistory): Promise<void> {
    await this.pool.query(
      `INSERT INTO tf_batches (id, owner, name, status, total, summary, created_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, summary = EXCLUDED.summary,
         finished_at = EXCLUDED.finished_at, total = EXCLUDED.total`,
      [b.id, b.owner, b.name ?? null, b.status, b.total, JSON.stringify(b.summary), b.createdAt, b.finishedAt ?? null]
    );
  }

  async getJob(id: string) {
    const { rows } = await this.pool.query('SELECT * FROM tf_jobs WHERE id = $1', [id]);
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  private where(s: Partial<HistorySearch>, params: unknown[]): string {
    const clauses: string[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      clauses.push(sql.replace('?', `$${params.length}`));
    };
    if (s.owner) add('owner = ?', s.owner);
    if (s.status) add('status = ?', s.status);
    if (s.batchId) add('batch_id = ?', s.batchId);
    if (s.from) add('created_at >= ?', s.from);
    if (s.to) add('created_at < ?', s.to);
    if (s.q) {
      params.push(`%${s.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      const p = `$${params.length}`;
      clauses.push(
        `(id::text ILIKE ${p} OR command ILIKE ${p} OR language ILIKE ${p} OR error ILIKE ${p} OR metadata::text ILIKE ${p})`
      );
    }
    return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  }

  async searchJobs(s: HistorySearch) {
    const params: unknown[] = [];
    const where = this.where(s, params);
    const [{ rows }, count] = await Promise.all([
      this.pool.query(
        `SELECT * FROM tf_jobs ${where} ORDER BY created_at DESC LIMIT ${Number(s.limit)} OFFSET ${(Number(s.page) - 1) * Number(s.limit)}`,
        params
      ),
      this.pool.query(`SELECT count(*)::int AS n FROM tf_jobs ${where}`, params),
    ]);
    return { jobs: rows.map(rowToRecord), total: Number(count.rows[0]?.n ?? 0) };
  }

  async listBatches(s: { owner?: string; page: number; limit: number }) {
    const params: unknown[] = [];
    let where = '';
    if (s.owner) {
      params.push(s.owner);
      where = 'WHERE owner = $1';
    }
    const [{ rows }, count] = await Promise.all([
      this.pool.query(
        `SELECT * FROM tf_batches ${where} ORDER BY created_at DESC LIMIT ${Number(s.limit)} OFFSET ${(Number(s.page) - 1) * Number(s.limit)}`,
        params
      ),
      this.pool.query(`SELECT count(*)::int AS n FROM tf_batches ${where}`, params),
    ]);
    return {
      batches: rows.map((r) => ({
        id: r.id,
        name: r.name ?? undefined,
        status: r.status,
        total: r.total,
        createdAt: iso(r.created_at),
        finishedAt: iso(r.finished_at),
        summary: r.summary,
      })),
      total: Number(count.rows[0]?.n ?? 0),
    };
  }

  /** Aggregates for dashboards: totals, per-day trend, and the most frequently failing tests. */
  async stats(s: { owner?: string; days: number }) {
    const from = new Date(Date.now() - s.days * 24 * 3600 * 1000);
    const params: unknown[] = [];
    const where = this.where({ owner: s.owner, from }, params);
    const [totals, daily, failing] = await Promise.all([
      this.pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'completed')::int AS completed,
                count(*) FILTER (WHERE status = 'failed')::int AS failed,
                count(*) FILTER (WHERE status = 'timeout')::int AS timeout,
                count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                round(avg(duration_ms))::int AS avg_duration_ms,
                round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::int AS p95_duration_ms,
                coalesce(sum(tests_total), 0)::int AS tests_total,
                coalesce(sum(tests_failed), 0)::int AS tests_failed
           FROM tf_jobs ${where}`,
        params
      ),
      this.pool.query(
        `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                count(*)::int AS total,
                count(*) FILTER (WHERE status = 'completed')::int AS completed,
                count(*) FILTER (WHERE status <> 'completed')::int AS unsuccessful
           FROM tf_jobs ${where}
          GROUP BY 1 ORDER BY 1`,
        params
      ),
      this.pool.query(
        `SELECT f->>'name' AS name, f->>'classname' AS classname, count(*)::int AS failures,
                max(created_at) AS last_failed_at
           FROM tf_jobs, jsonb_array_elements(coalesce(test_report->'failures', '[]'::jsonb)) AS f
           ${where}
          GROUP BY 1, 2 ORDER BY failures DESC, last_failed_at DESC LIMIT 10`,
        params
      ),
    ]);

    const t = totals.rows[0] ?? {};
    const finished = (t.completed ?? 0) + (t.failed ?? 0) + (t.timeout ?? 0);
    const byDay = new Map(daily.rows.map((r) => [r.day, r]));
    const days = [];
    for (let i = s.days - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const r = byDay.get(day);
      days.push({ day, total: r?.total ?? 0, completed: r?.completed ?? 0, unsuccessful: r?.unsuccessful ?? 0 });
    }
    return {
      days: s.days,
      totals: {
        total: t.total ?? 0,
        completed: t.completed ?? 0,
        failed: t.failed ?? 0,
        timeout: t.timeout ?? 0,
        cancelled: t.cancelled ?? 0,
        successRate: finished ? Math.round(((t.completed ?? 0) / finished) * 1000) / 10 : null,
        avgDurationMs: t.avg_duration_ms ?? null,
        p95DurationMs: t.p95_duration_ms ?? null,
        testsTotal: t.tests_total ?? 0,
        testsFailed: t.tests_failed ?? 0,
      },
      daily: days,
      topFailingTests: failing.rows.map((r) => ({
        name: r.name,
        classname: r.classname ?? undefined,
        failures: r.failures,
        lastFailedAt: iso(r.last_failed_at),
      })),
    };
  }

  async purge(retentionDays = config.history.retentionDays): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);
    const a = await this.pool.query('DELETE FROM tf_jobs WHERE created_at < $1', [cutoff]);
    const b = await this.pool.query('DELETE FROM tf_batches WHERE created_at < $1', [cutoff]);
    return (a.rowCount ?? 0) + (b.rowCount ?? 0);
  }

  async close(): Promise<void> {
    await this.pool.end?.();
  }
}

// ---------------------------------------------------------------- wiring

export const historyEnabled = (): boolean => !!config.history.databaseUrl;

let store: HistoryStore | null = null;
export const getHistory = (): HistoryStore | null => {
  if (!historyEnabled() && !store) return null;
  return (store ??= new HistoryStore());
};
export const setHistory = (h: HistoryStore | null): void => {
  store = h;
};

type HistoryEntry = { kind: 'job'; record: JobRecord } | { kind: 'batch'; batch: BatchHistory };

const queueName = () => `${config.queue.name}-history`;
let queue: Queue<HistoryEntry> | null = null;
let enqueueOverride: ((e: HistoryEntry) => Promise<void>) | null = null;

/** Test hook. */
export const setHistoryEnqueue = (fn: ((e: HistoryEntry) => Promise<void>) | null): void => {
  enqueueOverride = fn;
};

/**
 * Durable hand-off: history writes go through a retried queue so a Postgres
 * outage delays history but never loses it or slows down jobs.
 */
export async function recordHistory(entry: HistoryEntry): Promise<void> {
  // Strip env values (may hold secrets); keep only their names.
  const payload: HistoryEntry =
    entry.kind === 'job'
      ? { kind: 'job', record: { ...entry.record, env: Object.fromEntries(Object.keys(entry.record.env ?? {}).map((k) => [k, ''])) } }
      : entry;
  if (enqueueOverride) return enqueueOverride(payload);
  if (!historyEnabled()) return;
  try {
    queue ??= new Queue<HistoryEntry>(queueName(), {
      connection: createRedis('history-queue'),
      defaultJobOptions: {
        attempts: 20,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 14 * 24 * 3600 },
      },
    });
    await queue.add(entry.kind, payload);
  } catch (err) {
    log.error('Failed to queue history entry', { error: err instanceof Error ? err.message : String(err) });
  }
}

export function startHistoryWorker(connect: (name: string) => Redis = createRedis, history = getHistory()): Worker<HistoryEntry> | null {
  if (!history) return null;
  const worker = new Worker<HistoryEntry>(
    queueName(),
    async (job: Job<HistoryEntry>) => {
      if (job.data.kind === 'job') await history.recordJob(job.data.record);
      else await history.recordBatch(job.data.batch);
    },
    { connection: connect('history-worker'), concurrency: 5 }
  );
  worker.on('failed', (job, err) => log.warn('History write failed; will retry', { attempt: job?.attemptsMade, error: err.message }));
  worker.on('error', (err) => log.error('History worker error', { error: err.message }));
  return worker;
}

export async function closeHistory(): Promise<void> {
  await queue?.close();
  queue = null;
  await store?.close().catch(() => undefined);
  store = null;
}
