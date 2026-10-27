import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { createHmac } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { OssClient } from './oss.client';

/**
 * 媒体服务：
 * - 按租户分目录 objectKey = tenants/{tenantId}/...
 * - OSS_PROVIDER=aliyun 时签发 PostObject 直传凭证；否则 mock / 中转
 */
@Injectable()
export class MediaService {
  constructor(
    private readonly config: ConfigService,
    private readonly oss: OssClient,
  ) {}

  /**
   * 申请上传凭证（客户端直传 OSS）。
   * 微信小程序用 mode=post + wx.uploadFile 到 host。
   * 非 aliyun 时返回 mode=proxy，前端走服务端中转。
   */
  createUploadCredential(
    user: AuthContext,
    body: {
      filename?: string;
      mimeType?: string;
      purpose?: string;
      batchId?: string;
      count?: number;
      /** 风格样例等：拼进 objectKey，如 tenants/{tid}/promo_style_ref/{productId}/{batch}/… */
      productId?: string;
    },
  ) {
    const count = Math.min(Math.max(Number(body.count) || 1, 1), 60);
    const purpose = String(body.purpose || 'uploads').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'uploads';
    const batchSeg = body.batchId
      ? String(body.batchId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)
      : `b${Date.now().toString(36)}`;
    const productSeg = body.productId
      ? String(body.productId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)
      : '';
    // promo_style_ref：tenants/{tid}/promo_style_ref/{productId}/{batch}/…
    const keyPrefix =
      purpose === 'promo_style_ref' && productSeg
        ? `tenants/${user.tenantId}/${purpose}/${productSeg}/${batchSeg}`
        : `tenants/${user.tenantId}/${purpose}/${batchSeg}`;
    const ttl = this.config.get<number>('oss.signedUrlTtlSec') || 600;

    if (!this.oss.isAliyun()) {
      // 兼容本地：前端应改走 /api/media/upload 或 /api/products/publish/upload
      const items = [];
      for (let i = 0; i < count; i++) {
        const filename = body.filename || `img_${i}.jpg`;
        const ext = path.extname(filename) || this.extFromMime(body.mimeType) || '.jpg';
        const objectKey = `${keyPrefix}/${Date.now()}_${i}${ext}`;
        const expireAt = Date.now() + ttl * 1000;
        items.push({
          provider: 'local' as const,
          mode: 'proxy' as const,
          objectKey,
          uploadUrl: `/api/media/upload`,
          headers: { 'x-mock-auth': this.sign(objectKey, expireAt) },
          expireAt,
          publicUrl: this.oss.publicUrl(objectKey),
        });
      }
      return {
        provider: 'local' as const,
        mode: 'proxy' as const,
        batchId: batchSeg,
        expireAt: items[0]?.expireAt,
        items,
      };
    }

    try {
      const items = [];
      for (let i = 0; i < count; i++) {
        const filename = body.filename || `img_${i}.jpg`;
        const ext = path.extname(filename) || this.extFromMime(body.mimeType) || '.jpg';
        const objectKey = `${keyPrefix}/${Date.now()}_${i}_${Math.random()
          .toString(36)
          .slice(2, 6)}${ext}`;
        items.push(this.oss.createPostUploadCredential(objectKey, { ttlSec: ttl }));
      }
      return {
        provider: 'aliyun' as const,
        mode: 'post' as const,
        batchId: batchSeg,
        host: items[0]?.host,
        expireAt: items[0]?.expireAt,
        items,
      };
    } catch (e: any) {
      throw new ServiceUnavailableException(String(e?.message || e) || '无法签发 OSS 凭证');
    }
  }

