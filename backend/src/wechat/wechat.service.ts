import { BadGatewayException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';

export interface Code2SessionResult {
  openid: string;
  unionid?: string;
  session_key: string;
}

/** 微信小程序服务端接口：jscode2session / access_token / 订阅消息 */
@Injectable()
export class WechatService {
  private readonly logger = new Logger(WechatService.name);
  private tokenCache: { appId: string; token: string; expireAt: number } | null = null;

  async code2Session(appId: string, secret: string, code: string): Promise<Code2SessionResult> {
    const url =
      'https://api.weixin.qq.com/sns/jscode2session' +
      `?appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}` +
      `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
    let data: { openid?: string; unionid?: string; session_key?: string; errcode?: number; errmsg?: string };
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      data = (await res.json()) as typeof data;
    } catch (e) {
      this.logger.error(`jscode2session 请求失败: ${(e as Error).message}`);
      throw new BadGatewayException('调用微信登录接口失败，请稍后重试');
    }
    if (data.errcode || !data.openid) {
      this.logger.warn(`jscode2session errcode=${data.errcode} errmsg=${data.errmsg}`);
      throw new UnauthorizedException(`微信登录失败(errcode=${data.errcode ?? 'unknown'}): ${data.errmsg ?? ''}`);
    }
    return { openid: data.openid, unionid: data.unionid, session_key: data.session_key || '' };
  }

  /** 获取并缓存 access_token（客户端凭证） */
  async getAccessToken(appId: string, secret: string): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.appId === appId && this.tokenCache.expireAt > now + 60_000) {
      return this.tokenCache.token;
    }
    const url =
      'https://api.weixin.qq.com/cgi-bin/token' +
      `?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`;
    let data: { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      data = (await res.json()) as typeof data;
    } catch (e) {
      this.logger.error(`access_token 请求失败: ${(e as Error).message}`);
      throw new BadGatewayException('获取微信 access_token 失败');
    }
    if (!data.access_token) {
      this.logger.warn(`access_token errcode=${data.errcode} errmsg=${data.errmsg}`);
      throw new BadGatewayException(`微信 access_token 失败: ${data.errmsg || data.errcode}`);
    }
    this.tokenCache = {
      appId,
      token: data.access_token,
      expireAt: now + (data.expires_in || 7200) * 1000,
    };
    return data.access_token;
  }

  /**
   * 发送订阅消息。失败只打日志，不抛到业务主路径。
   * data 形如 { thing1: { value: '...' }, time2: { value: '...' } }
   */
  async sendSubscribeMessage(opts: {
    appId: string;
    secret: string;
    touser: string;
    templateId: string;
    page?: string;
    data: Record<string, { value: string }>;
    miniprogramState?: 'formal' | 'trial' | 'developer';
  }): Promise<{ ok: boolean; errcode?: number; errmsg?: string }> {
    if (!opts.templateId || !opts.touser) {
      return { ok: false, errmsg: 'missing templateId or touser' };
    }
    try {
      const token = await this.getAccessToken(opts.appId, opts.secret);
      const url = `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`;
      const body = {
        touser: opts.touser,
        template_id: opts.templateId,
        page: opts.page || '',
        data: opts.data,
        miniprogram_state: opts.miniprogramState || 'formal',
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      const data = (await res.json()) as { errcode?: number; errmsg?: string };
      if (data.errcode && data.errcode !== 0) {
        this.logger.warn(`subscribe send errcode=${data.errcode} errmsg=${data.errmsg}`);
        return { ok: false, errcode: data.errcode, errmsg: data.errmsg };
      }
      return { ok: true };
    } catch (e) {
      this.logger.warn(`subscribe send failed: ${(e as Error).message}`);
      return { ok: false, errmsg: (e as Error).message };
    }
  }

  /**
   * 生成小程序码（无限量）。scene ≤32 字节；成功返回 PNG buffer。
   * page 须为已发布页面路径（无前导 /）；开发期可 checkPath=false。
   */
  async getWxaCodeUnlimited(opts: {
    appId: string;
    secret: string;
    scene: string;
    page?: string;
    checkPath?: boolean;
    envVersion?: 'release' | 'trial' | 'develop';
    width?: number;
  }): Promise<Buffer> {
    const scene = String(opts.scene || '').slice(0, 32);
    if (!scene) throw new BadGatewayException('scene 不能为空');
    const token = await this.getAccessToken(opts.appId, opts.secret);
    const url = `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${token}`;
    const body = {
      scene,
      page: opts.page || undefined,
      check_path: opts.checkPath !== false,
      env_version: opts.envVersion || 'release',
      width: opts.width || 430,
    };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      const buf = Buffer.from(await res.arrayBuffer());
      if (ct.includes('application/json') || buf[0] === 0x7b) {
        let data: { errcode?: number; errmsg?: string } = {};
        try {
          data = JSON.parse(buf.toString('utf8'));
        } catch {
          /* */
        }
        this.logger.warn(`wxacode errcode=${data.errcode} errmsg=${data.errmsg}`);
        throw new BadGatewayException(`生成小程序码失败: ${data.errmsg || data.errcode || 'unknown'}`);
      }
      return buf;
    } catch (e) {
      if (e instanceof BadGatewayException) throw e;
      this.logger.error(`wxacode 请求失败: ${(e as Error).message}`);
      throw new BadGatewayException('生成小程序码失败，请稍后重试');
    }
  }

}
