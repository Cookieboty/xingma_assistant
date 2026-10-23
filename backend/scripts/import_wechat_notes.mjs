#!/usr/bin/env node
/**
 * 从微信收藏 NoteCache 导入商品到本地 wool_stall（图片落盘，不上 OSS）
 *
 * 关联策略：
 * 1. NoteCache 同批次前缀 temp_{batch}_{idx}_0.htm ↔ 微信图片_{batch}_{idx}_*.jpg
 * 2. 同款号多条笔记去重（保留图片更多的一条）
 * 3. temp/ 下无法映射到上述笔记索引的「微信图片_*」拷入 products/_unclassified/
 *
 * 用法：在 backend/ 下 node scripts/import_wechat_notes.mjs
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, '..');
const ROOT = path.resolve(BACKEND, '..');
dotenv.config({ path: path.join(BACKEND, '.env') });

const TENANT = 'tenant_dev_001';
const LEVEL_ID = 'pl_open';
const FAV =
  '/Users/liuchang/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/lgd_lc_afe5/business/favorite';
const TEMP = path.join(FAV, 'temp');
const NOTECACHE = path.join(TEMP, 'NoteCache');
const STORAGE = path.join(BACKEND, 'storage', 'tenants', TENANT, 'products');
const BATCH = '2026102017581854'; // NoteCache 本批 11 款

function uuid() {
  return crypto.randomUUID();
}

function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 按【字段】拆笔记 HTML（冒号可缺） */
function parseNoteHtml(html) {
  const parts = html.split(/【([^】]+)】[：:]?\s*/);
  const out = {};
  for (let i = 1; i < parts.length; i += 2) {
    const label = parts[i].trim();
    const val = stripHtml(parts[i + 1] || '');
    out[label] = val;
  }
  const styleNo = (out['款号'] || '').trim();
  const material = (out['成分'] || out['材质'] || '').trim();
  const style = (out['款式'] || '').trim();
  const weight = (out['克重'] || '').trim();
  const colorRaw = (out['颜色'] || '').trim();
  const sizeRaw = (out['尺码'] || '').trim();
  return { styleNo, material, style, weight, colorRaw, sizeRaw, raw: out };
}

function splitColors(raw) {
  if (!raw) return [null];
  // 优先按 / 拆；无 / 则按空白
  const parts = raw.includes('/')
    ? raw.split('/')
    : raw.split(/\s+/);
  const list = parts.map((s) => s.trim()).filter(Boolean);
  return list.length ? list : [null];
}

function splitSizes(raw) {
  if (!raw) return [null];
  const parts = /[-－]/.test(raw) ? raw.split(/[-－]/) : raw.split(/\s+/);
  const list = parts.map((s) => s.trim()).filter(Boolean);
  return list.length ? list : [null];
}

function fileFingerprint(fp) {
  const st = fs.statSync(fp);
  const fd = fs.openSync(fp, 'r');
  const head = Buffer.alloc(Math.min(4096, st.size));
  fs.readSync(fd, head, 0, head.length, 0);
  let tail = Buffer.alloc(0);
  if (st.size > 4096) {
    tail = Buffer.alloc(4096);
    fs.readSync(fd, tail, 0, 4096, st.size - 4096);
  }
  fs.closeSync(fd);
  return `${st.size}:${crypto.createHash('md5').update(Buffer.concat([head, tail])).digest('hex')}`;
}

function listNoteCacheNotes() {
  const re = new RegExp(`^temp_${BATCH}_(\\d+)_0\\.htm$`);
  const notes = [];
  for (const name of fs.readdirSync(NOTECACHE)) {
    const m = name.match(re);
    if (!m) continue;
    const idx = Number(m[1]);
    const html = fs.readFileSync(path.join(NOTECACHE, name), 'utf8');
    const parsed = parseNoteHtml(html);
    const imgRe = new RegExp(`^微信图片_${BATCH}_${idx}_\\d+\\.(jpe?g|png|webp)$`, 'i');
    const images = fs
      .readdirSync(NOTECACHE)
      .filter((n) => imgRe.test(n))
      .map((n) => path.join(NOTECACHE, n))
      .sort();
    notes.push({ idx, file: name, ...parsed, images });
  }
  notes.sort((a, b) => a.idx - b.idx);
  return notes;
}

/** 同款号去重：保留图片更多的 */
function dedupeByStyle(notes) {
  const map = new Map();
  for (const n of notes) {
    if (!n.styleNo) continue;
    const prev = map.get(n.styleNo);
    if (!prev || n.images.length > prev.images.length) map.set(n.styleNo, n);
  }
  return [...map.values()].sort((a, b) => a.styleNo.localeCompare(b.styleNo));
}

