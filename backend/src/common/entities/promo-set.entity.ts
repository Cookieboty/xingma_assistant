import {
  Entity,
  Column,
  Index,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export type PromoSetStatus = 'generating' | 'done' | 'partial' | 'failed';

export interface PromoSetImage {
  index: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  objectKey?: string;
  mediaId?: string;
  poseId?: string;
  sceneId?: string;
  error?: string;
  ms?: number;
}

@Entity('promo_sets')
@Index(['tenantId', 'productId', 'createdAt'])
export class PromoSetEntity {
  @PrimaryColumn({ type: 'varchar', length: 48 })
  id!: string;

  @Index()
  @Column({ type: 'varchar', length: 36, name: 'tenant_id' })
  tenantId!: string;

  @Index()
  @Column({ type: 'varchar', length: 36, name: 'product_id' })
  productId!: string;

  @Column({ type: 'varchar', length: 64, name: 'template_id' })
  templateId!: string;

  @Column({ type: 'json', nullable: true })
  params!: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  caption!: string | null;

  @Column({ type: 'varchar', length: 48, nullable: true, name: 'job_id' })
  jobId!: string | null;

  @Column({ type: 'varchar', length: 48, nullable: true, name: 'legacy_job_id' })
  legacyJobId!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'generating' })
  status!: PromoSetStatus;

  @Column({ type: 'json', nullable: true })
  images!: PromoSetImage[] | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}
