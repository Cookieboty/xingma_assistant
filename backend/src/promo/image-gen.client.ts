import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';

export interface GenRequest {
  prompt: string;
  size: string; // e.g. 1024x1024
  refs: string[]; // 本地绝对路径
}
export interface GenResult {
  buffer: Buffer;
  mime: string;
  via: string;
}

/**
 * aijws（OpenAI 兼容）生图客户端。
 * 探测结论：/v1/images/generations 同步返回 data[].b64_json（约 60-90s）；
 * /v1/images/edits 为 multipart，容易超过网关 60s 报 504。
 * generations 会忽略 image 字段；参考图需走 /v1/inputs + /v1/image/generations 异步任务（默认），失败再试 edits。
 */
@Injectable()
export class ImageGenClient {
  private readonly logger = new Logger('ImageGen');

  private get base() {
    return (process.env.IMAGE_GEN_BASE_URL || 'https://image.aijws.com/v1').replace(/\/$/, '');
  }
  private get key() {
    return process.env.IMAGE_GEN_API_KEY || '';
  }
  get model() {
    return process.env.IMAGE_GEN_MODEL || 'gpt-image-2-free';
  }
  private get timeoutMs() {
    return parseInt(process.env.IMAGE_GEN_TIMEOUT_MS || '300000', 10);
  }
  configured() {
    return !!this.key;
  }

  private isTransientGenError(msg: string) {
    const s = String(msg || '');
    return /IMAGE_TASK_UNKNOWN|HTTP 502|HTTP 503|HTTP 504|ECONNRESET|ETIMEDOUT|任务状态待确认|gateway|timeout/i.test(s);
  }

  async generate(req: GenRequest): Promise<GenResult> {
    if (!this.key) throw new Error('未配置 IMAGE_GEN_API_KEY');
    const modes = req.refs.length
      ? (process.env.IMAGE_GEN_REF_MODE || 'task,edits').split(',').map((s) => s.trim())
      : ['text'];
    const errors: string[] = [];
    const maxRounds = 2; // 瞬时 502 / IMAGE_TASK_UNKNOWN 整轮再试一次
    for (let round = 0; round < maxRounds; round++) {
      const roundErrors: string[] = [];
      for (const m of modes) {
        try {
          if (m === 'task') return await this.task(req);
          if (m === 'edits') return await this.edits(req);
          if (m === 'gen_image') return await this.generations(req, true);
          if (m === 'text') return await this.generations(req, false);
        } catch (e: any) {
          const msg = String(e?.message || e);
          roundErrors.push(`${m}: ${msg}`);
          this.logger.warn(`生图方式 ${m} 失败(round=${round + 1}): ${msg.slice(0, 160)}`);
        }
      }
      errors.push(...roundErrors);
      const transient = roundErrors.some((x) => this.isTransientGenError(x));
      if (!transient || round + 1 >= maxRounds) break;
      await new Promise((r) => setTimeout(r, 2500));
      this.logger.warn(`生图瞬时失败，整轮重试 (${round + 2}/${maxRounds})`);
    }
    throw new Error(errors.join(' | '));
  }

  /** 同步 OpenAI 接口用像素尺寸；异步任务用比例 */
  private pixel(size: string) {
    return ({ '1:1': '1024x1024', '3:4': '1024x1536', '4:3': '1536x1024' } as Record<string, string>)[size] || size;
  }

  private mimeOf(p: string) {
    const ext = path.extname(p).toLowerCase();
    return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  }

