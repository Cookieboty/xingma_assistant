import { Entity, Column, Index, Unique } from 'typeorm';
import { TenantScopedEntity } from './base.entity';

/**
 * 客户-商品例外规则：
 * allow = 即使策略不允许也放行
 * deny  = 即使策略允许也拒绝
 */
@Entity('customer_product_rules')
@Unique(['tenantId', 'customerId', 'productId'])
export class CustomerProductRule extends TenantScopedEntity {
  @Index()
  @Column({ type: 'varchar', length: 36, name: 'customer_id' })
  customerId!: string;

  @Index()
  @Column({ type: 'varchar', length: 36, name: 'product_id' })
  productId!: string;

  @Column({ type: 'varchar', length: 16, comment: 'allow|deny' })
  effect!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  remark!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'active', comment: 'active|deleted' })
  status!: string;
}
