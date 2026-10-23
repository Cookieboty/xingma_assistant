export type JobType = 'publish_product' | 'promo_image' | 'cover_reselect' | string;

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobProgress {
  percent: number;
  step?: string;
  message?: string;
  done?: number;
  total?: number;
}

/** handler 看到的精简任务视图（与表字段对齐） */
export interface JobRecord {
  id: string;
  tenantId: string;
  userId?: string;
  type: JobType;
  status: JobStatus;
  progress: JobProgress;
  /** 同 payload */
  input: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  error?: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
}

export type JobHandler = (
  job: JobRecord,
  ctx: JobHandlerContext,
) => Promise<Record<string, unknown> | void>;

export interface JobHandlerContext {
  updateProgress: (p: Partial<JobProgress>) => Promise<void>;
  isCancelled: () => Promise<boolean>;
  appendEvent?: (event: string, message?: string, data?: Record<string, unknown>) => Promise<void>;
}
