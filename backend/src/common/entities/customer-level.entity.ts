import { Entity, Column, Unique } from 'typeorm';
import { TenantScopedEntity } from './base.entity';

/** 客户等级（纯人工配置） */
@Entity('customer_levels')
@Unique(['tenantId', 'code'])
export class CustomerLevel extends TenantScopedEntity {
  @Column({ type: 'varchar', length: 32, comment: '等级编码，如 L1/L2' })
  code!: string;

  @Column({ type: 'varchar', length: 64, comment: '等级名称' })
  name!: string;

  @Column({ type: 'int', default: 0, comment: '排序，越大越高' })
  rank!: number;

  @Column({ type: 'tinyint', width: 1, default: 0, name: 'is_default', comment: '是否默认等级' })
  isDefault!: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true, comment: '备注' })
  remark!: string | null;
}
