import type { Language } from '../jobs/runtimes';

export const JOB_STATUSES = [
  'queued',
  'running',
  'retrying',
  'completed',
  'failed',
  'timeout',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  'completed',
  'failed',
  'timeout',
  'cancelled',
]);

export const isTerminal = (status: JobStatus): boolean => TERMINAL_STATUSES.has(status);

/** What the user asked to run. Stored with the job so it can be retried. */
export interface JobSpec {
  language?: Language;
  script?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs: number;
  retries: number;
  metadata?: Record<string, unknown>;
}

/** Durable job record (kept in Redis independent of BullMQ retention). */
export interface JobRecord extends JobSpec {
  id: string;
  owner: string;
  status: JobStatus;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  error?: string;
  workerId?: string;
  retryOf?: string;
  cancelRequested?: boolean;
  outputTruncated?: boolean;
}

export interface JobOutput {
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** Payload placed on the BullMQ queue: everything else lives in the job record. */
export interface QueuePayload {
  jobId: string;
}

export type ExecutionOutcome = 'completed' | 'failed' | 'timeout' | 'cancelled' | 'interrupted';

export interface ExecutionResult {
  outcome: ExecutionOutcome;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  error?: string;
}

export type KillReason = 'cancel' | 'timeout' | 'shutdown';

export interface Executor {
  run(): Promise<ExecutionResult>;
  kill(reason: KillReason): Promise<void>;
}

export type OutputListener = (stream: 'stdout' | 'stderr', chunk: string) => void;

export interface WorkerHeartbeat {
  id: string;
  hostname: string;
  pid: number;
  executor: string;
  concurrency: number;
  active: number;
  completed: number;
  failed: number;
  averageExecutionTime: number;
  startedAt: string;
  lastSeen: string;
}

export interface WorkerStats {
  instances: number;
  total: number;
  active: number;
  idle: number;
  completed: number;
  failed: number;
  averageExecutionTime: number;
}

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
}

export interface Principal {
  id: string;
  admin: boolean;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  details?: unknown;
}
