export type JobType = 'publish_product' | 'promo_image' | 'promo_video' | 'cover_reselect' | string;

/**
 * 业主任务中心 /「本商品任务」可见类型。
 * 新 job type 默认不展示，除非显式加入此白名单。
 */
export const USER_VISIBLE_JOB_TYPES = ['promo_image', 'promo_video', 'publish_product'] as const;
export type UserVisibleJobType = (typeof USER_VISIBLE_JOB_TYPES)[number];

export function isUserVisibleJobType(type: string | null | undefined): boolean {
  return (USER_VISIBLE_JOB_TYPES as readonly string[]).includes(String(type || ''));
}

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