  /**
   * 原生异步任务（参考图走这里，避开同步 edits 的网关 504）：
   * inputs 上传 → quotes 报价 → image/generations 建任务 → tasks 轮询 → content 下载
   */
  private async task(req: GenRequest): Promise<GenResult> {
    const model = `image:${this.model}`;
    const files = req.refs.map((r) => {
      const buf = fs.readFileSync(r);
      return { buf, mimeType: this.mimeOf(r), sha256: createHash('sha256').update(buf).digest('hex'), sourceId: path.basename(r) };
    });
    const json = (b: any, idem?: string) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(idem ? { 'Idempotency-Key': idem } : {}) },
      body: JSON.stringify(b),
    });
    const sess = (
      await this.call('/inputs', json({ purpose: 'image-generation', items: files.map(({ buf, ...f }) => ({ ...f, size: buf.length })) }, randomUUID()))
    ).data;
    for (let i = 0; i < files.length; i++) {
      await this.call(`/inputs/${sess.id}/items/${sess.items[i].itemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': files[i].mimeType },
        body: files[i].buf,
      });
    }
    const params = { mode: 'image-to-image', size: req.size, resolution: '1K', quality: 'auto', count: 1, referenceCount: files.length };
    const quote = (await this.call('/quotes', json({ type: 'image', model, params }))).data;
    const created = (
      await this.call(
        '/image/generations',
        json({ model, prompt: req.prompt, ...params, maxAmount: quote.amount, inputSessionId: sess.id, imageInputIds: sess.items.map((x: any) => x.itemId) }, sess.requestId), // 实测：建任务的幂等键须复用输入会话的 requestId，否则 404 INPUT_NOT_FOUND
      )
    ).data;
    const taskId = created.id;
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      const t = (await this.call(`/tasks/${taskId}`, { method: 'GET' })).data;
      if (t.status === 'succeeded') {
        const res = await fetch(`${this.base}/tasks/${taskId}/content?index=0`, {
          headers: { Authorization: `Bearer ${this.key}` },
        });
        if (!res.ok) throw new Error(`下载任务结果 HTTP ${res.status}`);
        return { buffer: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') || 'image/png', via: 'task' };
      }
      if (t.status === 'failed') throw new Error(`任务失败 ${JSON.stringify(t.error)}`);
    }
    throw new Error(`任务超时 ${taskId}`);
  }

  private async edits(req: GenRequest): Promise<GenResult> {
    const fd = new FormData();
    fd.append('model', this.model);
    fd.append('prompt', req.prompt);
    fd.append('size', this.pixel(req.size));
    fd.append('n', '1');
    for (const r of req.refs) {
      const buf = fs.readFileSync(r);
      fd.append(req.refs.length > 1 ? 'image[]' : 'image', new Blob([buf], { type: this.mimeOf(r) }), path.basename(r));
    }
    return this.parse(await this.call('/images/edits', { method: 'POST', body: fd }), 'edits');
  }

  private async generations(req: GenRequest, withImage: boolean): Promise<GenResult> {
    const body: any = { model: this.model, prompt: req.prompt, size: this.pixel(req.size), n: 1 };
    if (withImage) {
      body.image = req.refs.map(
        (r) => `data:${this.mimeOf(r)};base64,${fs.readFileSync(r).toString('base64')}`,
      );
    }
    return this.parse(
      await this.call('/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      withImage ? 'generations+image' : 'generations',
    );
  }

  private async call(p: string, init: RequestInit) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.base + p, {
        ...init,
        headers: { ...(init.headers as any), Authorization: `Bearer ${this.key}` },
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
      return JSON.parse(text);
    } finally {
      clearTimeout(t);
    }
  }

  private async parse(json: any, via: string): Promise<GenResult> {
    const d = json?.data?.[0];
    if (d?.b64_json) return { buffer: Buffer.from(d.b64_json, 'base64'), mime: 'image/png', via };
    if (d?.url) {
      const r = await fetch(d.url);
      if (!r.ok) throw new Error(`下载结果失败 HTTP ${r.status}`);
      return { buffer: Buffer.from(await r.arrayBuffer()), mime: r.headers.get('content-type') || 'image/png', via };
    }
    throw new Error(`上游无图片返回: ${JSON.stringify(json).slice(0, 300)}`);
  }
}
