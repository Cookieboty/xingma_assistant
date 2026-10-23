import { Entity, Column, Index, Unique, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/** 限制分享名额占用：每个 (share, customer) 一条 */
@Entity('share_event_bindings')
@Unique('uk_share_customer', ['shareEventId', 'customerId'])
export class ShareEventBinding {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'varchar', length: 36, name: 'tenant_id' })
  tenantId!: string;

  @Index()
  @Column({ type: 'varchar', length: 36, name: 'share_event_id' })
  shareEventId!: string;

  @Index()
  @Column({ type: 'varchar', length: 36, name: 'customer_id' })
  customerId!: string;

  @Column({ type: 'datetime', name: 'bound_at' })
  boundAt!: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
