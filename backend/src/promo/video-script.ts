/**
 * 档口宣传视频：短分镜脚本（中文，≤15s 单段）。
 * 吸收 beat 流思路；不克隆 novel-* 全链路。
 * 默认规则草稿（即时）；mode=polish 才走 VISION LLM。
 * beats 为可编辑结构化列表，前端可改秒数/文案并回写 script/promptEn。
 */
import { Logger } from '@nestjs/common';
import { VisionClient } from '../vision/vision.client';
import { clampDuration } from './lkb-video.client';
import { findTemplate, isVideoTemplate, MODELS } from './promo.templates';

export interface VideoBeat {
  /** 该段镜头描述（中文） */
  text: string;
  /** 该段建议时长（秒） */
  seconds: number;
}

export interface VideoScriptDraft {
  /** 业主可编辑的中文分镜脚本（由 beats 同步拼出，也可整段改） */
  script: string;
  /** 可编辑分镜列表 */
  beats: VideoBeat[];
  seconds: number;
  /** 给 xytoken 兜底的英文镜头描述 */
  promptEn: string;
  via: 'llm' | 'heuristic';
}

const log = new Logger('VideoScript');

const SYSTEM_HINT = `你是针织衫/羊毛衫档口短视频编导。为 9:16 竖屏「商品宣传短视频」写「单段」中文分镜脚本。
硬性约束：
- 内容只能是商品本身的宣传展示（挂拍/平铺/模特上身试穿/细节特写），禁止动画、二次元、动漫、短剧、网剧、影视剧情、叙事高潮、打斗、穿越、玄幻等非商品内容。
- 总时长 8～12 秒（默认 10），只写一个连续镜头段，不要多镜头拼接方案。
- 成衣外观必须忠于商品参考图：颜色、织纹、领型、袖型、版型不变，禁止改款。
- 按模板决定是否出真人：若模板/用户要求有模特则写真人出镜动作；静物模板则挂拍/平铺/细节，不出真人。
- 不要出现任何屏幕文字、logo、水印、字幕字样。
- 语气口语、档口能改：卖点自然融入镜头动作，不要硬广口号堆砌。

只返回 JSON（无 markdown）：
{"seconds":10,"beats":[{"text":"起幅…","seconds":2},{"text":"中段…","seconds":5},{"text":"收幅…","seconds":3}],"script":"连贯中文分镜（可含秒数标注）","promptEn":"one English paragraph for video model"}
beats 2～5 条，每条含 text+seconds，seconds 之和≈总时长；script 80～220 字；promptEn ≤ 400 字符。`;

function normalizeBeats(raw: unknown, totalSeconds: number): VideoBeat[] {
  const seconds = clampDuration(totalSeconds);
  if (!Array.isArray(raw) || !raw.length) return [];
  const out: VideoBeat[] = [];
  for (const b of raw) {
    if (b == null) continue;
    if (typeof b === 'string') {
      const text = String(b).trim();
      if (!text) continue;
      // 尝试从「0–2s：…」解析秒数
      const m = text.match(/^(\d+)\s*[–\-~～到至]\s*(\d+)\s*s?[：:．.\s]/i);
      let sec = 0;
      let body = text;
      if (m) {
        sec = Math.max(1, Number(m[2]) - Number(m[1]));
        body = text.slice(m[0].length).trim() || text;
      } else {
        const m2 = text.match(/^(\d+)\s*s?[：:．.\s]/i);
        if (m2) {
          sec = Math.max(1, Number(m2[1]));
          body = text.slice(m2[0].length).trim() || text;
        }
      }
      out.push({ text: body.slice(0, 200), seconds: sec || 0 });
      continue;
    }
    if (typeof b === 'object') {
      const text = String((b as any).text || (b as any).script || (b as any).desc || '').trim();
      const sec = Math.max(0, Math.round(Number((b as any).seconds ?? (b as any).duration ?? 0) || 0));
      if (!text) continue;
      out.push({ text: text.slice(0, 200), seconds: sec });
    }
  }
  if (!out.length) return [];
  // 若未标秒数，均分
  const missing = out.every((x) => !x.seconds);
  if (missing) {
    const each = Math.max(1, Math.floor(seconds / out.length));
    let left = seconds;
    out.forEach((x, i) => {
      x.seconds = i === out.length - 1 ? Math.max(1, left) : each;
      left -= x.seconds;
    });
  } else {
    // 补齐 0
    out.forEach((x) => {
      if (!x.seconds) x.seconds = 1;
    });
  }
  return out.slice(0, 6);
}

