#!/usr/bin/env node
/**
 * 按展示规则重排商品 cover_media_ids：主图 → 细节 → 场景 → 文档沉底；首张=封面。
 * 优先复用 dist/vision/cover-select + VisionClient；无图本地文件时仅文件名启发式。
 *
 * Usage:
 *   node scripts/reorder_cover_media.mjs [--dry-run] [--style 72769,76877] [--tenant tenant_dev_001]
 * Env: DB_* VISION_* from .env
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const {
  looksLikeDocument,
  orderCoverMediaIds,
  sortMediaIdsByDisplayOrder,
  selectCoverImage,
  displayOrderBucket,
} = require(path.join(root, 'dist/vision/cover-select.js'));
const { VisionClient } = require(path.join(root, 'dist/vision/vision.client.js'));

const dry = process.argv.includes('--dry-run');
const tenant = argValue('--tenant') || 'tenant_dev_001';
const stylesArg = argValue('--style');
const styleFilter = stylesArg ? new Set(stylesArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;
const modelOverride = argValue('--model');
if (modelOverride) process.env.VISION_MODEL = modelOverride;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

function mysql() {
  const host = process.env.DB_HOST || '127.0.0.1';
  const port = process.env.DB_PORT || '3306';
  const user = process.env.DB_USER || 'wool';
  const password = process.env.DB_PASSWORD || '';
  const database = process.env.DB_NAME || 'wool_stall';
  return { host, port, user, password, database };
}

function sql(q) {
  const c = mysql();
  const args = ['-h', c.host, '-P', String(c.port), `-u${c.user}`, `-p${c.password}`, c.database, '-N', '-B', '-e', q];
  const out = execFileSync('mysql', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  // strip password warnings from stderr via not mixing; stdout only
  return out;
}

function sqlJson(q) {
  // return rows as array of objects via JSON_ARRAYAGG when needed — use TSV parse
  const out = sql(q).trim();
  if (!out) return [];
  return out.split('\n').map((line) => line.split('\t'));
}

function parseJsonLoose(text) {
  const t = (text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : t;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`no json: ${t.slice(0, 120)}`);
  return JSON.parse(raw.slice(start, end + 1));
}

async function classifyBatch(vision, items) {
  // items: {id, localPath, filename}[]
  const types = new Map();
  if (!vision.configured() || !items.length) return types;
  const batchSize = Math.max(2, Math.min(4, parseInt(process.env.VISION_BATCH_SIZE || '4', 10)));
  for (let i = 0; i < items.length; i += batchSize) {
    const group = items.slice(i, i + batchSize).filter((it) => it.localPath && fs.existsSync(it.localPath));
    if (!group.length) continue;
    const parts = [
      {
        type: 'text',
        text: `你是羊毛衫电商图片分类助手。共 ${group.length} 张图（index 0..${group.length - 1}）。
为每张图标一个 type：
- main: 挂拍/平铺主图/全身半身一眼看清衣服
- multi_color: 多色合图
- detail: 面料/领口/袖口等局部细节
- scene: 场景/模特上身/街拍
- size_chart / lab_report / hangtag / text: 尺码表、质检报告、吊牌文字、纯文字
只回 JSON：{"items":[{"index":0,"type":"main"}]}`,
      },
    ];
    for (let j = 0; j < group.length; j++) {
      parts.push({ type: 'text', text: `index=${j} file=${group[j].filename}` });
      parts.push({ type: 'image_url', image_url: { url: vision.fileToDataUrl(group[j].localPath) } });
    }
    try {
      const content = await vision.chat(parts, { maxTokens: 500 });
      const parsed = parseJsonLoose(content);
      for (const row of parsed.items || []) {
        const idx = Number(row.index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= group.length) continue;
        types.set(group[idx].id, String(row.type || 'other').toLowerCase());
      }
    } catch (e) {
      console.warn(`  classify batch fail: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  return types;
}

function imageStats(localPath) {
  try {
    const out = execFileSync(
      'python3',
      [
        '-c',
        "from PIL import Image\nimport sys,os\nim=Image.open(sys.argv[1]).convert('RGB');w,h=im.size;s=os.path.getsize(sys.argv[1]);sm=im.resize((48,48));px=list(sm.getdata());n=len(px);white=sum(1 for r,g,b in px if r>210 and g>210 and b>210)/n\ndef sat(r,g,b):\n mx,mn=max(r,g,b),min(r,g,b);\n return 0 if mx==0 else (mx-mn)/mx\nsa=sum(sat(r,g,b) for r,g,b in px)/n\nprint(f'{w} {h} {s} {white:.4f} {sa:.4f}')",
        localPath,
      ],
      { encoding: 'utf8' },
    ).trim();
    const [w, h, size, white, sat] = out.split(/\s+/).map(Number);
    return { w, h, size, white, sat };
  } catch {
    return null;
  }
}

function heuristicType(it) {
  const name = it.filename || '';
  if (/尺码|尺寸表|size.?chart/i.test(name)) return 'size_chart';
  if (/质检|检验|lab.?report|test.?report/i.test(name)) return 'lab_report';
  if (/吊牌|hangtag|标签/i.test(name)) return 'hangtag';
  if (/场景|模特|上身|街拍|lookbook|scene|\bmodel\b/i.test(name)) return 'scene';
  if (/细节|detail|领口|袖口|面料/i.test(name)) return 'detail';
  if (/主图|封面|main|cover|平铺|挂拍|全身|半身/i.test(name)) return 'main';
  if (it.localPath && fs.existsSync(it.localPath)) {
    if (looksLikeDocument(it.localPath)) return 'lab_report';
    const st = imageStats(it.localPath);
    if (st) {
      if (st.white > 0.55 && st.sat < 0.18) return 'lab_report';
      // 小图+低饱和 ≈ 细节/特写；大图竖构图 ≈ 主图
      if (st.size < 280000 && st.sat < 0.12) return 'detail';
      if (st.w > 0 && st.h > 0 && st.w / st.h > 1.25 && st.white > 0.4) return 'scene';
      if (st.size > 350000) return 'main';
      if (st.size < 220000) return 'detail';
    }
  }
  return 'main';
}

async function reorderOne(vision, productId, styleNo, coverIds) {
  const storageRoot = path.join(root, 'storage');
  const rows = sqlJson(
    `SELECT id, object_key FROM media_assets WHERE tenant_id='${tenant}' AND id IN (${coverIds
      .map((id) => `'${id}'`)
      .join(',')}) AND status='active'`,
  );
  const byId = new Map(rows.map(([id, key]) => [id, key]));
  // also append any product images missing from cover list
  const extra = sqlJson(
    `SELECT id, object_key FROM media_assets WHERE tenant_id='${tenant}' AND product_id='${productId}' AND status='active' AND type='image'`,
  );
  for (const [id, key] of extra) {
    if (!byId.has(id) && !String(key).includes('/promo/')) byId.set(id, key);
  }
  const orderedIds = [
    ...coverIds.filter((id) => byId.has(id) && !String(byId.get(id)).includes('/promo/')),
    ...[...byId.keys()].filter((id) => !coverIds.includes(id) && !String(byId.get(id)).includes('/promo/')),
  ];
  const items = orderedIds.map((id) => {
    const key = byId.get(id);
    const localPath = path.join(storageRoot, key);
    return {
      id,
      filename: path.basename(key),
      localPath: fs.existsSync(localPath) ? localPath : undefined,
      objectKey: key,
    };
  });

  // 1) classify
  const typeMap = await classifyBatch(
    vision,
    items.filter((it) => it.localPath),
  );
  for (const it of items) {
    if (!typeMap.has(it.id)) typeMap.set(it.id, heuristicType(it));
  }

  const displayItems = items.map((it) => ({
    id: it.id,
    filename: it.filename,
    localPath: it.localPath,
    typeHint: typeMap.get(it.id),
    roleHint: typeMap.get(it.id),
  }));

  // 2) pick cover (exclude docs)
  let coverId = null;
  const cands = items
    .filter((it) => it.localPath)
    .map((it) => ({
      id: it.id,
      localPath: it.localPath,
      filename: it.filename,
      roleHint: typeMap.get(it.id),
    }));
  if (cands.length) {
    try {
      const pick = await selectCoverImage(vision, cands);
      coverId = pick.coverId;
      console.log(`  cover via=${pick.via} ${pick.reason}`);
    } catch (e) {
      console.warn(`  selectCover fail: ${String(e?.message || e).slice(0, 100)}`);
    }
  }
  if (!coverId) {
    const sorted = sortMediaIdsByDisplayOrder(displayItems);
    coverId = sorted.find((id) => displayOrderBucket(displayItems.find((d) => d.id === id)) === 0) || sorted[0];
  }

  const newIds = orderCoverMediaIds(displayItems, coverId);
  const beforeBuckets = coverIds.map((id) => `${(typeMap.get(id) || '?').slice(0, 8)}`);
  const afterBuckets = newIds.map((id) => `${(typeMap.get(id) || '?').slice(0, 8)}`);
  const changed = JSON.stringify(coverIds) !== JSON.stringify(newIds);
  return {
    styleNo,
    productId,
    changed,
    before: coverIds,
    after: newIds,
    beforeBuckets,
    afterBuckets,
    typeMap: Object.fromEntries(typeMap),
  };
}

async function main() {
  const vision = new VisionClient();
  console.log(`tenant=${tenant} dry=${dry} vision=${vision.configured()} model=${process.env.VISION_MODEL} styles=${stylesArg || 'ALL'}`);
  const products = sqlJson(
    `SELECT id, style_no, CAST(cover_media_ids AS CHAR) FROM products WHERE tenant_id='${tenant}' ORDER BY style_no`,
  );
  const report = [];
  for (const [id, styleNo, coverJson] of products) {
    if (styleFilter && !styleFilter.has(styleNo)) continue;
    let coverIds = [];
    try {
      coverIds = JSON.parse(coverJson || '[]') || [];
    } catch {
      coverIds = [];
    }
    console.log(`\n== ${styleNo} n=${coverIds.length} ==`);
    const r = await reorderOne(vision, id, styleNo, coverIds);
    report.push(r);
    console.log(`  before types: ${r.beforeBuckets.join(',')}`);
    console.log(`  after  types: ${r.afterBuckets.join(',')}`);
    console.log(`  changed=${r.changed}`);
    if (r.changed && !dry) {
      const json = JSON.stringify(r.after).replace(/'/g, "\\'");
      sql(
        `UPDATE products SET cover_media_ids=CAST('${json}' AS JSON) WHERE id='${id}' AND tenant_id='${tenant}'`,
      );
      console.log('  UPDATED');
    }
  }
  const outPath = path.join(root, '..', 'docs', 'reorder_cover_media_report.json');
  fs.writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), tenant, dry, report }, null, 2));
  console.log(`\nreport → ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
