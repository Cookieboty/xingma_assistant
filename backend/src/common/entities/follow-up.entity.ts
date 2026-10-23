import { Entity, Column, Index } from 'typeorm';
import { TenantScopedEntity } from './base.entity';

/** 跟进记录（询价回复 / 客户备注等） */
@Entity('follow_ups')
export class FollowUp extends TenantScopedEntity {
  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true, name: 'inquiry_id' })
  inquiryId!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true, name: 'customer_id' })
  customerId!: string | null;

  @Column({ type: 'varchar', length: 36, name: 'author_member_id' })
  authorMemberId!: string;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'varchar', length: 32, default: 'note', comment: 'note|reply' })
  kind!: string;
}
