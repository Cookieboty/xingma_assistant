import { Entity, Column, Index, Unique } from 'typeorm';
import { TenantScopedEntity } from './base.entity';

/** 商品 SKU：颜色/尺码等 */
@Entity('product_skus')
@Unique(['tenantId', 'productId', 'skuCode'])
export class ProductSku extends TenantScopedEntity {
  @Index()
  @Column({ type: 'varchar', length: 36, name: 'product_id' })
  productId!: string;

  @Column({ type: 'varchar', length: 64, name: 'sku_code', comment: 'SKU 编码' })
  skuCode!: string;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: '颜色' })
  color!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true, comment: '尺码' })
  size!: string | null;

  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true, comment: '单价（分可后续扩展）' })
  price!: string | null;

  @Column({ type: 'int', default: 0, comment: '库存（首期仅展示用）' })
  stock!: number;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: string;
}
