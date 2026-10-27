import { Entity, Column, Index, Unique } from 'typeorm';
import { TenantScopedEntity } from './base.entity';

/** 租户成员：业主 / 员工 */
@Entity('tenant_members')
@Unique(['tenantId', 'openid'])
export class TenantMember extends TenantScopedEntity {
  @Column({ type: 'varchar', length: 64, comment: '微信 openid' })
  openid!: string;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'union_id' })
  unionId!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: '昵称' })
  nickname!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'staff', comment: '角色: owner|staff' })
  role!: string;

  @Index()
  @Column({ type: 'varchar', length: 16, default: 'active', comment: '状态' })
  status!: string;

  /** 加入时所用邀请 id（可空：首位业主/假登录等） */
  @Column({ type: 'varchar', length: 36, name: 'invite_id', nullable: true })
  inviteId!: string | null;

  /** 加入时邀请码快照，便于成员列表展示 */
  @Column({ type: 'varchar', length: 16, name: 'invite_code', nullable: true })
  inviteCode!: string | null;
}
