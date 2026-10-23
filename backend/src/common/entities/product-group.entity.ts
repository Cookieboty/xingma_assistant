import { Entity, Column, Index, Unique } from 'typeorm';
import { TenantScopedEntity } from './base.entity';

/** 商品分组：本季 / 过季等 */
@Entity('product_groups')
@Unique(['tenantId', 'code'])
export class ProductGroup extends TenantScopedEntity {
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 64 })
  name!: string;

  @Column({ type: 'tinyint', width: 1, name: 'is_latest', default: 0 })
  isLatest!: boolean;

  @Column({ type: 'int', name: 'sort_order', default: 0 })
  sortOrder!: number;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: string;
}
