/**
 * 按场景区分的出图模板。每个模板有自己的步骤、参考图规则、可选项与 prompt 构造器。
 * 设计说明见 docs/生图模板设计.md
 */

export type Platform = 'moments' | 'xiaohongshu';
export type PromoStep = 'reference' | 'feature' | 'script' | 'model' | 'pose' | 'scene' | 'pose_scene' | 'colors' | 'count' | 'style_keywords' | 'bgm';

export interface Option {
  id: string;
  name: string;
  /** 英文提示词片段（不出现在图上） */
  prompt: string;
}

export interface SizeOption {
  id: string;
  name: string;
  /** 请求上游的尺寸 */
  upstream: string;
  /** 产品语义尺寸 */
  target: string;
}

export interface ReferenceRule {
  /** 建议使用的图片类别 */
  prefer: Array<'main' | 'detail' | 'sku'>;
  min: number;
  max: number;
  hint: string;
}

export interface PromoModel {
  id: string;
  /** 短标签，展示用，如「25岁中国女」 */
  name: string;
  /** 短描述，展示用；不展示英文 prompt */
  desc: string;
  /** 生成注入用英文人设（不下发前端） */
  prompt: string;
  /** 小程序头像：优先公网人脸图 */
  avatar: string;
  /** 公网人脸参考图 URL（external modelImageUrl / 前端展示） */
  faceUrl: string;
  /** OSS objectKey（无 OSS_PREFIX）：presets/models/{id}.jpg */
  faceObjectKey: string;
}

export interface PromptContext {
  feature: string;
  model?: PromoModel | null;
  pose?: Option | null;
  scene?: Option | null;
  /** 用户自由描述的姿势/呈现（优先于 pose.prompt） */
  poseText?: string;
  /** 用户自由描述的场景/背景（优先于 scene.prompt） */
  sceneText?: string;
  /** 风格参考模板：用户编辑后的中文软关键词（不画进图） */
  styleKeywordsText?: string;
  colors?: string[];
  index: number;
  total: number;
}

export interface PromoTemplate {
  id: string;
  name: string;
  desc: string;
  platforms: Platform[];
  defaultSize: string;
  sizes: string[];
  /** none=不用模特；optional=可选；required=必选 */
  model: 'none' | 'optional' | 'required';
  poses: Option[];
  scenes: Option[];
  sceneLabel: string;
  reference: ReferenceRule;
  count: { min: number; max: number; default: number };
  steps: PromoStep[];
  buildPrompt: (c: PromptContext) => string;
  /** image（默认）| video：前端与 generate 分流 */
  mediaKind?: 'image' | 'video';
  /**
   * 风格样例规则。仅 style_ref 等需要样例的模板声明；缺省 = 不支持风格样例。
   */
  styleRef?: { min: number; max: number; hint: string };
  /** style_ref 模板：风格图为硬参考（构图光影），仍低于服装 KEEP */
  styleRefPrimary?: boolean;
}

export const SIZES: Record<string, SizeOption> = {
  square: { id: 'square', name: '朋友圈方图 1080×1080', upstream: '1:1', target: '1080x1080' },
  portrait: { id: 'portrait', name: '小红书竖图 1080×1440 (3:4)', upstream: '3:4', target: '1080x1440' },
  /** 竖短视频 9:16；upstream 直接给视频 API 的 WxH */
  vertical_video: { id: 'vertical_video', name: '竖短视频 720×1280 (9:16)', upstream: '720x1280', target: '720x1280' },
};

/** 预置模特人脸：OSS xingma-stall/presets/models/；提示词仅服务端注入 */
const PRESET_FACE_BASE =
  process.env.PRESET_MODEL_FACE_BASE ||
  'https://xy-tradex.oss-cn-shenzhen.aliyuncs.com/xingma-stall';

function presetFace(id: string): Pick<PromoModel, 'avatar' | 'faceUrl' | 'faceObjectKey'> {
  const faceObjectKey = `presets/models/${id}.jpg`;
  const faceUrl = `${PRESET_FACE_BASE.replace(/\/$/, '')}/${faceObjectKey}`;
  return { faceObjectKey, faceUrl, avatar: faceUrl };
}

