import { findTemplate } from './promo.templates';

/** 按模板/平台生成可一键复制的种草文案（不画进图里） */
export function buildPromoCaption(opts: {
  templateId: string;
  product: { name?: string; styleNo?: string; material?: string; description?: string | null };
  colors?: string[];
  feature?: string;
  modelName?: string;
  poseNames?: string[];
  sceneNames?: string[];
}): string {
  const tpl = findTemplate(opts.templateId);
  const name = (opts.product.name || '新款羊毛衫').trim();
  const styleNo = (opts.product.styleNo || '').trim();
  const material = (opts.product.material || '').trim();
  const colors = (opts.colors || []).filter(Boolean);
  const platforms = tpl?.platforms || ['moments', 'xiaohongshu'];
  const isXhs = platforms.includes('xiaohongshu');

  const tags = [
    '#羊毛衫',
    '#针织衫',
    '#秋冬穿搭',
    isXhs ? '#小红书爆款' : '#朋友圈种草',
    styleNo ? `#款号${styleNo}` : '',
  ].filter(Boolean);

  const lines: string[] = [];
  if (isXhs) {
    lines.push(`${name}来啦～质感一看就高级`);
    lines.push('');
  } else {
    lines.push(`【新款】${name}`);
  }
  if (styleNo) lines.push(`款号：${styleNo}`);
  if (material) lines.push(`材质：${material}`);
  if (colors.length) lines.push(`颜色：${colors.join(' / ')}`);
  if (opts.modelName) lines.push(`出镜：${opts.modelName}`);
  if (opts.sceneNames?.length) lines.push(`场景：${opts.sceneNames.join('、')}`);
  if (opts.poseNames?.length) lines.push(`呈现：${opts.poseNames.join('、')}`);

  const feat = (opts.feature || '').trim();
  if (feat) {
    const short = feat
      .split(/\n+/)
      .map((s) => s.replace(/^[^：:]+[：:]/, '').trim())
      .filter((s) => s && !s.startsWith('品名') && !s.startsWith('款号'))
      .slice(0, 3)
      .join('；');
    if (short) {
      lines.push('');
      lines.push(short.slice(0, 120));
    }
  } else if (opts.product.description) {
    lines.push('');
    lines.push(String(opts.product.description).slice(0, 80));
  }

  lines.push('');
  lines.push(isXhs ? '细节看图，喜欢的姐妹评论区扣1询价～' : '细节看图，需要的联系我询价下单～');
  lines.push('');
  lines.push(tags.join(' '));
  return lines.join('\n').trim();
}
