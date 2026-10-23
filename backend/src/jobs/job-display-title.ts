import { findTemplate, MODELS } from '../promo/promo.templates';
import { isProvisionalStyleNo } from '../vision/publish-vision';

/** 任务列表友好标题：一眼看出场景/模特或发品款号，避免写死「宣传生图」 */
export function buildJobDisplayTitle(
  type: string,
  payload: Record<string, unknown> | null | undefined,
): string {
  const p = (payload || {}) as Record<string, any>;
  const templateId = String(p.templateId || '').trim();
  // multi_color 历史可能缓存了「极简浅色里的女模特」类文案，一律重算
  const cached = String(p.displayTitle || '').trim();
  if (cached && templateId !== 'multi_color') return cached;

  if (type === 'promo_image') return buildPromoTitle(p);
  if (type === 'promo_video') {
    const styleNo = String(p.styleNo || '').trim();
    const tpl = findTemplate(String(p.templateId || ''));
    const name = tpl?.name || '宣传视频';
    return styleNo ? `${name} · 款号${styleNo}` : name;
  }
  if (type === 'publish_product') return buildPublishTitle(p);
  if (type === 'cover_reselect') {
    const styleNo = String(p.styleNo || '').trim();
    return styleNo ? `重选封面 · 款号${styleNo}` : '重选封面';
  }
  return type || '任务';
}

function modelWho(modelId?: string | null): string | null {
  if (!modelId) return null;
  const id = String(modelId);
  if (id.startsWith('m_')) return '男模特';
  if (id.startsWith('f_')) return '女模特';
  const m = MODELS.find((x) => x.id === id);
  return m?.name || null;
}

function buildMultiColorTitle(p: Record<string, any>): string {
  const styleNo = String(p.styleNo || '').trim();
  const colors = Array.isArray(p.colors) ? p.colors.map((c: any) => String(c || '').trim()).filter(Boolean) : [];
  const colorPart = colors.length ? `${colors.length}色` : '';
  if (styleNo && colorPart) return `多色展示 · 款号${styleNo} · ${colorPart}`;
  if (styleNo) return `多色展示 · 款号${styleNo}`;
  if (colorPart) return `多色展示 · ${colorPart}`;
  return '多色展示';
}

function buildPromoTitle(p: Record<string, any>): string {
  const templateId = String(p.templateId || '');
  if (templateId === 'multi_color') return buildMultiColorTitle(p);

  const tpl = findTemplate(templateId);
  const sceneIds: string[] = Array.isArray(p.scenes) ? p.scenes : [];
  const scenes = (tpl?.scenes || []).filter((s) => sceneIds.includes(s.id));
  const sceneName = scenes[0]?.name || '';
  const who = modelWho(p.modelId);
  if (sceneName && who) {
    const join = /里$/.test(sceneName) ? '的' : '里的';
    return `${sceneName}${join}${who}`;
  }
  if (sceneName) return sceneName;
  if (who) return who;
  if (tpl?.name) return tpl.name;
  return '宣传生图';
}

function buildPublishTitle(p: Record<string, any>): string {
  const styleNo = String(p.styleNo || p.draftStyleNo || '').trim();
  if (styleNo && !isProvisionalStyleNo(styleNo)) {
    return `选图发品 · 款号${styleNo}`;
  }
  return '识别中·草稿';
}