export const MODELS: PromoModel[] = [
  {
    id: 'f_young',
    name: '25岁中国女',
    desc: '黑长直 · 清爽自然',
    prompt:
      'a natural-looking Chinese woman about 25 years old, long straight black hair, light natural makeup, slim build, East Asian facial features matching the provided face reference',
    ...presetFace('f_young'),
  },
  {
    id: 'f_fresh',
    name: '22岁中国女',
    desc: '微卷 · 清新甜美',
    prompt:
      'a fresh-faced Chinese woman about 22 years old, soft wavy black hair past the shoulders, light freckles optional, gentle closed-lip smile, youthful slim build, East Asian facial features matching the provided face reference',
    ...presetFace('f_fresh'),
  },
  {
    id: 'f_mature',
    name: '35岁中国女',
    desc: '齐肩发 · 知性温柔',
    prompt:
      'an elegant Chinese woman about 35 years old, shoulder-length dark hair, gentle confident expression, light natural makeup, East Asian facial features matching the provided face reference',
    ...presetFace('f_mature'),
  },
  {
    id: 'f_mom',
    name: '50岁中国女',
    desc: '短发 · 端庄妈妈款',
    prompt:
      'a graceful Chinese woman about 50 years old, short neat hair with soft gray strands, warm kind smile, healthy mature figure, East Asian facial features matching the provided face reference',
    ...presetFace('f_mom'),
  },
  {
    id: 'm_young',
    name: '28岁中国男',
    desc: '短发 · 干净利落',
    prompt:
      'a clean-cut Chinese man about 28 years old, short black hair, relaxed posture, natural expression, East Asian facial features matching the provided face reference',
    ...presetFace('m_young'),
  },
  {
    id: 'm_mature',
    name: '45岁中国男',
    desc: '短发 · 稳重儒雅',
    prompt:
      'a refined Chinese man about 45 years old, neat short hair with slight gray at the temples, calm and steady look, East Asian facial features matching the provided face reference',
    ...presetFace('m_mature'),
  },
];

/** 所有模板通用的约束：服装不变、不画字（颜色与参考图一致） */
const KEEP = 'The garment must stay exactly the same as in the reference image: identical color, knit stitch texture, yarn thickness, neckline, sleeve length, cut and every detail. Do not redesign, recolor or add patterns.';
/** multi_color：本张只跟「该色」参考图，颜色必须匹配该色参考，而非其它色 */
const KEEP_COLOR_VARIANT = (colorLabel?: string) =>
  `The garment must match THIS color variant's reference image exactly: knit stitch texture, yarn thickness, neckline, sleeve length, cut and every detail, and the garment COLOR must match that reference${colorLabel ? ` (${colorLabel})` : ''}. Do not redesign, add patterns, or blend colors from other variants.`;
const NO_TEXT = 'Absolutely no text, letters, watermark, logo or captions anywhere in the image.';
/** 全模板：真实相机摄影感，抑制塑料皮/蜡像脸/CGI */
const PHOTOREAL =
  'Photorealistic real-camera photograph only: natural skin with visible pores and subtle imperfections (never plastic, waxy, or airbrushed), realistic fabric knit texture, authentic lens depth of field and gentle film grain, natural lighting and color, documentary / premium e-commerce fashion photography. Not CGI, not 3D render, not illustration, not AI-looking, no unnatural glow or over-smoothed faces, no deformed hands.';
const FEATURE = (f: string) => (f ? `Garment notes (Chinese, for reference only, do not render as text): ${f}.` : '');

/** 风格样例强度：影响 STYLE_REF 段措辞；默认 medium */
export type StyleStrength = 'weak' | 'medium' | 'strong';

const STYLE_STRENGTH_LINE: Record<StyleStrength, string> = {
  weak: 'Apply style references subtly: only a light influence on lighting and mood; keep composition and camera largely driven by the template and pose/scene text.',
  medium: 'Apply style references moderately for lighting, color grading, framing and mood, while still obeying template and pose/scene instructions.',
  strong: 'Lean strongly on the style references for lighting, color grading, camera angle, framing and lifestyle mood, but never above garment KEEP or explicit pose/scene text.',
};

/**
 * 追加到 prompt 的 STYLE_REF 段。
 * 优先级写死：商品 KEEP > 模板/姿势场景文案 > 风格样例。
 * 明确禁止抄样例服装 / 人脸 / 品牌 logo / 商标。
 */
