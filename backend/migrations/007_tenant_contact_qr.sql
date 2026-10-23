-- 业主联系二维码；重复执行若 Duplicate column 可忽略
ALTER TABLE tenants
  ADD COLUMN contact_qr_url VARCHAR(512) NULL COMMENT '业主微信二维码公开 URL' AFTER oss_prefix;
