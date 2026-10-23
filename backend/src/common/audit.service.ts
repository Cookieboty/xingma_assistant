import { Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthContext } from './interfaces/auth-context.interface';
import { AuditLog } from './entities/audit-log.entity';

export type AuditInput = {
  tenantId: string;
  action: string;
  actor?: AuthContext | null;
  targetType?: string | null;
  targetId?: string | null;
  detail?: Record<string, unknown> | null;
};

/**
 * 关键写操作审计。DB 不可用时仅打日志，不阻断主流程。
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly mem: Array<Record<string, unknown>> = [];

  constructor(@Optional() private readonly ds?: DataSource) {}

  private get db(): DataSource | null {
    return process.env.DB_ENABLED === 'true' && this.ds ? this.ds : null;
  }

  async record(input: AuditInput): Promise<void> {
    const actor = input.actor;
    const row = {
      tenantId: input.tenantId,
      actorMemberId: actor?.memberId || null,
      actorOpenid: actor?.openid || null,
      actorRole: actor?.role || null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      detailJson: input.detail ? JSON.stringify(input.detail).slice(0, 4000) : null,
    };
    this.logger.log(
      `audit action=${row.action} tenant=${row.tenantId} actor=${row.actorMemberId || row.actorOpenid || '-'} target=${row.targetType || ''}:${row.targetId || ''}`,
    );
    try {
      if (this.db) {
        const repo = this.db.getRepository(AuditLog);
        await repo.save(repo.create(row));
      } else {
        this.mem.push({ ...row, createdAt: new Date() });
        if (this.mem.length > 500) this.mem.shift();
      }
    } catch (e) {
      this.logger.warn(`audit persist failed: ${(e as Error).message}`);
    }
  }
}
