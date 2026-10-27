-- 商品图异步分析落库：单图 meta + 商品级 ref_analysis，供生图复用
SET @db = DATABASE();

SET @s = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='media_assets' AND COLUMN_NAME='meta') = 0,
  'ALTER TABLE media_assets ADD COLUMN meta JSON NULL COMMENT ''异步分析：kind/roleZh/roleEn/sortHint/via/analyzedAt'' AFTER status',
  'SELECT ''media_assets.meta exists, skip''');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='products' AND COLUMN_NAME='ref_analysis') = 0,
  'ALTER TABLE products ADD COLUMN ref_analysis JSON NULL COMMENT ''商品图分析结果（分类/硬约束），生图可复用'' AFTER tags',
  'SELECT ''products.ref_analysis exists, skip''');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
