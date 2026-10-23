-- 宣传图组：一商品多组；生成完成即关联商品
CREATE TABLE IF NOT EXISTS promo_sets (
  id VARCHAR(48) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  product_id CHAR(36) NOT NULL,
  template_id VARCHAR(64) NOT NULL COMMENT '模板 id',
  params JSON NULL COMMENT '生成参数：model/poses/scenes/colors/size/feature/refs/count',
  caption TEXT NULL COMMENT '小红书/朋友圈等可复制文案',
  job_id VARCHAR(48) NULL COMMENT '最近一次框架 job id',
  legacy_job_id VARCHAR(48) NULL COMMENT '兼容旧 pj_* 文件 id',
  status VARCHAR(16) NOT NULL DEFAULT 'generating' COMMENT 'generating|done|partial|failed',
  images JSON NULL COMMENT '[{index,objectKey,mediaId,url?,status,error,ms,poseId,sceneId}]',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_promo_sets_product (tenant_id, product_id, created_at),
  KEY idx_promo_sets_job (job_id),
  KEY idx_promo_sets_legacy (tenant_id, legacy_job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- media_assets 关联宣传图组（可重复执行）
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'media_assets'
    AND COLUMN_NAME = 'promo_set_id'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE media_assets ADD COLUMN promo_set_id VARCHAR(48) NULL COMMENT ''宣传图组 id'' AFTER product_id, ADD KEY idx_media_promo_set (promo_set_id)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
