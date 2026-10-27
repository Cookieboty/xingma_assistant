-- 成员记录来自哪张邀请码/二维码（接受邀请时写入）
ALTER TABLE tenant_members
  ADD COLUMN invite_id CHAR(36) NULL COMMENT '来源 member_invites.id' AFTER status,
  ADD COLUMN invite_code VARCHAR(16) NULL COMMENT '来源邀请码快照' AFTER invite_id;

ALTER TABLE tenant_members
  ADD KEY idx_member_invite (tenant_id, invite_id);
