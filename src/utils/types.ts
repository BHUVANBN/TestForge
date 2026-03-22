export interface JobData {
  id: string;
  script: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
  retries?: number;
  metadata?: Record<string, any>;
  createdAt: Date;
}

export interface JobResult {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';
  startTime?: Date;
  endTime?: Date;
  duration?: number;
  exitCode?: number;
  stdout: string;
  stderr: string;
  error?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkerStats {
  total: number;
  active: number;
  idle: number;
  failed: number;
  completed: number;
  averageExecutionTime: number;
  memoryUsage: NodeJS.MemoryUsage;
}

export interface SystemMetrics {
  uptime: number;
  timestamp: Date;
  jobs: {
    pending: number;
    running: number;
    completed: number;
    failed: number;
  };
  workers: WorkerStats;
  memory: NodeJS.MemoryUsage;
  cpu: {
    usage: number;
    loadAverage: number[];
  };
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  details?: any;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  jobId?: string;
  component?: string;
  [key: string]: any;
}

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: Date;
  uptime: number;
  version: string;
  checks: {
    redis: boolean;
    queue: boolean;
    workers: boolean;
  };
  metrics: SystemMetrics;
}
