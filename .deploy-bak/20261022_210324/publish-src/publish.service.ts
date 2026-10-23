import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { AuthContext } from '../../common/interfaces/auth-context.interface';
import { MediaAsset } from '../../common/entities/media-asset.entity';
import { newId } from '../../common/utils/id';
import { ProductsService } from '../products.service';
import { buildPublishSuggestion } from './publish-analyze';
import {
  ConfirmPublishInput,
  PublishBatch,
  PublishBatchAsset,
} from './publish.types';
import { JobsService } from '../../jobs/jobs.service';
import { VisionClient } from '../../vision/vision.client';
import { registerPublishProductHandler } from '../../jobs/handlers/publish-product.handler';

const BATCH_TTL_MS = 2 * 60 * 60 * 1000; // 2h

@Injectable()
export class PublishService implements OnModuleInit {
  private readonly batches = new Map<string, PublishBatch>();
  private readonly logger = new Logger('Publish');

  constructor(
    private readonly products: ProductsService,
    private readonly config: ConfigService,
    private readonly jobs: JobsService,
    private readonly vision: VisionClient,
    @Optional() private readonly dataSource?: DataSource,
  ) {}

  onModuleInit() {
    registerPublishProductHandler(this.jobs, this, this.vision);
  }

  private storageRoot() {
    return path.join(process.cwd(), 'storage');
  }

