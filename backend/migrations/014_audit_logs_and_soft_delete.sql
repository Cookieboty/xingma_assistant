-- 审计日志 + 业务表软删 status（禁止物理 DELETE）
-- 可重复执行：列已存在时对应 ALTER 会失败，可忽略该条

CREATE TABLE IF NOT EXISTS audit_logs (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  actor_member_id VARCHAR(36) NULL,
  actor_openid VARCHAR(64) NULL,
  actor_role VARCHAR(16) NULL,
  action VARCHAR(64) NOT NULL COMMENT 'invite.create|invite.revoke|member.accept|tenant.contact_qr|tenant.allow_download|profile.update',
  target_type VARCHAR(64) NULL,
  target_id VARCHAR(64) NULL,
  detail_json TEXT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY idx_audit_tenant_created (tenant_id, created_at),
  KEY idx_audit_action (tenant_id, action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 以下 ALTER 在列已存在时会报错，部署脚本应容错执行
ALTER TABLE customer_levels ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'active|deleted' AFTER remark;
ALTER TABLE product_levels ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'active|deleted' AFTER min_customer_rank;
ALTER TABLE follow_ups ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'active|deleted' AFTER kind;
ALTER TABLE customer_product_rules ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'active|deleted' AFTER remark;
ALTER TABLE share_event_bindings ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'active|revoked' AFTER bound_at;
