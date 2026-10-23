import { Entity, Column, Index, Unique } from 'typeorm';
import { TenantScopedEntity } from './base.entity';

/** 业主邀请：扫码/邀请码绑定为 owner|staff */
@Entity('member_invites')
@Unique(['code'])
export class MemberInvite extends TenantScopedEntity {
  @Column({ type: 'varchar', length: 16, comment: '邀请码' })
  code!: string;

  @Column({ type: 'varchar', length: 16, comment: '角色: owner|staff' })
  role!: string;

  @Column({ type: 'varchar', length: 36, name: 'created_by_member_id' })
  createdByMemberId!: string;

  @Index()
  @Column({ type: 'varchar', length: 16, default: 'active', comment: 'active|revoked|exhausted|expired' })
  status!: string;

  @Column({ type: 'int', name: 'max_uses', default: 1 })
  maxUses!: number;

  @Column({ type: 'int', name: 'use_count', default: 0 })
  useCount!: number;

  @Column({ type: 'datetime', name: 'expires_at', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'varchar', length: 64, name: 'accepted_openid', nullable: true })
  acceptedOpenid!: string | null;

  @Column({ type: 'varchar', length: 36, name: 'accepted_member_id', nullable: true })
  acceptedMemberId!: string | null;

  @Column({ type: 'datetime', name: 'accepted_at', nullable: true })
  acceptedAt!: Date | null;

  @Column({ type: 'varchar', length: 512, name: 'wxacode_object_key', nullable: true })
  wxacodeObjectKey!: string | null;
}
