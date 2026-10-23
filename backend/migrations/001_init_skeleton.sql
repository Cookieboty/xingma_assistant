-- 羊毛衫档口 MVP 建表骨架（MySQL 8+）
-- 实际以 TypeORM migration 为准；本文件便于 DBA 审阅

CREATE TABLE IF NOT EXISTS tenants (
  id CHAR(36) PRIMARY KEY,
  wx_app_id VARCHAR(64) NOT NULL UNIQUE,
  wx_app_secret VARCHAR(128) NULL,
  name VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  oss_prefix VARCHAR(64) NULL,
  authorizer_appid VARCHAR(64) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tenant_members (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  openid VARCHAR(64) NOT NULL,
  union_id VARCHAR(64) NULL,
  nickname VARCHAR(64) NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'staff',
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uk_member_openid (tenant_id, openid),
  KEY idx_member_tenant (tenant_id),
  KEY idx_member_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS customer_levels (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(64) NOT NULL,
  `rank` INT NOT NULL DEFAULT 0,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  remark VARCHAR(255) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uk_cl_code (tenant_id, code),
  KEY idx_cl_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS customer_profiles (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  openid VARCHAR(64) NOT NULL,
  union_id VARCHAR(64) NULL,
  nickname VARCHAR(64) NULL,
  avatar_url VARCHAR(512) NULL,
  level_id CHAR(36) NOT NULL,
  phone VARCHAR(32) NULL,
  remark VARCHAR(255) NULL,
  first_share_event_id CHAR(36) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uk_cust_openid (tenant_id, openid),
  KEY idx_cust_tenant (tenant_id),
  KEY idx_cust_level (level_id),
  KEY idx_cust_openid (openid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS product_levels (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(64) NOT NULL,
  `rank` INT NOT NULL DEFAULT 0,
  default_share_policy VARCHAR(32) NOT NULL DEFAULT 'designated_only',
  min_customer_rank INT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uk_pl_code (tenant_id, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS products (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  style_no VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  description TEXT NULL,
  material VARCHAR(128) NULL,
  level_id CHAR(36) NOT NULL,
  price_display VARCHAR(16) NOT NULL DEFAULT 'show',
  share_policy VARCHAR(32) NULL,
  cover_media_ids JSON NULL,
  tags JSON NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'on_sale',
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uk_style (tenant_id, style_no),
  KEY idx_prod_tenant (tenant_id),
  KEY idx_prod_level (level_id),
  KEY idx_prod_style (style_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS product_skus (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  product_id CHAR(36) NOT NULL,
  sku_code VARCHAR(64) NOT NULL,
  color VARCHAR(64) NULL,
  size VARCHAR(32) NULL,
  price DECIMAL(12,2) NULL,
  stock INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uk_sku (tenant_id, product_id, sku_code),
  KEY idx_sku_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS customer_product_rules (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  product_id CHAR(36) NOT NULL,
  effect VARCHAR(16) NOT NULL,
  remark VARCHAR(255) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uk_cpr (tenant_id, customer_id, product_id),
  KEY idx_cpr_customer (customer_id),
  KEY idx_cpr_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS share_events (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  product_id CHAR(36) NOT NULL,
  creator_member_id CHAR(36) NOT NULL,
  share_policy VARCHAR(32) NOT NULL,
  bound_customer_id CHAR(36) NULL,
  bound_at DATETIME NULL,
  expires_at DATETIME NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  KEY idx_share_tenant (tenant_id),
  KEY idx_share_product (product_id),
  KEY idx_share_bound (bound_customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS product_view_events (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  product_id CHAR(36) NOT NULL,
  customer_id CHAR(36) NULL,
  member_id CHAR(36) NULL,
  share_event_id CHAR(36) NULL,
  viewer_role VARCHAR(32) NOT NULL,
  result VARCHAR(16) NOT NULL DEFAULT 'ok',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  KEY idx_pve_product (product_id),
  KEY idx_pve_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS inquiries (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  product_id CHAR(36) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  content TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  assignee_member_id CHAR(36) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  KEY idx_inq_tenant (tenant_id),
  KEY idx_inq_product (product_id),
  KEY idx_inq_customer (customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS follow_ups (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  inquiry_id CHAR(36) NULL,
  customer_id CHAR(36) NULL,
  author_member_id CHAR(36) NOT NULL,
  content TEXT NOT NULL,
  kind VARCHAR(32) NOT NULL DEFAULT 'note',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  KEY idx_fu_inquiry (inquiry_id),
  KEY idx_fu_customer (customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS media_assets (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  product_id CHAR(36) NULL,
  type VARCHAR(16) NOT NULL DEFAULT 'image',
  provider VARCHAR(16) NOT NULL DEFAULT 'oss',
  object_key VARCHAR(512) NOT NULL,
  mime_type VARCHAR(128) NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  KEY idx_media_tenant (tenant_id),
  KEY idx_media_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
