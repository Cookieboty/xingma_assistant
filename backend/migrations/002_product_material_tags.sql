-- 商品表补充材质、标签（幂等：001 新版已含这两列时自动跳过）
-- 兼容 MySQL 8 与 MariaDB（不依赖 ADD COLUMN IF NOT EXISTS）
SET @db = DATABASE();

SET @s = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='products' AND COLUMN_NAME='material') = 0,
  'ALTER TABLE products ADD COLUMN material VARCHAR(128) NULL COMMENT ''材质'' AFTER description',
  'SELECT ''material exists, skip''');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='products' AND COLUMN_NAME='tags') = 0,
  'ALTER TABLE products ADD COLUMN tags JSON NULL COMMENT ''标签列表'' AFTER cover_media_ids',
  'SELECT ''tags exists, skip''');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
