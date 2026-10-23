-- 限制分享：前 N 位打开链接的客户可看（默认 N=5；SHARE_LIMIT_SLOTS / share_events.slot_limit）
-- 兼容：旧 bound_customer_id 回填到 share_event_bindings

-- slot_limit（幂等：已存在则跳过）
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'share_events' AND COLUMN_NAME = 'slot_limit'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE share_events ADD COLUMN slot_limit INT NOT NULL DEFAULT 5 COMMENT ''限制分享名额；公开分享可忽略'' AFTER share_policy',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS share_event_bindings (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  share_event_id CHAR(36) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  bound_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uk_share_customer (share_event_id, customer_id),
  KEY idx_seb_tenant (tenant_id),
  KEY idx_seb_share (share_event_id),
  KEY idx_seb_customer (customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO share_event_bindings (id, tenant_id, share_event_id, customer_id, bound_at, created_at, updated_at)
SELECT UUID(), tenant_id, id, bound_customer_id, COALESCE(bound_at, created_at), NOW(6), NOW(6)
FROM share_events
WHERE bound_customer_id IS NOT NULL AND bound_customer_id <> '';