export function buildStyleRefPrompt(opts: {
  garmentRefCount: number;
  styleRefCount: number;
  strength?: StyleStrength | string | null;
  /** 风格参考专用模板：样例为构图/光影硬参考，但仍低于 KEEP */
  primary?: boolean;
}): string {
  const n = Math.max(0, Number(opts.styleRefCount) || 0);
  if (!n) return '';
  const g = Math.max(1, Number(opts.garmentRefCount) || 1);
  const raw = String(opts.strength || (opts.primary ? 'strong' : 'medium'));
  const strength: StyleStrength =
    raw === 'weak' || raw === 'strong' ? raw : 'medium';
  const primary = !!opts.primary;
  const lines = [
    `Additional style reference image(s) are provided AFTER the first ${g} garment reference image(s) (${n} style-only image(s)).`,
    primary
      ? 'These style images are the PRIMARY hard references for composition, camera framing, lighting, color grading, depth of field and lifestyle mood — match them closely.'
      : 'Use style references ONLY for lighting, color grading, camera angle, framing, depth of field and lifestyle mood.',
    'Do NOT copy clothing, garment cut, knit patterns, yarn color, faces or person identity, brand logos, trademarks, watermarks or text from the style references.',
    'If a preset model was selected, keep that model identity; never clone faces from style samples.',
    primary
      ? 'Priority when conflicting: garment KEEP (product refs) > soft keyword text > style sample composition/lighting. Never let style samples override garment identity.'
      : 'Priority when conflicting: garment KEEP > template / pose / scene text > style samples.',
    STYLE_STRENGTH_LINE[strength],
    'The knit garment must still match the garment reference exactly (KEEP).',
  ];
  return lines.join(' ');
}

/**
 * 风格样例上限（仅 style_ref 等显式声明 styleRef 的模板使用）。
 * 其它模板不再下发可选风格样例。
 */
export const STYLE_REF_RULE = {
  min: 0,
  max: 4,
  hint: '上传你喜欢的成片风格，系统尽量学构图和氛围；衣服仍以商品图为准',
};

const MODEL_SCENES: Option[] = [
  { id: 'street', name: '城市街拍', prompt: 'a stylish city street with soft-focus storefronts, overcast diffused daylight' },
  { id: 'cafe', name: '咖啡馆', prompt: 'a cozy cafe interior with wooden furniture, large window, warm ambient light' },
  { id: 'home', name: '室内温暖', prompt: 'a warm minimalist living room with a beige sofa, soft lamp light, knit blanket' },
  { id: 'autumn', name: '秋冬户外', prompt: 'an autumn park with golden fallen leaves, low warm sunlight, shallow depth of field' },
  { id: 'studio', name: '纯色影棚', prompt: 'a clean light-beige seamless studio backdrop, soft even studio lighting' },
];

const MODEL_POSES: Option[] = [
  { id: 'stand', name: '正面站立', prompt: 'standing facing the camera, relaxed arms, full upper body visible' },
  { id: 'walk', name: '自然走动', prompt: 'walking naturally toward the camera, candid mid-stride' },
  { id: 'side', name: '侧身回眸', prompt: 'three-quarter side pose looking back over the shoulder' },
  { id: 'sit', name: '坐姿', prompt: 'sitting casually, hands resting on knees, garment clearly visible' },
  { id: 'pocket', name: '手插兜/抱臂', prompt: 'one hand in pocket or arms lightly crossed, confident pose' },
  { id: 'closeup', name: '半身近景', prompt: 'waist-up close shot emphasizing neckline and knit texture' },
];

