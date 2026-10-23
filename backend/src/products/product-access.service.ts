import { Injectable } from '@nestjs/common';
import { AuthContext } from '../common/interfaces/auth-context.interface';

export type SharePolicy = 'open' | 'level_match' | 'designated_only';

export interface ProductAccessInput {
  productId: string;
  /** 生效策略（商品覆盖或等级默认） */
  sharePolicy: SharePolicy;
  /** 商品等级要求的最低客户 rank（level_match 用） */
  minCustomerRank?: number | null;
  customerRank?: number | null;
  /** 例外规则：allow | deny | null */
  ruleEffect?: 'allow' | 'deny' | null;
  /** 兼容：首位占用者 */
  boundCustomerId?: string | null;
  /** 限制分享：已占用名额的客户 id 列表（服务端解析，勿信前端伪造） */
  boundCustomerIds?: string[] | null;
  /** 当前是否经该分享入口 */
  viaShareEventId?: string | null;
}

/**
 * 商品访问判定：
 * 1. 业主/员工：始终允许
 * 2. 例外 deny → 拒绝；例外 allow → 放行
 * 3. open → 放行
 * 4. level_match → customerRank >= minCustomerRank
 * 5. designated_only（限制分享）→ 必须经分享且 customerId ∈ boundCustomerIds
 */
@Injectable()
export class ProductAccessService {
  canView(user: AuthContext, input: ProductAccessInput): { ok: boolean; reason: string } {
    if (user.role === 'owner' || user.role === 'staff') {
      return { ok: true, reason: 'staff' };
    }
    if (input.ruleEffect === 'deny') {
      return { ok: false, reason: 'rule_deny' };
    }
    if (input.ruleEffect === 'allow') {
      return { ok: true, reason: 'rule_allow' };
    }
    switch (input.sharePolicy) {
      case 'open':
        return { ok: true, reason: 'open' };
      case 'level_match': {
        const need = input.minCustomerRank ?? 0;
        const have = input.customerRank ?? 0;
        if (have >= need) return { ok: true, reason: 'level_ok' };
        return { ok: false, reason: 'level_insufficient' };
      }
      case 'designated_only': {
        if (!input.viaShareEventId) {
          return { ok: false, reason: 'need_share_entry' };
        }
        const ids =
          input.boundCustomerIds && input.boundCustomerIds.length
            ? input.boundCustomerIds
            : input.boundCustomerId
              ? [input.boundCustomerId]
              : [];
        if (!ids.length) {
          return { ok: false, reason: 'awaiting_bind' };
        }
        if (user.customerId && ids.includes(user.customerId)) {
          return { ok: true, reason: 'limited_slot_match' };
        }
        return { ok: false, reason: 'limited_slot_mismatch' };
      }
      default:
        return { ok: false, reason: 'unknown_policy' };
    }
  }

  /** 是否允许该客户继续转发该商品（按等级+策略） */
  canReshare(user: AuthContext, input: ProductAccessInput): boolean {
    if (user.role === 'owner' || user.role === 'staff') return true;
    const view = this.canView(user, input);
    if (!view.ok) return false;
    return true;
  }
}
