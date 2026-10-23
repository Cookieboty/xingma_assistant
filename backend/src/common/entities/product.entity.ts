import { Entity, Column, Index, Unique } from 'typeorm';
import { TenantScopedEntity } from './base.entity';

/** 商品主表：租户内款号唯一 */
@Entity('products')
@Unique(['tenantId', 'styleNo'])
export class Product extends TenantScopedEntity {
  @Index()
  @Column({ type: 'varchar', length: 64, name: 'style_no', comment: '款号' })
  styleNo!: string;

  @Column({ type: 'varchar', length: 128, comment: '商品名称' })
  name!: string;

  @Column({ type: 'text', nullable: true, comment: '描述' })
  description!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true, comment: '材质' })
  material!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 36, name: 'level_id', comment: '商品等级' })
  levelId!: string;

  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true, name: 'group_id', comment: '商品分组' })
  groupId!: string | null;

  /** 价格展示：show=展示价格 hide=显示「价格请询价」 */
  @Column({ type: 'varchar', length: 16, name: 'price_display', default: 'show' })
  priceDisplay!: string;

  /** 覆盖等级默认策略；null 则走商品等级 default_share_policy */
  @Column({ type: 'varchar', length: 32, nullable: true, name: 'share_policy' })
  sharePolicy!: string | null;

  /** 客户是否可长按/保存商品图；默认 false */
  @Column({ type: 'tinyint', width: 1, name: 'allow_customer_download', default: 0 })
  allowCustomerDownload!: boolean;

  @Column({ type: 'json', nullable: true, name: 'cover_media_ids', comment: '封面 MediaAsset id 列表' })
  coverMediaIds!: string[] | null;

  @Column({ type: 'json', nullable: true, comment: '标签列表' })
  tags!: string[] | null;

  @Column({ type: 'varchar', length: 16, default: 'on_sale', comment: 'on_sale|off_sale|draft' })
  status!: string;

  @Column({ type: 'int', default: 0, name: 'sort_order' })
  sortOrder!: number;
}