export const TEMPLATES: PromoTemplate[] = [
  {
    id: 'detail_closeup',
    name: '细节特写',
    desc: '不用模特，突出织纹、领口、袖口、颜色质感；换光线和背景',
    platforms: ['moments', 'xiaohongshu'],
    defaultSize: 'square',
    sizes: ['square', 'portrait'],
    model: 'none',
    poses: [],
    sceneLabel: '背景风格',
    scenes: [
      { id: 'wood', name: '原木桌面', prompt: 'resting on a warm natural oak wooden table' },
      { id: 'linen', name: '亚麻布', prompt: 'laid on soft oatmeal linen fabric with gentle folds' },
      { id: 'window', name: '窗边自然光', prompt: 'by a window with soft natural side light and delicate shadows' },
      { id: 'dark', name: '深色质感', prompt: 'on a dark charcoal felt surface with moody directional light' },
    ],
    reference: { prefer: ['detail', 'main'], min: 1, max: 2, hint: '选 1-2 张细节图或主图（织纹清晰的优先）' },
    count: { min: 1, max: 4, default: 1 },
    steps: ['reference', 'feature', 'pose_scene', 'count'],
    buildPrompt: (c) =>
      [
        'Macro close-up product photograph of a knitwear garment, focusing on the knit stitch texture, ribbing, neckline and cuff details.',
        (c.sceneText || c.scene?.prompt) ? `Setting: ${effectivePrompt(c.scene, c.sceneText)}.` : '',
        'Shallow depth of field, crisp texture, true-to-life color, premium e-commerce detail shot.',
        c.total > 1 ? `Variation ${c.index + 1} of ${c.total}: use a different crop / angle of the details.` : '',
        FEATURE(c.feature), KEEP, PHOTOREAL, NO_TEXT,
      ].filter(Boolean).join(' '),
  },
  {
    id: 'flatlay',
    name: '平铺 / 挂拍静物',
    desc: '不用模特，整件平铺或挂拍；极简背景或生活道具',
    platforms: ['moments', 'xiaohongshu'],
    defaultSize: 'square',
    sizes: ['square', 'portrait'],
    model: 'none',
    poses: [
      { id: 'flat', name: '平铺', prompt: 'neatly laid flat, shot from directly above' },
      { id: 'hang', name: '衣架挂拍', prompt: 'hanging on a wooden hanger against the wall' },
      { id: 'fold', name: '折叠叠放', prompt: 'neatly folded with the collar visible' },
    ],
    sceneLabel: '背景 / 道具',
    scenes: [
      { id: 'minimal', name: '极简浅色', prompt: 'on a clean off-white seamless background, minimal composition' },
      { id: 'props', name: '生活道具', prompt: 'surrounded by tasteful lifestyle props: a coffee cup, an open book, dried flowers, glasses' },
      { id: 'autumn', name: '秋冬氛围', prompt: 'with autumn leaves, pine cones and a warm scarf as props' },
      { id: 'wood', name: '原木地板', prompt: 'on light wooden floorboards with soft daylight' },
    ],
    reference: { prefer: ['main', 'detail'], min: 1, max: 4, hint: '选 1-4 张挂拍/平铺/静物主图与细节' },
    count: { min: 1, max: 4, default: 1 },
    steps: ['reference', 'feature', 'pose_scene', 'count'],
    buildPrompt: (c) =>
      [
        'Still-life e-commerce product photograph of the whole knit garment, entire garment visible, no person.',
        (c.poseText || c.pose?.prompt) ? `Presentation: ${effectivePrompt(c.pose, c.poseText)}.` : 'Presentation: neatly laid flat, shot from above.',
        (c.sceneText || c.scene?.prompt) ? `Setting: ${effectivePrompt(c.scene, c.sceneText)}.` : '',
        'Soft natural light, accurate colors, clean composition.',
        c.total > 1
          ? `Variation ${c.index + 1} of ${c.total}: rearrange props slightly and/or use a mild different camera angle; keep the same presentation style.`
          : '',
        FEATURE(c.feature), KEEP, PHOTOREAL, NO_TEXT,
      ].filter(Boolean).join(' '),
  },
  {
    id: 'model_scene',
    name: '模特上身 · 场景图',
    desc: '1 张商品图 + 1 个模特；可多选动作与场景，按动作×场景错开出图',
    platforms: ['moments', 'xiaohongshu'],
    defaultSize: 'portrait',
    sizes: ['portrait', 'square'],
    model: 'required',
    poses: MODEL_POSES,
    sceneLabel: '场景',
    scenes: MODEL_SCENES,
    reference: { prefer: ['main', 'detail'], min: 1, max: 1, hint: '只选 1 张清晰商品主图（正面整件优先）' },
    count: { min: 1, max: 6, default: 1 },
    steps: ['reference', 'feature', 'model', 'pose_scene', 'count'],
    buildPrompt: (c) =>
      [
        `Fashion lifestyle photograph: ${c.model?.prompt || 'an East Asian model'} wearing the exact knit garment from the reference image.`,
        // 多动作×场景：槽位用芯片 pose/scene；自由文案仅作补充，不覆盖错开配对
        c.pose?.prompt ? `Pose: ${c.pose.prompt}.` : '',
        c.poseText && !(c.pose?.name && c.poseText.trim() === c.pose.name)
          ? `Pose note from merchant: ${c.poseText}.`
          : '',
        c.scene?.prompt ? `Scene: ${c.scene.prompt}.` : '',
        c.sceneText && !(c.scene?.name && c.sceneText.trim() === c.scene.name)
          ? `Scene note from merchant: ${c.sceneText}.`
          : '',
        'Pair with simple neutral bottoms that do not distract. Realistic skin, natural proportions, professional e-commerce fashion photography.',
        c.total > 1
          ? `Shot ${c.index + 1} of ${c.total}: this slot's pose×scene pair must read differently from sibling slots; if the pair repeats, vary camera height/crop/gaze/hands; never clone the same frame; do not change garment.`
          : '',
        FEATURE(c.feature), KEEP, PHOTOREAL, NO_TEXT,
      ].filter(Boolean).join(' '),
  },
  {
    id: 'multi_color',
    name: '多色展示',
    desc: '同一模特同一姿势，每个颜色各生成一张上身图',
    platforms: ['moments', 'xiaohongshu'],
    defaultSize: 'square',
    sizes: ['square', 'portrait'],
    model: 'required',
    poses: MODEL_POSES,
    sceneLabel: '场景',
    scenes: MODEL_SCENES,
    reference: {
      prefer: ['sku'],
      min: 2,
      max: 6,
      hint: '每个颜色选 1 张对应主图，选几个颜色就出几张',
    },
    count: { min: 2, max: 6, default: 2 },
    steps: ['reference', 'colors', 'feature', 'model', 'pose_scene'],
    buildPrompt: (c) => {
      const colorName = (c.colors && c.colors[0]) || '';
      return [
        `Fashion e-commerce photograph: ${c.model?.prompt || 'an East Asian model'} wearing ONE color variant of the knit garment — only the ${colorName || 'selected'} color from its matching reference image.`,
        'This is a single-image shot of one color only. Do NOT collage, grid, or show multiple colors in the same frame.',
        (c.poseText || c.pose?.prompt) ? `Pose: ${effectivePrompt(c.pose, c.poseText)}.` : '',
        (c.sceneText || c.scene?.prompt) ? `Scene: ${effectivePrompt(c.scene, c.sceneText)}.` : '',
        c.total > 1
          ? `Part ${c.index + 1} of a ${c.total}-color set: keep pose, framing, camera distance, and scene identical across the set; only the garment color changes to match this variant's reference.`
          : '',
        'Pair with simple neutral bottoms that do not distract. Realistic skin, natural proportions.',
        FEATURE(c.feature),
        KEEP_COLOR_VARIANT(colorName),
        PHOTOREAL,
        NO_TEXT,
      ].filter(Boolean).join(' ');
    },
  },
  {
    id: 'xhs_cover',
    name: '小红书封面风',
    desc: '竖版 3:4，生活感、氛围感；模特可选',
    platforms: ['xiaohongshu'],
    defaultSize: 'portrait',
    sizes: ['portrait'],
    model: 'optional',
    poses: [
      { id: 'mirror', name: '对镜自拍感', prompt: 'mirror-selfie style framing, phone partially covering the face' },
      { id: 'candid', name: '抓拍感', prompt: 'candid unposed moment, slightly off-center composition' },
      { id: 'still', name: '无人氛围静物', prompt: 'no person, the garment casually draped over a chair with lifestyle props' },
      { id: 'closeup', name: '半身近景', prompt: 'waist-up close shot, soft smile' },
    ],
    sceneLabel: '氛围',
    scenes: [
      { id: 'morning', name: '清晨卧室', prompt: 'a sunlit cozy bedroom in the morning, white bedding, warm tones' },
      { id: 'cafe', name: '咖啡馆午后', prompt: 'an afternoon cafe corner with latte art and soft window light' },
      { id: 'autumn', name: '秋日街角', prompt: 'an autumn street corner with golden ginkgo leaves' },
      { id: 'winter', name: '冬日暖光', prompt: 'a winter evening with fairy lights and warm bokeh' },
    ],
    reference: { prefer: ['main'], min: 1, max: 2, hint: '选 1-2 张主图' },
    count: { min: 1, max: 4, default: 1 },
    steps: ['reference', 'feature', 'model', 'pose_scene', 'count'],
    buildPrompt: (c) => {
      const poseId = c.pose?.id || '';
      const hasModel = !!c.model;
      const poseP = effectivePrompt(c.pose, c.poseText);
      const sceneP = effectivePrompt(c.scene, c.sceneText);
      let shotLine = '';
      if (c.poseText && (!c.pose || c.pose.id === 'custom')) {
        shotLine = hasModel
          ? `Shot: ${poseP}.`
          : `Still-life / composition: ${poseP} (no person unless the description requires one).`;
      } else if (!hasModel) {
        if (poseId === 'still' || !c.pose) {
          shotLine = 'Still-life: no person; the garment casually draped or styled with lifestyle props.';
        } else {
          shotLine = 'Still-life product focus, no person in frame (ignore human-pose options).';
        }
      } else if (poseId === 'still') {
        shotLine = 'Waist-up lifestyle portrait, soft natural pose (not a empty still-life).';
      } else if (poseP) {
        shotLine = `Shot: ${poseP}.`;
      }
      return [
        'Vertical 3:4 Xiaohongshu-style lifestyle cover photo, airy film-like color grading, warm and cozy mood, eye-catching but natural.',
        hasModel
          ? `${c.model!.prompt} wears the exact knit garment from the reference.`
          : 'Feature the exact knit garment from the reference; no person.',
        shotLine,
        sceneP ? `Atmosphere: ${sceneP}.` : '',
        'Leave some clean negative space at the top (empty, no text).',
        FEATURE(c.feature), KEEP, PHOTOREAL, NO_TEXT,
      ].filter(Boolean).join(' ');
    },
  },

  {
    id: 'style_ref',
    name: '风格参考',
    desc: '照着你找的样例出图：风格样例必传；衣服仍以商品图为准；可改自动提取的关键词',
    platforms: ['moments', 'xiaohongshu'],
    defaultSize: 'portrait',
    sizes: ['portrait', 'square'],
    model: 'optional',
    poses: [],
    scenes: [],
    sceneLabel: '氛围',
    reference: { prefer: ['main', 'detail'], min: 1, max: 2, hint: '选 1-2 张商品主图/细节图（衣服保真）' },
    count: { min: 1, max: 4, default: 2 },
    steps: ['reference', 'style_keywords', 'model', 'count'],
    styleRef: {
      min: 1,
      max: 4,
      hint: '必传：上传你要照着出的成片样例（1-4 张）；衣服仍以商品图为准，不抄样例人脸/品牌',
    },
    styleRefPrimary: true,
    buildPrompt: (c) => {
      const hasModel = !!c.model;
      const kw = String(c.styleKeywordsText || '').trim();
      return [
        'Fashion e-commerce photograph matching the style reference image(s) for composition, lighting, color grading, framing and mood.',
        hasModel
          ? `${c.model!.prompt} wears the exact knit garment from the garment reference image(s).`
          : 'Feature the exact knit garment from the garment reference image(s); include a person only if the style samples clearly show one and soft keywords require it.',
        kw
          ? `Soft merchant style keywords (Chinese, follow intent for scene/mood/shot, do not render as text): ${kw}.`
          : 'Infer scene, shot type and mood primarily from the style reference image(s).',
        'Pair with simple neutral bottoms that do not distract when a model is present.',
        c.total > 1
          ? `Variation ${c.index + 1} of ${c.total}: keep the same style language; add natural micro-variation so shots are not clones.`
          : '',
        FEATURE(c.feature), KEEP, PHOTOREAL, NO_TEXT,
      ].filter(Boolean).join(' ');
    },
  },

  {
    id: 'product_showcase_video',
    name: '商品挂拍短视频',
    desc: '约 8～12 秒竖屏：静物/挂拍展示，不出真人；可多选商品图作参考',
    platforms: ['moments', 'xiaohongshu'],
    defaultSize: 'vertical_video',
    sizes: ['vertical_video'],
    model: 'none',
    poses: [],
    scenes: [],
    sceneLabel: '场景',
    reference: { prefer: ['main', 'detail'], min: 1, max: 9, hint: '选 1-9 张商品主图/细节图作为视频参考（越多细节越稳）' },
    count: { min: 1, max: 1, default: 1 },
    steps: ['reference', 'feature', 'script', 'bgm'],
    mediaKind: 'video',
    buildPrompt: (c) =>
      [
        'Vertical 9:16 short product showcase video of a knitwear garment for social commerce.',
        'Smooth cinematic camera: slow push-in, gentle orbit or tilt, soft natural light, premium e-commerce look.',
        'Keep the garment appearance faithful to the reference image(s): same color, knit texture, neckline, sleeves and cut. Do not redesign.',
        'No on-screen text, logos, watermarks or captions. No people / models on camera.',
        'Photoreal fabric motion and subtle depth of field; clean background suitable for Moments / Xiaohongshu.',
        FEATURE(c.feature),
      ].filter(Boolean).join(' '),
  },

  {
    id: 'street_walk_video',
    name: '街头漫步穿搭',
    desc: '真人模特穿着成衣在街上自然走动；可选模特与配乐',
    platforms: ['moments', 'xiaohongshu'],
    defaultSize: 'vertical_video',
    sizes: ['vertical_video'],
    model: 'optional',
    poses: [],
    scenes: [],
    sceneLabel: '场景',
    reference: { prefer: ['main', 'detail'], min: 1, max: 9, hint: '选 1-9 张商品图（正面/侧面/细节均可）' },
    count: { min: 1, max: 1, default: 1 },
    steps: ['reference', 'feature', 'model', 'script', 'bgm'],
    mediaKind: 'video',
    buildPrompt: (c) =>
      [
        'Vertical 9:16 lifestyle fashion video: a person walking casually on a city street wearing the exact knit garment from the reference.',
        c.model?.prompt
          ? `Talent: ${c.model.prompt}.`
          : 'Talent: a natural-looking East Asian young adult, realistic proportions, not a celebrity.',
        'Camera follows at mid-shot / three-quarter, gentle handheld feel, soft daylight, shallow depth of field.',
        'Keep garment faithful to reference: same color, knit texture, neckline, sleeves and cut; do not redesign.',
        'Natural walking gait, subtle fabric motion, clean urban backdrop; no on-screen text, logos or watermarks.',
        FEATURE(c.feature),
      ].filter(Boolean).join(' '),
  },

  {
    id: 'multi_color_outfit_video',
    name: '多色换装短视频',
    desc: '同一镜头氛围下切换成衣颜色；请按顺序选多色参考图',
    platforms: ['moments', 'xiaohongshu'],
    defaultSize: 'vertical_video',
    sizes: ['vertical_video'],
    model: 'optional',
    poses: [],
    scenes: [],
    sceneLabel: '场景',
    reference: { prefer: ['main', 'detail'], min: 2, max: 9, hint: '按颜色顺序选 2-9 张成衣图（一张一色）' },
    count: { min: 1, max: 1, default: 1 },
    steps: ['reference', 'colors', 'feature', 'model', 'script', 'bgm'],
    mediaKind: 'video',
    buildPrompt: (c) => {
      const colorHint = (c.colors || []).filter(Boolean).join(', ');
      return [
        'Vertical 9:16 knitwear color-change promo video for social commerce.',
        c.model?.prompt
          ? `Talent: ${c.model.prompt} wears successive color variants of the same knit garment.`
          : 'Show the same knit garment design in successive color variants (hanging or on a model if implied).',
        colorHint ? `Color sequence from merchant refs: ${colorHint}.` : 'Cycle through the color variants implied by the reference images in order.',
        'Smooth transitions between colors; keep cut, knit texture and styling consistent; only color changes.',
        'Keep each variant faithful to its matching reference. Soft light, clean set. No on-screen text, logos or watermarks.',
        FEATURE(c.feature),
      ].filter(Boolean).join(' ');
    },
  },

  {
    id: 'cafe_lifestyle_video',
    name: '咖啡馆生活感',
    desc: '窗边/咖啡馆氛围，模特轻坐或转身展示成衣',
    platforms: ['moments', 'xiaohongshu'],
    defaultSize: 'vertical_video',
    sizes: ['vertical_video'],
    model: 'optional',
    poses: [],
    scenes: [],
    sceneLabel: '场景',
    reference: { prefer: ['main', 'detail'], min: 1, max: 9, hint: '选 1-9 张商品主图/细节图' },
    count: { min: 1, max: 1, default: 1 },
    steps: ['reference', 'feature', 'model', 'script', 'bgm'],
    mediaKind: 'video',
    buildPrompt: (c) =>
      [
        'Vertical 9:16 cozy lifestyle fashion video in a cafe / by a warm window.',
        c.model?.prompt
          ? `Talent: ${c.model.prompt} wearing the exact knit garment from the reference.`
          : 'An East Asian model wearing the exact knit garment from the reference.',
        'Soft warm indoor light, gentle camera push-in and slight orbit; calm premium mood for Xiaohongshu / Moments.',
        'Keep garment faithful to reference. No on-screen text, logos or watermarks.',
        FEATURE(c.feature),
      ].filter(Boolean).join(' '),
  },

  {
    id: 'detail_macro_video',
    name: '织纹细节特写',
    desc: '静物细节推进：领口/袖口/织纹微距，不出真人',
    platforms: ['moments', 'xiaohongshu'],
    defaultSize: 'vertical_video',
    sizes: ['vertical_video'],
    model: 'none',
    poses: [],
    scenes: [],
    sceneLabel: '场景',
    reference: { prefer: ['detail', 'main'], min: 1, max: 9, hint: '优先选细节图，可叠加主图共 1-9 张' },
    count: { min: 1, max: 1, default: 1 },
    steps: ['reference', 'feature', 'script', 'bgm'],
    mediaKind: 'video',
    buildPrompt: (c) =>
      [
        'Vertical 9:16 macro detail video of a knitwear garment: neckline, cuff, knit texture close-ups.',
        'Slow cinematic push-in and gentle glide across fabric; soft natural light; premium e-commerce look.',
        'Keep color and texture faithful to references. No people, no on-screen text, logos or watermarks.',
        FEATURE(c.feature),
      ].filter(Boolean).join(' '),
  },
];

