import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Readable } from 'stream';
import { MediaService } from './media.service';

/**
 * 外部视频同域中转（无 JWT：<video src> 无法带 Authorization）。
 * 用 HMAC 查询参数鉴权；上游 URL 仍存 DB，不转存自有 OSS。
 */
@Controller('api/media')
export class MediaExternalPlayController {
  constructor(private readonly mediaService: MediaService) {}

  @Get('external-play')
  async externalPlay(
    @Query('u') u: string,
    @Query('e') e: string,
    @Query('s') s: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    let upstream: string;
    try {
      upstream = this.mediaService.verifyExternalPlayToken(u, e, s);
    } catch (err: any) {
      throw err instanceof BadRequestException
        ? err
        : new BadRequestException(String(err?.message || err));
    }

    const headers: Record<string, string> = {
      'User-Agent': 'xingma-wool-media-proxy/1',
      Accept: '*/*',
    };
    const range = req.headers.range;
    if (range) headers.Range = String(range);

    let upstreamRes: globalThis.Response;
    try {
      upstreamRes = await fetch(upstream, { headers, redirect: 'follow' });
    } catch (err: any) {
      throw new ServiceUnavailableException(
        `上游视频不可达: ${String(err?.message || err).slice(0, 120)}`,
      );
    }

    if (!(upstreamRes.ok || upstreamRes.status === 206)) {
      const t = await upstreamRes.text().catch(() => '');
      throw new ServiceUnavailableException(
        `上游视频 HTTP ${upstreamRes.status}: ${t.slice(0, 120)}`,
      );
    }

    res.status(upstreamRes.status);
    const pass = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'cache-control',
      'etag',
      'last-modified',
    ];
    for (const h of pass) {
      const v = upstreamRes.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!res.getHeader('content-type')) {
      res.setHeader('Content-Type', 'video/mp4');
    }
    if (!res.getHeader('accept-ranges') && !range) {
      res.setHeader('Accept-Ranges', 'bytes');
    }
    // 避免 CDN/浏览器过度缓存过期签名路径
    if (!res.getHeader('cache-control')) {
      res.setHeader('Cache-Control', 'private, max-age=300');
    }

    if (!upstreamRes.body) {
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      res.end(buf);
      return;
    }

    const nodeStream = Readable.fromWeb(upstreamRes.body as any);
    nodeStream.on('error', () => {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    });
    nodeStream.pipe(res);
  }
}
