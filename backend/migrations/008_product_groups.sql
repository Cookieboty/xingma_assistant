-- 商品分组：默认「本季款式」为最新组；可建过季组并移动商品
CREATE TABLE IF NOT EXISTS product_groups (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(64) NOT NULL,
  is_latest TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=最新组，新建商品默认进此组',
  sort_order INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uk_pg_code (tenant_id, code),
  KEY idx_pg_tenant (tenant_id),
  KEY idx_pg_latest (tenant_id, is_latest)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO product_groups (id, tenant_id, code, name, is_latest, sort_order, status)
VALUES ('pg_current', 'tenant_dev_001', 'current', '本季款式', 1, 0, 'active')
ON DUPLICATE KEY UPDATE name=VALUES(name), is_latest=VALUES(is_latest);

INSERT INTO product_groups (id, tenant_id, code, name, is_latest, sort_order, status)
VALUES ('pg_offseason', 'tenant_dev_001', 'offseason', '过季款式', 0, 10, 'active')
ON DUPLICATE KEY UPDATE name=VALUES(name);

-- 商品挂组；默认本季
ALTER TABLE products
  ADD COLUMN group_id CHAR(36) NULL COMMENT '商品分组' AFTER level_id;

UPDATE products SET group_id = 'pg_current' WHERE tenant_id = 'tenant_dev_001' AND (group_id IS NULL OR group_id = '');

ALTER TABLE products ADD KEY idx_product_group (tenant_id, group_id);
