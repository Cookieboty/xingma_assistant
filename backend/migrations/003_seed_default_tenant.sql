-- 默认租户（星马档口）+ 默认等级种子。可重复执行。
-- AppSecret 不写入仓库：wx_app_secret 允许为空，生产通过环境变量 WECHAT_APP_SECRET
-- 或在服务器上手工执行：UPDATE tenants SET wx_app_secret='<真实值>' WHERE wx_app_id='wx394d23ea099d8a01';
ALTER TABLE tenants MODIFY wx_app_secret VARCHAR(128) NULL;

INSERT INTO tenants (id, wx_app_id, wx_app_secret, name, status, oss_prefix)
VALUES ('tenant_dev_001', 'wx394d23ea099d8a01', NULL, '星马羊毛衫档口', 'active', 'tenants/tenant_dev_001')
ON DUPLICATE KEY UPDATE wx_app_id = VALUES(wx_app_id), name = VALUES(name);

INSERT IGNORE INTO customer_levels (id, tenant_id, code, name, `rank`, is_default, remark) VALUES
  ('cl_default', 'tenant_dev_001', 'L1', '普通客户', 1, 1, '首次建档默认'),
  ('cl_vip',     'tenant_dev_001', 'L2', 'VIP 客户', 2, 0, NULL);

INSERT IGNORE INTO product_levels (id, tenant_id, code, name, `rank`, default_share_policy, min_customer_rank) VALUES
  ('pl_open',  'tenant_dev_001', 'OPEN',  '公开款',     0, 'open',            NULL),
  ('pl_vip',   'tenant_dev_001', 'VIP',   '定向款',     1, 'designated_only', 1),
  ('pl_match', 'tenant_dev_001', 'MATCH', '等级匹配款', 2, 'level_match',     2);