function collectUnclassified(associatedPaths) {
  const associatedFp = new Set();
  for (const p of associatedPaths) {
    try {
      associatedFp.add(fileFingerprint(p));
    } catch {
      /* ignore */
    }
  }
  const unclassified = [];
  for (const dir of [TEMP, NOTECACHE]) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.includes('微信图片_')) continue;
      const full = path.join(dir, name);
      if (!fs.statSync(full).isFile()) continue;
      let fp;
      try {
        fp = fileFingerprint(full);
      } catch {
        continue;
      }
      if (associatedFp.has(fp)) continue;
      unclassified.push(full);
      associatedFp.add(fp); // 跨目录去重
    }
  }
  return unclassified;
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function copyImage(src, destDir, destName) {
  ensureDir(destDir);
  const dest = path.join(destDir, destName);
  fs.copyFileSync(src, dest);
  return dest;
}

async function main() {
  const report = {
    strategy:
      'NoteCache 同批次前缀 + 笔记序号：temp_{batch}_{idx}_0.htm ↔ 微信图片_{batch}_{idx}_*.jpg；同款去重；其余微信图片进 _unclassified',
    batch: BATCH,
    tenantId: TENANT,
    products: [],
    unclassifiedCount: 0,
    unclassifiedDir: path.join(STORAGE, '_unclassified'),
    totals: { products: 0, skus: 0, productImages: 0, unclassifiedImages: 0 },
  };

  const rawNotes = listNoteCacheNotes();
  const notes = dedupeByStyle(rawNotes);
  if (notes.length !== 11) {
    console.warn(`期望 11 个唯一款号，实际 ${notes.length}`);
  }

  const associated = [];
  ensureDir(STORAGE);

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'wool_stall',
    multipleStatements: false,
  });

  try {
    await conn.beginTransaction();

    for (const note of notes) {
      const colors = splitColors(note.colorRaw);
      const sizes = splitSizes(note.sizeRaw);
      const productId = uuid();
      const coverIds = [];
      const destDir = path.join(STORAGE, note.styleNo);
      ensureDir(destDir);

      const mediaRows = [];
      let i = 0;
      for (const img of note.images) {
        associated.push(img);
        const ext = path.extname(img).toLowerCase() || '.jpg';
        const destName = `${String(++i).padStart(2, '0')}${ext}`;
        const dest = copyImage(img, destDir, destName);
        const st = fs.statSync(dest);
        const mediaId = uuid();
        const objectKey = `tenants/${TENANT}/products/${note.styleNo}/${destName}`;
        coverIds.push(mediaId);
        mediaRows.push({
          id: mediaId,
          objectKey,
          size: st.size,
          mime: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg',
          localPath: dest,
          url: `/media/${objectKey}`,
        });
      }

      const name = note.style || `款号 ${note.styleNo}`;
      const descParts = [];
      if (note.weight) descParts.push(`克重：${note.weight}`);
      if (note.colorRaw) descParts.push(`颜色：${note.colorRaw}`);
      if (note.sizeRaw) descParts.push(`尺码：${note.sizeRaw}`);
      const description = descParts.join('\n') || null;
      const tags = [];
      if (note.weight) tags.push(note.weight);
      if (note.style) tags.push(...note.style.split(/\s+/).filter(Boolean).slice(0, 4));

      await conn.execute(
        `INSERT INTO products
          (id, tenant_id, style_no, name, description, material, level_id, price_display, share_policy,
           cover_media_ids, tags, status, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'show', NULL, CAST(? AS JSON), CAST(? AS JSON), 'on_sale', 0)
         ON DUPLICATE KEY UPDATE
           name=VALUES(name), description=VALUES(description), material=VALUES(material),
           cover_media_ids=VALUES(cover_media_ids), tags=VALUES(tags), status='on_sale'`,
        [
          productId,
          TENANT,
          note.styleNo,
          name,
          description,
          note.material || null,
          LEVEL_ID,
          JSON.stringify(coverIds),
          JSON.stringify(tags),
        ],
      );

      // 若 ON DUPLICATE 命中，需取已有 product id
      const [existRows] = await conn.execute(
        `SELECT id FROM products WHERE tenant_id=? AND style_no=?`,
        [TENANT, note.styleNo],
      );
      const realProductId = existRows[0].id;

      // 清理旧 SKU / media 再写入（幂等重跑）
      await conn.execute(`DELETE FROM product_skus WHERE tenant_id=? AND product_id=?`, [
        TENANT,
        realProductId,
      ]);
      await conn.execute(`DELETE FROM media_assets WHERE tenant_id=? AND product_id=?`, [
        TENANT,
        realProductId,
      ]);

      // 若是更新而非新建，cover_media_ids 可能仍指向旧 productId 插入的；重写 cover
      const finalCoverIds = [];
      for (const m of mediaRows) {
        const mid = uuid();
        finalCoverIds.push(mid);
        await conn.execute(
          `INSERT INTO media_assets
            (id, tenant_id, product_id, type, provider, object_key, mime_type, size_bytes, status)
           VALUES (?, ?, ?, 'image', 'local', ?, ?, ?, 'active')`,
          [mid, TENANT, realProductId, m.objectKey, m.mime, m.size],
        );
        m.id = mid;
      }
      await conn.execute(
        `UPDATE products SET cover_media_ids=CAST(? AS JSON) WHERE id=?`,
        [JSON.stringify(finalCoverIds), realProductId],
      );

      // SKU 只按颜色拆；尺码保留在商品 description，不进 SKU 笛卡尔积
      const skuCodes = new Set();
      let skuCount = 0;
      for (const color of colors) {
        const skuCode = `${note.styleNo}-${color || 'NA'}`;
        if (skuCodes.has(skuCode)) continue;
        skuCodes.add(skuCode);
        await conn.execute(
          `INSERT INTO product_skus
            (id, tenant_id, product_id, sku_code, color, size, price, stock, status)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, 'active')`,
          [uuid(), TENANT, realProductId, skuCode, color],
        );
        skuCount++;
      }

      report.products.push({
        styleNo: note.styleNo,
        noteIdx: note.idx,
        name,
        material: note.material,
        colors: colors.filter(Boolean),
        sizes: sizes.filter(Boolean),
        skuCount,
        imageCount: mediaRows.length,
        imageDir: destDir,
        coverUrls: mediaRows.map((m) => m.url),
      });
      report.totals.skus += skuCount;
      report.totals.productImages += mediaRows.length;
    }

    report.totals.products = report.products.length;

    // 未归类图片
    const unclassified = collectUnclassified(associated);
    const uDir = path.join(STORAGE, '_unclassified');
    ensureDir(uDir);
    let u = 0;
    for (const src of unclassified) {
      const base = path.basename(src);
      // 避免覆盖：同名加短 hash
      let destName = base;
      const dest = path.join(uDir, destName);
      if (fs.existsSync(dest)) {
        const h = crypto.createHash('md5').update(src).digest('hex').slice(0, 6);
        destName = `${h}_${base}`;
      }
      copyImage(src, uDir, destName);
      u++;
    }
    report.unclassifiedCount = u;
    report.totals.unclassifiedImages = u;

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    await conn.end();
  }

  // 校验查询
  const conn2 = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'wool_stall',
  });
  const [[{ products }]] = await conn2.query(
    `SELECT COUNT(*) AS products FROM products WHERE tenant_id=?`,
    [TENANT],
  );
  const [[{ skus }]] = await conn2.query(
    `SELECT COUNT(*) AS skus FROM product_skus WHERE tenant_id=?`,
    [TENANT],
  );
  const [[{ media }]] = await conn2.query(
    `SELECT COUNT(*) AS media FROM media_assets WHERE tenant_id=? AND provider='local'`,
    [TENANT],
  );
  await conn2.end();

  report.verify = { products, skus, media };

  // 磁盘图片数（不含未归类）
  let diskProductImgs = 0;
  for (const p of report.products) {
    diskProductImgs += fs.readdirSync(p.imageDir).filter((n) => /\.(jpe?g|png|webp)$/i.test(n)).length;
  }
  const diskUnclassified = fs
    .readdirSync(path.join(STORAGE, '_unclassified'))
    .filter((n) => /\.(jpe?g|png|webp)$/i.test(n) || n.includes('微信图片')).length;
  report.verify.diskProductImages = diskProductImgs;
  report.verify.diskUnclassifiedImages = diskUnclassified;

  const reportPath = path.join(ROOT, 'docs', 'wechat_notes_import_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  // 刷新 sample：用 NoteCache 完整字段
  const sample = notes.map((n) => ({
    款号: n.styleNo,
    成分: n.material,
    款式: n.style,
    克重: n.weight,
    颜色: n.colorRaw,
    尺码: n.sizeRaw,
    来源文件: path.join(NOTECACHE, n.file),
    NoteCache索引: n.idx,
    关联图片数: n.images.length,
  }));
  fs.writeFileSync(
    path.join(ROOT, 'docs', 'wechat_notes_sample.json'),
    JSON.stringify(sample, null, 2),
    'utf8',
  );

  console.log(JSON.stringify({ ok: true, reportPath, verify: report.verify, totals: report.totals }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
