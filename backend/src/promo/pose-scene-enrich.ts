/**
 * 将用户中文自由描述（姿势+场景+氛围）解析为英文生图片段。
 * 优先走 VISION_*（xytoken chat/completions）；失败则关键词启发式 + 原文附注。
 */
import { Logger } from '@nestjs/common';
import { VisionClient } from '../vision/vision.client';

export interface EnrichedPoseScene {
  posePrompt: string;
  scenePrompt: string;
  moodStyle: string;
  keywords: string[];
  via: 'llm' | 'heuristic';
}

const log = new Logger('PoseSceneEnrich');

const SYSTEM_HINT = `You convert Chinese fashion photo directions into English image-generation fragments for knitwear e-commerce.
Return STRICT JSON only (no markdown):
{"keywords":["..."],"pose":"...","scene":"...","moodStyle":"..."}
Rules:
- Extract ALL distinct concepts (place, posture, expression, gaze, props, fashion style, lighting, mood).
- pose: body pose + expression + gaze + framing, one flowing English phrase.
- scene: location + background + lighting, one flowing English phrase.
- moodStyle: overall aesthetic (e.g. British/English style, cozy autumn).
- Do NOT mention garment redesign, text, logos, or watermarks.
- Do NOT invent a different garment; focus on pose/scene/mood only.
- Keep each field under 220 characters.`;

/** 咖啡馆门口靠墙微眯远望英伦风 → 拆词启发式 */
const HEURISTICS: Array<{ re: RegExp; kind: 'pose' | 'scene' | 'mood'; en: string; kw: string }> = [
  { re: /咖啡(馆|厅|店)?门口|咖啡馆门|cafe\s*door/i, kind: 'scene', en: 'at a cafe entrance doorway', kw: 'cafe doorway' },
  { re: /咖啡(馆|厅|店)|cafe/i, kind: 'scene', en: 'in a cozy cafe interior with warm ambient light', kw: 'cafe' },
  { re: /靠着?墙|倚墙|lean(?:ing)?\s+on\s+(?:the\s+)?wall/i, kind: 'pose', en: 'leaning casually against a wall', kw: 'leaning on wall' },
  { re: /眼睛微眯|微眯着眼|眯眼/, kind: 'pose', en: 'eyes slightly squinted', kw: 'eyes squinted' },
  { re: /看着远方|望向远方|望远|looking\s+into\s+the\s+distance/i, kind: 'pose', en: 'looking into the distance', kw: 'looking into distance' },
  { re: /英伦|英式|british|english\s+style/i, kind: 'mood', en: 'British / English-style fashion aesthetic', kw: 'British style' },
  { re: /街拍|街头|street/, kind: 'scene', en: 'on a stylish city street', kw: 'street' },
  { re: /窗边|靠窗/, kind: 'scene', en: 'by a large window with soft side light', kw: 'by window' },
  { re: /回眸|回头看/, kind: 'pose', en: 'looking back over the shoulder', kw: 'looking back' },
  { re: /插兜|手插口袋/, kind: 'pose', en: 'hands in pockets', kw: 'hands in pockets' },
  { re: /抱臂|双手抱胸/, kind: 'pose', en: 'arms lightly crossed', kw: 'arms crossed' },
  { re: /坐着|坐姿|坐下/, kind: 'pose', en: 'sitting casually', kw: 'sitting' },
  { re: /走动|走路|漫步/, kind: 'pose', en: 'walking naturally toward camera', kw: 'walking' },
  { re: /影棚|棚拍|纯色背景/, kind: 'scene', en: 'clean seamless studio backdrop, soft even light', kw: 'studio' },
  { re: /秋日|秋天|落叶/, kind: 'scene', en: 'autumn setting with golden fallen leaves', kw: 'autumn' },
  { re: /冬日|暖光|壁炉/, kind: 'mood', en: 'warm winter coziness', kw: 'winter warm' },
  { re: /卧室|清晨/, kind: 'scene', en: 'sunlit cozy bedroom in the morning', kw: 'bedroom morning' },
  { re: /半身|近景/, kind: 'pose', en: 'waist-up close framing', kw: 'waist-up' },
  { re: /侧身/, kind: 'pose', en: 'three-quarter side angle', kw: 'side angle' },
  { re: /正面站|站立/, kind: 'pose', en: 'standing facing the camera, relaxed', kw: 'standing' },
];

function heuristicEnrich(combined: string): EnrichedPoseScene {
  const keywords: string[] = [];
  const poseBits: string[] = [];
  const sceneBits: string[] = [];
  const moodBits: string[] = [];
  for (const h of HEURISTICS) {
    if (h.re.test(combined)) {
      keywords.push(h.kw);
      if (h.kind === 'pose') poseBits.push(h.en);
      else if (h.kind === 'scene') sceneBits.push(h.en);
      else moodBits.push(h.en);
    }
  }
  // 去重保序
  const uniq = (arr: string[]) => [...new Set(arr)];
  const posePrompt =
    uniq(poseBits).join(', ') ||
    'natural fashion pose matching the merchant description';
  const scenePrompt =
    uniq(sceneBits).join(', ') ||
    'setting matching the merchant description';
  const moodStyle = uniq(moodBits).join(', ');
  // 始终附上原文意图，避免丢信息
  const appendix = `Merchant direction (Chinese, follow intent, do not render as text): ${combined}`;
  return {
    posePrompt: `${posePrompt}. ${appendix}`,
    scenePrompt: moodStyle ? `${scenePrompt}, ${moodStyle}` : scenePrompt,
    moodStyle,
    keywords: uniq(keywords),
    via: 'heuristic',
  };
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

async function llmEnrich(vision: VisionClient, combined: string): Promise<EnrichedPoseScene | null> {
  try {
    const content = await vision.chat(
      [
        { type: 'text', text: SYSTEM_HINT },
        {
          type: 'text',
          text: `Chinese direction:\n${combined}\n\nJSON:`,
        },
      ],
      { maxTokens: 350, temperature: 0.2 },
    );
    const json = parseJsonLoose(content);
    if (!json) return null;
    const pose = String(json.pose || '').trim();
    const scene = String(json.scene || '').trim();
    const moodStyle = String(json.moodStyle || json.mood || json.style || '').trim();
    const keywords = Array.isArray(json.keywords)
      ? json.keywords.map((k: any) => String(k || '').trim()).filter(Boolean).slice(0, 16)
      : [];
    if (!pose && !scene && !moodStyle) return null;
    return {
      posePrompt: pose || 'natural fashion pose',
      scenePrompt: [scene, moodStyle].filter(Boolean).join(', '),
      moodStyle,
      keywords,
      via: 'llm',
    };
  } catch (e: any) {
    log.warn(`LLM enrich failed: ${String(e?.message || e).slice(0, 160)}`);
    return null;
  }
}

/**
 * poseText / sceneText 合并解析。自定义文案优先于芯片预设写入最终 prompt。
 */
export async function enrichPoseSceneText(
  vision: VisionClient | null | undefined,
  opts: { poseText?: string; sceneText?: string },
): Promise<EnrichedPoseScene | null> {
  const poseText = String(opts.poseText || '').trim();
  const sceneText = String(opts.sceneText || '').trim();
  if (!poseText && !sceneText) return null;

  const combined =
    poseText && sceneText && poseText !== sceneText
      ? `${poseText}；${sceneText}`
      : poseText || sceneText;

  if (vision?.configured()) {
    const llm = await llmEnrich(vision, combined);
    if (llm) return llm;
  }
  return heuristicEnrich(combined);
}
