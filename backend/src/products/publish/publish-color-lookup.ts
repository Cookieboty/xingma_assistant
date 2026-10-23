/**
 * 按款号从微信笔记导出 / 已有商品 SKU 回填颜色。
 * 用于密排多色挂拍 OCR 不稳时的高价值兜底。
 */
import * as fs from 'fs';
import * as path from 'path';

export type ColorLookupSource = 'note' | 'product';

export interface StyleColorLookup {
  styleNo: string;
  colors: string[];
  source: ColorLookupSource;
  name?: string;
  material?: string;
  sizeText?: string;
  weight?: string;
}

type NoteIndex = Map<string, StyleColorLookup>;

let cachedNoteIndex: NoteIndex | null = null;
let cachedNoteIndexMtime = 0;

function projectDocsDirs(): string[] {
  const cwd = process.cwd();
  return [
    path.join(cwd, '..', 'docs'), // backend cwd → repo/docs
    path.join(cwd, 'docs'),
    path.resolve(cwd, '../../docs'),
    path.join(__dirname, '..', '..', '..', '..', 'docs'), // dist/products/publish → repo/docs
  ];
}

function splitColorRaw(raw: string): string[] {
  if (!raw) return [];
  const parts = raw.includes('/')
    ? raw.split('/')
    : raw.split(/[,，、\s]+/);
  return [...new Set(parts.map((s) => s.trim()).filter(Boolean))];
}

function normalizeStyleNo(s: string): string {
  return String(s || '')
    .trim()
    .replace(/[A-Za-z]$/, ''); // 81029A → 81029
}

function loadJsonSafe(file: string): unknown {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function ingestNoteItem(index: NoteIndex, styleNo: string, colors: string[], extra?: Partial<StyleColorLookup>) {
  const key = normalizeStyleNo(styleNo);
  if (!key || !colors.length) return;
  const existing = index.get(key);
  if (existing && existing.colors.length >= colors.length) {
    // 保留信息更全的一条；可补 name/material
    if (!existing.name && extra?.name) existing.name = extra.name;
    if (!existing.material && extra?.material) existing.material = extra.material;
    if (!existing.sizeText && extra?.sizeText) existing.sizeText = extra.sizeText;
    if (!existing.weight && extra?.weight) existing.weight = extra.weight;
    return;
  }
  index.set(key, {
    styleNo: key,
    colors: [...colors],
    source: 'note',
    name: extra?.name,
    material: extra?.material,
    sizeText: extra?.sizeText,
    weight: extra?.weight,
  });
}

function buildNoteIndex(): NoteIndex {
  const index: NoteIndex = new Map();
  const dirs = projectDocsDirs();
  let newestMtime = 0;

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const sample = path.join(dir, 'wechat_notes_sample.json');
    const report = path.join(dir, 'wechat_notes_import_report.json');
    for (const file of [sample, report]) {
      try {
        if (fs.existsSync(file)) {
          newestMtime = Math.max(newestMtime, fs.statSync(file).mtimeMs);
        }
      } catch {
        /* ignore */
      }
    }

    const sampleData = loadJsonSafe(sample);
    if (Array.isArray(sampleData)) {
      for (const it of sampleData) {
        if (!it || typeof it !== 'object') continue;
        const row = it as Record<string, unknown>;
        const styleNo = String(row['款号'] || row['styleNo'] || '');
        const colors = splitColorRaw(String(row['颜色'] || ''));
        ingestNoteItem(index, styleNo, colors, {
          name: row['款式'] ? String(row['款式']) : undefined,
          material: row['成分'] ? String(row['成分']) : undefined,
          sizeText: row['尺码'] ? String(row['尺码']) : undefined,
          weight: row['克重'] ? String(row['克重']) : undefined,
        });
      }
    }

    const reportData = loadJsonSafe(report) as Record<string, unknown> | null;
    const products = reportData?.products;
    if (Array.isArray(products)) {
      for (const it of products) {
        if (!it || typeof it !== 'object') continue;
        const row = it as Record<string, unknown>;
        const styleNo = String(row.styleNo || row['款号'] || '');
        let colors: string[] = [];
        if (Array.isArray(row.colors)) {
          colors = row.colors.map((c) => String(c).trim()).filter(Boolean);
        } else if (row['颜色']) {
          colors = splitColorRaw(String(row['颜色']));
        }
        ingestNoteItem(index, styleNo, colors, {
          name: (row.name || row['款式']) ? String(row.name || row['款式']) : undefined,
          material: (row.material || row['成分']) ? String(row.material || row['成分']) : undefined,
          sizeText: (row.sizeText || row['尺码']) ? String(row.sizeText || row['尺码']) : undefined,
          weight: (row.weight || row['克重']) ? String(row.weight || row['克重']) : undefined,
        });
      }
    }
  }

  cachedNoteIndexMtime = newestMtime;
  return index;
}

/** 读微信笔记导出（带简单 mtime 缓存） */
export function lookupColorsFromNotes(styleNo: string): StyleColorLookup | null {
  const key = normalizeStyleNo(styleNo);
  if (!key) return null;

  // 文件更新则重建
  let newest = 0;
  for (const dir of projectDocsDirs()) {
    for (const name of ['wechat_notes_sample.json', 'wechat_notes_import_report.json']) {
      const f = path.join(dir, name);
      try {
        if (fs.existsSync(f)) newest = Math.max(newest, fs.statSync(f).mtimeMs);
      } catch {
        /* ignore */
      }
    }
  }
  if (!cachedNoteIndex || newest > cachedNoteIndexMtime) {
    cachedNoteIndex = buildNoteIndex();
  }
  return cachedNoteIndex.get(key) || null;
}

/** OCR 色是否「很少/占位」需要回填 */
export function isSparseColorList(colors: string[]): boolean {
  const real = (colors || []).filter((c) => c && !/^色\d+$/.test(c));
  return real.length < 2;
}

/**
 * 合并：OCR/角标色名优先保留顺序，再追加笔记/商品中缺失的色。
 */
export function mergeColorsPreferOcr(ocrColors: string[], lookupColors: string[]): string[] {
  const realOcr = (ocrColors || []).filter((c) => c && !/^色\d+$/.test(c));
  const out: string[] = [];
  for (const c of realOcr) {
    if (!out.includes(c)) out.push(c);
  }
  for (const c of lookupColors || []) {
    const t = (c || '').trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function clearNoteIndexCache() {
  cachedNoteIndex = null;
  cachedNoteIndexMtime = 0;
}