  /** 中转上传：落盘 + 可选 OSS，返回可展示 URL。不做商品 cover / media_assets 写入。 */
  async uploadBuffer(
    user: AuthContext,
    file: Express.Multer.File,
    purpose = 'misc',
    opts?: { productId?: string },
  ) {
    const ext = (path.extname(file.originalname || '') || '.jpg').toLowerCase();
    const safePurpose = String(purpose || 'misc').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'misc';
    if (safePurpose === 'promo_style_ref') {
      const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
      if (!allowed.includes(ext)) {
        throw new BadRequestException('风格样例仅支持 jpg/png/webp');
      }
    }
    const productSeg = opts?.productId
      ? String(opts.productId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)
      : '';
    const objectKey =
      safePurpose === 'promo_style_ref' && productSeg
        ? `tenants/${user.tenantId}/${safePurpose}/${productSeg}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`
        : `tenants/${user.tenantId}/${safePurpose}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    const abs = path.join(process.cwd(), 'storage', objectKey);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.buffer);
    const url = await this.oss.putObjectSafe(file.buffer, objectKey, file.mimetype);
    return {
      objectKey,
      url,
      provider: this.oss.mediaProvider(),
      size: file.buffer.length,
      mime: file.mimetype,
    };
  }

  signAccessUrl(user: AuthContext, objectKey: string) {
    if (!objectKey.startsWith(`tenants/${user.tenantId}/`)) {
      throw new BadRequestException('对象不属于当前租户');
    }
    return {
      url: this.oss.publicUrl(objectKey),
      expireAt: Date.now() + 600000,
    };
  }

  private extFromMime(mime?: string) {
    if (!mime) return '.jpg';
    if (mime.includes('png')) return '.png';
    if (mime.includes('webp')) return '.webp';
    if (mime.includes('gif')) return '.gif';
    return '.jpg';
  }

  private sign(objectKey: string, expireAt: number) {
    const secret = this.config.get<string>('jwt.secret') || 'dev';
    return createHmac('sha256', secret).update(`${objectKey}:${expireAt}`).digest('hex').slice(0, 32);
  }

  private hmacSecret() {
    return this.config.get<string>('jwt.secret') || process.env.JWT_SECRET || 'dev';
  }

  /** 自有 OSS / 本站域名：小程序 downloadFile 已白名单，可直链播放 */
  isAlreadyPlayableHost(url: string): boolean {
    try {
      const host = new URL(url).host.toLowerCase();
      const appBase = String(process.env.APP_BASE_URL || this.config.get<string>('app.baseUrl') || '')
        .trim()
        .replace(/\/$/, '');
      if (appBase) {
        const appHost = new URL(appBase.startsWith('http') ? appBase : `https://${appBase}`).host.toLowerCase();
        if (host === appHost) return true;
      }
      // 业务自有桶（mp downloadFile 已配 xy-tradex 深圳）
      if (host === 'xy-tradex.oss-cn-shenzhen.aliyuncs.com') return true;
      if (host.endsWith('.oss-cn-shenzhen.aliyuncs.com') && host.startsWith('xy-tradex.')) return true;
      return false;
    } catch {
      return false;
    }
  }

  /**
   * 外部视频同域 HMAC 中转 URL（应急保留；默认播放已改回上游直链）。
   * 不落盘、不转存自有 OSS。正常路径不再由 itemPlayUrl 调用。
   */
  buildExternalPlayUrl(upstreamUrl: string, ttlSec = 6 * 3600): string {
    const u = String(upstreamUrl || '').trim();
    if (!/^https?:\/\//i.test(u)) {
      throw new BadRequestException('external play url 无效');
    }
    if (this.isAlreadyPlayableHost(u)) return u;
    const exp = Math.floor(Date.now() / 1000) + Math.max(300, ttlSec);
    const sig = createHmac('sha256', this.hmacSecret())
      .update(`extplay:${u}:${exp}`)
      .digest('hex')
      .slice(0, 32);
    const appBase = String(process.env.APP_BASE_URL || this.config.get<string>('app.baseUrl') || '')
      .trim()
      .replace(/\/$/, '') || '';
    const q = `u=${encodeURIComponent(u)}&e=${exp}&s=${sig}`;
    if (appBase) return `${appBase}/api/media/external-play?${q}`;
    return `/api/media/external-play?${q}`;
  }

  /** 校验 HMAC 并返回上游 URL；过期/篡改抛错 */
  verifyExternalPlayToken(u: string, e: string | number, s: string): string {
    const url = String(u || '').trim();
    const exp = Number(e);
    const sig = String(s || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new BadRequestException('无效地址');
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000) - 30) {
      throw new BadRequestException('播放链接已过期');
    }
    if (!/^[a-f0-9]{32}$/i.test(sig)) throw new BadRequestException('签名无效');
    const expect = createHmac('sha256', this.hmacSecret())
      .update(`extplay:${url}:${exp}`)
      .digest('hex')
      .slice(0, 32);
    if (expect !== sig) throw new BadRequestException('签名无效');
    return url;
  }
}