/** 视频配乐预设（一期：UI + 入参透传；LKB 仅 generateAudio 布尔，具体曲目待上游支持） */
export interface VideoBgmPreset {
  id: string;
  name: string;
  desc: string;
  /** 传给 LKB videoGeneration.generateAudio */
  generateAudio: boolean;
}

export const VIDEO_BGM_PRESETS: VideoBgmPreset[] = [
  { id: 'none', name: '无配乐', desc: '静音成片 / 后期自配', generateAudio: false },
  { id: 'soft_ambient', name: '轻柔氛围', desc: '低干扰铺底（若上游支持）', generateAudio: true },
  { id: 'upbeat_light', name: '轻快流行', desc: '节奏略明快（若上游支持）', generateAudio: true },
  { id: 'warm_acoustic', name: '温暖原声', desc: '吉他/原声气质（若上游支持）', generateAudio: true },
];

export function findVideoBgm(id?: string | null) {
  const hit = VIDEO_BGM_PRESETS.find((b) => b.id === id);
  return hit || VIDEO_BGM_PRESETS[0];
}



/** 将自由文本匹配到最近预设；匹配不上则返回自定义 Option */
export function resolveOption(
  options: Option[],
  selectedIds: string[] | undefined,
  freeText: string | undefined,
  kind: 'pose' | 'scene',
): Option | null {
  const text = String(freeText || '').trim();
  if (text) {
    const lower = text.toLowerCase();
    const hit =
      options.find((o) => o.name === text || o.id === text) ||
      options.find((o) => text.includes(o.name) || o.name.includes(text)) ||
      options.find((o) => lower.includes(o.id) || o.prompt.toLowerCase().includes(lower));
    if (hit) return hit;
    const label = kind === 'pose' ? 'Pose/presentation' : 'Scene/setting';
    return {
      id: 'custom',
      name: '自定义',
      prompt: `${label} described by merchant (follow closely, Chinese ok): ${text}`,
    };
  }
  const ids = (selectedIds || []).filter(Boolean);
  const picked = options.filter((o) => ids.includes(o.id));
  if (picked.length) return picked[0];
  return options[0] || null;
}

