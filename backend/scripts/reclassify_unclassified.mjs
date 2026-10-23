#!/usr/bin/env node
/**
 * 将 _unclassified 高置信图片归入已有款号，并修正 SKU 为「一色一 SKU」。
 *
 * 高置信信号：NoteCache 笔记打开 mtime ↔ temp 导出时间戳前缀（±约3秒）+
 * 同时间戳组内已与 NoteCache batch 关联图指纹重叠（每组均验证通过）。
 * 低置信（下午/八月批次，OCR 未命中已有款号）→ _needs_review。
 * 不删除、不改写已有 121 条 media_assets；仅追加。
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
const STORAGE = path.join(BACKEND, 'storage', 'tenants', TENANT, 'products');
const UN = path.join(STORAGE, '_unclassified');
const REVIEW = path.join(STORAGE, '_needs_review');

/** 由笔记 mtime 与 temp 导出前缀对齐，并用同组指纹重叠验证 */
const TS_TO_STYLE = {
  '20261020175828': '72769',
  '20261020175833': '51137',
  '20261020175837': '81029',
  '20261020175841': '69322',
  // '20261020175845': '72769', // 与 175828 同款笔记重复，未归类已并入 175828
  '20261020175849': '76877',
  '20261020175855': '72516',
  '20261020175859': '72733',
  '20261020175903': '72768',
  '20261020175906': '72773',
  '20261020175910': '72778',
  '20261020175915': '79922',
};

