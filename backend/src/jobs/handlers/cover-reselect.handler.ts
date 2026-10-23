import { Injectable, Logger, OnModuleInit, Inject, forwardRef, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as path from 'path';
import { JobsService } from '../jobs.service';
import { JobHandler } from '../job.types';
import { VisionClient } from '../../vision/vision.client';
import { orderCoverMediaIds, selectCoverImage } from '../../vision/cover-select';
import { ProductsService } from '../../products/products.service';
import { MediaAsset } from '../../common/entities/media-asset.entity';
import { AuthContext } from '../../common/interfaces/auth-context.interface';

/** 批量/单款重算封面 */
@Injectable()
export class CoverReselectRegistrar implements OnModuleInit {
  private readonly logger = new Logger('CoverReselect');

  constructor(
    private readonly jobs: JobsService,
    private readonly vision: VisionClient,
    @Inject(forwardRef(() => ProductsService)) private readonly products: ProductsService,
    @Optional() private readonly dataSource?: DataSource,
  ) {}

  onModuleInit() {
    this.jobs.registerHandler('cover_reselect', this.handle);
  }

  private handle: JobHandler = async (job, ctx) => {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      throw new Error('需开启数据库');
    }
    const productId = String(job.input.productId || '');
    if (!productId) throw new Error('缺少 productId');
    const user: AuthContext = {
      tenantId: job.tenantId,
      openid: job.userId || 'job-worker',
      role: 'owner',
      memberId: job.userId,
    };
    await ctx.updateProgress({ percent: 10, step: 'load', message: '读取商品图片' });
    const detail: any = await this.products.getDetail(user, productId);
    const repo = this.dataSource.getRepository(MediaAsset);
    const rows = await repo.find({
      where: { tenantId: user.tenantId, productId, status: 'active', type: 'image' },
    });
    const order: string[] = detail.coverMediaIds || [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = [
      ...order.map((id) => byId.get(id)).filter(Boolean),
      ...rows.filter((r) => !order.includes(r.id)),
    ] as MediaAsset[];

    const storageRoot = path.join(process.cwd(), 'storage');
    const cands = ordered
      .filter((r) => !r.objectKey.includes('/promo/'))
      .map((r) => ({
        id: r.id,
        localPath: path.join(storageRoot, r.objectKey),
        filename: path.basename(r.objectKey),
      }))
      .filter((c) => {
        try {
          return require('fs').existsSync(c.localPath);
        } catch {
          return false;
        }
      });
    if (!cands.length) throw new Error('无可用商品图');

    await ctx.updateProgress({ percent: 40, step: 'vision', message: `选封面(${cands.length}张)` });
    const pick = await selectCoverImage(this.vision, cands);
    const allIds = order.length ? order : ordered.map((r) => r.id);
    const byCand = new Map(cands.map((c) => [c.id, c]));
    const newCovers = orderCoverMediaIds(
      allIds.map((id) => {
        const c = byCand.get(id);
        const row = byId.get(id);
        return {
          id,
          filename: c?.filename || (row ? path.basename(row.objectKey) : undefined),
          localPath: c?.localPath,
        };
      }),
      pick.coverId,
    );
    await this.products.update(user, productId, { coverMediaIds: newCovers });
    await ctx.updateProgress({ percent: 100, step: 'done', message: pick.reason });
    return {
      productId,
      styleNo: detail.styleNo,
      beforeCoverId: order[0] || null,
      afterCoverId: pick.coverId,
      via: pick.via,
      reason: pick.reason,
      coverMediaIds: newCovers,
    };
  };
}
