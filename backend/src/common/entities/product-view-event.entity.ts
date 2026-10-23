import { Entity, Column, Index } from 'typeorm';
import { TenantScopedEntity } from './base.entity';

/** 商品浏览埋点 */
@Entity('product_view_events')
export class ProductViewEvent extends TenantScopedEntity {
  @Index()
  @Column({ type: 'varchar', length: 36, name: 'product_id' })
  productId!: string;

  @Column({ type: 'varchar', length: 36, nullable: true, name: 'customer_id' })
  customerId!: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true, name: 'member_id' })
  memberId!: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true, name: 'share_event_id' })
  shareEventId!: string | null;

  @Column({ type: 'varchar', length: 32, name: 'viewer_role', comment: 'customer|staff|owner|anonymous' })
  viewerRole!: string;

  @Column({ type: 'varchar', length: 16, default: 'ok', comment: 'ok|denied' })
  result!: string;
}
