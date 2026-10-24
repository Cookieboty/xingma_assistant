/**
 * 风格样例轻量识图：抽出可编辑中文关键词（场景/有无模特/景别/氛围/背景）。
 * Vision 未配置或失败 → 空关键词，仍可仅凭图片生图。
 */
import { Logger } from '@nestjs/common';
import { VisionClient, VisionContentPart } from '../vision/vision.client';

export interface StyleKeywordsZh {
  scene: string;
  hasPerson: boolean | null;
  personVibe: string;
  shotType: string;
  mood: string;
  background: string;
  /** 扁平标签，便于芯片展示 */
  keywords: string[];
  /** 建议模特 id（MODELS），可空 */
  suggestedModelId?: string | null;
  /** 合并成一句中文软提示 */
  promptZh: string;
  via: 'llm' | 'empty';
}

const log = new Logger('StyleRefAnalyze');

const SYSTEM = `你是电商宣传图风格分析助手。根据「风格样例」图片，提取可编辑的中文关键词，供用户改后再生图。
只描述构图/光影/氛围/景别/场景/是否有人，不要描述衣服款式颜色（衣服以商品图为准）。
返回严格 JSON（无 markdown）：
{
  "scene": "场景短词，如咖啡馆窗边",
  "hasPerson": true/false,
  "personVibe": "有人时：性别年龄气质，如亚洲女22-28清爽；无人则空串",
  "shotType": "半身/全身/平铺/特写/对镜 等",
  "mood": "氛围，如暖调胶片感",
  "background": "背景简述",
  "keywords": ["标签1","标签2"],
  "suggestedModelId": "f_young|f_mature|f_mom|m_young|m_mature|null"
}
规则：keywords 最多 12 个中文短词；不要品牌/logo/人脸身份；suggestedModelId 仅在 hasPerson=true 时填。`;

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

function emptyKeywords(): StyleKeywordsZh {
  return {
    scene: '',
    hasPerson: null,
    personVibe: '',
    shotType: '',
    mood: '',
    background: '',
    keywords: [],
    suggestedModelId: null,
    promptZh: '',
    via: 'empty',
  };
}

function normalize(json: any): StyleKeywordsZh {
  const scene = String(json?.scene || '').trim().slice(0, 40);
  const hasPerson =
    typeof json?.hasPerson === 'boolean'
      ? json.hasPerson
      : json?.hasPerson == null
        ? null
        : !!json.hasPerson;
  const personVibe = String(json?.personVibe || '').trim().slice(0, 40);
  const shotType = String(json?.shotType || '').trim().slice(0, 20);
  const mood = String(json?.mood || '').trim().slice(0, 40);
  const background = String(json?.background || '').trim().slice(0, 40);
  const keywords = Array.isArray(json?.keywords)
    ? json.keywords.map((k: any) => String(k || '').trim()).filter(Boolean).slice(0, 12)
    : [];
  const rawModel = String(json?.suggestedModelId || '').trim();
  const allowed = new Set(['f_young', 'f_mature', 'f_mom', 'm_young', 'm_mature']);
  const suggestedModelId = hasPerson && allowed.has(rawModel) ? rawModel : null;
  const parts = [
    scene && `场景:${scene}`,
    hasPerson === true ? '有模特' : hasPerson === false ? '无人' : '',
    personVibe && `人物:${personVibe}`,
    shotType && `景别:${shotType}`,
    mood && `氛围:${mood}`,
    background && `背景:${background}`,
    ...keywords,
  ].filter(Boolean);
  return {
    scene,
    hasPerson,
    personVibe,
    shotType,
    mood,
    background,
    keywords,
    suggestedModelId,
    promptZh: parts.join('；').slice(0, 500),
    via: 'llm',
  };
}

/**
 * @param localPaths 风格样例本地路径（已 ensureLocal）
 */
export async function analyzeStyleRefs(
  vision: VisionClient | null | undefined,
  localPaths: string[],
): Promise<StyleKeywordsZh> {
  const paths = (localPaths || []).filter(Boolean).slice(0, 4);
  if (!paths.length) return emptyKeywords();
  if (!vision?.configured()) {
    log.warn('style-ref analyze skip: VISION 未配置');
    return emptyKeywords();
  }
  try {
    const parts: VisionContentPart[] = [{ type: 'text', text: SYSTEM }];
    for (const p of paths) {
      try {
        parts.push({
          type: 'image_url',
          image_url: { url: vision.fileToDataUrl(p, 768, 70) },
        });
      } catch (e: any) {
        log.warn(`style-ref read fail: ${String(e?.message || e).slice(0, 80)}`);
      }
    }
    parts.push({
      type: 'text',
      text: `共 ${paths.length} 张风格样例。请综合提取关键词 JSON：`,
    });
    if (parts.length < 3) return emptyKeywords();
    const content = await vision.chat(parts, { maxTokens: 400, temperature: 0.1 });
    const json = parseJsonLoose(content);
    if (!json) {
      log.warn('style-ref analyze: JSON 解析失败');
      return emptyKeywords();
    }
    return normalize(json);
  } catch (e: any) {
    log.warn(`style-ref analyze fail: ${String(e?.message || e).slice(0, 160)}`);
    return emptyKeywords();
  }
}

/** 把用户编辑后的关键词结构 / 自由文本压成中文软提示（留痕） */
export function styleKeywordsToPromptZh(
  kw?: Partial<StyleKeywordsZh> | null,
  freeText?: string,
): string {
  const free = String(freeText || '').trim();
  if (free) return free.slice(0, 500);
  if (!kw) return '';
  if (kw.promptZh) return String(kw.promptZh).slice(0, 500);
  const parts = [
    kw.scene && `场景:${kw.scene}`,
    kw.hasPerson === true ? '有模特' : kw.hasPerson === false ? '无人' : '',
    kw.personVibe && `人物:${kw.personVibe}`,
    kw.shotType && `景别:${kw.shotType}`,
    kw.mood && `氛围:${kw.mood}`,
    kw.background && `背景:${kw.background}`,
    ...(Array.isArray(kw.keywords) ? kw.keywords : []),
  ].filter(Boolean);
  return parts.join('；').slice(0, 500);
}
