import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { MediaAsset } from '../common/entities/media-asset.entity';
import { PromoSetEntity, PromoSetImage, ImageGenCallRecord, OutfitCompareRecord } from '../common/entities/promo-set.entity';
import { newId } from '../common/utils/id';
import { ProductsService } from '../products/products.service';
import { ImageGenClient } from './image-gen.client';
import { MODELS, SIZES, TEMPLATES, findTemplate, templateDto, resolveOption, buildStyleRefPrompt, StyleStrength, isVideoTemplate, listTemplatesByKind, VIDEO_BGM_PRESETS, findVideoBgm } from './promo.templates';
import { enrichPoseSceneText } from './pose-scene-enrich';
import { analyzeStyleRefs, styleKeywordsToPromptZh, StyleKeywordsZh } from './style-ref-analyze';
import { prepareRefsForCategory, buildPromptZh } from './garment-ref-prepare';
import type { ProductRefAnalysis, GarmentRefKind } from './garment-ref-prepare';
import { VisionClient } from '../vision/vision.client';
import { JobsService } from '../jobs/jobs.service';
import { registerPromoImageHandler } from '../jobs/handlers/promo-image.handler';
import { registerPromoVideoHandler } from '../jobs/handlers/promo-video.handler';
import { JobProgress } from '../jobs/job.types';
import { OssClient } from '../media/oss.client';
import { MediaService } from '../media/media.service';
import { buildPromoCaption } from './promo.captions';
import { buildJobDisplayTitle } from '../jobs/job-display-title';
import { VideoGenClient } from './video-gen.client';
import { LkbVideoClient, clampDuration, LkbVideoAttachment } from './lkb-video.client';
import { draftVideoBeatScript, resolveVideoPromptZh, syncScriptFromBeats, VideoBeat } from './video-script';
import { ExternalOutfitClient } from './external-outfit.client';

export interface GenerateInput {
  templateId: string;
  /** image（默认）| video：走 promo_image / promo_video */
  mediaKind?: 'image' | 'video';
  feature?: string;
  referenceAssetIds: string[];
  modelId?: string | null;
  poses?: string[];
  scenes?: string[];
  /** 用户自由描述姿势/呈现；可与 poses 并存，优先写入 prompt */
  poseText?: string;
  /** 用户自由描述场景/背景 */
  sceneText?: string;
  colors?: string[];
  count?: number;
  sizeId?: string;
  /** 已有宣传图组：整组/单张重生成时传入 */
  setId?: string;
  /** 仅重生成这些下标；缺省则整组 */
  regenIndexes?: number[];
  /** 每次重新生成随机令牌：写入 prompt/instruction/seed，避免同参同图 */
  regenNonce?: string;
  /**
   * 风格样例 OSS objectKey（业务 key，无 OSS_PREFIX）。
   * 0～4；须 tenants/{tenantId}/promo_style_ref/ 前缀；不写 coverMediaIds。
   */
  styleRefObjectKeys?: string[];
  /** 风格强弱：weak / medium / strong；默认 medium；无风格图时忽略 */
  styleStrength?: StyleStrength;
  /**
   * 风格参考模板：用户编辑后的关键词（中文结构或扁平）。
   * 留痕进 params；软提示进 promptZh / buildPrompt。
   */
  styleKeywords?: Partial<StyleKeywordsZh> | null;
  /** 风格关键词自由文本（覆盖结构化字段拼句） */
  styleKeywordsText?: string;
  /** 视频时长秒数（约 8–12，钳制 4–15）；仅 mediaKind=video */
  seconds?: number;
  /** 可选一句话卖点（视频）；可与 feature 并存 */
  sellingPoint?: string;
  /** 业主确认/编辑后的中文分镜脚本 */
  script?: string;
  /** 可编辑分镜 beats（可选；有则优先用于拼脚本） */
  beats?: VideoBeat[];
  /** 视频配乐预设 id（none / soft_ambient / …）；引擎未支持曲目时仍透传 params */
  bgmId?: string | null;
  /** 是否请上游生成/附带音频（LKB generateAudio） */
  generateAudio?: boolean;
}

interface JobItem {
  index: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  prompt: string;
  /** 中文原话（用户输入 + 读衣中文），与 prompt 成对留痕 */
  promptZh?: string;
  poseId?: string;
  sceneId?: string;
  objectKey?: string;
  url?: string;
  via?: string;
  error?: string;
  savedMediaId?: string;
  ms?: number;
  /** 本次 IMAGE_GEN 调用记录（重生时与 prior.genCalls 合并） */
  genCall?: ImageGenCallRecord;
  /** 保留未重生槽位的历史 */
  genCalls?: ImageGenCallRecord[];
  model?: string;
  size?: string;
  /** 同图对比（self vs external） */
  compare?: OutfitCompareRecord;
}
interface PromoJob {
  id: string;
  tenantId: string;
  productId: string;
  templateId: string;
  status: 'queued' | 'running' | 'done' | 'partial' | 'failed';
  input: GenerateInput;
  size: string;
  items: JobItem[];
  createdAt: number;
  updatedAt: number;
}

/** 全局上游并发上限 */
const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.IMAGE_GEN_CONCURRENCY || '2', 10));

@Injectable()
export class PromoService implements OnModuleInit {
  private readonly logger = new Logger('Promo');
  private running = 0;
  private waiters: Array<() => void> = [];
  /** productIds already scanned for pj_ legacy migrate this process */
  private readonly legacyMigratedProducts = new Set<string>();

  constructor(
    private readonly products: ProductsService,
    private readonly gen: ImageGenClient,
    private readonly videoGen: VideoGenClient,
    private readonly lkbVideo: LkbVideoClient,
    private readonly jobs: JobsService,
    private readonly oss: OssClient,
    private readonly media: MediaService,
    private readonly externalOutfit: ExternalOutfitClient,
    @Optional() private readonly vision?: VisionClient,
    @Optional() private readonly dataSource?: DataSource,
  ) {}

  onModuleInit() {
    registerPromoImageHandler(this.jobs, this);
    registerPromoVideoHandler(this.jobs, this);
  }

