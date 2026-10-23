-- 业主邀请员工/业主：邀请码 + 可选小程序码缓存
CREATE TABLE IF NOT EXISTS member_invites (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  code VARCHAR(16) NOT NULL,
  role VARCHAR(16) NOT NULL COMMENT 'owner|staff',
  created_by_member_id CHAR(36) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'active|revoked|exhausted|expired',
  max_uses INT NOT NULL DEFAULT 1,
  use_count INT NOT NULL DEFAULT 0,
  expires_at DATETIME NULL,
  accepted_openid VARCHAR(64) NULL,
  accepted_member_id CHAR(36) NULL,
  accepted_at DATETIME NULL,
  wxacode_object_key VARCHAR(512) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uk_invite_code (code),
  KEY idx_invite_tenant (tenant_id),
  KEY idx_invite_status (tenant_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
