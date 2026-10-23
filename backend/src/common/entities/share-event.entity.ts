import { Entity, Column, Index } from 'typeorm';
import { TenantScopedEntity } from './base.entity';

/**
 * 分享事件：
 * - 业主/员工创建时不预先选客户
 * - designated_only（限制分享）：前 N 位打开链接的客户占用名额（见 share_event_bindings / slot_limit）
 * - open（公开分享）：无名义额限制
 * - boundCustomerId：兼容字段，记录首位占用者
 */
@Entity('share_events')
export class ShareEvent extends TenantScopedEntity {
  @Index()
  @Column({ type: 'varchar', length: 36, name: 'product_id' })
  productId!: string;

  @Column({ type: 'varchar', length: 36, name: 'creator_member_id', comment: '发起分享的成员' })
  creatorMemberId!: string;

  /** open | level_match | designated_only（UI：限制分享） */
  @Column({ type: 'varchar', length: 32, name: 'share_policy' })
  sharePolicy!: string;

  /** 限制分享名额（公开分享可忽略）；创建时取 SHARE_LIMIT_SLOTS 默认 5 */
  @Column({ type: 'int', name: 'slot_limit', default: 5 })
  slotLimit!: number;

  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true, name: 'bound_customer_id', comment: '首位占用名额的客户（兼容）' })
  boundCustomerId!: string | null;

  @Column({ type: 'datetime', nullable: true, name: 'bound_at' })
  boundAt!: Date | null;

  @Column({ type: 'datetime', nullable: true, name: 'expires_at', comment: '可选过期时间' })
  expiresAt!: Date | null;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: string;
}