/** 由 beats 拼中文脚本 + 英文 prompt */
export function syncScriptFromBeats(opts: {
  beats: VideoBeat[];
  seconds?: number;
  sellingPoint?: string;
  feature?: string;
  withPerson?: boolean;
  templateId?: string;
}): { script: string; promptEn: string; seconds: number; beats: VideoBeat[] } {
  const beats = normalizeBeats(opts.beats, opts.seconds || 10);
  const sum = beats.reduce((a, b) => a + (b.seconds || 0), 0) || clampDuration(opts.seconds || 10);
  const seconds = clampDuration(sum || opts.seconds || 10);
  const sell = String(opts.sellingPoint || '').trim();
  const withPerson = !!opts.withPerson;
  let t = 0;
  const lines = beats.map((b) => {
    const start = t;
    t += b.seconds;
    return `${start}–${t}s：${b.text}`;
  });
  const script = [
    `【${seconds}秒·竖屏${withPerson ? '穿搭' : '商品展示'}】`,
    ...lines,
    sell ? `卖点：${sell}。` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const promptEn = [
    `Vertical 9:16 ${seconds}s knitwear ${withPerson ? 'lifestyle fashion' : 'product showcase'} video, photoreal.`,
    ...beats.map((b) => `(${b.seconds}s) ${b.text}`),
    'Keep garment faithful to reference: same color, knit texture, neckline, sleeves, cut; do not redesign.',
    withPerson ? 'Natural person on camera as described; realistic motion.' : 'No people/models on camera.',
    'No on-screen text, logos or watermarks.',
    sell ? `Highlight: ${sell}.` : opts.feature ? `Merchant notes: ${String(opts.feature).slice(0, 160)}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { script: script.slice(0, 1200), promptEn: promptEn.slice(0, 800), seconds, beats };
}

function templateWantsPerson(templateId?: string): boolean {
  if (!templateId) return false;
  const t = findTemplate(templateId);
  if (!t || !isVideoTemplate(t)) return false;
  return t.model === 'optional' || t.model === 'required';
}

function heuristicDraft(opts: {
  feature?: string;
  sellingPoint?: string;
  seconds: number;
  templateId?: string;
  modelId?: string | null;
  withPerson?: boolean;
}): VideoScriptDraft {
  const seconds = clampDuration(opts.seconds);
  const sell = String(opts.sellingPoint || '').trim();
  const feature = String(opts.feature || '').trim();
  const sellBit = sell || pickFeatureLine(feature) || '针织质感与版型';
  const withPerson = opts.withPerson ?? templateWantsPerson(opts.templateId);
  const model = opts.modelId ? MODELS.find((m) => m.id === opts.modelId) : null;
  const midEnd = Math.max(3, seconds - 3);
  let beats: VideoBeat[];
  if (opts.templateId === 'multi_color_outfit_video') {
    beats = [
      { text: `成衣首色全貌入画，缓慢推进，突出${sellBit}`, seconds: 2 },
      { text: '平滑过渡到下一颜色，版型与织纹保持一致，仅颜色变化', seconds: Math.max(3, midEnd - 2) },
      { text: '回到干净全貌收幅，多色印象定格', seconds: Math.max(2, seconds - midEnd) },
    ];
  } else if (opts.templateId === 'detail_macro_video') {
    beats = [
      { text: '织纹/领口特写入画，微距缓慢推进', seconds: 2 },
      { text: `镜头轻缓滑过袖口与针织纹理，突出${sellBit}`, seconds: Math.max(3, midEnd - 2) },
      { text: '拉远至局部全貌收幅，干净背景', seconds: Math.max(2, seconds - midEnd) },
    ];
  } else if (opts.templateId === 'street_walk_video' || withPerson) {
    const who = model?.name || '模特';
    beats = [
      { text: `${who}穿着成衣入画，城市街景，自然光`, seconds: 2 },
      { text: `自然走动或轻转身，带出版型与${sellBit}，镜头中近景跟随`, seconds: Math.max(3, midEnd - 2) },
      { text: '放慢收幅，成衣全貌定格，适合朋友圈/小红书', seconds: Math.max(2, seconds - midEnd) },
    ];
  } else if (opts.templateId === 'cafe_lifestyle_video') {
    const who = model?.name || '模特';
    beats = [
      { text: `${who}在窗边/咖啡馆入座，暖光，成衣全貌`, seconds: 2 },
      { text: `轻转或抬手整理，突出${sellBit}与织纹`, seconds: Math.max(3, midEnd - 2) },
      { text: '缓推近后回到生活感全貌收幅', seconds: Math.max(2, seconds - midEnd) },
    ];
  } else {
    beats = [
      { text: `成衣全貌入画，缓慢推进，突出${sellBit}`, seconds: 2 },
      { text: '轻缓环绕或微俯仰，带出织纹/领口/袖口细节', seconds: Math.max(3, midEnd - 2) },
      { text: '回到全貌收幅，干净背景，适合朋友圈/小红书', seconds: Math.max(2, seconds - midEnd) },
    ];
  }
  const synced = syncScriptFromBeats({
    beats,
    seconds,
    sellingPoint: sell,
    feature,
    withPerson,
    templateId: opts.templateId,
  });
  // heuristic 保留稍完整的 script 叙述（与旧版接近），beats 仍可编辑
  const script = withPerson
    ? [
        `【${seconds}秒·竖屏穿搭】`,
        `起幅：${beats[0].text}。`,
        `卖点：${sellBit}。`,
        `中段：${beats[1]?.text || ''}。`,
        `收幅：${beats[2]?.text || ''}。成衣颜色与版型忠于参考图；无字幕无水印。`,
      ].join('\n')
    : [
        `【${seconds}秒·竖屏商品展示】`,
        `起幅：商品参考图驱动，${beats[0].text}。`,
        `卖点：${sellBit}。`,
        `中段：${beats[1]?.text || ''}，颜色与版型保持与参考图一致。`,
        `收幅：${beats[2]?.text || ''}，无字幕无水印，不出真人模特。`,
      ].join('\n');
  return {
    script: script.slice(0, 1200),
    beats: synced.beats,
    seconds,
    promptEn: synced.promptEn,
    via: 'heuristic',
  };
}

function pickFeatureLine(feature: string): string {
  const lines = String(feature || '')
    .split(/\n|；|;/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const l of lines) {
    if (/卖点|特色|亮点|材质|版型|领|袖|厚|薄|软/.test(l)) return l.replace(/^[^：:]*[：:]/, '').slice(0, 40) || l.slice(0, 40);
  }
  return lines[0] ? lines[0].slice(0, 40) : '';
}

function parseJsonLoose(raw: string): any | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

async function llmDraft(
  vision: VisionClient,
  opts: {
    feature?: string;
    sellingPoint?: string;
    seconds: number;
    templateId?: string;
    modelId?: string | null;
    withPerson?: boolean;
  },
): Promise<VideoScriptDraft | null> {
  try {
    const withPerson = opts.withPerson ?? templateWantsPerson(opts.templateId);
    const tpl = opts.templateId ? findTemplate(opts.templateId) : null;
    const model = opts.modelId ? MODELS.find((m) => m.id === opts.modelId) : null;
    const user = [
      `目标时长约 ${opts.seconds} 秒（可在 8-12 微调，须落在 4-15）。`,
      tpl ? `模板：${tpl.name}（${tpl.id}）${withPerson ? '，需真人出镜' : '，静物不出真人'}。` : '',
      model ? `已选模特气质：${model.name} — ${model.desc}` : '',
      opts.sellingPoint ? `一句话卖点：${opts.sellingPoint}` : '',
      opts.feature ? `商品特征/资料：\n${opts.feature}` : '',
      `请输出 JSON。`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const content = await vision.chat(
      [
        { type: 'text', text: SYSTEM_HINT },
        { type: 'text', text: user },
      ],
      { maxTokens: 500, temperature: 0.35 },
    );
    const json = parseJsonLoose(content);
    if (!json) return null;
    const seconds = clampDuration(Number(json.seconds) || opts.seconds);
    const beats = normalizeBeats(json.beats, seconds);
    const script = String(json.script || '').trim();
    const promptEn = String(json.promptEn || json.prompt_en || '').trim();
    if (!script && !beats.length) return null;
    const synced = syncScriptFromBeats({
      beats: beats.length
        ? beats
        : script.split(/\n+/).map((s) => s.trim()).filter(Boolean).map((text) => ({ text, seconds: 0 })),
      seconds,
      sellingPoint: opts.sellingPoint,
      feature: opts.feature,
      withPerson,
      templateId: opts.templateId,
    });
    return {
      script: (script || synced.script).slice(0, 1200),
      beats: synced.beats,
      seconds: synced.seconds,
      promptEn: (promptEn || synced.promptEn).slice(0, 800),
      via: 'llm',
    };
  } catch (e: any) {
    log.warn(`LLM video script failed: ${String(e?.message || e).slice(0, 160)}`);
    return null;
  }
}

export async function draftVideoBeatScript(
  vision: VisionClient | null | undefined,
  opts: {
    feature?: string;
    sellingPoint?: string;
    seconds?: number;
    /** heuristic（默认，即时）| polish（可选润色，调 VISION） */
    mode?: 'heuristic' | 'polish';
    templateId?: string;
    modelId?: string | null;
  },
): Promise<VideoScriptDraft> {
  const seconds = clampDuration(Number(opts.seconds) || 10);
  const withPerson = templateWantsPerson(opts.templateId);
  const base = {
    feature: opts.feature,
    sellingPoint: opts.sellingPoint,
    seconds,
    templateId: opts.templateId,
    modelId: opts.modelId,
    withPerson,
  };
  const mode = opts.mode === 'polish' ? 'polish' : 'heuristic';
  if (mode === 'polish' && vision?.configured()) {
    const llm = await llmDraft(vision, base);
    if (llm) return llm;
  }
  return heuristicDraft(base);
}

/** 业主确认后的脚本 → 上游中文 content；无脚本则拼卖点+特征 */
export function resolveVideoPromptZh(opts: {
  script?: string;
  feature?: string;
  sellingPoint?: string;
  seconds?: number;
  templateId?: string;
  modelId?: string | null;
  beats?: VideoBeat[];
}): string {
  const script = String(opts.script || '').trim();
  if (script) return script.slice(0, 1200);
  if (opts.beats && opts.beats.length) {
    return syncScriptFromBeats({
      beats: opts.beats,
      seconds: opts.seconds,
      sellingPoint: opts.sellingPoint,
      feature: opts.feature,
      withPerson: templateWantsPerson(opts.templateId),
      templateId: opts.templateId,
    }).script;
  }
  const d = heuristicDraft({
    feature: opts.feature,
    sellingPoint: opts.sellingPoint,
    seconds: clampDuration(Number(opts.seconds) || 10),
    templateId: opts.templateId,
    modelId: opts.modelId,
  });
  return d.script;
}
