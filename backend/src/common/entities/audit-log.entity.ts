import { Entity, Column, Index, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

/** 关键写操作审计：谁、何时、做了什么 */
@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'varchar', length: 36, name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 36, nullable: true, name: 'actor_member_id' })
  actorMemberId!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'actor_openid' })
  actorOpenid!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true, name: 'actor_role' })
  actorRole!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  action!: string;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'target_type' })
  targetType!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'target_id' })
  targetId!: string | null;

  @Column({ type: 'text', nullable: true, name: 'detail_json' })
  detailJson!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
