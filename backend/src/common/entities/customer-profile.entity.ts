import { Entity, Column, Index, Unique } from 'typeorm';
import { TenantScopedEntity } from './base.entity';

/** 客户档案：首次通过分享进入时自动建档 */
@Entity('customer_profiles')
@Unique(['tenantId', 'openid'])
export class CustomerProfile extends TenantScopedEntity {
  @Index()
  @Column({ type: 'varchar', length: 64, comment: '微信 openid' })
  openid!: string;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'union_id' })
  unionId!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: '昵称' })
  nickname!: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true, name: 'avatar_url' })
  avatarUrl!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 36, name: 'level_id', comment: '客户等级 ID' })
  levelId!: string;

  @Column({ type: 'varchar', length: 32, nullable: true, comment: '手机号（可选）' })
  phone!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, comment: '备注' })
  remark!: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true, name: 'first_share_event_id', comment: '首次进入的分享事件' })
  firstShareEventId!: string | null;
}
