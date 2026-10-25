-- 询价处理人：待沟通 → 我来沟通(in_progress) → 沟通完成(handled)
-- assignee_member_id 已有；补 openid + 昵称快照，列表常显「处理人」
ALTER TABLE inquiries
  ADD COLUMN assignee_openid VARCHAR(64) NULL COMMENT '处理人 openid' AFTER assignee_member_id,
  ADD COLUMN assignee_name VARCHAR(64) NULL COMMENT '处理人昵称快照' AFTER assignee_openid,
  ADD KEY idx_inq_assignee (tenant_id, assignee_member_id);
