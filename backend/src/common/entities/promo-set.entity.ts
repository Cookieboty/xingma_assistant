import {
  Entity,
  Column,
  Index,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export type PromoSetStatus = 'generating' | 'done' | 'partial' | 'failed' | 'deleted';

/** 单次 IMAGE_GEN 调用的可分析记录（追加不覆盖） */
export interface ImageGenCallRecord {
  at: string;
  /** 英文最终 prompt（送 IMAGE_GEN） */
  prompt: string;
  /** 中文原话：用户 feature/pose/scene + 读衣中文摘要/参考图角色 */
  promptZh?: string;
  /** 与 prompt 同义留痕，便于中英成对读取 */
  promptEn?: string;
  model: string;
  size: string;
  via?: string;
  status: 'ok' | 'failed';
  error?: string;
  ms?: number;
  jobId?: string;
  legacyJobId?: string;
  setId?: string;
  index: number;
  /** 本次参考图 objectKey（商品图 + 风格样例） */
  refObjectKeys?: string[];
  refCount?: number;
  /** 读衣/宫格准备摘要 */
  garmentPrep?: {
    via?: string;
    detailSufficiency?: string;
    garmentDescZh?: string;
    refKinds?: string[];
  };
}

/** 同图对比：自建羊毛衫 vs 外部 Agent */
export interface OutfitCompareSide {
  status: 'ok' | 'failed' | 'skipped';
  objectKey?: string;
  imageUrls?: string[];
  prompt?: string;
  promptZh?: string;
  promptEn?: string;
  requestId?: string;
  ms?: number;
  error?: string;
  agentCode?: string;
}

export interface OutfitCompareRecord {
  engine: 'self' | 'external' | 'both';
  self?: OutfitCompareSide;
  external?: OutfitCompareSide;
}

export interface PromoSetImage {
  index: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  objectKey?: string;
  mediaId?: string;
  poseId?: string;
  sceneId?: string;
  error?: string;
  ms?: number;
  /** 最近一次英文最终提示词 */
  prompt?: string;
  /** 最近一次中文原话 */
  promptZh?: string;
  promptEn?: string;
  model?: string;
  size?: string;
  /** 历次 IMAGE_GEN 调用（重生追加，不丢历史） */
  genCalls?: ImageGenCallRecord[];
  /** 同图双引擎对比（OUTFIT_ENGINE=both 时写入） */
  compare?: OutfitCompareRecord;
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
