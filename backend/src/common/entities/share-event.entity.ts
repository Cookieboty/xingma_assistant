import { Entity, Column, Index } from 'typeorm';
import { TenantScopedEntity } from './base.entity';

/**
 * 分享事件：
 * - 业主/员工创建时可不指定客户
 * - 客户首次经此入口进入时绑定 boundCustomerId
 * - designated_only 策略下仅绑定客户可看内容
 */
@Entity('share_events')
export class ShareEvent extends TenantScopedEntity {
  @Index()
  @Column({ type: 'varchar', length: 36, name: 'product_id' })
  productId!: string;

  @Column({ type: 'varchar', length: 36, name: 'creator_member_id', comment: '发起分享的成员' })
  creatorMemberId!: string;

  /** open | level_match | designated_only */
  @Column({ type: 'varchar', length: 32, name: 'share_policy' })
  sharePolicy!: string;

  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true, name: 'bound_customer_id', comment: '首访绑定的客户' })
  boundCustomerId!: string | null;

  @Column({ type: 'datetime', nullable: true, name: 'bound_at' })
  boundAt!: Date | null;

  @Column({ type: 'datetime', nullable: true, name: 'expires_at', comment: '可选过期时间' })
  expiresAt!: Date | null;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: string;
}
