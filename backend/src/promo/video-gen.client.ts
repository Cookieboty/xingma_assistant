import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface VideoGenRequest {
  prompt: string;
  /** e.g. 720x1280 */
  size?: string;
  /** clip length in seconds (~15) */
  seconds?: number | string;
  /** local absolute paths for image-to-video refs (optional) */
  refs?: string[];
}

export interface VideoGenResult {
  buffer: Buffer;
  mime: string;
  via: string;
  videoId: string;
  seconds?: number;
  size?: string;
}

/**
 * xytoken OpenAI-style Videos API（Seedance）。
 * POST /v1/videos → poll GET /v1/videos/{id} → GET /v1/videos/{id}/content
 * 默认复用 VISION_*；可用 VIDEO_GEN_* 覆盖。
 */
@Injectable()
export class VideoGenClient {
  private readonly logger = new Logger('VideoGen');

  private get base() {
    return (
      process.env.VIDEO_GEN_BASE_URL ||
      process.env.VISION_BASE_URL ||
      'https://api.xytoken.xyb2b.com/v1'
    ).replace(/\/$/, '');
  }
  private get key() {
    return process.env.VIDEO_GEN_API_KEY || process.env.VISION_API_KEY || '';
  }
  get model() {
    return process.env.VIDEO_GEN_MODEL || 'doubao-seedance-2-5-260628';
  }
  get defaultSeconds() {
    return parseInt(process.env.VIDEO_GEN_SECONDS || '15', 10) || 15;
  }
  get defaultSize() {
    return process.env.VIDEO_GEN_SIZE || '720x1280';
  }
  private get timeoutMs() {
    return parseInt(process.env.VIDEO_GEN_TIMEOUT_MS || '600000', 10);
  }
  private get pollMs() {
    return Math.max(2000, parseInt(process.env.VIDEO_GEN_POLL_MS || '5000', 10));
  }
  configured() {
    return !!this.key;
  }

  async generate(req: VideoGenRequest): Promise<VideoGenResult> {
    if (!this.key) throw new Error('未配置 VIDEO_GEN_API_KEY / VISION_API_KEY');
    const size = req.size || this.defaultSize;
    const seconds = String(req.seconds ?? this.defaultSeconds);
    const refs = (req.refs || []).filter((p) => p && fs.existsSync(p));
    const prompt = String(req.prompt || '').trim();
    if (!prompt) throw new Error('视频 prompt 为空');

    let created: any;
    const errors: string[] = [];
    // 优先 multipart（文件引用稳）；失败再试 JSON data URL
    try {
      created = await this.createMultipart({ prompt, model: this.model, seconds, size, refs });
    } catch (e: any) {
      errors.push(`multipart: ${e.message}`);
      this.logger.warn(`videos.create multipart fail: ${e.message}`);
      try {
        created = await this.createJson({ prompt, model: this.model, seconds, size, refs });
      } catch (e2: any) {
        errors.push(`json: ${e2.message}`);
        throw new Error(errors.join(' | '));
      }
    }

    const videoId = String(created?.id || created?.task_id || created?.data?.id || '');
    if (!videoId) throw new Error(`建视频任务无 id: ${JSON.stringify(created).slice(0, 300)}`);

    const meta = await this.poll(videoId);
    const downloaded = await this.downloadContent(videoId);
    return {
      buffer: downloaded.buffer,
      mime: downloaded.mime,
      via: 'xytoken-videos',
      videoId,
      seconds: Number(meta?.seconds) || Number(seconds) || undefined,
      size: String(meta?.size || size),
    };
  }

  private mimeOf(p: string) {
    const ext = path.extname(p).toLowerCase();
    return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  }

  private async createMultipart(opts: {
    prompt: string;
    model: string;
    seconds: string;
    size: string;
    refs: string[];
  }) {
    const fd = new FormData();
    fd.append('model', opts.model);
    fd.append('prompt', opts.prompt);
    fd.append('seconds', opts.seconds);
    fd.append('size', opts.size);
    // Seedance / OpenAI-compat：重复 input_reference；最多取前 4 张控成本
    for (const r of opts.refs.slice(0, 4)) {
      const buf = fs.readFileSync(r);
      fd.append('input_reference', new Blob([buf], { type: this.mimeOf(r) }), path.basename(r));
    }
    return this.callJson('/videos', { method: 'POST', body: fd }, 120_000);
  }

  private async createJson(opts: {
    prompt: string;
    model: string;
    seconds: string;
    size: string;
    refs: string[];
  }) {
    const body: any = {
      model: opts.model,
      prompt: opts.prompt,
      seconds: opts.seconds,
      size: opts.size,
    };
    if (opts.refs.length === 1) {
      const r = opts.refs[0];
      const b64 = fs.readFileSync(r).toString('base64');
      body.input_reference = { image_url: `data:${this.mimeOf(r)};base64,${b64}` };
    } else if (opts.refs.length > 1) {
      body.input_references = opts.refs.slice(0, 4).map((r) => {
        const b64 = fs.readFileSync(r).toString('base64');
        return { image_url: `data:${this.mimeOf(r)};base64,${b64}` };
      });
      // 部分网关仍要单字段：取首张
      const r0 = opts.refs[0];
      body.input_reference = {
        image_url: `data:${this.mimeOf(r0)};base64,${fs.readFileSync(r0).toString('base64')}`,
      };
    }
    return this.callJson(
      '/videos',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      120_000,
    );
  }

  private async poll(videoId: string): Promise<any> {
    const deadline = Date.now() + this.timeoutMs;
    let last: any = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.pollMs));
      last = await this.callJson(`/videos/${encodeURIComponent(videoId)}`, { method: 'GET' }, 60_000);
      const status = String(last?.status || last?.data?.status || '').toLowerCase();
      const progress = last?.progress ?? last?.data?.progress;
      this.logger.log(`video ${videoId} status=${status} progress=${progress ?? '-'}`);
      if (['completed', 'succeeded', 'success', 'done'].includes(status)) return last?.data || last;
      if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
        const err = last?.error || last?.data?.error || last;
        throw new Error(`视频任务失败: ${JSON.stringify(err).slice(0, 400)}`);
      }
    }
    throw new Error(`视频任务超时 ${videoId} last=${JSON.stringify(last).slice(0, 200)}`);
  }

  private async downloadContent(videoId: string): Promise<{ buffer: Buffer; mime: string }> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.min(this.timeoutMs, 300_000));
    try {
      const res = await fetch(`${this.base}/videos/${encodeURIComponent(videoId)}/content`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.key}` },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`下载视频 HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      const mime = res.headers.get('content-type') || 'video/mp4';
      return { buffer: Buffer.from(await res.arrayBuffer()), mime };
    } finally {
      clearTimeout(t);
    }
  }

  private async callJson(p: string, init: RequestInit, timeoutMs: number) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.key}`,
        ...((init.headers as Record<string, string>) || {}),
      };
      // FormData 由 fetch 自带 boundary，勿强行写 Content-Type
      if (init.body instanceof FormData) {
        delete headers['Content-Type'];
      }
      const res = await fetch(this.base + p, { ...init, headers, signal: ctrl.signal });
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${res.status} 非 JSON: ${text.slice(0, 200)}`);
      }
      if (!res.ok || json?.error) {
        const msg = json?.error?.message || json?.message || text.slice(0, 300);
        throw new Error(`HTTP ${res.status}: ${String(msg).slice(0, 280)}`);
      }
      return json;
    } finally {
      clearTimeout(t);
    }
  }
}
