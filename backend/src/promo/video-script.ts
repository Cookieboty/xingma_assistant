/**
 * 档口宣传视频：短分镜脚本（中文，≤15s 单段）。
 * 吸收 beat 流思路；不克隆 novel-* 全链路。优先 VISION chat；失败启发式。
 */
import { Logger } from '@nestjs/common';
import { VisionClient } from '../vision/vision.client';
import { clampDuration } from './lkb-video.client';

export interface VideoScriptDraft {
  /** 业主可编辑的中文分镜脚本（整段） */
  script: string;
  /** 分镜要点（便于 UI 展示） */
  beats: string[];
  seconds: number;
  /** 给 xytoken 兜底的英文镜头描述 */
  promptEn: string;
  via: 'llm' | 'heuristic';
}

const log = new Logger('VideoScript');

const SYSTEM_HINT = `你是针织衫/羊毛衫档口短视频编导。为 9:16 竖屏电商短视频写「单段」中文分镜脚本。
硬性约束：
- 总时长 8～12 秒（默认 10），只写一个连续镜头段，不要多镜头拼接方案。
- 成衣外观必须忠于商品参考图：颜色、织纹、领型、袖型、版型不变，禁止改款。
- 一期不出真人模特出镜；可写挂拍/平铺/细节推进、轻缓运镜。
- 不要出现任何屏幕文字、logo、水印、字幕字样。
- 语气口语、档口能改：卖点自然融入镜头动作，不要硬广口号堆砌。

只返回 JSON（无 markdown）：
{"seconds":10,"beats":["起幅…","中段…","收幅…"],"script":"连贯中文分镜（可含秒数标注）","promptEn":"one English paragraph for video model"}
beats 2～4 条；script 80～220 字；promptEn ≤ 400 字符。`;

function heuristicDraft(opts: {
  feature?: string;
  sellingPoint?: string;
  seconds: number;
}): VideoScriptDraft {
  const seconds = clampDuration(opts.seconds);
  const sell = String(opts.sellingPoint || '').trim();
  const feature = String(opts.feature || '').trim();
  const sellBit = sell || pickFeatureLine(feature) || '针织质感与版型';
  const beats = [
    `0–2s：成衣全貌入画，缓慢推进，突出${sellBit}`,
    `2–${Math.max(3, seconds - 3)}s：轻缓环绕或微俯仰，带出织纹/领口/袖口细节`,
    `${Math.max(3, seconds - 3)}–${seconds}s：回到全貌收幅，干净背景，适合朋友圈/小红书`,
  ];
  const script = [
    `【${seconds}秒·竖屏商品展示】`,
    `起幅：商品参考图驱动，成衣全貌，柔和自然光，缓慢推进。`,
    `卖点：${sellBit}。`,
    `中段：镜头轻缓移动，带出针织纹理与领袖细节，颜色与版型保持与参考图一致。`,
    `收幅：回到干净全貌，无字幕无水印，不出真人模特。`,
  ].join('\n');
  const promptEn = [
    `Vertical 9:16 ${seconds}s knitwear product showcase, photoreal.`,
    `Slow cinematic push-in then gentle orbit/tilt; soft natural light; premium e-commerce look.`,
    `Keep garment faithful to reference: same color, knit texture, neckline, sleeves, cut; do not redesign.`,
    `No people/models, no on-screen text, logos or watermarks.`,
    sell ? `Highlight: ${sell}.` : feature ? `Merchant notes: ${feature.slice(0, 180)}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { script, beats, seconds, promptEn, via: 'heuristic' };
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
  opts: { feature?: string; sellingPoint?: string; seconds: number },
): Promise<VideoScriptDraft | null> {
  try {
    const user = [
      `目标时长约 ${opts.seconds} 秒（可在 8-12 微调，须落在 4-15）。`,
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
    const beats = Array.isArray(json.beats)
      ? json.beats.map((b: any) => String(b || '').trim()).filter(Boolean).slice(0, 6)
      : [];
    const script = String(json.script || '').trim();
    const promptEn = String(json.promptEn || json.prompt_en || '').trim();
    if (!script) return null;
    return {
      script: script.slice(0, 1200),
      beats: beats.length ? beats : script.split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 4),
      seconds,
      promptEn: promptEn.slice(0, 800) || heuristicDraft(opts).promptEn,
      via: 'llm',
    };
  } catch (e: any) {
    log.warn(`LLM video script failed: ${String(e?.message || e).slice(0, 160)}`);
    return null;
  }
}

export async function draftVideoBeatScript(
  vision: VisionClient | null | undefined,
  opts: { feature?: string; sellingPoint?: string; seconds?: number },
): Promise<VideoScriptDraft> {
  const seconds = clampDuration(Number(opts.seconds) || 10);
  const base = { feature: opts.feature, sellingPoint: opts.sellingPoint, seconds };
  if (vision?.configured()) {
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
}): string {
  const script = String(opts.script || '').trim();
  if (script) return script.slice(0, 1200);
  const d = heuristicDraft({
    feature: opts.feature,
    sellingPoint: opts.sellingPoint,
    seconds: clampDuration(Number(opts.seconds) || 10),
  });
  return d.script;
}
