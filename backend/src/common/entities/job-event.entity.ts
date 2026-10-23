import {
  Entity,
  Column,
  Index,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';

@Entity('job_events')
export class JobEventEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index()
  @Column({ type: 'varchar', length: 48, name: 'job_id' })
  jobId!: string;

  @Index()
  @Column({ type: 'varchar', length: 36, name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 16, default: 'info' })
  level!: string;

  @Column({ type: 'varchar', length: 64 })
  event!: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  message!: string | null;

  @Column({ type: 'json', nullable: true })
  data!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;
}
