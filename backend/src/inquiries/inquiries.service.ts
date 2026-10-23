import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Inquiry } from '../common/entities/inquiry.entity';
import { AuthContext } from '../common/interfaces/auth-context.interface';

export interface InquiryRec {
  id: string;
  tenantId: string;
  productId: string;
  customerId: string;
  content: string;
  status: string;
  createdAt: Date;
}

/** 询价：文字 + 关联单商品（DB_ENABLED=true 落 inquiries 表） */
@Injectable()
export class InquiriesService {
  private readonly listStore: InquiryRec[] = [];
  private seq = 1;

  constructor(@Optional() private readonly ds?: DataSource) {}

  private get db(): DataSource | null {
    return process.env.DB_ENABLED === 'true' && this.ds ? this.ds : null;
  }

  private toRec(e: Inquiry): InquiryRec {
    return {
      id: e.id,
      tenantId: e.tenantId,
      productId: e.productId,
      customerId: e.customerId,
      content: e.content,
      status: e.status,
      createdAt: e.createdAt,
    };
  }

  async create(user: AuthContext, body: { productId: string; content: string }) {
    if (!body.productId || !body.content?.trim()) throw new BadRequestException('商品与询价内容必填');
    if (!user.customerId) throw new ForbiddenException('仅客户可发起询价');
    if (this.db) {
      const repo = this.db.getRepository(Inquiry);
      const saved = await repo.save(
        repo.create({
          tenantId: user.tenantId,
          productId: body.productId,
          customerId: user.customerId,
          content: body.content.trim(),
          status: 'open',
          assigneeMemberId: null,
        }),
      );
      return this.toRec(saved);
    }
    const rec: InquiryRec = {
      id: `inq_${String(this.seq++).padStart(6, '0')}`,
      tenantId: user.tenantId,
      productId: body.productId,
      customerId: user.customerId,
      content: body.content.trim(),
      status: 'open',
      createdAt: new Date(),
    };
    this.listStore.push(rec);
    return rec;
  }

  async list(user: AuthContext) {
    const onlyMine = user.role === 'customer';
    if (this.db) {
      const where: Record<string, string> = { tenantId: user.tenantId };
      if (onlyMine) where.customerId = user.customerId || '-';
      const rows = await this.db.getRepository(Inquiry).find({ where, order: { createdAt: 'DESC' } });
      return rows.map((r) => this.toRec(r));
    }
    return this.listStore.filter(
      (i) => i.tenantId === user.tenantId && (!onlyMine || i.customerId === user.customerId),
    );
  }

  async get(user: AuthContext, id: string) {
    let rec: InquiryRec | null = null;
    if (this.db) {
      const e = await this.db.getRepository(Inquiry).findOne({ where: { id, tenantId: user.tenantId } });
      rec = e ? this.toRec(e) : null;
    } else {
      rec = this.listStore.find((i) => i.id === id && i.tenantId === user.tenantId) || null;
    }
    if (!rec || (user.role === 'customer' && rec.customerId !== user.customerId)) {
      throw new NotFoundException('询价不存在');
    }
    return rec;
  }
}
