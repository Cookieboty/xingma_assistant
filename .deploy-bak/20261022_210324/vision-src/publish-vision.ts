import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { VisionClient, VisionContentPart } from './vision.client';

const logger = new Logger('PublishVision');

export interface VisionTitleResult {
  title: string;
  subtitle?: string;
  via: 'vision' | 'fallback';
  reason: string;
}

export interface VisionColorsResult {
  colors: string[];
  via: 'vision' | 'none';
  reason: string;
}

function parseJsonLoose(text: string): any {
  const t = (text || '').trim();
  if (!t) throw new Error('空响应');
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : t;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`无 JSON: ${t.slice(0, 120)}`);
  return JSON.parse(raw.slice(start, end + 1));
}

function sanitizeTitle(raw: string): string {
  let t = String(raw || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/["""'']/g, '')
    .replace(/\s+/g, '')
    .trim();
  // 去掉常见无用前后缀
  t = t.replace(/^(标题|商品名|款式)[：:]\s*/i, '');
  if (t.length > 24) t = t.slice(0, 24);
  return t;
}

function sanitizeSubtitle(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let t = String(raw)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t === 'null' || t === '无') return undefined;
  if (t.length > 40) t = t.slice(0, 40);
  return t;
}

function normalizeVisionColors(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    let c = String(item || '')
      .replace(/\s+/g, '')
      .trim();
    if (!c || /^色\d+$/.test(c)) continue;
    if (c === '黑') c = '黑色';
    if (c === '白') c = '白色';
    if (c === '灰') c = '灰色';
    // 限制长度，避免模型胡写长句
    if (c.length > 8) continue;
    if (!/[\u4e00-\u9fff]/.test(c)) continue;
    if (!out.includes(c)) out.push(c);
  }
  return out.slice(0, 12);
}

/**
 * 根据主图生成中文商品标题（款式描述），可附副标题。
 * 失败时返回兜底标题，保证非空。
 */
export async function generateProductTitle(
  vision: VisionClient,
  localPath: string,
  opts?: { styleNo?: string },
): Promise<VisionTitleResult> {
  const fallback = opts?.styleNo
    ? `款号 ${opts.styleNo}`
    : '针织上衣';
  if (!localPath || !fs.existsSync(localPath)) {
    return { title: fallback, via: 'fallback', reason: '主图不存在' };
  }
  if (!vision.configured()) {
    return { title: fallback, via: 'fallback', reason: '未配置 VISION_API_KEY' };
  }
  try {
    const parts: VisionContentPart[] = [
      {
        type: 'text',
        text: `你是羊毛衫档口电商助手。根据这张成衣主图，写一条中文商品标题（款式描述）。
要求：
- title：8～16 个汉字，描述领型/袖长/版型/面料观感，例如「圆领短袖净色针织」「半高领宽松绞花毛衣」
- 不要写品牌、价格、尺码、颜色枚举、营销词（爆款/新款/包邮）
- 不要空 title
- subtitle 可选：一句补充材质或细节（≤20字），没有则 null
只回一行 JSON：{"title":"圆领短袖净色针织","subtitle":null}`,
      },
      {
        type: 'image_url',
        image_url: { url: vision.fileToDataUrl(localPath) },
      },
    ];
    const content = await vision.chat(parts, { maxTokens: 200, temperature: 0.2 });
    const parsed = parseJsonLoose(content);
    const title = sanitizeTitle(parsed.title);
    const subtitle = sanitizeSubtitle(parsed.subtitle);
    if (!title) {
      return { title: fallback, via: 'fallback', reason: 'vision 标题为空' };
    }
    return {
      title,
      subtitle,
      via: 'vision',
      reason: subtitle ? `vision+副标题` : 'vision',
    };
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 120);
    logger.warn(`生成标题失败: ${msg}`);
    return { title: fallback, via: 'fallback', reason: `vision失败: ${msg}` };
  }
}

/**
 * 从主图/多色挂拍估主色名列表（中文常见色名）。
 */
export async function estimateGarmentColors(
  vision: VisionClient,
  localPaths: string[],
): Promise<VisionColorsResult> {
  const paths = (localPaths || []).filter((p) => p && fs.existsSync(p)).slice(0, 4);
  if (!paths.length) {
    return { colors: [], via: 'none', reason: '无可用图片' };
  }
  if (!vision.configured()) {
    return { colors: [], via: 'none', reason: '未配置 VISION_API_KEY' };
  }
  try {
    const parts: VisionContentPart[] = [
      {
        type: 'text',
        text: `你是羊毛衫档口助手。根据图中成衣，列出可见的主色名称（中文）。
规则：
- colors：字符串数组，用档口常见色名（如黑色、米白、驼色、花灰、酒红、军绿），1～8 个
- 多色挂拍图请列出每件可见颜色；单色主图只列主色
- 不要「色1」占位，不要英文，不要材质/款式词
只回一行 JSON：{"colors":["黑色","米白","驼色"]}`,
      },
    ];
    for (let i = 0; i < paths.length; i++) {
      parts.push({
        type: 'text',
        text: `image_${i} file=${path.basename(paths[i])}`,
      });
      parts.push({
        type: 'image_url',
        image_url: { url: vision.fileToDataUrl(paths[i]) },
      });
    }
    const content = await vision.chat(parts, { maxTokens: 300, temperature: 0 });
    const parsed = parseJsonLoose(content);
    const colors = normalizeVisionColors(parsed.colors);
    if (!colors.length) {
      return { colors: [], via: 'none', reason: 'vision 未返回有效色名' };
    }
    return { colors, via: 'vision', reason: `vision 估色 ${colors.length} 个` };
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 120);
    logger.warn(`估色失败: ${msg}`);
    return { colors: [], via: 'none', reason: `vision失败: ${msg}` };
  }
}

/** 是否弱标题（需 vision 补全） */
export function isWeakProductTitle(name: string | null | undefined): boolean {
  const n = String(name || '').trim();
  if (!n) return true;
  if (n === '新款羊毛衫' || n === '未命名' || n === '针织上衣') return true;
  if (/^款号\s*\S+$/.test(n)) return true;
  return false;
}

/** 是否仅占位色名 */
export function isPlaceholderColorList(colors: string[] | null | undefined): boolean {
  const list = colors || [];
  if (!list.length) return true;
  return list.every((c) => !c || /^色\d+$/.test(c));
}

/** 无款号时生成临时款号，便于落库；需 needReview */
export function provisionalStyleNo(batchId?: string): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}`;
  const tail = String(batchId || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-4)
    .toUpperCase();
  return `V${stamp}${tail || Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}
