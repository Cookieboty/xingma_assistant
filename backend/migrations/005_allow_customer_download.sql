-- 客户是否可长按/保存商品图（默认禁止）
-- 可重复执行：列已存在则跳过
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'products'
    AND COLUMN_NAME = 'allow_customer_download'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE products ADD COLUMN allow_customer_download TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''客户是否可长按/保存商品图'' AFTER share_policy',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