function uuid() {
  return crypto.randomUUID();
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function nextDestName(destDir, ext) {
  const existing = new Set(fs.readdirSync(destDir));
  let i = 1;
  while (true) {
    const name = `${String(i).padStart(2, '0')}${ext}`;
    if (!existing.has(name)) return name;
    i++;
  }
}

function mimeOf(ext) {
  const e = ext.toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    timezone: 'Asia/Shanghai',
    strategy: {
      highConfidence:
        'NoteCache 笔记打开 mtime 与 temp「微信图片_{ts}_*」时间戳前缀对齐（±约3秒）；同 ts 组内文件指纹与已关联 NoteCache batch 图重叠验证通过',
      lowConfidence:
        '下午批次 161900/161902 与八月残留：无笔记 mtime 对齐；macOS Vision OCR 抽样未命中 11 个已入库款号 → _needs_review',
      ocr: {
        tesseract: 'eng/snum only，无 chi_sim，款号不可靠，未用于归类',
        vision: '已用 /tmp/vision_ocr（zh-Hans）；下午/八月抽样未见已有款号',
      },
      signalsUsed: [
        'filename_timestamp_prefix',
        'note_htm_mtime_proximity',
        'same_ts_group_fingerprint_overlap_with_associated',
        'vision_ocr_sample_negative_for_afternoon_august',
      ],
      notUsed: ['mid/data/thumb raw fingerprint (WeChat V2 encrypted)', 'favorite.db (encrypted)'],
    },
    preservedExistingMedia: 121,
    perStyle: {},
    moved: [],
    needsReview: [],
    stillUnclassified: [],
    skuFix: {},
    totals: {},
  };

  const files = fs.readdirSync(UN).filter((n) => n.includes('微信图片') || /\.(jpe?g|png|webp)$/i.test(n));
  const byStyle = new Map();
  const reviewList = [];
  const leftover = [];

  for (const name of files) {
    const m = name.match(/^微信图片_(\d+)_/);
    const ts = m ? m[1] : null;
    const style = ts && TS_TO_STYLE[ts] ? TS_TO_STYLE[ts] : null;
    if (style) {
      if (!byStyle.has(style)) byStyle.set(style, []);
      byStyle.get(style).push(name);
    } else if (
      ts &&
      (ts.startsWith('202610201619') || ts.startsWith('202608'))
    ) {
      reviewList.push(name);
    } else {
      leftover.push(name);
    }
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'wool_stall',
  });

  try {
    await conn.beginTransaction();

    // --- 1) move high-confidence images + append media_assets ---
    const [[{ mediaBefore }]] = await conn.query(
      `SELECT COUNT(*) AS mediaBefore FROM media_assets WHERE tenant_id=?`,
      [TENANT],
    );
    if (Number(mediaBefore) !== 121) {
      console.warn(`warn: expected 121 media before, got ${mediaBefore}`);
    }

    for (const [style, names] of [...byStyle.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const [prows] = await conn.execute(
        `SELECT id, cover_media_ids FROM products WHERE tenant_id=? AND style_no=?`,
        [TENANT, style],
      );
      if (!prows.length) throw new Error(`missing product ${style}`);
      const productId = prows[0].id;
      let covers = [];
      try {
        covers = typeof prows[0].cover_media_ids === 'string'
          ? JSON.parse(prows[0].cover_media_ids)
          : prows[0].cover_media_ids || [];
      } catch {
        covers = [];
      }

      const destDir = path.join(STORAGE, style);
      ensureDir(destDir);
      let added = 0;
      const addedFiles = [];

      for (const name of names.sort()) {
        const src = path.join(UN, name);
        if (!fs.existsSync(src)) continue;
        let ext = path.extname(name).toLowerCase();
        if (!ext || ext === '.') ext = '.jpg';
        const destName = nextDestName(destDir, ext);
        const dest = path.join(destDir, destName);
        fs.renameSync(src, dest);
        const st = fs.statSync(dest);
        const mediaId = uuid();
        const objectKey = `tenants/${TENANT}/products/${style}/${destName}`;
        await conn.execute(
          `INSERT INTO media_assets
            (id, tenant_id, product_id, type, provider, object_key, mime_type, size_bytes, status)
           VALUES (?, ?, ?, 'image', 'local', ?, ?, ?, 'active')`,
          [mediaId, TENANT, productId, objectKey, mimeOf(ext), st.size],
        );
        covers.push(mediaId);
        added++;
        addedFiles.push({ from: name, to: destName, mediaId, objectKey });
      }

      await conn.execute(`UPDATE products SET cover_media_ids=CAST(? AS JSON) WHERE id=?`, [
        JSON.stringify(covers),
        productId,
      ]);

      report.perStyle[style] = {
        addedImages: added,
        files: addedFiles,
      };
      report.moved.push(...addedFiles.map((f) => ({ style, ...f })));
    }

    // --- 2) low confidence → _needs_review ---
    ensureDir(REVIEW);
    for (const name of reviewList.sort()) {
      const src = path.join(UN, name);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(REVIEW, name);
      if (fs.existsSync(dest)) {
        const h = crypto.createHash('md5').update(name).digest('hex').slice(0, 6);
        fs.renameSync(src, path.join(REVIEW, `${h}_${name}`));
        report.needsReview.push(`${h}_${name}`);
      } else {
        fs.renameSync(src, dest);
        report.needsReview.push(name);
      }
    }
    for (const name of leftover) {
      report.stillUnclassified.push(name);
    }

    // --- 3) SKU fix: one SKU per color ---
    const [products] = await conn.execute(
      `SELECT id, style_no FROM products WHERE tenant_id=? ORDER BY style_no`,
      [TENANT],
    );
    for (const p of products) {
      const [skus] = await conn.execute(
        `SELECT id, color, size, price, stock, status FROM product_skus
         WHERE tenant_id=? AND product_id=? ORDER BY color, size`,
        [TENANT, p.id],
      );
      const byColor = new Map();
      for (const s of skus) {
        const color = s.color || 'NA';
        if (!byColor.has(color)) {
          byColor.set(color, {
            price: s.price,
            stock: Number(s.stock) || 0,
            status: s.status || 'active',
          });
        } else {
          const cur = byColor.get(color);
          cur.stock += Number(s.stock) || 0;
          if (cur.price == null && s.price != null) cur.price = s.price;
        }
      }
      await conn.execute(`DELETE FROM product_skus WHERE tenant_id=? AND product_id=?`, [
        TENANT,
        p.id,
      ]);
      for (const [color, meta] of byColor) {
        const skuCode = `${p.style_no}-${color}`;
        await conn.execute(
          `INSERT INTO product_skus
            (id, tenant_id, product_id, sku_code, color, size, price, stock, status)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
          [uuid(), TENANT, p.id, skuCode, color === 'NA' ? null : color, meta.price, meta.stock, meta.status],
        );
      }
      report.skuFix[p.style_no] = {
        before: skus.length,
        after: byColor.size,
        colors: [...byColor.keys()],
      };
    }

    await conn.commit();

    const [[{ mediaAfter }]] = await conn.query(
      `SELECT COUNT(*) AS mediaAfter FROM media_assets WHERE tenant_id=?`,
      [TENANT],
    );
    const [[{ skuTotal }]] = await conn.query(
      `SELECT COUNT(*) AS skuTotal FROM product_skus WHERE tenant_id=?`,
      [TENANT],
    );

    // disk counts
    const diskByStyle = {};
    for (const style of Object.keys(report.skuFix)) {
      const dir = path.join(STORAGE, style);
      diskByStyle[style] = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((n) => /\.(jpe?g|png|webp)$/i.test(n)).length
        : 0;
    }
    const stillUn = fs.existsSync(UN)
      ? fs.readdirSync(UN).filter((n) => n.includes('微信图片') || /\.(jpe?g|png|webp)$/i.test(n)).length
      : 0;
    const reviewN = fs.existsSync(REVIEW) ? fs.readdirSync(REVIEW).length : 0;

    report.totals = {
      highConfidenceMoved: report.moved.length,
      needsReview: report.needsReview.length,
      stillUnclassified: stillUn,
      mediaBefore: Number(mediaBefore),
      mediaAfter: Number(mediaAfter),
      mediaAdded: Number(mediaAfter) - Number(mediaBefore),
      skuTotalAfter: Number(skuTotal),
      diskImagesByStyle: diskByStyle,
      reviewDirCount: reviewN,
    };

    // per-style summary for report
    const summary = {};
    for (const style of Object.keys(report.skuFix)) {
      summary[style] = {
        addedImages: report.perStyle[style]?.addedImages || 0,
        diskImages: diskByStyle[style],
        skuCount: report.skuFix[style].after,
        skuColors: report.skuFix[style].colors,
      };
    }
    report.summaryByStyle = summary;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    await conn.end();
  }

  const reportPath = path.join(ROOT, 'docs', 'wechat_notes_reclassify_report.json');
  // compact file list in report for readability
  const out = {
    ...report,
    perStyle: Object.fromEntries(
      Object.entries(report.perStyle).map(([k, v]) => [
        k,
        { addedImages: v.addedImages, sample: v.files.slice(0, 3).map((f) => f.from) },
      ]),
    ),
  };
  fs.writeFileSync(reportPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, reportPath, totals: report.totals, summaryByStyle: report.summaryByStyle, skuFix: report.skuFix }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