/** buildPrompt 用：有 poseText/sceneText 时覆盖 option.prompt */
export function effectivePrompt(opt: Option | null | undefined, freeText?: string): string {
  const t = String(freeText || '').trim();
  // 自定义文案（可能已是 enrich 后的英文片段）始终优先于芯片预设
  if (t) return t;
  return opt?.prompt || '';
}

export function findTemplate(id: string) {
  return TEMPLATES.find((t) => t.id === id);
}

export function isVideoTemplate(t: PromoTemplate | undefined | null) {
  return !!t && (t.mediaKind === 'video' || t.id === 'product_showcase_video');
}

export function listTemplatesByKind(kind: 'image' | 'video' | 'all' = 'image') {
  if (kind === 'all') return TEMPLATES;
  if (kind === 'video') return TEMPLATES.filter((t) => isVideoTemplate(t));
  return TEMPLATES.filter((t) => !isVideoTemplate(t));
}

/** 给前端的纯数据（去掉函数） */
export function templateDto(t: PromoTemplate) {
  const { buildPrompt, ...rest } = t;
  // 仅显式声明且 max>0 的模板（当前：style_ref）下发风格样例；其它模板省略 / max=0
  const styleRef =
    t.styleRef && Number(t.styleRef.max) > 0
      ? { min: t.styleRef.min, max: t.styleRef.max, hint: t.styleRef.hint }
      : { min: 0, max: 0, hint: '' };
  return {
    ...rest,
    mediaKind: t.mediaKind || (isVideoTemplate(t) ? 'video' : 'image'),
    sizeOptions: t.sizes.map((s) => SIZES[s]).filter(Boolean),
    styleRef,
    styleRefPrimary: !!t.styleRefPrimary,
  };
}
