-- 通用异步任务框架
CREATE TABLE IF NOT EXISTS jobs (
  id VARCHAR(48) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  type VARCHAR(64) NOT NULL COMMENT 'publish_product|promo_image|cover_reselect|...',
  status VARCHAR(16) NOT NULL DEFAULT 'queued' COMMENT 'queued|running|succeeded|failed|cancelled',
  progress JSON NULL COMMENT '{percent,step,message,done,total}',
  payload JSON NOT NULL COMMENT '任务入参',
  result JSON NULL,
  error TEXT NULL,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  created_by VARCHAR(64) NULL COMMENT 'memberId/openid',
  locked_by VARCHAR(64) NULL COMMENT '执行器实例标识',
  next_run_at DATETIME(3) NULL COMMENT '到期才可被调度（重试退避）',
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_jobs_tenant_status (tenant_id, status, created_at),
  KEY idx_jobs_schedule (status, next_run_at, created_at),
  KEY idx_jobs_tenant_type (tenant_id, type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS job_events (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  job_id VARCHAR(48) NOT NULL,
  tenant_id CHAR(36) NOT NULL,
  level VARCHAR(16) NOT NULL DEFAULT 'info' COMMENT 'info|warn|error',
  event VARCHAR(64) NOT NULL COMMENT 'created|claimed|progress|succeeded|failed|retry|cancel',
  message VARCHAR(512) NULL,
  data JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_job_events_job (job_id, id),
  KEY idx_job_events_tenant (tenant_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
