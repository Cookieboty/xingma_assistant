import { Entity, Column, Index } from 'typeorm';
import { TenantScopedEntity } from './base.entity';

/** 媒体资产：按租户分目录，禁止永久公开 URL */
@Entity('media_assets')
export class MediaAsset extends TenantScopedEntity {
  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true, name: 'product_id' })
  productId!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 48, nullable: true, name: 'promo_set_id' })
  promoSetId!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'image', comment: 'image|video' })
  type!: string;

  @Column({ type: 'varchar', length: 16, default: 'oss', comment: 'oss|cos|local' })
  provider!: string;

  @Column({ type: 'varchar', length: 512, name: 'object_key', comment: '对象存储 key，含租户前缀' })
  objectKey!: string;

  @Column({ type: 'varchar', length: 128, nullable: true, name: 'mime_type' })
  mimeType!: string | null;

  @Column({ type: 'bigint', default: 0, name: 'size_bytes' })
  sizeBytes!: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: string;
}
