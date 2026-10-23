import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ShareEvent } from '../common/entities/share-event.entity';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { ProductAccessService, SharePolicy } from '../products/product-access.service';
import { ProductsService } from '../products/products.service';
import { CustomersService } from '../customers/customers.service';

export interface ShareRecord {
  id: string;
  tenantId: string;
  productId: string;
  creatorMemberId: string;
  sharePolicy: SharePolicy;
  boundCustomerId: string | null;
  boundAt: Date | null;
  status: string;
  createdAt: Date;
}

/**
 * 分享服务核心逻辑：
 * 1. 业主/员工创建分享时不必先选客户
 * 2. 客户第一次打开 → 自动建档 + 绑定 ShareEvent.boundCustomerId
 * 3. 之后任何人打开同一条分享 → 比对当前访问者与 boundCustomerId
 */
@Injectable()
export class SharesService {
  private readonly shares = new Map<string, ShareRecord>();
  private seq = 1;

  constructor(
    private readonly access: ProductAccessService,
    private readonly products: ProductsService,
    private readonly customers: CustomersService,
    @Optional() private readonly ds?: DataSource,
  ) {}

  private get db(): DataSource | null {
    return process.env.DB_ENABLED === 'true' && this.ds ? this.ds : null;
  }

  private toRec(e: ShareEvent): ShareRecord {
    return {
      id: e.id,
      tenantId: e.tenantId,
      productId: e.productId,
      creatorMemberId: e.creatorMemberId,
      sharePolicy: e.sharePolicy as SharePolicy,
      boundCustomerId: e.boundCustomerId,
      boundAt: e.boundAt,
      status: e.status,
      createdAt: e.createdAt,
    };
  }

  private async load(tenantId: string, shareId: string): Promise<ShareRecord | null> {
    if (this.db) {
      const e = await this.db.getRepository(ShareEvent).findOne({ where: { id: shareId, tenantId } });
      return e ? this.toRec(e) : null;
    }
    const r = this.shares.get(shareId);
    return r && r.tenantId === tenantId ? r : null;
  }

  /**
   * 首访绑定（原子）：仅当 bound_customer_id IS NULL 时写入，防止并发下两个客户同时绑定。
   * 返回绑定后的最新记录。
   */
  private async bindIfUnbound(share: ShareRecord, customerId: string): Promise<{ rec: ShareRecord; boundNow: boolean }> {
    if (this.db) {
      const now = new Date();
      const res = await this.db
        .getRepository(ShareEvent)
        .createQueryBuilder()
        .update(ShareEvent)
        .set({ boundCustomerId: customerId, boundAt: now })
        .where('id = :id AND tenant_id = :tid AND bound_customer_id IS NULL', { id: share.id, tid: share.tenantId })
        .execute();
      const fresh = (await this.load(share.tenantId, share.id))!;
      return { rec: fresh, boundNow: (res.affected || 0) > 0 };
    }
    if (!share.boundCustomerId) {
      share.boundCustomerId = customerId;
      share.boundAt = new Date();
      this.shares.set(share.id, share);
      return { rec: share, boundNow: true };
    }
    return { rec: share, boundNow: false };
  }

  /** 创建分享：两种策略可显式指定，默认取商品策略 */
  async createShare(
    user: AuthContext,
    body: { productId: string; sharePolicy?: SharePolicy },
  ) {
    if (user.role !== 'owner' && user.role !== 'staff') {
      throw new ForbiddenException('仅业主/员工可创建分享');
    }
    // 校验商品归属
    await this.products.getDetail(user, body.productId);
    const policy = body.sharePolicy || 'designated_only';
    let rec: ShareRecord;
    if (this.db) {
      const repo = this.db.getRepository(ShareEvent);
      const saved = await repo.save(
        repo.create({
          tenantId: user.tenantId,
          productId: body.productId,
          creatorMemberId: user.memberId || 'unknown',
          sharePolicy: policy,
          boundCustomerId: null,
          boundAt: null,
          expiresAt: null,
          status: 'active',
        }),
      );
      rec = this.toRec(saved);
    } else {
      rec = {
        id: `share_${String(this.seq++).padStart(6, '0')}`,
        tenantId: user.tenantId,
        productId: body.productId,
        creatorMemberId: user.memberId || 'unknown',
        sharePolicy: policy,
        boundCustomerId: null,
        boundAt: null,
        status: 'active',
        createdAt: new Date(),
      };
      this.shares.set(rec.id, rec);
    }
    const id = rec.id;
    return {
      shareId: id,
      productId: rec.productId,
      sharePolicy: rec.sharePolicy,
      path: `/pages/share/landing?shareId=${id}`,
    };
  }

  /**
   * 打开分享落地：
   * - 若未绑定且访问者为客户 → 自动建档并绑定
   * - 若已绑定 → 身份比对，通过则返回商品内容（含签名 URL 占位）
   */
  async openShare(user: AuthContext, shareId: string) {
    let share = await this.load(user.tenantId, shareId);
    if (!share) {
      throw new NotFoundException('分享不存在');
    }
    if (share.status !== 'active') {
      throw new ForbiddenException('分享已失效');
    }

    // 员工打开：直接看，不绑定
    if (user.role === 'owner' || user.role === 'staff') {
      const product = await this.products.getDetail(user, share.productId);
      return { share, product, bound: !!share.boundCustomerId, access: 'staff' };
    }

    // 客户路径：确保档案存在
    const customer = await this.customers.ensureProfile(user);

    if (!share.boundCustomerId) {
      // 首访绑定（DB 模式条件更新，保证只绑定一次）
      const { rec, boundNow } = await this.bindIfUnbound(share, customer.id);
      share = rec;
      if (boundNow) await this.customers.markFirstShare(customer.id, shareId, share.tenantId);
    }

    const verdict = this.access.canView(user, {
      productId: share.productId,
      sharePolicy: share.sharePolicy,
      viaShareEventId: shareId,
      boundCustomerId: share.boundCustomerId,
    });

    // designated_only 绑定后，customerId 必须一致
    // ensureProfile 后 user.customerId 可能仍是 JWT 里的 mock；以档案 id 为准比对
    if (share.sharePolicy === 'designated_only') {
      if (customer.id !== share.boundCustomerId) {
        throw new ForbiddenException('该分享仅指定客户可查看');
      }
    } else if (!verdict.ok && verdict.reason !== 'awaiting_bind') {
      throw new ForbiddenException(`无权查看: ${verdict.reason}`);
    }

    const product = await this.products.getDetail(
      { ...user, customerId: customer.id, role: 'customer' },
      share.productId,
      {
        shareEventId: shareId,
        boundCustomerId: share.boundCustomerId ?? undefined,
      },
    );

    return {
      share: {
        id: share.id,
        productId: share.productId,
        sharePolicy: share.sharePolicy,
        boundCustomerId: share.boundCustomerId,
        boundAt: share.boundAt,
      },
      product,
      customerId: customer.id,
      access: 'granted',
    };
  }

  getShare(tenantId: string, shareId: string) {
    return this.load(tenantId, shareId);
  }
}
