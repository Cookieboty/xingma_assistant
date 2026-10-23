/**
 * 手工发品：解析微信笔记风格纯文本 → 可编辑 suggestion（一色一价，不含尺码 SKU）
 * 规则对齐 publish-analyze / import_wechat_notes 的【字段】拆解。
 */
import {
  parseBracketFields,
  splitColors,
  extractColorsFromText,
} from './publish-analyze';
import { ColorSkuDraft, PublishSuggestion } from './publish.types';

export type ParseNoteResult = Pick<
  PublishSuggestion,
  | 'styleNo'
  | 'name'
  | 'material'
  | 'weight'
  | 'sizeText'
  | 'description'
  | 'tags'
  | 'colors'
  | 'skus'
  | 'ocrUsed'
  | 'ocrNote'
> & {
  /** 原文里抽到的默认价（可空）；写入各 SKU 若该色无单独价 */
  defaultPrice: string | null;
};

function stripHtml(s: string): string {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fieldOrLabel(
  fields: Record<string, string>,
  text: string,
  labels: string[],
): string {
  for (const lab of labels) {
    if (fields[lab]) return fields[lab].trim();
  }
  for (const lab of labels) {
    const re = new RegExp(
      `${lab.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[：:\\s]*([^\\n【]+)`,
    );
    const m = text.match(re);
    if (m) return m[1].replace(/\s+/g, ' ').trim();
  }
  return '';
}

function extractDefaultPrice(
  fields: Record<string, string>,
  text: string,
): string | null {
  const fromField = (fields['价格'] || fields['单价'] || fields['售价'] || '').trim();
  const mField = fromField.match(/(\d+(?:\.\d+)?)/);
  if (mField) return mField[1];
  const m = text.match(/(?:价格|单价|售价|批发价)[：:\s]*[¥￥]?\s*(\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

/**
 * 从「色名 价格」行抽每色价；支持：
 *   米白 98
 *   黑色：108
 *   米白/黑色 128（多色同价）
 */
function extractColorPrices(
  text: string,
  colors: string[],
): Map<string, string> {
  const map = new Map<string, string>();
  if (!text || !colors.length) return map;
  const lines = text.split(/\n+/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || /款号|成分|材质|款式|克重|尺码|【/.test(t)) continue;
    // 多色同价：色1/色2/色3 128
    const multi = t.match(
      /^([\u4e00-\u9fffA-Za-z0-9/／、，,\s]{2,40}?)\s*[：: ]\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*$/,
    );
    if (multi) {
      const left = multi[1];
      const price = multi[2];
      const parts = left.includes('/') || left.includes('／')
        ? left.split(/[/／]/)
        : left.includes('、') || left.includes('，') || left.includes(',')
          ? left.split(/[、，,]/)
          : [left];
      const names = parts.map((s) => s.trim()).filter(Boolean);
      const matched = names.filter((n) => colors.includes(n));
      if (matched.length >= 1 && matched.length === names.length) {
        for (const n of matched) map.set(n, price);
        continue;
      }
    }
    // 单色：色名 价格
    for (const c of colors) {
      if (map.has(c)) continue;
      const re = new RegExp(
        `^${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[：: ]\\s*[¥￥]?\\s*(\\d+(?:\\.\\d+)?)\\s*$`,
      );
      const m = t.match(re);
      if (m) map.set(c, m[1]);
    }
  }
  return map;
}

/** 解析用户粘贴的微信笔记风格文字 */
export function parseNoteText(rawInput: string): ParseNoteResult {
  const text = stripHtml(rawInput || '');
  if (!text) {
    return {
      styleNo: '',
      name: '',
      material: '',
      weight: '',
      sizeText: '',
      description: '',
      tags: [],
      colors: [],
      skus: [],
      defaultPrice: null,
      ocrUsed: false,
      ocrNote: '正文为空',
    };
  }

  const fields = parseBracketFields(text);

  let styleNo = fieldOrLabel(fields, text, ['款号']).replace(/\s+/g, '');
  // 去掉末尾字母后缀（与 analyze 一致）
  styleNo = styleNo.replace(/[A-Za-z]$/, '');
  if (!styleNo) {
    const m = text.match(/(?:^|\n|\s)(\d{5,6})(?:\s|$|\n)/);
    if (m) styleNo = m[1];
  }

  const material =
    fieldOrLabel(fields, text, ['成分', '材质']) ||
    (() => {
      const m = text.match(
        /(\d+%[^\n]{0,40}(?:山羊绒|羊毛|桑蚕丝|腈纶|锦纶|聚酯纤维)[^\n]{0,60})/,
      );
      return m ? m[1].replace(/\s+/g, ' ').trim() : '';
    })();

  const styleName = fieldOrLabel(fields, text, ['款式', '名称', '品名']);
  const weight = fieldOrLabel(fields, text, ['克重']);
  const sizeText = fieldOrLabel(fields, text, ['尺码', '尺码说明']);

  let colors: string[] = [];
  if (fields['颜色']) {
    colors = splitColors(fields['颜色']);
  } else {
    const m = text.match(/颜色[：:\s]*([^\n【]+)/);
    if (m) colors = splitColors(m[1]);
  }
  if (!colors.length) {
    colors = extractColorsFromText(text);
  }
  // 去重保序
  colors = [...new Set(colors.map((c) => c.trim()).filter(Boolean))];

  const defaultPrice = extractDefaultPrice(fields, text);
  const priceMap = extractColorPrices(text, colors);

  const skus: ColorSkuDraft[] = colors.map((color) => ({
    color,
    price: priceMap.get(color) || defaultPrice,
    mediaIds: [],
  }));

  const descParts: string[] = [];
  if (weight) descParts.push(`克重：${weight}`);
  if (colors.length) descParts.push(`颜色：${colors.join('/')}`);
  if (sizeText) descParts.push(`尺码：${sizeText}`);

  const name = (styleName || (styleNo ? `款号 ${styleNo}` : '')).trim();
  const tags: string[] = [];
  if (weight) tags.push(weight);
  if (styleName) tags.push(...styleName.split(/\s+/).filter(Boolean).slice(0, 4));

  const notes: string[] = [];
  if (styleNo) notes.push(`款号 ${styleNo}`);
  if (colors.length) notes.push(`${colors.length} 色`);
  else notes.push('未识别颜色');
  if (defaultPrice) notes.push(`默认价 ${defaultPrice}`);
  if (priceMap.size) notes.push(`${priceMap.size} 色有单独价`);

  return {
    styleNo,
    name,
    material: material.trim(),
    weight: weight.trim(),
    sizeText: sizeText.trim(),
    description: descParts.join('\n'),
    tags,
    colors,
    skus,
    defaultPrice,
    ocrUsed: false,
    ocrNote: notes.join('；') || '已解析',
  };
}