  // ---------- 路径 ----------
  private storageRoot() {
    return path.join(process.cwd(), 'storage');
  }
  /** 状态 JSON 不放在 /media 静态目录下 */
  private stateDir(tenantId: string, productId: string) {
    const d = path.join(process.cwd(), 'data', 'promo', tenantId, productId);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  private publicUrl(objectKey: string) {
    const k = String(objectKey || '').trim();
    if (/^https?:\/\//i.test(k)) return k;
    return this.oss.publicUrl(objectKey);
  }

  /**
   * 槽位播放 URL：外部直链优先，否则 OSS/本地 objectKey。
   * 视频且上游非自有 OSS/本站时，经 /api/media/external-play 同域中转
   * （小程序 <video>/downloadFile 合法域名不含 LKB 桶如 xy-tradex.oss-cn-shenzhen）。
   */
  private itemPlayUrl(
    it: { objectKey?: string | null; externalUrl?: string | null; url?: string | null },
    opts?: { proxyExternal?: boolean },
  ): string | null {
    const ext = String(it?.externalUrl || it?.url || '').trim();
    if (/^https?:\/\//i.test(ext)) {
      if (opts?.proxyExternal && !this.media.isAlreadyPlayableHost(ext)) {
        return this.media.buildExternalPlayUrl(ext);
      }
      return ext;
    }
    const key = String(it?.objectKey || '').trim();
    if (!key) return null;
    return this.publicUrl(key);
  }

  /** 槽位是否已有可展示结果（本地/OSS objectKey 或外部 http(s) 直链） */
  private itemHasResult(it: { status?: string; objectKey?: string | null; url?: string | null; externalUrl?: string | null }): boolean {
    if (it?.status !== 'done') return false;
    if (String(it?.objectKey || '').trim()) return true;
    const u = String(it?.externalUrl || it?.url || '').trim();
    return /^https?:\/\//i.test(u);
  }

  /** 校验并规范化风格样例 keys；空/缺省 → [] */
  private normalizeStyleRefs(user: AuthContext, keys: unknown): string[] {
    if (keys == null || keys === undefined) return [];
    if (!Array.isArray(keys)) throw new BadRequestException('styleRefObjectKeys 须为数组');
    const arr = keys.map((k) => String(k || '').trim()).filter(Boolean);
    if (arr.length > 4) throw new BadRequestException('风格样例最多 4 张');
    const prefix = `tenants/${user.tenantId}/promo_style_ref/`;
    const okExt = /\.(jpe?g|png|webp)$/i;
    for (const k of arr) {
      if (k.includes('..') || k.includes('\\') || k.startsWith('/')) {
        throw new BadRequestException('风格样例路径不合法');
      }
      if (!k.startsWith(prefix)) {
        throw new BadRequestException('风格样例不属于当前租户或不合法');
      }
      if (!okExt.test(k)) {
        throw new BadRequestException('风格样例仅支持 jpg/png/webp');
      }
    }
    return arr;
  }

  private normalizeStyleStrength(v: unknown): StyleStrength {
    if (v == null || v === '' || v === undefined) return 'medium';
    const s = String(v);
    if (s === 'weak' || s === 'medium' || s === 'strong') return s;
    throw new BadRequestException('styleStrength 须为 weak / medium / strong');
  }

  /**
   * 确保 objectKey 在本地 storage/ 可读；缺则从 OSS 拉取。
   * 失败返回 null（调用方决定降级或报错）。
   */
  private async ensureLocal(objectKey: string): Promise<string | null> {
    const abs = path.join(this.storageRoot(), objectKey);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).size > 0) return abs;
    } catch {
      /* fall through to download */
    }
    try {
      const buf = await this.oss.getObjectBuffer(objectKey);
      if (!buf?.length) return null;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      return abs;
    } catch (e: any) {
      // 本地 mock / 无 OSS：若文件本就该在 storage，再探一次
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).size > 0) return abs;
      } catch {
        /* ignore */
      }
      this.logger.warn(`ensureLocal fail key=${objectKey}: ${e?.message || e}`);
      return null;
    }
  }

  // ---------- 预设 ----------
  listTemplates(kind: 'image' | 'video' | 'all' = 'image') {
    return listTemplatesByKind(kind).map(templateDto);
  }
  listModels() {
    return MODELS.map(({ id, name, desc, avatar, prompt }) => ({ id, name, desc, avatar, prompt }));
  }
  listVideoBgm() {
    return VIDEO_BGM_PRESETS.map(({ id, name, desc, generateAudio }) => ({ id, name, desc, generateAudio }));
  }
  presets() {
    return {
      templates: this.listTemplates('image'),
      videoTemplates: this.listTemplates('video'),
      models: this.listModels(),
      videoBgmPresets: this.listVideoBgm(),
      sizes: Object.values(SIZES),
    };
  }

  // ---------- 素材 ----------
  private async productAssets(user: AuthContext, productId: string) {
    const product: any = await this.products.getDetail(user, productId);
    let assets: Array<{ id: string; objectKey: string; meta?: Record<string, unknown> | null }> = [];
    if (this.dataSource && process.env.DB_ENABLED === 'true') {
      const rows = await this.dataSource
        .getRepository(MediaAsset)
        .find({ where: { tenantId: user.tenantId, productId, status: 'active', type: 'image' } });
      const order: string[] = product.coverMediaIds || [];
      rows.sort((a, b) => {
        const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
        return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.objectKey.localeCompare(b.objectKey);
      });
      assets = rows.map((r) => ({ id: r.id, objectKey: r.objectKey, meta: (r as any).meta || null }));
    }
    return { product, assets };
  }

  private defaultFeature(p: any) {
    const colors = [...new Set((p.skus || []).map((s: any) => s.color).filter(Boolean))];
    return [
      p.name && `品名：${p.name}`,
      p.styleNo && `款号：${p.styleNo}`,
      p.material && `材质：${p.material}`,
      colors.length && `颜色：${colors.join('、')}`,
      p.description && `描述：${String(p.description).slice(0, 300)}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  async start(user: AuthContext, productId: string, body: { templateId?: string }) {
    const { product, assets } = await this.productAssets(user, productId);
    const draft = this.readFeature(user.tenantId, productId);
    const feature = draft?.feature || this.defaultFeature(product);
    const tpl = body?.templateId ? findTemplate(body.templateId) : null;
    return {
      product: { id: product.id, styleNo: product.styleNo, name: product.name },
      colors: [...new Set((product.skus || []).map((s: any) => s.color).filter(Boolean))],
      assets: assets.map((a, i) => ({
        id: a.id,
        url: this.publicUrl(a.objectKey),
        isCover: i < (product.coverMediaIds || []).length,
        isPromo: a.objectKey.includes('/promo/'),
      })),
      feature,
      featureSource: draft ? 'saved' : 'auto',
      template: tpl ? templateDto(tpl) : null,
      configured: this.gen.configured(),
      videoConfigured: this.videoEngineConfigured(),
      videoEngine: this.resolveVideoEngine(),
    };
  }

  private readFeature(tenantId: string, productId: string): { feature: string } | null {
    const f = path.join(this.stateDir(tenantId, productId), 'feature.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }
  async getFeature(user: AuthContext, productId: string) {
    const { product } = await this.productAssets(user, productId);
    const d = this.readFeature(user.tenantId, productId);
    return { feature: d?.feature || this.defaultFeature(product), source: d ? 'saved' : 'auto' };
  }
  async putFeature(user: AuthContext, productId: string, body: { feature: string }) {
    await this.products.getDetail(user, productId);
    const feature = String(body?.feature || '').slice(0, 2000);
    fs.writeFileSync(
      path.join(this.stateDir(user.tenantId, productId), 'feature.json'),
      JSON.stringify({ feature, updatedAt: Date.now() }),
    );
    return { feature, source: 'saved' };
  }

  // ---------- 生成 ----------
  private setsRepo() {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      throw new BadRequestException('宣传图组需要 DB_ENABLED=true');
    }
    return this.dataSource.getRepository(PromoSetEntity);
  }

  private captionFor(product: any, input: GenerateInput, tplId: string) {
    const tpl = findTemplate(tplId);
    const model = MODELS.find((m) => m.id === input.modelId);
    const poses = (tpl?.poses || []).filter((o) => (input.poses || []).includes(o.id)).map((o) => o.name);
    const scenes = (tpl?.scenes || []).filter((o) => (input.scenes || []).includes(o.id)).map((o) => o.name);
    return buildPromoCaption({
      templateId: tplId,
      product,
      colors: input.colors,
      feature: input.feature,
      modelName: model?.name,
      poseNames: poses,
      sceneNames: scenes,
    });
  }

  /**
   * 风格样例识图 → 可编辑中文关键词。失败返回空结构（仍可生图）。
   * body.styleRefObjectKeys 须已上传。
   */
  async analyzeStyleRefsApi(
    user: AuthContext,
    productId: string,
    body: { styleRefObjectKeys?: string[] },
  ) {
    await this.products.getDetail(user, productId);
    const keys = this.normalizeStyleRefs(user, body?.styleRefObjectKeys);
    if (!keys.length) {
      throw new BadRequestException('请先上传至少 1 张风格样例');
    }
    const locals: string[] = [];
    for (const k of keys) {
      const local = await this.ensureLocal(k);
      if (local) locals.push(local);
    }
    const result = await analyzeStyleRefs(this.vision, locals);
    return {
      ...result,
      styleRefObjectKeys: keys,
      analyzed: result.via === 'llm',
    };
  }

  async generate(user: AuthContext, productId: string, input: GenerateInput) {
    const tpl = findTemplate(input?.templateId);
    if (!tpl) throw new BadRequestException('未知模板');
    const wantVideo =
      input?.mediaKind === 'video' || isVideoTemplate(tpl) || String(input?.mediaKind || '') === 'promo_video';
    if (wantVideo) {
      return this.generateVideo(user, productId, { ...input, mediaKind: 'video', templateId: tpl.id });
    }
    // OUTFIT_ENGINE=external 时不调用自建 IMAGE_GEN，无需 IMAGE_GEN 密钥
    const outfitEngineEarly = this.externalOutfit.engineMode();
    if (outfitEngineEarly !== 'external' && !this.gen.configured()) {
      throw new BadRequestException('服务端未配置生图密钥');
    }
    if (outfitEngineEarly !== 'self' && !this.externalOutfit.configured()) {
      throw new BadRequestException('外部穿搭 Agent 未配置（OUTFIT_AGENT_ENABLED / API Key）');
    }
    const product: any = await this.products.getDetail(user, productId);
    const colorsIn = Array.isArray(input.colors) ? input.colors.map((c) => String(c || '').trim()).filter(Boolean) : [];
    let count: number;
    if (tpl.id === 'multi_color') {
      const n = colorsIn.length;
      if (n < tpl.count.min) throw new BadRequestException(`多色展示至少选择 ${tpl.count.min} 个颜色`);
      if (n > tpl.count.max) throw new BadRequestException(`多色展示最多 ${tpl.count.max} 个颜色`);
      const refs = (input.referenceAssetIds || []).filter(Boolean);
      if (refs.length !== n) {
        throw new BadRequestException(`多色展示需每个颜色 1 张参考图（已选 ${n} 色 / ${refs.length} 张图）`);
      }
      if (tpl.model === 'required' && !input.modelId) {
        throw new BadRequestException('多色展示需要选择模特');
      }
      count = n;
    } else {
      count = Math.min(tpl.count.max, Math.max(tpl.count.min, Number(input.count) || tpl.count.default));
    }
    // 风格样例仅 style_ref（styleRef.max>0）；其它模板忽略入参，防误传
    const styleAllowed = !!(tpl.styleRef && Number(tpl.styleRef.max) > 0);
    const styleRefObjectKeys = styleAllowed
      ? this.normalizeStyleRefs(user, input.styleRefObjectKeys)
      : [];
    const styleStrength = styleAllowed
      ? this.normalizeStyleStrength(input.styleStrength)
      : this.normalizeStyleStrength(undefined);
    const styleRefMin = styleAllowed ? (tpl.styleRef?.min ?? 0) : 0;
    if (styleRefMin > 0 && styleRefObjectKeys.length < styleRefMin) {
      throw new BadRequestException(`「${tpl.name}」至少上传 ${styleRefMin} 张风格样例`);
    }
    const styleKeywordsText = styleKeywordsToPromptZh(
      input.styleKeywords,
      input.styleKeywordsText,
    );
    const caption = this.captionFor(product, { ...input, colors: colorsIn.length ? colorsIn : input.colors, count }, tpl.id);
    const params = {
      templateId: tpl.id,
      feature: input.feature || '',
      referenceAssetIds: input.referenceAssetIds || [],
      modelId: input.modelId || null,
      // multi_color：整组共用同一姿态/场景（只取首个）
      poses: tpl.id === 'multi_color' ? (input.poses || []).slice(0, 1) : (input.poses || []),
      scenes: tpl.id === 'multi_color' ? (input.scenes || []).slice(0, 1) : (input.scenes || []),
      poseText: String(input.poseText || '').trim() || undefined,
      sceneText: String(input.sceneText || '').trim() || undefined,
      colors: tpl.id === 'multi_color' ? colorsIn : (input.colors || []),
      count,
      sizeId: input.sizeId || tpl.defaultSize,
      // 风格样例仅 style_ref 模板写入；其它模板为空
      styleRefObjectKeys,
      styleStrength: styleRefObjectKeys.length ? styleStrength : undefined,
      styleKeywords: input.styleKeywords || undefined,
      styleKeywordsText: styleKeywordsText || undefined,
      regenNonce: input.regenNonce ? String(input.regenNonce) : undefined,
    };

    const isPartialRegen = Array.isArray(input.regenIndexes) && input.regenIndexes.length > 0;
    const isExplicitSetRegen = !!String(input.setId || '').trim();
    const repo = this.setsRepo();

    // 仅「全新生成」防重复提交；已有 set 的重生必须重新排队（不可静默返回进行中 job）
    if (!isPartialRegen && !isExplicitSetRegen) {
      const reused = await this.findActivePromo(user, productId, tpl.id, input.setId);
      if (reused) {
        this.logger.log(
          `generate reuse productId=${productId} templateId=${tpl.id} setId=${reused.setId} jobId=${reused.jobId}`,
        );
        return reused;
      }
    }

    let setId = input.setId;
    let existingJobId: string | null = null;
    if (setId) {
      const existing = await repo.findOne({ where: { id: setId, tenantId: user.tenantId, productId } });
      if (!existing) throw new NotFoundException('宣传图组不存在');
      existing.status = 'generating';
      existing.params = params;
      existing.caption = caption;
      existing.templateId = tpl.id;
      // 局部重生：目标槽位标 pending，列表立刻显示「生成中」占位；整组则全部 pending
      const regenIdx = isPartialRegen
        ? new Set((input.regenIndexes || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0))
        : null;
      const prevImages = Array.isArray(existing.images) ? existing.images : [];
      if (prevImages.length) {
        existing.images = prevImages.map((img) => {
          const shouldPending = !regenIdx || regenIdx.has(Number(img.index));
          if (!shouldPending) return img;
          return {
            ...img,
            status: 'pending' as const,
            error: undefined,
            ms: undefined,
          };
        });
      } else if (!isPartialRegen) {
        existing.images = Array.from({ length: count }, (_, i) => ({ index: i, status: 'pending' as const }));
      }
      existingJobId = existing.jobId || null;
      await repo.save(existing);
    } else {
      // 同模板失败空壳：复用该 set，避免「本商品任务」再堆一行
      const reusable = await this.findReusableFailedSet(user, productId, tpl.id);
      if (reusable) {
        setId = reusable.id;
        reusable.status = 'generating';
        reusable.params = params;
        reusable.caption = caption;
        reusable.templateId = tpl.id;
        reusable.images = Array.from({ length: count }, (_, i) => ({ index: i, status: 'pending' as const }));
        existingJobId = reusable.jobId || null;
        await repo.save(reusable);
        await this.softDeleteFailedEmptySets(user, productId, tpl.id, setId);
      } else {
        setId = newId('ps');
        await repo.save(
          repo.create({
            id: setId,
            tenantId: user.tenantId,
            productId,
            templateId: tpl.id,
            params,
            caption,
            jobId: null,
            legacyJobId: null,
            status: 'generating',
            images: Array.from({ length: count }, (_, i) => ({ index: i, status: 'pending' as const })),
          }),
        );
        await this.softDeleteFailedEmptySets(user, productId, tpl.id, setId);
      }
    }

    const jobPayload = {
      productId,
      setId,
      ...params,
      styleNo: product.styleNo,
      regenIndexes: input.regenIndexes,
    };
    // multi_color 不写入易错的场景模特 displayTitle，由 buildJobDisplayTitle 现算
    const displayTitle = buildJobDisplayTitle('promo_image', { ...jobPayload, displayTitle: undefined });
    // 重生：复用该组已有 job，不在任务中心新开一行
    const job = await this.jobs.reuseOrCreate(
      user,
      'promo_image',
      { ...jobPayload, displayTitle },
      { existingJobId },
    );
    try {
      await this.jobs.cancelSiblingPromoJobs(user, {
        setId,
        exceptJobId: job.id,
        types: ['promo_image'],
      });
    } catch (e: any) {
      this.logger.warn(`cancelSiblingPromoJobs: ${e?.message || e}`);
    }
    await repo.update({ id: setId, tenantId: user.tenantId }, { jobId: job.id });

    return {
      id: job.id,
      jobId: job.id,
      setId,
      status: job.status,
      templateId: tpl.id,
      caption,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      progress: job.progress,
      done: 0,
      total: count,
      items: [],
      reused: false,
    };
  }



  /** VIDEO_ENGINE=lkb|xytoken；未设时：LKB 已配置则 lkb，否则 xytoken */
  resolveVideoEngine(): 'lkb' | 'xytoken' {
    const m = String(process.env.VIDEO_ENGINE || '').trim().toLowerCase();
    if (m === 'lkb' || m === 'xytoken') return m;
    return this.lkbVideo.configured() ? 'lkb' : 'xytoken';
  }

  videoEngineConfigured(): boolean {
    const e = this.resolveVideoEngine();
    if (e === 'lkb') return this.lkbVideo.configured();
    return this.videoGen.configured();
  }

  /**
   * 视频分镜脚本草案：业主可编辑后再 POST generate（script 字段）。
   * 不创建 job / promo_set。
   */
  async draftVideoScript(
    user: AuthContext,
    productId: string,
    body: {
      feature?: string;
      sellingPoint?: string;
      referenceAssetIds?: string[];
      seconds?: number;
      /** heuristic（默认）| polish（润色，调 LLM） */
      mode?: 'heuristic' | 'polish';
      polish?: boolean;
      templateId?: string;
      modelId?: string | null;
      beats?: VideoBeat[];
    },
  ) {
    const { product } = await this.productAssets(user, productId);
    const feature =
      String(body?.feature || '').trim() ||
      this.readFeature(user.tenantId, productId)?.feature ||
      this.defaultFeature(product);
    const sellingPoint = String(body?.sellingPoint || '').trim().slice(0, 200);
    const seconds = clampDuration(
      Number(body?.seconds ?? process.env.VIDEO_GEN_SECONDS ?? this.lkbVideo.defaultSeconds) || 10,
    );
    const mode =
      body?.mode === 'polish' || body?.polish === true ? 'polish' : 'heuristic';
    const templateId = String(body?.templateId || '').trim() || undefined;
    const modelId = body?.modelId ? String(body.modelId) : null;
    // 若前端已改 beats 再请求同步，可回写 script（仍走 heuristic/polish 生成时忽略入参 beats）
    const draft = await draftVideoBeatScript(this.vision, {
      feature,
      sellingPoint,
      seconds,
      mode,
      templateId,
      modelId,
    });
    return {
      ...draft,
      feature,
      sellingPoint: sellingPoint || null,
      templateId: templateId || null,
      modelId,
      engine: this.resolveVideoEngine(),
      configured: this.videoEngineConfigured(),
      productId,
      styleNo: product.styleNo,
    };
  }

  /**
   * 宣传视频：创建 promo_sets(kind=video) + jobs(type=promo_video)。
   * 一期固定 1 条竖屏约 8–12s；模板默认 product_showcase_video。
   */
  async generateVideo(user: AuthContext, productId: string, input: GenerateInput) {
    let tpl = findTemplate(input?.templateId);
    if (!tpl || !isVideoTemplate(tpl)) {
      tpl = findTemplate('product_showcase_video') || undefined;
    }
    if (!tpl) throw new BadRequestException('未知视频模板');
    if (!this.videoEngineConfigured()) throw new BadRequestException('服务端未配置视频生成密钥');
    const product: any = await this.products.getDetail(user, productId);
    const refs = (input.referenceAssetIds || []).filter(Boolean);
    if (refs.length < tpl.reference.min || refs.length > tpl.reference.max) {
      throw new BadRequestException(`视频需选择 ${tpl.reference.min}-${tpl.reference.max} 张参考图`);
    }
    const count = 1;
    const sizeId = tpl.sizes.includes(String(input.sizeId || '')) ? String(input.sizeId) : tpl.defaultSize;
    const feature = String(input.feature || '').slice(0, 2000);
    const sellingPoint = String(input.sellingPoint || '').slice(0, 200);
    const script = String(input.script || '').trim().slice(0, 1200);
    const seconds = clampDuration(
      Number(input.seconds ?? process.env.VIDEO_GEN_SECONDS ?? this.lkbVideo.defaultSeconds) || 10,
    );
    const bgm = findVideoBgm(input.bgmId);
    // 生视频一律请上游出音；UI「无配乐」仍记 bgmId=none，但不压制 generateAudio
    const generateAudio = true;
    const modelId =
      tpl.model === 'none' ? null : input.modelId ? String(input.modelId) : null;
    if (tpl.model === 'required' && !modelId) {
      throw new BadRequestException('该视频模板需要选择模特');
    }
    if (tpl.id === 'multi_color_outfit_video') {
      const colors = (input.colors || []).filter(Boolean);
      if (colors.length < 2) throw new BadRequestException('多色换装至少选 2 个颜色');
      if (colors.length !== refs.length) {
        throw new BadRequestException('颜色数量需与参考图数量一致（按顺序对应）');
      }
    }
    let beats = Array.isArray(input.beats) ? input.beats : undefined;
    let scriptFinal = script;
    if (!scriptFinal && beats && beats.length) {
      scriptFinal = syncScriptFromBeats({
        beats,
        seconds,
        sellingPoint,
        feature,
        withPerson: tpl.model !== 'none',
        templateId: tpl.id,
      }).script;
    }
    const caption = this.captionFor(product, { ...input, feature, count, sizeId }, tpl.id);
    const params = {
      kind: 'video' as const,
      mediaKind: 'video' as const,
      templateId: tpl.id,
      feature,
      sellingPoint: sellingPoint || undefined,
      script: scriptFinal || undefined,
      beats: beats || undefined,
      referenceAssetIds: refs,
      modelId,
      poses: [],
      scenes: [],
      colors: (input.colors || []).filter(Boolean),
      count,
      sizeId,
      seconds,
      bgmId: bgm.id,
      generateAudio: true,
      videoEngine: this.resolveVideoEngine(),
    };

    const repo = this.setsRepo();
    const reused = await this.findActivePromo(user, productId, tpl.id, input.setId, 'promo_video');
    if (reused) {
      this.logger.log(
        `generateVideo reuse productId=${productId} templateId=${tpl.id} setId=${reused.setId} jobId=${reused.jobId}`,
      );
      return reused;
    }

    let setId = input.setId;
    if (setId) {
      const existing = await repo.findOne({ where: { id: setId, tenantId: user.tenantId, productId } });
      if (!existing) throw new NotFoundException('宣传素材组不存在');
      existing.status = 'generating';
      existing.params = params;
      existing.caption = caption;
      existing.templateId = tpl.id;
      await repo.save(existing);
    } else {
      setId = newId('ps');
      await repo.save(
        repo.create({
          id: setId,
          tenantId: user.tenantId,
          productId,
          templateId: tpl.id,
          params,
          caption,
          jobId: null,
          legacyJobId: null,
          status: 'generating',
          images: [{ index: 0, status: 'pending' as const }],
        }),
      );
    }

    const jobPayload = {
      productId,
      setId,
      ...params,
      styleNo: product.styleNo,
    };
    const displayTitle = buildJobDisplayTitle('promo_video', { ...jobPayload, displayTitle: undefined });
    const job = await this.jobs.create(user, 'promo_video', {
      ...jobPayload,
      displayTitle,
    });
    await repo.update({ id: setId, tenantId: user.tenantId }, { jobId: job.id });

    return {
      id: job.id,
      jobId: job.id,
      setId,
      status: job.status,
      templateId: tpl.id,
      kind: 'video',
      mediaKind: 'video',
      caption,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      progress: job.progress,
      done: 0,
      total: count,
      items: [],
      reused: false,
    };
  }

  /**
   * promo_video worker：生成单条视频 → OSS → promo_sets / media_assets(type=video)。
   */
  async executeGenerateVideoJob(
    user: AuthContext,
    productId: string,
    input: GenerateInput & Record<string, unknown>,
    opts?: { onProgress?: (p: Partial<JobProgress>) => Promise<void> },
  ) {
    let tpl = findTemplate(String(input?.templateId || ''));
    if (!tpl || !isVideoTemplate(tpl)) tpl = findTemplate('product_showcase_video') || undefined;
    if (!tpl) throw new Error('未知视频模板');
    if (!this.videoEngineConfigured()) throw new Error('服务端未配置视频生成密钥');
    const engine = this.resolveVideoEngine();

    const { product, assets } = await this.productAssets(user, productId);
    const refIds = ((input.referenceAssetIds as string[]) || []).filter(Boolean);
    if (refIds.length < tpl.reference.min || refIds.length > tpl.reference.max) {
      throw new Error(`视频需选择 ${tpl.reference.min}-${tpl.reference.max} 张参考图`);
    }
    const byId = new Map(assets.map((a) => [a.id, a]));
    const refs = refIds.map((id) => byId.get(id));
    if (refs.some((r) => !r)) throw new Error('参考图不属于该商品');

    const feature = String(
      input.feature ?? this.readFeature(user.tenantId, productId)?.feature ?? this.defaultFeature(product),
    ).slice(0, 2000);
    const sellingPoint = String(input.sellingPoint || '').slice(0, 200);
    const script = String(input.script || '').trim().slice(0, 1200);
    const sizeId = tpl.sizes.includes(String(input.sizeId || '')) ? String(input.sizeId) : tpl.defaultSize;
    const upstreamSize =
      SIZES[sizeId]?.upstream || (engine === 'lkb' ? this.lkbVideo.defaultSize : this.videoGen.defaultSize);
    let seconds = clampDuration(
      Number(input.seconds ?? process.env.VIDEO_GEN_SECONDS ?? this.lkbVideo.defaultSeconds) || 10,
    );
    const model = tpl.model === 'none' ? null : MODELS.find((m) => m.id === input.modelId) || null;
    const colors = ((input.colors as string[]) || []).filter(Boolean);
    const beats = Array.isArray(input.beats) ? (input.beats as VideoBeat[]) : undefined;
    const bgm = findVideoBgm(input.bgmId as string | undefined);
    // 生视频一律请上游出音；UI「无配乐」仍记 bgmId=none，但不压制 generateAudio
    const generateAudio = true;
    let scriptResolved = script;
    if (!scriptResolved && beats && beats.length) {
      scriptResolved = syncScriptFromBeats({
        beats,
        seconds,
        sellingPoint,
        feature,
        withPerson: tpl.model !== 'none',
        templateId: tpl.id,
      }).script;
    }
    const promptZh = resolveVideoPromptZh({
      script: scriptResolved,
      feature,
      sellingPoint,
      seconds,
      templateId: tpl.id,
      modelId: model?.id,
      beats,
    });
    const promptEn = tpl.buildPrompt({
      feature: [sellingPoint, feature].filter(Boolean).join('\n'),
      model,
      pose: null,
      scene: null,
      colors,
      index: 0,
      total: 1,
    });
    // 上游：LKB 用中文分镜；xytoken 用英文模板 prompt
    const prompt = engine === 'lkb' ? promptZh : promptEn;

    await opts?.onProgress?.({ percent: 10, step: 'refs', message: '准备参考图', done: 0, total: 1 });

    const refPaths: string[] = [];
    const refUrls: string[] = [];
    for (const r of refs) {
      const local = await this.ensureLocal(r!.objectKey);
      if (!local) throw new Error(`参考图本地不可用：${r!.objectKey}`);
      refPaths.push(local);
      const url = this.publicUrl(r!.objectKey);
      if (/^https?:\/\//i.test(url)) refUrls.push(url);
    }

    const legacyId = newId('pj');
    const keyDir = `tenants/${user.tenantId}/products/${product.styleNo}/promo/${legacyId}`;
    fs.mkdirSync(path.join(this.storageRoot(), keyDir), { recursive: true });

    const setId = String(input.setId || '');
    const item: JobItem = { index: 0, status: 'running', prompt, promptZh };
    const legacy: PromoJob = {
      id: legacyId,
      tenantId: user.tenantId,
      productId,
      templateId: tpl.id,
      status: 'running',
      input: {
        ...(input as GenerateInput),
        mediaKind: 'video',
        feature,
        sellingPoint: sellingPoint || undefined,
        script: scriptResolved || promptZh,
        count: 1,
        sizeId,
        seconds,
        _frameworkJobId: String(input._frameworkJobId || ''),
      } as any,
      size: upstreamSize,
      items: [item],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.saveJob(legacy);

    await opts?.onProgress?.({
      percent: 20,
      step: 'generating',
      message: engine === 'lkb' ? 'LKB 视频生成中' : '视频生成中',
      done: 0,
      total: 1,
    });
    const t0 = Date.now();
    try {
      let r: { buffer?: Buffer; mime: string; via: string; videoId: string; videoUrl?: string; seconds?: number; size?: string };
      if (engine === 'lkb') {
        const attachments: LkbVideoAttachment[] = [];
        if (refUrls.length) {
          // 有商品/宣传图作首帧 → FIRST_LAST_FRAME；其余作 reference_image
          attachments.push({
            type: 'image',
            uri: refUrls[0],
            mediaType: 'image/jpeg',
            name: 'first_frame',
            metadata: { role: 'first_frame' },
          });
          for (let i = 1; i < Math.min(refUrls.length, 9); i++) {
            attachments.push({
              type: 'image',
              uri: refUrls[i],
              mediaType: 'image/jpeg',
              name: `ref_${i}`,
              metadata: { role: 'reference_image' },
            });
          }
        }
        const taskType = attachments.some((a) => a.metadata.role === 'first_frame')
          ? 'FIRST_LAST_FRAME'
          : 'FREE';
        // FREE 时仍可带 reference_image
        if (taskType === 'FREE' && refUrls.length && !attachments.length) {
          for (let i = 0; i < Math.min(refUrls.length, 9); i++) {
            attachments.push({
              type: 'image',
              uri: refUrls[i],
              mediaType: 'image/jpeg',
              name: `ref_${i}`,
              metadata: { role: 'reference_image' },
            });
          }
        }
        r = await this.lkbVideo.generate({
          prompt: promptZh,
          duration: seconds,
          taskType,
          attachments,
          generateAudio: true,
          watermark: false,
        });
      } else {
        r = await this.videoGen.generate({
          prompt: promptEn,
          size: upstreamSize,
          seconds,
          refs: refPaths,
        });
      }
      if (typeof (r as any).seconds === 'number' && (r as any).seconds > 0) {
        seconds = clampDuration((r as any).seconds);
      }
      const directUrl = String((r as any).videoUrl || '').trim();
      if (engine === 'lkb' && /^https?:\/\//i.test(directUrl)) {
        // LKB：直接持久化 SUCCEEDED 直链，不下载、不转存自有 OSS
        Object.assign(item, {
          status: 'done',
          objectKey: undefined,
          url: directUrl,
          via: r.via,
          ms: Date.now() - t0,
        });
        this.saveJob(legacy);
        await opts?.onProgress?.({ percent: 90, step: 'link', message: '已拿到成片链接', done: 1, total: 1 });
      } else {
        if (!r.buffer?.length) throw new Error('视频引擎未返回文件内容');
        const ext = r.mime.includes('webm') ? '.webm' : r.mime.includes('quicktime') ? '.mov' : '.mp4';
        const objectKey = `${keyDir}/01${ext}`;
        const absVideo = path.join(this.storageRoot(), objectKey);
        fs.writeFileSync(absVideo, r.buffer);
        let uploadBuf = r.buffer;
        if (ext === '.mp4') {
          const remuxed = await this.ensureMp4Faststart(absVideo);
          if (remuxed?.length) uploadBuf = remuxed;
        }
        await this.oss.putObjectSafe(uploadBuf, objectKey, r.mime || 'video/mp4');
        Object.assign(item, {
          status: 'done',
          objectKey,
          via: r.via,
          ms: Date.now() - t0,
        });
        this.saveJob(legacy);
        await opts?.onProgress?.({ percent: 85, step: 'upload', message: '上传完成', done: 1, total: 1 });
      }
    } catch (e: any) {
      item.status = 'failed';
      item.error = String(e.message || e).slice(0, 500);
      item.ms = Date.now() - t0;
      legacy.status = 'failed';
      this.saveJob(legacy);
      // 标记 set failed
      if (setId && this.dataSource && process.env.DB_ENABLED === 'true') {
        try {
          await this.setsRepo().update(
            { id: setId, tenantId: user.tenantId },
            { status: 'failed', images: [{ index: 0, status: 'failed', error: item.error }] as any },
          );
        } catch {
          /* ignore */
        }
      }
      throw e;
    }

    legacy.status = 'done';
    this.saveJob(legacy);

    const setResult = await this.persistVideoSetAfterGenerate(user, productId, product, {
      setId,
      frameworkJobId: String(input._frameworkJobId || ''),
      legacyJobId: legacy.id,
      templateId: tpl.id,
      input: {
        ...(input as GenerateInput),
        mediaKind: 'video',
        feature,
        count: 1,
        sizeId,
      },
      item,
      seconds,
      size: upstreamSize,
    });

    await opts?.onProgress?.({ percent: 100, step: 'done', message: '视频已完成', done: 1, total: 1 });

    return {
      promoJobId: legacy.id,
      setId: setResult.setId,
      templateId: tpl.id,
      kind: 'video',
      status: 'done',
      caption: setResult.caption,
      done: 1,
      total: 1,
      items: [
        {
          index: 0,
          status: 'done',
          url: this.itemPlayUrl(item, { proxyExternal: true }),
          mediaId: item.savedMediaId || null,
          mimeType: 'video/mp4',
          ms: item.ms,
          seconds,
        },
      ],
    };
  }

  /** 视频生成成功：promo_sets(kind=video) + media_assets(type=video)；不写入封面图列表 */
  private async persistVideoSetAfterGenerate(
    user: AuthContext,
    productId: string,
    product: any,
    opts: {
      setId: string;
      frameworkJobId: string;
      legacyJobId: string;
      templateId: string;
      input: GenerateInput;
      item: JobItem;
      seconds: number;
      size: string;
    },
  ) {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      return { setId: opts.setId || opts.legacyJobId, caption: '' };
    }
    const repo = this.setsRepo();
    const mediaRepo = this.dataSource.getRepository(MediaAsset);
    let setId = opts.setId;
    let row = setId
      ? await repo.findOne({ where: { id: setId, tenantId: user.tenantId, productId } })
      : null;
    if (!row) {
      setId = setId || newId('ps');
      row = repo.create({
        id: setId,
        tenantId: user.tenantId,
        productId,
        templateId: opts.templateId,
        params: null,
        caption: null,
        jobId: null,
        legacyJobId: opts.legacyJobId,
        status: 'generating',
        images: [],
      });
    }

    // 重生：软删本组旧视频 media
    if (row.images?.length) {
      const oldIds = row.images.map((i) => i.mediaId).filter(Boolean) as string[];
      for (const mid of oldIds) {
        await mediaRepo.update({ id: mid, tenantId: user.tenantId }, { status: 'deleted' });
      }
    }

    const caption = this.captionFor(product, opts.input, opts.templateId);
    let mediaId: string | undefined;
    const externalUrl = String(opts.item.url || '').trim();
    const hasExternal = /^https?:\/\//i.test(externalUrl);
    if (opts.item.status === 'done' && (opts.item.objectKey || hasExternal)) {
      const abs = opts.item.objectKey
        ? path.join(this.storageRoot(), opts.item.objectKey)
        : '';
      const sizeBytes = abs && fs.existsSync(abs) ? fs.statSync(abs).size : 0;
      const mime = opts.item.objectKey?.endsWith('.webm')
        ? 'video/webm'
        : opts.item.objectKey?.endsWith('.mov')
          ? 'video/quicktime'
          : 'video/mp4';
      const saved = await mediaRepo.save(
        mediaRepo.create({
          tenantId: user.tenantId,
          productId,
          promoSetId: setId,
          type: 'video',
          provider: hasExternal ? 'external' : this.oss.mediaProvider(),
          // 直链存完整 URL；本地/OSS 仍存 objectKey
          objectKey: hasExternal ? externalUrl : opts.item.objectKey!,
          mimeType: mime,
          sizeBytes: String(sizeBytes),
          status: 'active',
        }),
      );
      mediaId = saved.id;
      opts.item.savedMediaId = mediaId;
    }

    const images: PromoSetImage[] = [
      {
        index: 0,
        status: opts.item.status === 'done' ? 'done' : 'failed',
        objectKey: hasExternal ? undefined : opts.item.objectKey,
        externalUrl: hasExternal ? externalUrl : undefined,
        mediaId,
        error: opts.item.error,
        ms: opts.item.ms,
        prompt: opts.item.prompt || undefined,
        size: opts.size,
      },
    ];

    row.templateId = opts.templateId;
    row.params = {
      kind: 'video',
      mediaKind: 'video',
      templateId: opts.templateId,
      feature: opts.input.feature || '',
      referenceAssetIds: opts.input.referenceAssetIds || [],
      count: 1,
      sizeId: opts.input.sizeId,
      seconds: opts.seconds,
      durationSec: opts.seconds,
      videoUrl: hasExternal ? externalUrl : undefined,
      size: opts.size,
      styleNo: product.styleNo,
    };
    row.caption = caption;
    row.jobId = opts.frameworkJobId || row.jobId;
    row.legacyJobId = opts.legacyJobId;
    row.status = opts.item.status === 'done' ? 'done' : 'failed';
    row.images = images;
    await repo.save(row);

    try {
      const legacy = this.loadJob(user, productId, opts.legacyJobId);
      legacy.items = [opts.item];
      this.saveJob(legacy);
    } catch {
      /* ignore */
    }
    return { setId, caption };
  }

  /** 查找同商品+模板（或指定 set）进行中的生图，用于防双开 */
  private async findActivePromo(
    user: AuthContext,
    productId: string,
    templateId: string,
    setId?: string,
    jobType: 'promo_image' | 'promo_video' = 'promo_image',
  ) {
    const repo = this.setsRepo();
    if (setId) {
      const row = await repo.findOne({ where: { id: setId, tenantId: user.tenantId, productId } });
      if (row && row.status === 'generating' && row.jobId) {
        try {
          const j = await this.jobs.get(user, row.jobId);
          if (j.status === 'queued' || j.status === 'running') {
            return {
              id: j.id,
              jobId: j.id,
              setId: row.id,
              status: j.status,
              templateId,
              caption: row.caption || '',
              createdAt: j.createdAt,
              updatedAt: j.updatedAt,
              progress: j.progress,
              done: (j.progress as any)?.done || 0,
              total: (j.progress as any)?.total || 0,
              items: [],
              reused: true,
            };
          }
        } catch {
          /* fall through */
        }
      }
    } else {
      const busySets = await repo.find({
        where: { tenantId: user.tenantId, productId, templateId, status: 'generating' },
        order: { createdAt: 'DESC' },
        take: 5,
      });
      for (const row of busySets) {
        if (!row.jobId) continue;
        try {
          const j = await this.jobs.get(user, row.jobId);
          if (j.status === 'queued' || j.status === 'running') {
            return {
              id: j.id,
              jobId: j.id,
              setId: row.id,
              status: j.status,
              templateId,
              caption: row.caption || '',
              createdAt: j.createdAt,
              updatedAt: j.updatedAt,
              progress: j.progress,
              done: (j.progress as any)?.done || 0,
              total: (j.progress as any)?.total || 0,
              items: [],
              reused: true,
            };
          }
        } catch {
          /* next */
        }
      }
      // 组尚未落库但 job 已排队
      try {
        const { items } = await this.jobs.list(user, { type: jobType, limit: 30 });
        const hit = items.find(
          (j) =>
            (j.status === 'queued' || j.status === 'running') &&
            (j.payload as any)?.productId === productId &&
            (j.payload as any)?.templateId === templateId,
        );
        if (hit) {
          return {
            id: hit.id,
            jobId: hit.id,
            setId: (hit.payload as any)?.setId || '',
            status: hit.status,
            templateId,
            caption: '',
            createdAt: hit.createdAt,
            updatedAt: hit.updatedAt,
            progress: hit.progress,
            done: (hit.progress as any)?.done || 0,
            total: (hit.progress as any)?.total || 0,
            items: [],
            reused: true,
          };
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  /** 整组重生成：沿用 params，复用同组 job */
  async regenerateSet(user: AuthContext, productId: string, setId: string) {
    const set = await this.getSetEntity(user, productId, setId);
    const p = (set.params || {}) as unknown as GenerateInput;
    if (!p.templateId || !(p.referenceAssetIds || []).length) {
      throw new BadRequestException('该组缺少生成参数，无法重生成');
    }
    return this.generate(user, productId, {
      ...p,
      setId,
      regenIndexes: undefined,
      regenNonce: newId('rg'),
    });
  }

  /** 单张重生成（兼容旧路径） */
  async regenerateImage(user: AuthContext, productId: string, setId: string, index: number) {
    return this.regenerateImages(user, productId, setId, [index]);
  }

  /** 批量局部重生成：一次请求、一个 job、同一 set */
  async regenerateImages(user: AuthContext, productId: string, setId: string, indexes: number[]) {
    const set = await this.getSetEntity(user, productId, setId);
    const p = (set.params || {}) as unknown as GenerateInput;
    if (!p.templateId || !(p.referenceAssetIds || []).length) {
      throw new BadRequestException('该组缺少生成参数，无法重生成');
    }
    const idxs = [...new Set((indexes || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0))];
    if (!idxs.length) throw new BadRequestException('请指定要重生成的图片下标');
    return this.generate(user, productId, {
      ...p,
      setId,
      regenIndexes: idxs,
      regenNonce: newId('rg'),
    });
  }

  private async getSetEntity(user: AuthContext, productId: string, setId: string) {
    await this.products.getDetail(user, productId);
    const set = await this.setsRepo().findOne({ where: { id: setId, tenantId: user.tenantId, productId } });
    if (!set) throw new NotFoundException('宣传图组不存在');
    return set;
  }

  /**
   * 通用 Job worker 回调：执行生图并回写 progress/result。
   */
  async executeGenerateJob(
    user: AuthContext,
    productId: string,
    input: GenerateInput & Record<string, unknown>,
    opts?: {
      onProgress?: (p: Partial<JobProgress>) => Promise<void>;
      appendEvent?: (event: string, message?: string, data?: Record<string, unknown>) => Promise<void>;
    },
  ) {
    const tpl = findTemplate(String(input?.templateId || ''));
    if (!tpl) throw new Error('未知模板');
    const outfitEngine = this.externalOutfit.engineMode();
    if (outfitEngine !== 'external' && !this.gen.configured()) {
      throw new Error('服务端未配置生图密钥');
    }
    if (outfitEngine !== 'self' && !this.externalOutfit.configured()) {
      throw new Error('外部穿搭 Agent 未配置（OUTFIT_AGENT_ENABLED + API_KEY/.secrets），无法使用 external/both');
    }
    const { product, assets } = await this.productAssets(user, productId);
    const refIds = ((input.referenceAssetIds as string[]) || []).filter(Boolean);
    if (refIds.length < tpl.reference.min || refIds.length > tpl.reference.max) {
      throw new Error(`该模板需选择 ${tpl.reference.min}-${tpl.reference.max} 张参考图`);
    }
    {
      const styleAllowedEarly = !!(tpl.styleRef && Number(tpl.styleRef.max) > 0) || tpl.id === 'style_ref';
      const styleMin = styleAllowedEarly ? (tpl.styleRef?.min ?? 0) : 0;
      const styleKeysEarly = styleAllowedEarly
        ? this.normalizeStyleRefs(user, input.styleRefObjectKeys)
        : [];
      if (styleMin > 0 && styleKeysEarly.length < styleMin) {
        throw new Error(`「${tpl.name}」至少需要 ${styleMin} 张风格样例`);
      }
      if (!styleAllowedEarly) {
        // 安全：其它模板执行期丢弃风格样例入参
        (input as any).styleRefObjectKeys = [];
        (input as any).styleStrength = undefined;
      }
    }
    const byId = new Map(assets.map((a) => [a.id, a]));
    const refs = refIds.map((id) => byId.get(id));
    if (refs.some((r) => !r)) throw new Error('参考图不属于该商品');

    let model = null as (typeof MODELS)[number] | null;
    if (tpl.model !== 'none' && input.modelId) {
      model = MODELS.find((m) => m.id === input.modelId) || null;
      if (!model) throw new Error('未知模特');
    }
    if (tpl.model === 'required' && !model) throw new Error('该模板需要选择模特');

    const colorsAll = Array.isArray(input.colors)
      ? (input.colors as string[]).map((c) => String(c || '').trim()).filter(Boolean)
      : [];
    const isMultiColor = tpl.id === 'multi_color';
    let count: number;
    if (isMultiColor) {
      count = Math.min(tpl.count.max, Math.max(tpl.count.min, colorsAll.length));
      if (colorsAll.length < tpl.count.min) throw new Error(`多色展示至少 ${tpl.count.min} 个颜色`);
      if (colorsAll.length !== refIds.length) {
        throw new Error(`多色展示需颜色与参考图 1:1（${colorsAll.length} 色 / ${refIds.length} 张图）`);
      }
      if (!model) throw new Error('多色展示需要选择模特');
      count = colorsAll.length;
    } else {
      count = Math.min(tpl.count.max, Math.max(tpl.count.min, Number(input.count) || tpl.count.default));
    }
    const sizeId = tpl.sizes.includes(String(input.sizeId || '')) ? String(input.sizeId) : tpl.defaultSize;
    let poses = tpl.poses.filter((o) => ((input.poses as string[]) || []).includes(o.id));
    let scenes = tpl.scenes.filter((o) => ((input.scenes as string[]) || []).includes(o.id));
    // multi_color：全组同一姿态/场景（只用第一个），不跨 index 轮换
    if (isMultiColor) {
      poses = poses.length ? [poses[0]] : tpl.poses[0] ? [tpl.poses[0]] : [];
      scenes = scenes.length ? [scenes[0]] : tpl.scenes[0] ? [tpl.scenes[0]] : [];
    }
    // 自由文本：匹配预设或生成 custom option（整组共用）
    const poseTextEarly = String(input.poseText || '').trim();
    const sceneTextEarly = String(input.sceneText || '').trim();
    if (poseTextEarly && tpl.poses.length) {
      const resolved = resolveOption(tpl.poses, (input.poses as string[]) || [], poseTextEarly, 'pose');
      if (resolved) poses = [resolved];
    }
    if (sceneTextEarly && tpl.scenes.length) {
      const resolved = resolveOption(tpl.scenes, (input.scenes as string[]) || [], sceneTextEarly, 'scene');
      if (resolved) scenes = [resolved];
    }
    const feature = String(
      input.feature ?? this.readFeature(user.tenantId, productId)?.feature ?? this.defaultFeature(product),
    ).slice(0, 2000);
    // 中文原话（留痕用，不被英文 enrich 覆盖）
    const poseTextZh = String(input.poseText || '').trim();
    const sceneTextZh = String(input.sceneText || '').trim();
    let poseText = poseTextZh;
    let sceneText = sceneTextZh;
    // 自由描述 → 关键词拆解 + 英文生图片段（LLM 优先，否则启发式）；自定义文案覆盖芯片 prompt
    if (poseText || sceneText) {
      try {
        const enriched = await enrichPoseSceneText(this.vision, { poseText, sceneText });
        if (enriched) {
          poseText = enriched.posePrompt || poseText;
          sceneText = enriched.scenePrompt || sceneText;
          this.logger.log(
            `pose-scene enrich via=${enriched.via} kw=${(enriched.keywords || []).slice(0, 8).join(',')}`,
          );
        }
      } catch (e: any) {
        this.logger.warn(`pose-scene enrich skip: ${e?.message || e}`);
      }
    }

    const regenRaw = (input.regenIndexes as number[]) || [];
    const regenSet = new Set(regenRaw.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0));
    const onlyRegen = regenSet.size > 0;

    // 若是单张重生成且已有 set，保留其它张
    let priorImages: PromoSetImage[] = [];
    const setId = String(input.setId || '');
    if (setId && this.dataSource && process.env.DB_ENABLED === 'true') {
      const existing = await this.setsRepo().findOne({ where: { id: setId, tenantId: user.tenantId, productId } });
      if (existing?.images?.length) priorImages = existing.images;
    }

    const items: JobItem[] = [];
    for (let i = 0; i < count; i++) {
      const pose = isMultiColor
        ? (poses[0] || tpl.poses[0] || null)
        : poses.length
          ? poses[i % poses.length]
          : tpl.poses[0] || null;
      const scene = isMultiColor
        ? (scenes[0] || tpl.scenes[0] || null)
        : scenes.length
          ? scenes[Math.floor(i / Math.max(1, poses.length)) % scenes.length]
          : tpl.scenes[0] || null;
      const prior = priorImages.find((x) => x.index === i);
      if (onlyRegen && !regenSet.has(i) && prior?.objectKey && prior.status === 'done') {
        items.push({
          index: i,
          status: 'done',
          poseId: prior.poseId || pose?.id,
          sceneId: prior.sceneId || scene?.id,
          objectKey: prior.objectKey,
          savedMediaId: prior.mediaId,
          prompt: prior.prompt || '',
          promptZh: prior.promptZh,
          genCalls: Array.isArray(prior.genCalls) ? prior.genCalls : [],
          model: prior.model,
          size: prior.size,
        });
        continue;
      }
      const colorsForPrompt = isMultiColor
        ? [colorsAll[i]].filter(Boolean)
        : colorsAll;
      const styleKwText = styleKeywordsToPromptZh(
        (input as any).styleKeywords,
        String((input as any).styleKeywordsText || '').trim() || undefined,
      );
      items.push({
        index: i,
        status: 'pending',
        poseId: pose?.id,
        sceneId: scene?.id,
        prompt: tpl.buildPrompt({
          feature,
          model,
          pose,
          scene,
          poseText: poseText || undefined,
          sceneText: sceneText || undefined,
          styleKeywordsText: styleKwText || undefined,
          colors: colorsForPrompt,
          index: i,
          total: count,
        }),
      });
    }

    // 兼容旧版按商品落盘的 job 文件，便于原 UI 轮询
    const legacy: PromoJob = {
      id: newId('pj'),
      tenantId: user.tenantId,
      productId,
      templateId: tpl.id,
      status: 'running',
      input: {
        ...(input as GenerateInput),
        feature,
        count,
        sizeId,
        colors: isMultiColor ? colorsAll : (input.colors as string[]) || [],
        _frameworkJobId: String(input._frameworkJobId || ''),
      } as any,
      size: SIZES[sizeId].upstream,
      items,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.saveJob(legacy);

    // 商品参考图：ensureLocal（OSS→本地）；缺一不可
    const refPaths: string[] = [];
    const refInputs: Array<{
      localPath: string;
      objectKey?: string;
      assetId?: string;
      filename?: string;
      priorKind?: GarmentRefKind;
      priorRoleZh?: string;
      priorRoleEn?: string;
    }> = [];
    const cachedAnalysis = (product as any)?.refAnalysis as ProductRefAnalysis | null | undefined;
    const cachedByAsset = new Map(
      (cachedAnalysis?.assets || []).filter((a) => a?.assetId).map((a) => [a.assetId, a]),
    );
    for (const r of refs) {
      const local = await this.ensureLocal(r!.objectKey);
      if (!local) throw new Error(`参考图本地不可用：${r!.objectKey}`);
      refPaths.push(local);
      const prior = cachedByAsset.get(r!.id) || ((r as any).meta as any) || null;
      const priorKind = prior?.kind as GarmentRefKind | undefined;
      refInputs.push({
        localPath: local,
        objectKey: r!.objectKey,
        assetId: r!.id,
        filename: (r as any).filename || (r as any).originalName,
        priorKind:
          priorKind === 'hang' || priorKind === 'detail' || priorKind === 'unusable' ? priorKind : undefined,
        priorRoleZh: prior?.roleZh ? String(prior.roleZh) : undefined,
        priorRoleEn: prior?.roleEn ? String(prior.roleEn) : undefined,
      });
    }
    const canReuseCached =
      !!cachedAnalysis?.analyzedAt &&
      refInputs.length > 0 &&
      refInputs.every((i) => !!i.priorKind);

    const keyDir = `tenants/${user.tenantId}/products/${product.styleNo}/promo/${legacy.id}`;
    fs.mkdirSync(path.join(this.storageRoot(), keyDir), { recursive: true });

    // 羊毛衫专用标准流程：分类 → 宫格补细节 → 角色标注 → 硬约束；非羊毛衫/读不全拒生
    await opts?.onProgress?.({
      percent: 8,
      step: 'prepare_refs',
      message: '识别羊毛衫参考图…',
      done: 0,
      total: items.length,
    });
    const garmentPrep = await prepareRefsForCategory('knitwear', this.vision, refInputs, {
      workDir: path.join(this.storageRoot(), keyDir, '_knitwear_grid'),
      reuseCached: canReuseCached,
      cachedAnalysis: canReuseCached ? cachedAnalysis || null : null,
    });
    if (!garmentPrep.ok) {
      throw new Error(garmentPrep.reasonZh || '羊毛衫参考图不可用，已拒绝生图');
    }
    this.logger.log(
      `knitwear-prep via=${garmentPrep.via} detail=${garmentPrep.detailSufficiency} refs=${garmentPrep.refs.length} classified=${garmentPrep.classified.length}`,
    );
    await opts?.appendEvent?.('garment_prep', '羊毛衫参考图准备完成', {
      via: garmentPrep.via,
      detailSufficiency: garmentPrep.detailSufficiency,
      garmentDescZh: garmentPrep.garmentDescZh,
      refKinds: garmentPrep.refs.map((r) => r.kind),
      classified: garmentPrep.classified.map((c) => ({ kind: c.kind, roleZh: c.roleZh, objectKey: c.objectKey })),
    });

    // 将硬约束 + 参考图角色写入每张待生图 prompt；中文原话成对留痕
    const styleKwZhForTrace = styleKeywordsToPromptZh(
      (input as any).styleKeywords,
      String((input as any).styleKeywordsText || '').trim() || undefined,
    );
    const promptZhBase = [
      buildPromptZh({
        feature,
        poseText: poseTextZh,
        sceneText: sceneTextZh,
        garmentDescZh: garmentPrep.garmentDescZh,
        refRolesPromptZh: garmentPrep.refRolesPromptZh,
      }),
      styleKwZhForTrace ? `风格关键词：${styleKwZhForTrace}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const regenNonce = String((input as any).regenNonce || '').trim();
    const regenNudgeEn = regenNonce
      ? `Regeneration ${regenNonce}: intentionally change camera angle, crop, pose micro-gesture, expression or lighting so the result is visibly different from any prior output; keep the exact same garment identity, color and knit texture.`
      : '';
    const regenNudgeZh = regenNonce
      ? `重新生成 ${regenNonce}：请在构图/机位/姿势微动作/表情/光影上做出可见差异，切勿与上一版几乎相同；衣服款式、颜色、织纹必须与参考成衣一致。`
      : '';
    for (const it of items) {
      if (this.itemHasResult(it)) continue;
      const enrichedPrompt = [it.prompt, garmentPrep.garmentConstraintEn, garmentPrep.refRolesPromptEn, regenNudgeEn]
        .filter(Boolean)
        .join(' ');
      it.prompt = enrichedPrompt;
      it.promptZh = [promptZhBase, regenNudgeZh].filter(Boolean).join('\n');
    }

    // 风格样例：仅 style_ref；其它模板强制忽略（即便 params 残留）
    const styleAllowedExec = !!(tpl.styleRef && Number(tpl.styleRef.max) > 0) || tpl.id === 'style_ref';
    const styleKeysRaw = styleAllowedExec
      ? this.normalizeStyleRefs(user, input.styleRefObjectKeys)
      : [];
    const styleStrength = this.normalizeStyleStrength(
      styleAllowedExec ? input.styleStrength : undefined,
    );
    const stylePaths: string[] = [];
    const styleWarns: string[] = [];
    for (const k of styleKeysRaw) {
      const local = await this.ensureLocal(k);
      if (!local) {
        styleWarns.push(`风格样例不可用已跳过：${k}`);
        continue;
      }
      stylePaths.push(local);
    }
    if (styleWarns.length) {
      this.logger.warn(`style-ref degrade productId=${productId}: ${styleWarns.join('; ')}`);
    }

    let done = 0;
    // external 单引擎：跳过 IMAGE_GEN，后面统一拉外部结果
    const skipSelfGen = outfitEngine === 'external';
    await Promise.all(
      items.map(async (it) => {
        if (skipSelfGen) {
          done += 1;
          return;
        }
        if (this.itemHasResult(it)) {
          done += 1;
          const okKeep = items.filter((x) => x.status === 'done').length;
          await opts?.onProgress?.({
            percent: Math.min(95, Math.round((done / items.length) * 90) + 5),
            step: 'generating',
            message: `生图 ${done}/${items.length}`,
            done: okKeep,
            total: items.length,
          });
          return;
        }
        await this.acquire();
        const t0 = Date.now();
        try {
          it.status = 'running';
          this.saveJob(legacy);
          // 羊毛衫：prepared 挂拍/细节/宫格；多色时只用「该色」参考 + 细节（禁止混入其它色挂拍）
          const prepPaths = garmentPrep.refs.map((r) => r.localPath);
          let garmentRefs = prepPaths;
          if (isMultiColor && refPaths[it.index]) {
            const colorPath = refPaths[it.index];
            const detailOnly = garmentPrep.refs
              .filter((r) => r.kind === 'detail' || r.kind === 'grid_cell')
              .map((r) => r.localPath)
              .filter((p) => p && p !== colorPath);
            garmentRefs = [colorPath, ...detailOnly];
          }
          const refsForShot = stylePaths.length
            ? [...garmentRefs, ...stylePaths]
            : garmentRefs;
          const styleBlock = buildStyleRefPrompt({
            garmentRefCount: garmentRefs.length,
            styleRefCount: stylePaths.length,
            strength: styleStrength,
            primary: !!tpl.styleRefPrimary || tpl.id === 'style_ref',
          });
          const prompt = styleBlock ? `${it.prompt} ${styleBlock}` : it.prompt;
          if (styleBlock) it.prompt = prompt;
          const promptZh = it.promptZh || promptZhBase;
          const garmentKeys =
            isMultiColor && refs[it.index]
              ? [refs[it.index]!.objectKey]
              : refs.map((r) => r!.objectKey);
          const refObjectKeys = styleKeysRaw.length
            ? [...garmentKeys, ...styleKeysRaw]
            : garmentKeys;
          const callBase: ImageGenCallRecord = {
            at: new Date().toISOString(),
            prompt,
            promptEn: prompt,
            promptZh,
            model: this.gen.model,
            size: legacy.size,
            status: 'ok',
            jobId: String(input._frameworkJobId || '') || undefined,
            legacyJobId: legacy.id,
            setId: String(input.setId || '') || undefined,
            index: it.index,
            refObjectKeys,
            refCount: refsForShot.length,
            garmentPrep: {
              via: garmentPrep.via,
              detailSufficiency: garmentPrep.detailSufficiency,
              garmentDescZh: garmentPrep.garmentDescZh,
              refKinds: garmentPrep.refs.map((r) => r.kind),
            },
          };
          try {
            const seed = regenNonce
              ? Math.abs(Array.from(regenNonce).reduce((a, ch) => ((a * 33) + ch.charCodeAt(0)) | 0, it.index + 1))
              : undefined;
            const r = await this.gen.generate({
              prompt,
              size: legacy.size,
              refs: refsForShot,
              seed,
            });
            const ext = r.mime.includes('jpeg') ? '.jpg' : r.mime.includes('webp') ? '.webp' : '.png';
            const objectKey = `${keyDir}/${String(it.index + 1).padStart(2, '0')}${ext}`;
            fs.writeFileSync(path.join(this.storageRoot(), objectKey), r.buffer);
            await this.oss.putObjectSafe(r.buffer, objectKey, r.mime);
            const genCall: ImageGenCallRecord = {
              ...callBase,
              status: 'ok',
              via: r.via,
              ms: Date.now() - t0,
            };
            Object.assign(it, {
              status: 'done',
              objectKey,
              via: r.via,
              prompt,
              promptZh,
              model: this.gen.model,
              size: legacy.size,
              genCall,
            });
            await opts?.appendEvent?.(
              'image_gen',
              `生图 #${it.index + 1} 成功`,
              genCall as unknown as Record<string, unknown>,
            );
          } catch (genErr: any) {
            const msg = String(genErr?.message || genErr).slice(0, 500);
            const genCall: ImageGenCallRecord = {
              ...callBase,
              status: 'failed',
              error: msg,
              ms: Date.now() - t0,
            };
            it.status = 'failed';
            it.error = msg;
            it.prompt = prompt;
            it.promptZh = promptZh;
            it.model = this.gen.model;
            it.size = legacy.size;
            it.genCall = genCall;
            await opts?.appendEvent?.(
              'image_gen',
              `生图 #${it.index + 1} 失败`,
              genCall as unknown as Record<string, unknown>,
            );
          }
        } catch (e: any) {
          if (it.status !== 'failed') {
            it.status = 'failed';
            it.error = String(e.message || e).slice(0, 500);
          }
        } finally {
          it.ms = Date.now() - t0;
          done += 1;
          this.release();
          this.saveJob(legacy);
          const ok = items.filter((x) => x.status === 'done').length;
          await opts?.onProgress?.({
            percent: Math.min(95, Math.round((done / items.length) * 90) + 5),
            step: 'generating',
            message: `生图 ${done}/${items.length}`,
            done: ok,
            total: items.length,
          });
        }
      }),
    );

    // 外部 Agent：同图对比 / 或纯外部引擎（定稿对接预留，Token 只读 env/secrets）
    if (outfitEngine === 'both' || outfitEngine === 'external') {
      await opts?.onProgress?.({
        percent: 92,
        step: 'external_outfit',
        message: outfitEngine === 'both' ? '外部 Agent 同图对比中…' : '外部穿搭 Agent 生图中…',
        done: items.filter((x) => x.status === 'done').length,
        total: items.length,
      });
      const styleUrls = styleKeysRaw
        .map((k) => this.oss.publicUrl(k))
        .filter((u) => /^https?:\/\//i.test(u));
      const styleKwZh = styleKeywordsToPromptZh(
        (input as any).styleKeywords,
        String((input as any).styleKeywordsText || '').trim() || undefined,
      );
      const styleNote = styleUrls.length
        ? `前若干张是成衣参考（保真），后 ${styleUrls.length} 张是风格样例（只学构图光影氛围，禁止抄样例衣服/人脸/品牌logo）`
        : '';
      const regenNote = String((input as any).regenNonce || '').trim()
        ? `重新生成 ${String((input as any).regenNonce).trim()}：必须与上一版有可见差异（机位/构图/姿势微变/光影），禁止复刻同一张；成衣保真不变。`
        : '';

      const buildTemplateBrief = (it: JobItem, colorLabel?: string) => {
        const pose = (tpl.poses || []).find((o) => o.id === it?.poseId);
        const scene = (tpl.scenes || []).find((o) => o.id === it?.sceneId);
        const bits: string[] = [`模板：${tpl.name}`, `templateId=${tpl.id}`];
        if (tpl.id === 'detail_closeup') bits.push('细节特写：微距织纹/领口/袖口，浅景深，不要全身、不要真人出镜');
        else if (tpl.id === 'flatlay') bits.push('平铺/挂拍静物：整件成衣完整入镜，不要真人模特');
        else if (tpl.id === 'model_scene') bits.push('模特上身场景图：真人穿着成衣，生活场景，衣服保真');
        else if (tpl.id === 'multi_color') {
          bits.push('多色展示：同一姿势场景，本张只出「一个」颜色，姿态构图与其它色保持一致只换颜色');
          if (colorLabel) bits.push(`本张颜色：${colorLabel}（必须与本张成衣参考图颜色一致，禁止混用其它色）`);
        } else if (tpl.id === 'xhs_cover') bits.push('小红书封面风：竖版氛围感，上方留白（不要写字），可有可无模特');
        else if (tpl.id === 'style_ref') bits.push('风格参考：成衣保真，构图光影学风格样例，禁止抄样例衣服/人脸/logo');
        else if (tpl.model === 'none') bits.push('不要出真人模特，做静物/挂拍/细节');
        else if (tpl.model === 'required') bits.push('必须出真人模特上身展示成衣');
        else bits.push('模特可选');
        if (model) bits.push(`模特：${model.name}（${model.desc || ''}）`);
        if (pose?.name) bits.push(`姿势/呈现：${pose.name}`);
        if (scene?.name) bits.push(`场景：${scene.name}`);
        return bits.filter(Boolean).join('；');
      };

      const garmentUrlForSlot = (idx: number): string[] => {
        // multi_color：严格 1:1 只用该色参考图；其它模板仍可传整组成衣
        if (isMultiColor) {
          const r = refs[idx];
          if (r?.objectKey) {
            const u = this.oss.publicUrl(r.objectKey);
            if (/^https?:\/\//i.test(u)) return [u];
          }
          // fallback：garmentPrep 同序
          const prep = garmentPrep.refs[idx];
          if (prep?.objectKey) {
            const u = this.oss.publicUrl(prep.objectKey);
            if (/^https?:\/\//i.test(u)) return [u];
          }
          return [];
        }
        const keys =
          garmentPrep.refs
            .map((r) => r.objectKey)
            .filter((k): k is string => !!k)
            .slice(0, 9) ||
          refs.map((r) => r!.objectKey).filter(Boolean).slice(0, 9);
        const use = keys.length
          ? keys
          : refs.map((r) => r!.objectKey).filter(Boolean).slice(0, 9);
        return use.map((k) => this.oss.publicUrl(k)).filter((u) => /^https?:\/\//i.test(u));
      };

      const applyExternalToItem = (
        it: JobItem,
        ext: Awaited<ReturnType<ExternalOutfitClient['invoke']>>,
        urlIdx: number,
      ) => {
        if (outfitEngine === 'external') {
          if (!ext.ok || !ext.imageUrls.length) {
            it.status = 'failed';
            it.error = String(ext.error || '外部穿搭 Agent 未返回结果图').slice(0, 500);
            it.compare = {
              engine: 'external',
              external: { status: 'failed', error: it.error, requestId: ext.requestId, ms: ext.ms },
              self: { status: 'skipped' },
            };
            return;
          }
          // caller assigns image asynchronously
          (it as any)._extUrl = ext.imageUrls[Math.min(urlIdx, ext.imageUrls.length - 1)];
          it.compare = {
            engine: 'external',
            external: {
              status: 'ok',
              imageUrls: ext.imageUrls,
              requestId: ext.requestId,
              ms: ext.ms,
              agentCode: ext.agentCode,
            },
            self: { status: 'skipped' },
          };
        } else {
          it.compare = {
            engine: 'both',
            self: {
              status: it.status === 'done' ? 'ok' : 'failed',
              objectKey: it.objectKey,
              prompt: it.prompt,
              promptZh: it.promptZh,
              promptEn: it.prompt,
              ms: it.ms,
              error: it.error,
            },
            external: ext.ok
              ? {
                  status: 'ok',
                  imageUrls: ext.imageUrls,
                  requestId: ext.requestId,
                  ms: ext.ms,
                  agentCode: ext.agentCode,
                }
              : {
                  status: 'failed',
                  error: ext.error,
                  requestId: ext.requestId,
                  ms: ext.ms,
                  agentCode: ext.agentCode,
                },
          };
        }
      };

      const downloadExtToItem = async (it: JobItem, url: string) => {
        try {
          const u = String(url || '').trim();
          // 外部引擎已返回可访问直链：直接入库/展示，不下载、不转存自有 OSS（同视频 LKB 直链策略）
          if (/^https?:\/\//i.test(u)) {
            it.status = 'done';
            it.objectKey = undefined;
            it.url = u;
            it.via = 'external_outfit';
            return;
          }
          const buf = Buffer.from(await (await fetch(u)).arrayBuffer());
          const extName = u.toLowerCase().includes('.png') ? '.png' : '.jpg';
          const objectKey = `${keyDir}/${String(it.index + 1).padStart(2, '0')}${extName}`;
          fs.writeFileSync(path.join(this.storageRoot(), objectKey), buf);
          await this.oss.putObjectSafe(buf, objectKey, extName === '.png' ? 'image/png' : 'image/jpeg');
          it.status = 'done';
          it.objectKey = objectKey;
          it.via = 'external_outfit';
        } catch (e: any) {
          it.status = 'failed';
          it.error = String(e?.message || e).slice(0, 500);
          if (it.compare?.external) {
            (it.compare.external as any).status = 'failed';
            (it.compare.external as any).error = it.error;
          }
        }
      };

      if (isMultiColor) {
        // 关键：每个颜色单独调一次 Agent（1 色参考 + 该色 prompt），避免整组一锅炖只出第一色
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (this.itemHasResult(it)) continue;
          const colorLabel = colorsAll[i] || '';
          const garmentUrls = garmentUrlForSlot(i);
          if (!garmentUrls.length) {
            it.status = 'failed';
            it.error = `多色展示第 ${i + 1} 色缺少参考图 URL`;
            continue;
          }
          const combinedImages = [...garmentUrls, ...styleUrls].slice(0, 9);
          const promptLead = String(it.prompt || it.promptZh || '').trim();
          const instruction = [
            buildTemplateBrief(it, colorLabel),
            poseTextZh ? `姿势描述：${poseTextZh}` : '',
            sceneTextZh ? `场景描述：${sceneTextZh}` : '',
            feature ? `商品特征：${feature}` : '',
            colorLabel ? `本张只生成颜色「${colorLabel}」，成衣颜色必须与唯一成衣参考图一致` : '',
            styleKwZh,
            styleNote,
            promptLead ? `生图要求：${promptLead}` : '',
            regenNote,
          ]
            .filter(Boolean)
            .join('\n')
            .slice(0, 2400);
          const ext = await this.externalOutfit.invoke({
            garmentImages: combinedImages,
            instruction: instruction || undefined,
          });
          await opts?.appendEvent?.('external_outfit', ext.ok ? `外部 Agent 色${i + 1}成功` : `外部 Agent 色${i + 1}失败`, {
            ok: ext.ok,
            ms: ext.ms,
            requestId: ext.requestId,
            agentCode: ext.agentCode,
            imageCount: ext.imageUrls.length,
            error: ext.error,
            engine: outfitEngine,
            colorIndex: i,
            colorLabel,
            garmentImageCount: garmentUrls.length,
          });
          applyExternalToItem(it, ext, 0);
          if (outfitEngine === 'external' && (it as any)._extUrl) {
            await downloadExtToItem(it, String((it as any)._extUrl));
            delete (it as any)._extUrl;
          }
          await opts?.onProgress?.({
            percent: Math.min(98, 92 + Math.round(((i + 1) / items.length) * 6)),
            step: 'external_outfit',
            message: `外部 Agent 生图 ${i + 1}/${items.length}`,
            done: items.filter((x) => x.status === 'done').length,
            total: items.length,
          });
        }
      } else {
        // 非多色：整组一次调用（原逻辑）
        const garmentUrls = garmentUrlForSlot(0);
        const combinedImages = [...garmentUrls, ...styleUrls].slice(0, 9);
        const pending = items.filter((x) => !this.itemHasResult(x));
        const lead = pending[0] || items[0];
        const promptLead = String(lead?.prompt || lead?.promptZh || '').trim();
        const instruction = [
          buildTemplateBrief(lead),
          poseTextZh ? `姿势描述：${poseTextZh}` : '',
          sceneTextZh ? `场景描述：${sceneTextZh}` : '',
          feature ? `商品特征：${feature}` : '',
          styleKwZh,
          styleNote,
          promptLead ? `生图要求：${promptLead}` : '',
          items.length > 1 ? `共需 ${items.length} 张不同构图/微变体，勿完全重复` : '',
          regenNote,
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 2400);
        const ext = await this.externalOutfit.invoke({
          garmentImages: combinedImages.length ? combinedImages : garmentUrls,
          instruction: instruction || undefined,
        });
        await opts?.appendEvent?.('external_outfit', ext.ok ? '外部 Agent 成功' : '外部 Agent 失败', {
          ok: ext.ok,
          ms: ext.ms,
          requestId: ext.requestId,
          agentCode: ext.agentCode,
          imageCount: ext.imageUrls.length,
          error: ext.error,
          engine: outfitEngine,
        });

        if (outfitEngine === 'external') {
          if (!ext.ok || !ext.imageUrls.length) {
            throw new Error(ext.error || '外部穿搭 Agent 未返回结果图');
          }
          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (this.itemHasResult(it)) continue;
            applyExternalToItem(it, ext, i);
            if ((it as any)._extUrl) {
              await downloadExtToItem(it, String((it as any)._extUrl));
              delete (it as any)._extUrl;
            }
          }
        } else {
          for (const it of items) applyExternalToItem(it, ext, 0);
        }
      }
    }


    const ok = items.filter((i) => i.status === 'done').length;
    legacy.status = ok === items.length ? 'done' : ok ? 'partial' : 'failed';
    this.saveJob(legacy);
    if (!ok) throw new Error(items.find((i) => i.error)?.error || '生图全部失败');

    const setResult = await this.persistSetAfterGenerate(user, productId, product, {
      setId: String(input.setId || ''),
      frameworkJobId: String(input._frameworkJobId || ''),
      legacyJobId: legacy.id,
      templateId: tpl.id,
      input: {
        ...(input as GenerateInput),
        feature,
        count,
        sizeId,
        styleRefObjectKeys: styleKeysRaw,
        styleStrength: styleKeysRaw.length ? styleStrength : undefined,
      },
      items,
      status: legacy.status === 'done' ? 'done' : 'partial',
    });

    return {
      promoJobId: legacy.id,
      setId: setResult.setId,
      templateId: tpl.id,
      status: legacy.status,
      caption: setResult.caption,
      done: ok,
      total: items.length,
      items: items.map((i) => ({
        index: i.index,
        status: i.status,
        url: this.itemPlayUrl(i),
        mediaId: i.savedMediaId || null,
        error: i.error,
        ms: i.ms,
      })),
    };
  }

  /** 生成成功：upsert 宣传图组 + media_assets；宣传图绝不写入商品 coverMediaIds */
  private async persistSetAfterGenerate(
    user: AuthContext,
    productId: string,
    product: any,
    opts: {
      setId: string;
      frameworkJobId: string;
      legacyJobId: string;
      templateId: string;
      input: GenerateInput;
      items: JobItem[];
      status: 'done' | 'partial';
    },
  ) {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      return { setId: opts.setId || opts.legacyJobId, caption: '' };
    }
    const repo = this.setsRepo();
    const mediaRepo = this.dataSource.getRepository(MediaAsset);
    let setId = opts.setId;
    let row = setId
      ? await repo.findOne({ where: { id: setId, tenantId: user.tenantId, productId } })
      : null;
    if (!row) {
      setId = setId || newId('ps');
      row = repo.create({
        id: setId,
        tenantId: user.tenantId,
        productId,
        templateId: opts.templateId,
        params: null,
        caption: null,
        jobId: null,
        legacyJobId: opts.legacyJobId,
        status: 'generating',
        images: [],
      });
    }

    const caption = this.captionFor(product, opts.input, opts.templateId);
    const addedMediaIds: string[] = [];
    const images: PromoSetImage[] = [];

    // 整组重生成：清掉本组旧 media（单张重生成保留未改动的）
    const regenOnly = Array.isArray((opts.input as any).regenIndexes) && (opts.input as any).regenIndexes.length > 0;
    if (!regenOnly && row.images?.length) {
      const oldIds = row.images.map((i) => i.mediaId).filter(Boolean) as string[];
      for (const mid of oldIds) {
        await mediaRepo.update({ id: mid, tenantId: user.tenantId }, { status: 'deleted' });
      }
      if (oldIds.length) {
        const covers = (product.coverMediaIds || []).filter((id: string) => !oldIds.includes(id));
        product.coverMediaIds = covers;
        await this.products.update(user, productId, { coverMediaIds: covers });
      }
    }

    const priorByIndex = new Map((row.images || []).map((x) => [x.index, x]));
    const mergeGenCalls = (it: JobItem): ImageGenCallRecord[] => {
      const prior = priorByIndex.get(it.index);
      const hist = Array.isArray(it.genCalls)
        ? [...it.genCalls]
        : Array.isArray(prior?.genCalls)
          ? [...prior!.genCalls!]
          : [];
      if (it.genCall) hist.push(it.genCall);
      // 每槽最多保留 30 次，便于分析且控 JSON 体积
      return hist.slice(-30);
    };
    for (const it of opts.items) {
      const externalUrl = String(it.url || '').trim();
      const hasExternal = /^https?:\/\//i.test(externalUrl);
      if (it.status !== 'done' || !(it.objectKey || hasExternal)) {
        const genCalls = mergeGenCalls(it);
        images.push({
          index: it.index,
          status: it.status === 'failed' ? 'failed' : it.status,
          poseId: it.poseId,
          sceneId: it.sceneId,
          error: it.error,
          ms: it.ms,
          objectKey: it.objectKey,
          externalUrl: hasExternal ? externalUrl : undefined,
          mediaId: it.savedMediaId,
          prompt: it.prompt || priorByIndex.get(it.index)?.prompt,
          promptZh: it.promptZh || it.genCall?.promptZh || priorByIndex.get(it.index)?.promptZh,
          promptEn: it.prompt || it.genCall?.promptEn || priorByIndex.get(it.index)?.promptEn,
          model: it.model || it.genCall?.model || priorByIndex.get(it.index)?.model,
          size: it.size || it.genCall?.size || priorByIndex.get(it.index)?.size,
          genCalls: genCalls.length ? genCalls : undefined,
          compare: it.compare || priorByIndex.get(it.index)?.compare,
        });
        continue;
      }
      let mediaId = it.savedMediaId;
      if (!mediaId) {
        const abs = !hasExternal && it.objectKey ? path.join(this.storageRoot(), it.objectKey) : '';
        const size = abs && fs.existsSync(abs) ? fs.statSync(abs).size : 0;
        const mime = hasExternal
          ? externalUrl.toLowerCase().includes('.png')
            ? 'image/png'
            : 'image/jpeg'
          : it.objectKey!.endsWith('.jpg')
            ? 'image/jpeg'
            : 'image/png';
        const saved = await mediaRepo.save(
          mediaRepo.create({
            tenantId: user.tenantId,
            productId,
            promoSetId: setId,
            type: 'image',
            provider: hasExternal ? 'external' : this.oss.mediaProvider(),
            // 直链存完整 URL；本地/OSS 仍存 objectKey
            objectKey: hasExternal ? externalUrl : it.objectKey!,
            mimeType: mime,
            sizeBytes: String(size),
            status: 'active',
          }),
        );
        mediaId = saved.id;
        it.savedMediaId = mediaId;
        addedMediaIds.push(mediaId);
      } else {
        await mediaRepo.update({ id: mediaId, tenantId: user.tenantId }, { promoSetId: setId, productId });
      }
      const genCalls = mergeGenCalls(it);
      images.push({
        index: it.index,
        status: 'done',
        objectKey: hasExternal ? undefined : it.objectKey,
        externalUrl: hasExternal ? externalUrl : undefined,
        mediaId,
        poseId: it.poseId,
        sceneId: it.sceneId,
        ms: it.ms,
        prompt: it.prompt || priorByIndex.get(it.index)?.prompt,
        promptZh: it.promptZh || it.genCall?.promptZh || priorByIndex.get(it.index)?.promptZh,
        promptEn: it.prompt || it.genCall?.promptEn || priorByIndex.get(it.index)?.promptEn,
        model: it.model || it.genCall?.model || priorByIndex.get(it.index)?.model,
        size: it.size || it.genCall?.size || priorByIndex.get(it.index)?.size,
        genCalls: genCalls.length ? genCalls : undefined,
        compare: it.compare || priorByIndex.get(it.index)?.compare,
      });
    }

    row.templateId = opts.templateId;
    const styleKeys = Array.isArray(opts.input.styleRefObjectKeys)
      ? opts.input.styleRefObjectKeys.filter(Boolean)
      : [];
    row.params = {
      templateId: opts.templateId,
      feature: opts.input.feature || '',
      referenceAssetIds: opts.input.referenceAssetIds || [],
      modelId: opts.input.modelId || null,
      imageGenModel: this.gen.model,
      garmentCategory: 'knitwear',
      poses: opts.input.poses || [],
      scenes: opts.input.scenes || [],
      poseText: opts.input.poseText || undefined,
      sceneText: opts.input.sceneText || undefined,
      colors: opts.input.colors || [],
      count: opts.input.count,
      sizeId: opts.input.sizeId,
      styleRefObjectKeys: styleKeys,
      styleStrength: styleKeys.length
        ? this.normalizeStyleStrength(opts.input.styleStrength)
        : undefined,
    };
    row.caption = caption;
    row.jobId = opts.frameworkJobId || row.jobId;
    row.legacyJobId = opts.legacyJobId;
    row.status = opts.status;
    row.images = images;
    await repo.save(row);
    try {
      const legacy = this.loadJob(user, productId, opts.legacyJobId);
      legacy.items = opts.items;
      this.saveJob(legacy);
    } catch {
      /* ignore */
    }

    // 站规：宣传图只进 promo_sets / media_assets(promoSetId)，不进商品图 coverMediaIds
    if (addedMediaIds.length) {
      const covers = (product.coverMediaIds || []).filter((id: string) => !addedMediaIds.includes(id));
      // 顺带清掉历史误写入的本组宣传图
      const setMediaIds = images.map((i) => i.mediaId).filter(Boolean) as string[];
      const cleaned = covers.filter((id: string) => !setMediaIds.includes(id));
      if (cleaned.length !== (product.coverMediaIds || []).length) {
        await this.products.update(user, productId, { coverMediaIds: cleaned });
      }
    }
    return { setId, caption };
  }


  private async acquire() {
    if (this.running < MAX_CONCURRENCY) {
      this.running++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
    this.running++;
  }
  private release() {
    this.running--;
    const w = this.waiters.shift();
    if (w) w();
  }

  private async runJob(job: PromoJob, refPaths: string[], keyDir: string) {
    job.status = 'running';
    this.saveJob(job);
    fs.mkdirSync(path.join(this.storageRoot(), keyDir), { recursive: true });
    await Promise.all(
      job.items.map(async (it) => {
        await this.acquire();
        const t0 = Date.now();
        try {
          it.status = 'running';
          this.saveJob(job);
          const r = await this.gen.generate({ prompt: it.prompt, size: job.size, refs: refPaths });
          const ext = r.mime.includes('jpeg') ? '.jpg' : r.mime.includes('webp') ? '.webp' : '.png';
          const objectKey = `${keyDir}/${String(it.index + 1).padStart(2, '0')}${ext}`;
          fs.writeFileSync(path.join(this.storageRoot(), objectKey), r.buffer);
          await this.oss.putObjectSafe(r.buffer, objectKey, r.mime);
          const genCall: ImageGenCallRecord = {
            at: new Date().toISOString(),
            prompt: it.prompt,
            model: this.gen.model,
            size: job.size,
            status: 'ok',
            via: r.via,
            ms: Date.now() - t0,
            legacyJobId: job.id,
            index: it.index,
            refCount: refPaths.length,
          };
          Object.assign(it, {
            status: 'done',
            objectKey,
            via: r.via,
            model: this.gen.model,
            size: job.size,
            genCall,
          });
        } catch (e: any) {
          const msg = String(e.message || e).slice(0, 500);
          it.status = 'failed';
          it.error = msg;
          it.genCall = {
            at: new Date().toISOString(),
            prompt: it.prompt,
            model: this.gen.model,
            size: job.size,
            status: 'failed',
            error: msg,
            ms: Date.now() - t0,
            legacyJobId: job.id,
            index: it.index,
            refCount: refPaths.length,
          };
        } finally {
          it.ms = Date.now() - t0;
          this.release();
          this.saveJob(job);
        }
      }),
    );
    const ok = job.items.filter((i) => i.status === 'done').length;
    job.status = ok === job.items.length ? 'done' : ok ? 'partial' : 'failed';
    this.saveJob(job);
    this.logger.log(`job ${job.id} ${job.status} ${ok}/${job.items.length}`);
  }


  /** Put moov before mdat so WeChat <video> can read duration (avoids 0:00). */
  private async ensureMp4Faststart(absPath: string): Promise<Buffer | null> {
    if (!absPath.toLowerCase().endsWith('.mp4')) return null;
    if (!fs.existsSync(absPath)) return null;
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const tmp = `${absPath}.faststart.tmp.mp4`;
    try {
      const r = spawnSync(
        ffmpeg,
        ['-y', '-i', absPath, '-c', 'copy', '-movflags', '+faststart', tmp],
        { encoding: 'utf8', timeout: 120_000 },
      );
      if (r.status !== 0 || !fs.existsSync(tmp)) {
        this.logger.warn(
          `mp4 faststart skip: ${String(r.stderr || r.error || 'ffmpeg failed').slice(0, 200)}`,
        );
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
        return null;
      }
      fs.renameSync(tmp, absPath);
      return fs.readFileSync(absPath);
    } catch (e: any) {
      this.logger.warn(`mp4 faststart error: ${String(e?.message || e).slice(0, 200)}`);
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
      return null;
    }
  }

  private jobFile(tenantId: string, productId: string, jobId: string) {
    if (!/^pj_[a-f0-9]+$/.test(jobId)) throw new NotFoundException('任务不存在');
    return path.join(this.stateDir(tenantId, productId), `${jobId}.json`);
  }
  private saveJob(job: PromoJob) {
    job.updatedAt = Date.now();
    fs.writeFileSync(this.jobFile(job.tenantId, job.productId, job.id), JSON.stringify(job, null, 1));
  }
  private loadJob(user: AuthContext, productId: string, jobId: string): PromoJob {
    const f = this.jobFile(user.tenantId, productId, jobId);
    if (!fs.existsSync(f)) throw new NotFoundException('任务不存在');
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  private jobDto(job: PromoJob) {
    const displayTitle = buildJobDisplayTitle('promo_image', {
      ...(job.input as any),
      templateId: job.templateId,
      displayTitle: job.templateId === 'multi_color' ? undefined : (job.input as any)?.displayTitle,
    });
    return {
      id: job.id,
      templateId: job.templateId,
      templateName: displayTitle || findTemplate(job.templateId)?.name || '宣传生图',
      displayTitle,
      title: displayTitle,
      status: job.status,
      size: job.size,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      done: job.items.filter((i) => i.status === 'done').length,
      total: job.items.length,
      items: job.items.map((i) => ({
        index: i.index,
        status: i.status,
        poseId: i.poseId,
        sceneId: i.sceneId,
        url: this.itemPlayUrl(i),
        error: i.error,
        saved: !!i.savedMediaId,
        ms: i.ms,
      })),
    };
  }

  async getJob(user: AuthContext, productId: string, jobId: string) {
    await this.products.getDetail(user, productId);
    // 框架 jobId（job_*）→ 若已写出 legacy pj_* 则返回图集；否则返回进度占位
    if (!/^pj_/.test(jobId)) {
      const fj = await this.jobs.get(user, jobId);
      const promoJobId = (fj.result as any)?.promoJobId as string | undefined;
      if (promoJobId && fs.existsSync(this.jobFile(user.tenantId, productId, promoJobId))) {
        const dto = this.jobDto(this.loadJob(user, productId, promoJobId));
        return {
          ...dto,
          frameworkJobId: fj.id,
          setId: (fj.result as any)?.setId || (fj.payload as any)?.setId,
          caption: (fj.result as any)?.caption,
          progress: fj.progress,
          error: fj.error,
        };
      }
      const statusMap: Record<string, string> = {
        queued: 'queued',
        running: 'running',
        succeeded: 'done',
        failed: 'failed',
        cancelled: 'failed',
      };
      return {
        id: fj.id,
        frameworkJobId: fj.id,
        setId: (fj.payload as any)?.setId,
        templateId: (fj.payload as any)?.templateId,
        status: statusMap[fj.status] || fj.status,
        createdAt: fj.createdAt,
        updatedAt: fj.updatedAt,
        progress: fj.progress,
        done: (fj.progress as any)?.done || 0,
        total: (fj.progress as any)?.total || 0,
        items: [],
        error: fj.error,
      };
    }
    return this.jobDto(this.loadJob(user, productId, jobId));
  }

  async listJobs(user: AuthContext, productId: string) {
    await this.products.getDetail(user, productId);
    const dir = this.stateDir(user.tenantId, productId);
    const legacyRaw: PromoJob[] = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.startsWith('pj_') && f.endsWith('.json'))
          .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as PromoJob)
      : [];

    // 附带仍在排队/执行中的框架任务（尚未写出 pj_* 时也能在宣传图页看到）
    let pendingJobs: any[] = [];
    try {
      const imageJobs = await this.jobs.list(user, { type: 'promo_image', limit: 50 });
      const videoJobs = await this.jobs.list(user, { type: 'promo_video', limit: 30 });
      pendingJobs = [...(imageJobs.items || []), ...(videoJobs.items || [])]
        .filter((j) => (j.payload as any)?.productId === productId)
        .filter((j) => j.status === 'queued' || j.status === 'running');
    } catch {
      /* ignore */
    }

    const activeFwIds = new Set(pendingJobs.map((j) => j.id));
    // legacy 若挂了进行中的框架 job，不再单独列出（避免双行：job_* + pj_*）
    const legacy = legacyRaw
      .filter((j) => {
        const fw = String((j.input as any)?._frameworkJobId || '');
        if (fw && activeFwIds.has(fw)) return false;
        return true;
      })
      .map((j) => this.jobDto(j));

    // 已写出 promoJobId / 或同 set 已有 legacy 进度时，不再塞框架占位行
    const legacyFwLinked = new Set(
      legacyRaw
        .map((j) => String((j.input as any)?._frameworkJobId || ''))
        .filter(Boolean),
    );
    const pending = pendingJobs
      .filter((j) => !((j.result as any)?.promoJobId))
      .filter((j) => !legacyFwLinked.has(j.id))
      .map((j) => ({
        id: j.id,
        frameworkJobId: j.id,
        setId: (j.payload as any)?.setId,
        templateId: (j.payload as any)?.templateId,
        status: j.status === 'queued' ? 'queued' : 'running',
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        progress: j.progress,
        done: (j.progress as any)?.done || 0,
        total: (j.progress as any)?.total || 0,
        items: [],
        error: j.error,
        title: buildJobDisplayTitle(j.type || 'promo_image', j.payload as any),
        displayTitle: buildJobDisplayTitle(j.type || 'promo_image', j.payload as any),
        kind: j.type === 'promo_video' ? 'video' : 'image',
      }));

    return [...pending, ...legacy]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 30);
  }

  // ---------- 宣传图组（UI 以 set 为中心） ----------
  private setDto(row: PromoSetEntity) {
    const kindEarly =
      (row as any).kind || (row.params as any)?.kind || (row.params as any)?.mediaKind || 'image';
    const proxyExternal =
      kindEarly === 'video' || kindEarly === 'promo_video';
    const images = (row.images || []).map((i) => {
      const regenerating = i.status === 'pending' || i.status === 'running';
      return {
        index: i.index,
        status: i.status,
        poseId: i.poseId,
        sceneId: i.sceneId,
        mediaId: i.mediaId || null,
        // 重生中的槽位先藏旧图，列表立刻出现「生成中」占位
        url: !regenerating ? this.itemPlayUrl(i, { proxyExternal }) : null,
        error: i.error,
        ms: i.ms,
        saved: !!i.mediaId,
        regenerating: !!regenerating && !!(i.objectKey || (i as any).externalUrl || (i as any).url),
        // IMAGE_GEN 可分析：中文原话 + 英文最终提示词 + 历次调用（重生追加）
        prompt: i.prompt || null,
        promptZh: i.promptZh || null,
        promptEn: i.promptEn || i.prompt || null,
        model: i.model || null,
        size: i.size || null,
        genCalls: Array.isArray(i.genCalls) ? i.genCalls : [],
        compare: i.compare || null,
      };
    });
    const done = images.filter((i) => i.status === 'done' && i.url).length;
    const tpl = findTemplate(row.templateId);
    const kind = (row as any).kind || (row.params as any)?.kind || (row.params as any)?.mediaKind || 'image';
    const jobType = kind === 'video' || kind === 'promo_video' ? 'promo_video' : 'promo_image';
    const displayTitle = buildJobDisplayTitle(jobType, {
      ...(row.params as any),
      templateId: row.templateId,
      displayTitle: row.templateId === 'multi_color' ? undefined : (row.params as any)?.displayTitle,
      styleNo: (row.params as any)?.styleNo,
    });
    const posterUrl =
      (row.params as any)?.posterUrl ||
      (images.find((i) => i.url)?.url) ||
      null;
    return {
      id: row.id,
      setId: row.id,
      productId: row.productId,
      kind,
      type: kind,
      posterUrl: kind === 'video' || kind === 'promo_video' ? posterUrl : null,
      coverUrl: kind === 'video' || kind === 'promo_video' ? posterUrl : null,
      templateId: row.templateId,
      templateName: displayTitle || tpl?.name || row.templateId,
      displayTitle,
      params: row.params,
      caption: row.caption || '',
      jobId: row.jobId,
      legacyJobId: row.legacyJobId,
      status: row.status,
      done,
      total: images.length || Number((row.params as any)?.count) || 0,
      // 视频时长（秒）：params.seconds；供 gallery 展示，避免 moov 未就绪时播放器显示 0:00
      seconds:
        kind === 'video' || kind === 'promo_video'
          ? Number((row.params as any)?.seconds) || null
          : null,
      durationSec:
        kind === 'video' || kind === 'promo_video'
          ? Number((row.params as any)?.seconds) || null
          : null,
      items: images,
      createdAt: row.createdAt?.getTime?.() ?? row.createdAt,
      updatedAt: row.updatedAt?.getTime?.() ?? row.updatedAt,
    };
  }

  async listSets(user: AuthContext, productId: string) {
    // Light ACL — avoid full getDetail (images/signing) on every gallery poll
    await this.products.assertProductReadable(user, productId);
    await this.migrateLegacyJobsToSets(user, productId);
    let rows = await this.setsRepo().find({
      where: { tenantId: user.tenantId, productId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
    rows = rows.filter((r) => r.status !== 'deleted');
    // 附带尚未落库完成的排队中任务（仅 payload.setId 已有）
    const dtos = rows.map((r) => this.setDto(r));
    try {
      const [imageJobs, videoJobs] = await Promise.all([
        this.jobs.list(user, { type: 'promo_image', limit: 30 }),
        this.jobs.list(user, { type: 'promo_video', limit: 30 }),
      ]);
      const items = [...(imageJobs.items || []), ...(videoJobs.items || [])];
      for (const j of items) {
        if ((j.payload as any)?.productId !== productId) continue;
        const sid = (j.payload as any)?.setId as string | undefined;
        const hit = sid && dtos.find((d) => d.id === sid);
        if (!hit) continue;
        if (j.status === 'queued' || j.status === 'running') {
          hit.status = 'generating';
          hit.jobId = j.id;
          (hit as any).progress = j.progress;
          (hit as any).busy = true;
          if (j.type === 'promo_video') {
            hit.kind = 'video';
            hit.type = 'video';
          }
          continue;
        }
        if (
          hit.status === 'generating' &&
          hit.jobId === j.id &&
          (j.status === 'failed' || j.status === 'cancelled')
        ) {
          hit.status = 'failed';
          (hit as any).busy = false;
          try {
            await this.setsRepo().update(
              { id: hit.id, tenantId: user.tenantId },
              { status: 'failed' },
            );
          } catch { /* ignore */ }
        }
      }
    } catch {
      /* ignore */
    }
    const mapped = dtos
      .filter((d) => {
        const busy = d.status === 'generating' || (d as any).busy;
        const empty = !(d.total > 0) && !(d.items && d.items.length);
        // 空壳 generating 且没有挂上活 job → 幽灵组，不展示
        if (empty && d.status === 'generating' && !d.jobId && !(d as any).busy) return false;
        if (empty && !busy && d.status !== 'done' && d.status !== 'partial') return false;
        return true;
      })
      .map((d) => ({
        ...d,
        busy: d.status === 'generating' || (d as any).busy,
      }));
    return this.collapseBusySetsByTemplate(mapped);
  }

  /**
   * 素材列表去重：
   * - 同模板多条 generating 只留最新
   * - 失败且无可用图、且同模板已有更新成功组 → 不展示（避免「失败空壳」刷屏）
   */
  private collapseBusySetsByTemplate<T extends {
    id: string;
    templateId?: string;
    busy?: boolean;
    status?: string;
    createdAt?: any;
    done?: number;
    total?: number;
    items?: any[];
  }>(sets: T[]): T[] {
    const seenBusyTpl = new Set<string>();
    const hasDoneTpl = new Set<string>();
    for (const s of sets) {
      const tpl = String(s.templateId || '');
      const done =
        typeof s.done === 'number'
          ? s.done
          : (s.items || []).filter((i) => i && (i.status === 'done' || i.url)).length;
      if (tpl && (s.status === 'done' || s.status === 'partial') && done > 0) {
        hasDoneTpl.add(tpl);
      }
    }
    const out: T[] = [];
    for (const s of sets) {
      const busy = !!(s.busy || s.status === 'generating' || s.status === 'queued');
      const tpl = String(s.templateId || '');
      const done =
        typeof s.done === 'number'
          ? s.done
          : (s.items || []).filter((i) => i && (i.status === 'done' || i.url)).length;
      if (busy && tpl) {
        if (seenBusyTpl.has(tpl)) continue;
        seenBusyTpl.add(tpl);
      }
      // 失败空壳：同模板已有成功成片时隐藏
      if (s.status === 'failed' && done <= 0 && tpl && hasDoneTpl.has(tpl)) {
        continue;
      }
      out.push(s);
    }
    return out;
  }

  /** 软删同商品+模板下无成片的失败空壳组，避免新建时堆积 */
  private async softDeleteFailedEmptySets(
    user: AuthContext,
    productId: string,
    templateId: string,
    exceptSetId?: string,
  ) {
    const repo = this.setsRepo();
    const rows = await repo.find({
      where: { tenantId: user.tenantId, productId, templateId, status: 'failed' },
      take: 20,
      order: { createdAt: 'DESC' },
    });
    for (const row of rows) {
      if (exceptSetId && row.id === exceptSetId) continue;
      const done = (row.images || []).filter((i) => i && i.status === 'done' && (i.objectKey || (i as any).externalUrl || (i as any).url)).length;
      if (done > 0) continue;
      row.status = 'deleted';
      await repo.save(row);
      this.logger.log(`soft-delete failed empty set ${row.id} tpl=${templateId}`);
    }
  }

  /** 新建时优先复用同模板失败空壳 set，避免任务/素材双增 */
  private async findReusableFailedSet(
    user: AuthContext,
    productId: string,
    templateId: string,
  ) {
    const repo = this.setsRepo();
    const rows = await repo.find({
      where: { tenantId: user.tenantId, productId, templateId, status: 'failed' },
      order: { createdAt: 'DESC' },
      take: 5,
    });
    for (const row of rows) {
      const done = (row.images || []).filter((i) => i && i.status === 'done' && (i.objectKey || (i as any).externalUrl || (i as any).url)).length;
      if (done > 0) continue;
      return row;
    }
    return null;
  }

  async getSet(user: AuthContext, productId: string, setId: string) {
    const row = await this.getSetEntity(user, productId, setId);
    const dto = this.setDto(row);
    if (row.jobId) {
      try {
        const fj = await this.jobs.get(user, row.jobId);
        (dto as any).progress = fj.progress;
        (dto as any).frameworkStatus = fj.status;
        if (fj.status === 'queued' || fj.status === 'running') {
          dto.status = 'generating';
          (dto as any).busy = true;
        } else if (
          row.status === 'generating' &&
          (fj.status === 'failed' || fj.status === 'cancelled')
        ) {
          dto.status = 'failed';
          (dto as any).busy = false;
          row.status = 'failed';
          await this.setsRepo().save(row);
        }
      } catch {
        /* ignore */
      }
    }
    return dto;
  }

  async deleteSet(user: AuthContext, productId: string, setId: string) {
    const row = await this.getSetEntity(user, productId, setId);
    const product: any = await this.products.getDetail(user, productId);
    const mediaIds = (row.images || []).map((i) => i.mediaId).filter(Boolean) as string[];
    if (this.dataSource && mediaIds.length) {
      const mediaRepo = this.dataSource.getRepository(MediaAsset);
      for (const mid of mediaIds) {
        await mediaRepo.update({ id: mid, tenantId: user.tenantId }, { status: 'deleted' });
      }
      const covers = (product.coverMediaIds || []).filter((id: string) => !mediaIds.includes(id));
      await this.products.update(user, productId, { coverMediaIds: covers });
    }
    row.status = 'deleted';
    await this.setsRepo().save(row);
    return { deleted: setId, mediaRemoved: mediaIds.length };
  }

  /** 把旧 pj_* 文件一次性迁入 promo_sets（幂等） */
  private async migrateLegacyJobsToSets(user: AuthContext, productId: string) {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) return;
    const memoKey = `${user.tenantId}:${productId}`;
    if (this.legacyMigratedProducts.has(memoKey)) return;
    // Peek without mkdir (stateDir always creates)
    const dir = path.join(process.cwd(), 'data', 'promo', user.tenantId, productId);
    if (!fs.existsSync(dir)) {
      this.legacyMigratedProducts.add(memoKey);
      return;
    }
    const repo = this.setsRepo();
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('pj_') && f.endsWith('.json'));
    if (!files.length) {
      this.legacyMigratedProducts.add(memoKey);
      return;
    }
    for (const f of files) {
      try {
        const job: PromoJob = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!job?.id) continue;
        const existed = await repo.findOne({ where: { tenantId: user.tenantId, productId, legacyJobId: job.id } });
        if (existed) continue;
        const status =
          job.status === 'done' ? 'done' : job.status === 'partial' ? 'partial' : job.status === 'failed' ? 'failed' : 'generating';
        if (status === 'generating') continue;
        const images: PromoSetImage[] = (job.items || []).map((it) => ({
          index: it.index,
          status: it.status === 'done' ? 'done' : it.status === 'failed' ? 'failed' : 'pending',
          objectKey: it.objectKey,
          mediaId: it.savedMediaId,
          poseId: it.poseId,
          sceneId: it.sceneId,
          error: it.error,
          ms: it.ms,
        }));
        const product: any = await this.products.getDetail(user, productId);
        const input = job.input || ({} as GenerateInput);
        await repo.save(
          repo.create({
            id: newId('ps'),
            tenantId: user.tenantId,
            productId,
            templateId: job.templateId,
            params: {
              templateId: job.templateId,
              feature: input.feature || '',
              referenceAssetIds: input.referenceAssetIds || [],
              modelId: input.modelId || null,
              poses: input.poses || [],
              scenes: input.scenes || [],
              colors: input.colors || [],
              count: input.count || job.items?.length,
              sizeId: input.sizeId,
              styleRefObjectKeys: input.styleRefObjectKeys || [],
              styleStrength: input.styleStrength,
            },
            caption: this.captionFor(product, input, job.templateId),
            jobId: null,
            legacyJobId: job.id,
            status: status as any,
            images,
          }),
        );
      } catch (e: any) {
        this.logger.warn(`migrate legacy ${f}: ${e.message || e}`);
      }
    }
    this.legacyMigratedProducts.add(memoKey);
  }

  /**
   * 兼容旧接口：仅确保宣传结果落 media_assets（带 promo 路径），
   * 绝不写入商品 coverMediaIds（商品图与宣传图分离）。
   */
  async saveToProduct(user: AuthContext, productId: string, jobId: string, body: { indexes?: number[] }) {
    const job = this.loadJob(user, productId, jobId);
    await this.products.getDetail(user, productId);
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) throw new BadRequestException('需开启数据库');
    const repo = this.dataSource.getRepository(MediaAsset);
    const want = body?.indexes?.length ? body.indexes : job.items.map((i) => i.index);
    const added: string[] = [];
    for (const it of job.items) {
      const externalUrl = String(it.url || '').trim();
      const hasExternal = /^https?:\/\//i.test(externalUrl);
      if (!want.includes(it.index) || it.status !== 'done' || !(it.objectKey || hasExternal) || it.savedMediaId) continue;
      const abs = !hasExternal && it.objectKey ? path.join(this.storageRoot(), it.objectKey) : '';
      const sizeBytes = abs && fs.existsSync(abs) ? fs.statSync(abs).size : 0;
      const mime = hasExternal
        ? externalUrl.toLowerCase().includes('.png')
          ? 'image/png'
          : 'image/jpeg'
        : it.objectKey!.endsWith('.jpg')
          ? 'image/jpeg'
          : 'image/png';
      const saved = await repo.save(
        repo.create({
          tenantId: user.tenantId,
          productId,
          type: 'image',
          provider: hasExternal ? 'external' : this.oss.mediaProvider(),
          objectKey: hasExternal ? externalUrl : it.objectKey!,
          mimeType: mime,
          sizeBytes: String(sizeBytes),
          status: 'active',
        }),
      );
      it.savedMediaId = saved.id;
      added.push(saved.id);
    }
    this.saveJob(job);
    return { added, job: this.jobDto(job), mixedIntoProductImages: false };
  }
}
