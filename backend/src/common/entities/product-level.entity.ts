import { Entity, Column, Unique } from 'typeorm';
import { TenantScopedEntity } from './base.entity';

/** 商品等级（决定默认分享策略） */
@Entity('product_levels')
@Unique(['tenantId', 'code'])
export class ProductLevel extends TenantScopedEntity {
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  @Column({ type: 'varchar', length: 64 })
  name!: string;

  @Column({ type: 'int', default: 0, comment: '等级权重' })
  rank!: number;

  /**
   * 默认分享策略：
   * open - 任意人可看
   * level_match - 客户等级 >= 要求才可继续分享/查看（结合规则）
   * designated_only - 仅绑定指定客户可看
   */
  @Column({ type: 'varchar', length: 32, name: 'default_share_policy', default: 'designated_only' })
  defaultSharePolicy!: string;

  @Column({ type: 'int', nullable: true, name: 'min_customer_rank', comment: '客户最低等级要求（可选）' })
  minCustomerRank!: number | null;
}