  private publicUrl(objectKey: string) {
    // 小程序本地联调固定走本机；可用 MEDIA_PUBLIC_BASE 覆盖
    const base = (process.env.MEDIA_PUBLIC_BASE || process.env.APP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
    return `${base}/media/${objectKey}`;
  }

  private purgeExpired() {
    const now = Date.now();
    for (const [id, b] of this.batches) {
      if (now - b.createdAt > BATCH_TTL_MS) this.batches.delete(id);
    }
  }

  getBatch(tenantId: string, batchId: string): PublishBatch {
    this.purgeExpired();
    const b = this.batches.get(batchId);
    if (!b || b.tenantId !== tenantId) throw new NotFoundException('发品批次不存在或已过期');
    return b;
  }

  /**
   * 上传一批无序图 → 落盘 media_assets + 内存 batch
   */
  async uploadBatch(
    user: AuthContext,
    files: Express.Multer.File[],
    existingBatchId?: string,
  ) {
    if (!files?.length) throw new BadRequestException('请至少上传一张图片');
    this.purgeExpired();

    let batch: PublishBatch;
    if (existingBatchId) {
      batch = this.getBatch(user.tenantId, existingBatchId);
    } else {
      batch = {
        batchId: newId('batch'),
        tenantId: user.tenantId,
        createdAt: Date.now(),
        assets: [],
      };
      this.batches.set(batch.batchId, batch);
    }

    const uploadDir = path.join(
      this.storageRoot(),
      'tenants',
      user.tenantId,
      'uploads',
      batch.batchId,
    );
    fs.mkdirSync(uploadDir, { recursive: true });

    const added: PublishBatchAsset[] = [];
    for (const file of files) {
      const ext = path.extname(file.originalname || '') || this.extFromMime(file.mimetype) || '.jpg';
      const safeName = `${String(batch.assets.length + added.length + 1).padStart(2, '0')}_${Date.now()}${ext}`;
      const localPath = path.join(uploadDir, safeName);
      fs.writeFileSync(localPath, file.buffer);
      const objectKey = `tenants/${user.tenantId}/uploads/${batch.batchId}/${safeName}`;
      const mediaId = await this.insertMediaAsset(user.tenantId, {
        objectKey,
        mimeType: file.mimetype || 'image/jpeg',
        sizeBytes: file.size || file.buffer.length,
      });
      const asset: PublishBatchAsset = {
        mediaId,
        objectKey,
        url: this.publicUrl(objectKey),
        filename: file.originalname || safeName,
        mimeType: file.mimetype || 'image/jpeg',
        sizeBytes: file.size || file.buffer.length,
        localPath,
      };
      added.push(asset);
    }
    batch.assets.push(...added);
    batch.suggestion = undefined;

    return {
      batchId: batch.batchId,
      assets: batch.assets.map((a) => ({
        mediaId: a.mediaId,
        url: a.url,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
      })),
      count: batch.assets.length,
    };
  }

  /**
   * 上传后立即建异步发品任务（主流程）。
   * 返回 jobId，前端轮询 /api/jobs/:id。
   */
  async uploadAndEnqueue(
    user: AuthContext,
    files: Express.Multer.File[],
    body?: {
      batchId?: string;
      levelId?: string;
      status?: 'on_sale' | 'off_sale' | 'draft';
      priceDisplay?: 'show' | 'hide';
      styleNo?: string;
      name?: string;
    },
  ) {
    const uploaded = await this.uploadBatch(user, files || [], body?.batchId);
    const job = await this.jobs.create(user, 'publish_product', {
      batchId: uploaded.batchId,
      levelId: body?.levelId || process.env.DEFAULT_PRODUCT_LEVEL_ID || 'pl_open',
      status: body?.status || 'on_sale',
      priceDisplay: body?.priceDisplay || 'show',
      styleNo: body?.styleNo,
      name: body?.name,
    });
    this.logger.log(`enqueue publish_product ${job.id} batch=${uploaded.batchId}`);
    return {
      jobId: job.id,
      batchId: uploaded.batchId,
      count: uploaded.count,
      job,
    };
  }

  /** 对已有 batch 再入队（失败重试之外的手动触发） */
  async enqueueExistingBatch(
    user: AuthContext,
    batchId: string,
    body?: { levelId?: string; status?: string; priceDisplay?: string; styleNo?: string; name?: string },
  ) {
    this.getBatch(user.tenantId, batchId);
    const job = await this.jobs.create(user, 'publish_product', {
      batchId,
      levelId: body?.levelId || process.env.DEFAULT_PRODUCT_LEVEL_ID || 'pl_open',
      status: body?.status || 'on_sale',
      priceDisplay: body?.priceDisplay || 'show',
      styleNo: body?.styleNo,
      name: body?.name,
    });
    return { jobId: job.id, batchId, job };
  }

  async analyze(user: AuthContext, batchId: string, body?: { runOcr?: boolean }) {
    const batch = this.getBatch(user.tenantId, batchId);
    if (!batch.assets.length) throw new BadRequestException('批次内无图片');
    const suggestion = await buildPublishSuggestion(batch.assets, {
      runOcr: body?.runOcr !== false,
      lookupByStyleNo: async (styleNo: string) => {
        const hit = await this.products.findByStyleNoWithColors(user.tenantId, styleNo);
        if (!hit?.colors?.length) return null;
        return {
          styleNo: hit.styleNo,
          colors: hit.colors,
          source: 'product' as const,
          name: hit.name,
          material: hit.material || undefined,
        };
      },
    });
    batch.suggestion = suggestion;
    return {
      batchId,
      suggestion,
      assets: batch.assets.map((a) => ({
        mediaId: a.mediaId,
        url: a.url,
        filename: a.filename,
      })),
    };
  }

  /**
   * 确认发品：创建 Product + 颜色 SKU（size=null）+ 挂图
   */
  async confirm(user: AuthContext, input: ConfirmPublishInput) {
    const batch = this.getBatch(user.tenantId, input.batchId);
    if (!input.styleNo?.trim()) throw new BadRequestException('款号必填');
    if (!input.name?.trim()) throw new BadRequestException('名称必填');
    if (!input.levelId) throw new BadRequestException('商品等级必填');
    if (!input.skus?.length) throw new BadRequestException('至少保留一个颜色 SKU');

    const colors = input.skus.map((s) => (s.color || '').trim()).filter(Boolean);
    if (!colors.length) throw new BadRequestException('颜色名不能为空');
    if (new Set(colors).size !== colors.length) {
      throw new BadRequestException('颜色名不能重复');
    }

    const mediaIds = input.images?.map((i) => i.mediaId) || batch.assets.map((a) => a.mediaId);
    const validSet = new Set(batch.assets.map((a) => a.mediaId));
    for (const id of mediaIds) {
      if (!validSet.has(id)) throw new BadRequestException(`图片不在本批次: ${id}`);
    }

    // 将 uploads 下文件挪到 products/{styleNo}/
    const styleNo = input.styleNo.trim();
    const destDir = path.join(this.storageRoot(), 'tenants', user.tenantId, 'products', styleNo);
    fs.mkdirSync(destDir, { recursive: true });

    const coverMediaIds: string[] = [];
    // 列表首图优先衣服主图；吊牌/细节靠后（具体封面由 vision 写入 coverMediaIds）
    const roleOrder = ['main', 'multi_color', 'detail', 'hangtag', 'unknown'];
    const ordered = [...(input.images || [])].sort(
      (a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role),
    );
    const seq =
      ordered.length > 0
        ? ordered
        : batch.assets.map((a) => ({ mediaId: a.mediaId, role: 'main' as const }));

    let idx = 0;
    for (const im of seq) {
      const asset = batch.assets.find((a) => a.mediaId === im.mediaId);
      if (!asset) continue;
      idx += 1;
      const ext = path.extname(asset.localPath) || '.jpg';
      const destName = `${String(idx).padStart(2, '0')}${ext}`;
      const destPath = path.join(destDir, destName);
      if (fs.existsSync(asset.localPath)) {
        fs.copyFileSync(asset.localPath, destPath);
      }
      const newKey = `tenants/${user.tenantId}/products/${styleNo}/${destName}`;
      await this.updateMediaAsset(user.tenantId, asset.mediaId, {
        objectKey: newKey,
        productId: null, // 创建后再绑
        sizeBytes: fs.existsSync(destPath) ? fs.statSync(destPath).size : asset.sizeBytes,
      });
      asset.objectKey = newKey;
      asset.localPath = destPath;
      asset.url = this.publicUrl(newKey);
      coverMediaIds.push(asset.mediaId);
    }

    const finalCovers =
      input.coverMediaIds?.filter((id) => coverMediaIds.includes(id)) || coverMediaIds;

    const sizeText =
      batch.suggestion?.sizeText ||
      (input.description || '').match(/尺码[：:]\s*(.+)/)?.[1] ||
      '';
    let description = (input.description || '').trim();
    if (sizeText && !description.includes('尺码')) {
      description = description ? `${description}\n尺码：${sizeText}` : `尺码：${sizeText}`;
    }

    const skus = input.skus.map((s) => ({
      color: s.color.trim(),
      size: null as null,
      price: s.price != null && String(s.price).trim() !== '' ? String(s.price).trim() : null,
      stock: 0,
      status: 'active',
      skuCode: `${styleNo}-${s.color.trim()}`,
    }));

    let product;
    try {
      product = await this.products.create(user, {
        styleNo,
        name: input.name.trim(),
        material: input.material?.trim() || null,
        description: description || null,
        levelId: input.levelId,
        priceDisplay: input.priceDisplay || 'show',
        status: input.status || 'on_sale',
        tags: input.tags || batch.suggestion?.tags || [],
        coverMediaIds: finalCovers,
        skus,
      });
    } catch (e) {
      if (e instanceof ConflictException) throw e;
      throw e;
    }

    // 绑定 media.product_id
    for (const mid of finalCovers) {
      await this.updateMediaAsset(user.tenantId, mid, { productId: product.id });
    }

    this.batches.delete(batch.batchId);
    return product;
  }

  private extFromMime(mime?: string) {
    if (!mime) return '.jpg';
    if (mime.includes('png')) return '.png';
    if (mime.includes('webp')) return '.webp';
    if (mime.includes('gif')) return '.gif';
    return '.jpg';
  }

  private async insertMediaAsset(
    tenantId: string,
    data: { objectKey: string; mimeType: string; sizeBytes: number },
  ): Promise<string> {
    if (this.dataSource && process.env.DB_ENABLED === 'true') {
      const repo = this.dataSource.getRepository(MediaAsset);
      const row = repo.create({
        tenantId,
        productId: null,
        type: 'image',
        provider: 'local',
        objectKey: data.objectKey,
        mimeType: data.mimeType,
        sizeBytes: String(data.sizeBytes),
        status: 'active',
      });
      const saved = await repo.save(row);
      return saved.id;
    }
    return newId();
  }

  private async updateMediaAsset(
    tenantId: string,
    mediaId: string,
    patch: { objectKey?: string; productId?: string | null; sizeBytes?: number },
  ) {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) return;
    const repo = this.dataSource.getRepository(MediaAsset);
    const row = await repo.findOne({ where: { id: mediaId, tenantId } });
    if (!row) return;
    if (patch.objectKey !== undefined) row.objectKey = patch.objectKey;
    if ('productId' in patch) row.productId = patch.productId ?? null;
    if (patch.sizeBytes !== undefined) row.sizeBytes = String(patch.sizeBytes);
    await repo.save(row);
  }
}
