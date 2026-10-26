import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { MemberInvite } from '../common/entities/member-invite.entity';
import { OssClient } from '../media/oss.client';
import { TenantsService, MemberRec } from '../tenants/tenants.service';
import { WechatService } from '../wechat/wechat.service';
import { AuditService } from '../common/audit.service';

export type InviteRole = 'owner' | 'staff';

interface MemInvite {
  id: string;
  tenantId: string;
  code: string;
  role: InviteRole;
  createdByMemberId: string;
  status: string;
  maxUses: number;
  useCount: number;
  expiresAt: Date | null;
  acceptedOpenid: string | null;
  acceptedMemberId: string | null;
  acceptedAt: Date | null;
  wxacodeObjectKey: string | null;
  createdAt: Date;
}

@Injectable()
export class InvitesService {
  private readonly logger = new Logger(InvitesService.name);
  private readonly mem = new Map<string, MemInvite>();

  constructor(
    private readonly tenants: TenantsService,
    private readonly wechat: WechatService,
    private readonly oss: OssClient,
    private readonly audit: AuditService,
    @Optional() private readonly ds?: DataSource,
  ) {}

  private get db(): DataSource | null {
    return process.env.DB_ENABLED === 'true' && this.ds ? this.ds : null;
  }

  private genCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(8);
    let s = '';
    for (let i = 0; i < 8; i++) s += alphabet[bytes[i] % alphabet.length];
    return s;
  }

  private toDto(row: MemberInvite | MemInvite, wxacodeUrl?: string | null) {
    return {
      id: row.id,
      code: row.code,
      role: 'staff', // UI 平权：对外一律员工
      status: row.status,
      maxUses: row.maxUses,
      useCount: row.useCount,
      expiresAt: row.expiresAt,
      acceptedMemberId: row.acceptedMemberId,
      acceptedAt: row.acceptedAt,
      createdAt: 'createdAt' in row ? row.createdAt : undefined,
      wxacodeUrl: wxacodeUrl ?? null,
      scene: `c=${row.code}`,
      path: 'pages/invite/accept/accept',
    };
  }

  async create(
    user: AuthContext,
    body: { role?: string; maxUses?: number; expiresInDays?: number },
  ) {
    if (user.role !== 'owner' && user.role !== 'staff') {
      throw new ForbiddenException('无权创建邀请');
    }
    // 员工平权：新邀请一律 staff（忽略 body.role 的 owner）
    const role = 'staff' as InviteRole;
    const maxUses = Math.min(Math.max(Number(body.maxUses) || 3, 1), 50);
    const days = body.expiresInDays != null ? Number(body.expiresInDays) : 7;
    const expiresAt =
      days > 0 && Number.isFinite(days)
        ? new Date(Date.now() + Math.min(days, 90) * 86400_000)
        : null;

    let code = this.genCode();
    for (let i = 0; i < 5; i++) {
      const hit = await this.findByCode(code);
      if (!hit) break;
      code = this.genCode();
    }

    const createdBy = user.memberId || '';
    let invite: MemberInvite | MemInvite;

    if (this.db) {
      const repo = this.db.getRepository(MemberInvite);
      invite = await repo.save(
        repo.create({
          tenantId: user.tenantId,
          code,
          role,
          createdByMemberId: createdBy,
          status: 'active',
          maxUses,
          useCount: 0,
          expiresAt,
          acceptedOpenid: null,
          acceptedMemberId: null,
          acceptedAt: null,
          wxacodeObjectKey: null,
        }),
      );
    } else {
      invite = {
        id: `inv_${code}`,
        tenantId: user.tenantId,
        code,
        role,
        createdByMemberId: createdBy,
        status: 'active',
        maxUses,
        useCount: 0,
        expiresAt,
        acceptedOpenid: null,
        acceptedMemberId: null,
        acceptedAt: null,
        wxacodeObjectKey: null,
        createdAt: new Date(),
      };
      this.mem.set(code, invite);
    }

    const wxacodeUrl = await this.ensureWxacode(user.tenantId, invite);
    await this.audit.record({
      tenantId: user.tenantId,
      actor: user,
      action: 'invite.create',
      targetType: 'member_invite',
      targetId: invite.id,
      detail: { code: invite.code, role, maxUses, expiresAt },
    });
    return this.toDto(invite, wxacodeUrl);
  }

  async list(user: AuthContext) {
    if (user.role !== 'owner' && user.role !== 'staff') {
      throw new ForbiddenException('无权查看邀请');
    }
    if (this.db) {
      const rows = await this.db.getRepository(MemberInvite).find({
        where: { tenantId: user.tenantId },
        order: { createdAt: 'DESC' },
        take: 100,
      });
      return rows.map((r) =>
        this.toDto(r, r.wxacodeObjectKey ? this.oss.publicUrl(r.wxacodeObjectKey) : null),
      );
    }
    return [...this.mem.values()]
      .filter((x) => x.tenantId === user.tenantId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) =>
        this.toDto(r, r.wxacodeObjectKey ? this.oss.publicUrl(r.wxacodeObjectKey) : null),
      );
  }

  async revoke(user: AuthContext, id: string) {
    if (user.role !== 'owner' && user.role !== 'staff') {
      throw new ForbiddenException('无权撤销邀请');
    }
    if (this.db) {
      const repo = this.db.getRepository(MemberInvite);
      const row = await repo.findOne({ where: { id, tenantId: user.tenantId } });
      if (!row) throw new NotFoundException('邀请不存在');
      if (row.status === 'revoked') return this.toDto(row);
      row.status = 'revoked';
      await repo.save(row);
      await this.audit.record({
        tenantId: user.tenantId,
        actor: user,
        action: 'invite.revoke',
        targetType: 'member_invite',
        targetId: row.id,
        detail: { code: row.code },
      });
      return this.toDto(row, row.wxacodeObjectKey ? this.oss.publicUrl(row.wxacodeObjectKey) : null);
    }
    const row = [...this.mem.values()].find((x) => x.id === id && x.tenantId === user.tenantId);
    if (!row) throw new NotFoundException('邀请不存在');
    row.status = 'revoked';
    await this.audit.record({
      tenantId: user.tenantId,
      actor: user,
      action: 'invite.revoke',
      targetType: 'member_invite',
      targetId: row.id,
      detail: { code: row.code },
    });
    return this.toDto(row);
  }

  async listMembers(user: AuthContext) {
    if (user.role !== 'owner' && user.role !== 'staff') {
      throw new ForbiddenException('无权查看成员');
    }
    const rows = await this.tenants.listMembers(user.tenantId);
    // 不向前端返回 openid；角色对外统一为员工（平权）
    return rows.map((m) => ({
      id: m.id,
      nickname: m.nickname,
      status: m.status,
      role: 'staff',
      createdAt: m.createdAt,
      inviteId: m.inviteId || null,
      inviteCode: m.inviteCode || null,
    }));
  }

  /** 踢除员工（平权：任意员工可踢，不可踢自己）：逻辑禁用，之后不能再以员工登录；可再被邀请激活 */
  async disableMember(user: AuthContext, memberId: string) {
    if (user.role !== 'owner' && user.role !== 'staff') {
      throw new ForbiddenException('无权踢除员工');
    }
    const id = String(memberId || '').trim();
    if (!id) throw new BadRequestException('缺少成员 id');
    if (user.memberId && user.memberId === id) {
      throw new BadRequestException('不能踢除自己');
    }
    try {
      const r = await this.tenants.disableMember(user.tenantId, id);
      await this.audit.record({
        tenantId: user.tenantId,
        actor: user,
        action: 'member.disable',
        targetType: 'tenant_member',
        targetId: r.id,
      });
      return r;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === 'NOT_FOUND') throw new NotFoundException('成员不存在');
      throw e;
    }
  }

  async acceptByCode(
    tenantId: string,
    openid: string,
    codeRaw: string,
  ): Promise<{ member: MemberRec; inviteCode: string; role: InviteRole }> {
    const code = String(codeRaw || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (!code) throw new BadRequestException('缺少邀请码');

    const invite = await this.findByCode(code);
    if (!invite || invite.tenantId !== tenantId) {
      throw new BadRequestException('邀请码无效');
    }
    if (invite.status === 'revoked') throw new BadRequestException('邀请已撤销');
    if (invite.status === 'exhausted') throw new BadRequestException('邀请已用完');
    if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
      await this.markStatus(invite, 'expired');
      throw new BadRequestException('邀请已过期');
    }
    if (invite.status !== 'active') throw new BadRequestException('邀请不可用');
    if (invite.useCount >= invite.maxUses) {
      await this.markStatus(invite, 'exhausted');
      throw new BadRequestException('邀请已用完');
    }

    const role = (invite.role === 'owner' ? 'owner' : 'staff') as InviteRole;
    // 已是活跃成员再点邀请卡：不重复消耗次数，直接回成员身份
    const already = await this.tenants.findMember(tenantId, openid);
    if (already) {
      const keepRole = (already.role === 'owner' || role === 'owner' ? 'owner' : role) as InviteRole;
      const member =
        keepRole !== already.role
          ? await this.tenants.ensureMember(tenantId, openid, keepRole)
          : already;
      await this.tenants.setMemberInviteSource(tenantId, member.id, {
        inviteId: invite.id,
        inviteCode: invite.code,
      });
      this.logger.log(`invite re-entry code=${code} tenant=${tenantId} role=${member.role}`);
      return { member, inviteCode: code, role: member.role as InviteRole };
    }

    const member = await this.tenants.ensureMember(tenantId, openid, role);
    await this.tenants.setMemberInviteSource(tenantId, member.id, {
      inviteId: invite.id,
      inviteCode: invite.code,
    });

    invite.useCount += 1;
    invite.acceptedOpenid = openid;
    invite.acceptedMemberId = member.id;
    invite.acceptedAt = new Date();
    if (invite.useCount >= invite.maxUses) invite.status = 'exhausted';
    await this.saveInvite(invite);

    this.logger.log(`invite accepted code=${code} tenant=${tenantId} role=${role}`);
    return { member, inviteCode: code, role };
  }

  async accept(user: AuthContext, body: { code?: string }) {
    const r = await this.acceptByCode(user.tenantId, user.openid, body?.code || '');
    await this.audit.record({
      tenantId: user.tenantId,
      actor: user,
      action: 'member.accept',
      targetType: 'tenant_member',
      targetId: r.member.id,
      detail: { inviteCode: r.inviteCode, role: r.role },
    });
    return { ok: true, role: r.role, memberId: r.member.id, inviteCode: r.inviteCode };
  }

  private async findByCode(code: string): Promise<MemberInvite | MemInvite | null> {
    if (this.db) {
      return this.db.getRepository(MemberInvite).findOne({ where: { code } });
    }
    return this.mem.get(code) || null;
  }

  private async markStatus(invite: MemberInvite | MemInvite, status: string) {
    invite.status = status;
    await this.saveInvite(invite);
  }

  private async saveInvite(invite: MemberInvite | MemInvite) {
    if (this.db) {
      await this.db.getRepository(MemberInvite).save(invite as MemberInvite);
      return;
    }
    this.mem.set(invite.code, invite as MemInvite);
  }

  private async ensureWxacode(
    tenantId: string,
    invite: MemberInvite | MemInvite,
  ): Promise<string | null> {
    if (invite.wxacodeObjectKey) {
      return this.oss.publicUrl(invite.wxacodeObjectKey);
    }
    try {
      const tenant = await this.tenants.getById(tenantId);
      if (!tenant) return null;
      const secret = await this.tenants.getAppSecret(tenant);
      if (!secret) {
        this.logger.warn('无 AppSecret，跳过小程序码（仍可用邀请码）');
        return null;
      }
      const scene = `c=${invite.code}`;
      const buf = await this.wechat.getWxaCodeUnlimited({
        appId: tenant.wxAppId,
        secret,
        scene,
        page: 'pages/invite/accept/accept',
        checkPath: false,
        envVersion: (['release','trial','develop'].includes(String(process.env.WECHAT_WXACODE_ENV || ''))
          ? (process.env.WECHAT_WXACODE_ENV as 'release' | 'trial' | 'develop')
          : process.env.NODE_ENV === 'production'
            ? 'release'
            : 'trial'),
        width: 430,
      });
      const objectKey = `tenants/${tenantId}/invites/${invite.code}.png`;
      try {
        const abs = path.join(process.cwd(), 'storage', objectKey);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buf);
      } catch (e) {
        this.logger.warn(`本地保存小程序码失败: ${(e as Error).message}`);
      }
      await this.oss.putObjectSafe(buf, objectKey, 'image/png');
      invite.wxacodeObjectKey = objectKey;
      await this.saveInvite(invite);
      return this.oss.publicUrl(objectKey);
    } catch (e) {
      this.logger.warn(`生成小程序码失败（仍可用邀请码）: ${(e as Error).message}`);
      return null;
    }
  }
}
