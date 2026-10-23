import { Entity, Column, Index } from 'typeorm';
import { TenantScopedEntity } from './base.entity';

/** 询价：文字，关联单商品 */
@Entity('inquiries')
export class Inquiry extends TenantScopedEntity {
  @Index()
  @Column({ type: 'varchar', length: 36, name: 'product_id' })
  productId!: string;

  @Index()
  @Column({ type: 'varchar', length: 36, name: 'customer_id' })
  customerId!: string;

  @Column({ type: 'text', comment: '询价内容' })
  content!: string;

  @Column({ type: 'varchar', length: 16, default: 'open', comment: 'open|replied|closed' })
  status!: string;

  @Column({ type: 'varchar', length: 36, nullable: true, name: 'assignee_member_id' })
  assigneeMemberId!: string | null;
}
