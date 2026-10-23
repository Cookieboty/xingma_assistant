import {
  Entity,
  Column,
  Index,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export type JobStatusDb = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

@Entity('jobs')
@Index(['tenantId', 'status', 'createdAt'])
@Index(['status', 'nextRunAt', 'createdAt'])
export class JobEntity {
  @PrimaryColumn({ type: 'varchar', length: 48 })
  id!: string;

  @Index()
  @Column({ type: 'varchar', length: 36, name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 64 })
  type!: string;

  @Column({ type: 'varchar', length: 16, default: 'queued' })
  status!: JobStatusDb;

  @Column({ type: 'json', nullable: true })
  progress!: Record<string, unknown> | null;

  @Column({ type: 'json' })
  payload!: Record<string, unknown>;

  @Column({ type: 'json', nullable: true })
  result!: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'int', name: 'max_attempts', default: 3 })
  maxAttempts!: number;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'created_by' })
  createdBy!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'locked_by' })
  lockedBy!: string | null;

  @Column({ type: 'datetime', precision: 3, nullable: true, name: 'next_run_at' })
  nextRunAt!: Date | null;

  @Column({ type: 'datetime', precision: 3, nullable: true, name: 'started_at' })
  startedAt!: Date | null;

  @Column({ type: 'datetime', precision: 3, nullable: true, name: 'finished_at' })
  finishedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}
