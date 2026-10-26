#!/usr/bin/env node
/**
 * Wipe demo-stall product/promo/job data and recreate products from WeChat NoteCache,
 * uploading images to xy-tradex under OSS_PREFIX (xingma-stall).
 *
 * Scope: tenant_dev_001 only. Does NOT delete tenants/members/levels/customers.
 *
 * Usage (backend/):
 *   node scripts/recreate_products_from_wechat_notes.mjs [--dry-run] [--skip-wipe] [--skip-oss]
 *
 * DB/OSS from backend/.env. Override DB_HOST for SSH tunnel (e.g. 127.0.0.1:13306).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

const require = createRequire(import.meta.url);
const AliOss = require('ali-oss');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, '..');
const ROOT = path.resolve(BACKEND, '..');
dotenv.config({ path: path.join(BACKEND, '.env') });

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const SKIP_WIPE = args.has('--skip-wipe');
const SKIP_OSS = args.has('--skip-oss');

const TENANT = 'tenant_dev_001';
const LEVEL_ID = process.env.DEFAULT_PRODUCT_LEVEL_ID || 'pl_open';
const FAV =
  process.env.WECHAT_FAVORITE_DIR ||
  '/Users/liuchang/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/lgd_lc_afe5/business/favorite';
const TEMP = path.join(FAV, 'temp');
const NOTECACHE = path.join(TEMP, 'NoteCache');
const STORAGE = path.join(BACKEND, 'storage', 'tenants', TENANT, 'products');
const BATCH = process.env.WECHAT_NOTE_BATCH || '2026102017581854';
const NEW_PUBLIC_BASE = (
  process.env.MEDIA_PUBLIC_BASE || 'https://xy-tradex.oss-cn-shenzhen.aliyuncs.com'
).replace(/\/$/, '');
const OSS_PREFIX = String(process.env.OSS_PREFIX || 'xingma-stall').replace(/^\/+|\/+$/g, '');

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

function parseNoteHtml(html) {
  const parts = html.split(/【([^】]+)】[：:]?\s*/);
  const out = {};
  for (let i = 1; i < parts.length; i += 2) {
    out[parts[i].trim()] = stripHtml(parts[i + 1] || '');
  }
  return {
    styleNo: (out['款号'] || '').trim(),
    material: (out['成分'] || out['材质'] || '').trim(),
    style: (out['款式'] || '').trim(),
    weight: (out['克重'] || '').trim(),
    colorRaw: (out['颜色'] || '').trim(),
    sizeRaw: (out['尺码'] || '').trim(),
  };
}

function splitColors(raw) {
  if (!raw) return [null];
  const parts = raw.includes('/') ? raw.split('/') : raw.split(/\s+/);
  const list = parts.map((s) => s.trim()).filter(Boolean);
  return list.length ? list : [null];
}

function splitSizes(raw) {
  if (!raw) return [null];
  const parts = /[-－]/.test(raw) ? raw.split(/[-－]/) : raw.split(/\s+/);
  const list = parts.map((s) => s.trim()).filter(Boolean);
  return list.length ? list : [null];
}

function listNoteCacheNotes() {
  if (!fs.existsSync(NOTECACHE)) throw new Error(`NoteCache missing: ${NOTECACHE}`);
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

function dedupeByStyle(notes) {
  const map = new Map();
  for (const n of notes) {
    if (!n.styleNo) continue;
    const prev = map.get(n.styleNo);
    if (!prev || n.images.length > prev.images.length) map.set(n.styleNo, n);
  }
  return [...map.values()].sort((a, b) => a.styleNo.localeCompare(b.styleNo));
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function makeOss() {
  const endpoint = (process.env.OSS_ENDPOINT || '').replace(/\/$/, '');
  const bucket = process.env.OSS_BUCKET;
  const accessKeyId = process.env.OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET;
  if (!endpoint || !bucket || !accessKeyId || !accessKeySecret) {
    throw new Error('OSS env incomplete');
  }
  return new AliOss({
    accessKeyId,
    accessKeySecret,
    bucket,
    endpoint,
    secure: true,
    timeout: 120000,
  });
}

async function putOss(client, objectKey, localPath, mime) {
  const fullKey = `${OSS_PREFIX}/${objectKey}`;
  if (DRY) return `${NEW_PUBLIC_BASE}/${fullKey}`;
  await client.put(fullKey, localPath, {
    headers: {
      'Content-Type': mime,
      'x-oss-object-acl': 'public-read',
    },
  });
  return `${NEW_PUBLIC_BASE}/${fullKey}`;
}

async function dbConn() {
  return mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'wool',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'wool_stall',
    multipleStatements: true,
  });
}

async function tableExists(conn, name) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=? LIMIT 1`,
    [name],
  );
  return rows.length > 0;
}

async function wipeDemoStall(conn) {
  // PRODUCTS ONLY — do not touch promo_sets / jobs / 生图任务
  const safeDelete = async (table, sql, params = []) => {
    if (!(await tableExists(conn, table))) {
      console.log(`skip wipe missing table ${table}`);
      return 0;
    }
    if (DRY) return 0;
    const [r] = await conn.query(sql, params);
    console.log(`wiped ${table}: ${r.affectedRows || 0}`);
    return r.affectedRows || 0;
  };
  await safeDelete('media_assets', `DELETE FROM media_assets WHERE tenant_id=?`, [TENANT]);
  await safeDelete('product_skus', `DELETE FROM product_skus WHERE tenant_id=?`, [TENANT]);
  await safeDelete('products', `DELETE FROM products WHERE tenant_id=?`, [TENANT]);
  return { jobIds: 0 };
}

async function headOk(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (res.ok) return res.status;
    const g = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
    return g.status;
  } catch {
    return 0;
  }
}

async function main() {
  console.log(`NoteCache=${NOTECACHE}`);
  console.log(`batch=${BATCH} tenant=${TENANT} dry=${DRY} skipWipe=${SKIP_WIPE} skipOss=${SKIP_OSS}`);
  console.log(`OSS bucket=${process.env.OSS_BUCKET} prefix=${OSS_PREFIX} (secrets hidden)`);
  console.log(`DB ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);

  const rawNotes = listNoteCacheNotes();
  const notes = dedupeByStyle(rawNotes);
  console.log(`notes raw=${rawNotes.length} unique styles=${notes.length}`);
  for (const n of notes) {
    console.log(`  ${n.styleNo} imgs=${n.images.length} ${n.style || ''}`);
  }
  if (!notes.length) throw new Error('No notes found');

  const conn = await dbConn();
  const oss = SKIP_OSS ? null : makeOss();
  const report = {
    at: new Date().toISOString(),
    batch: BATCH,
    tenantId: TENANT,
    wipe: {},
    products: [],
    verify: { broken: [], ok: 0 },
  };

  try {
    async function countTenant(table) {
      if (!(await tableExists(conn, table))) return 0;
      const [[{ c }]] = await conn.query(`SELECT COUNT(*) c FROM ${table} WHERE tenant_id=?`, [TENANT]);
      return c;
    }
    const beforeProducts = await countTenant('products');
    const beforeMedia = await countTenant('media_assets');
    const beforePromo = await countTenant('promo_sets');
    const beforeJobs = await countTenant('jobs');
    report.wipe.before = {
      products: beforeProducts,
      media: beforeMedia,
      promo: beforePromo,
      jobs: beforeJobs,
    };
    console.log('BEFORE', report.wipe.before);

    if (!SKIP_WIPE) {
      await conn.beginTransaction();
      const w = await wipeDemoStall(conn);
      if (!DRY) await conn.commit();
      else await conn.rollback();
      report.wipe.jobsDeleted = w.jobIds;
      console.log(`Wiped demo stall product/promo/job data (dry=${DRY})`);
    }

    await conn.beginTransaction();
    ensureDir(STORAGE);

    for (const note of notes) {
      const colors = splitColors(note.colorRaw);
      const sizes = splitSizes(note.sizeRaw);
      const destDir = path.join(STORAGE, note.styleNo);
      ensureDir(destDir);

      // clear existing style dir images for clean renumber
      for (const f of fs.readdirSync(destDir)) {
        if (/\.(jpe?g|png|webp)$/i.test(f)) fs.unlinkSync(path.join(destDir, f));
      }

      const mediaRows = [];
      let i = 0;
      for (const img of note.images) {
        const ext = path.extname(img).toLowerCase() || '.jpg';
        const destName = `${String(++i).padStart(2, '0')}${ext === '.jpeg' ? '.jpg' : ext}`;
        const dest = path.join(destDir, destName);
        fs.copyFileSync(img, dest);
        const st = fs.statSync(dest);
        const objectKey = `tenants/${TENANT}/products/${note.styleNo}/${destName}`;
        const mime =
          ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        let url = `${NEW_PUBLIC_BASE}/${OSS_PREFIX}/${objectKey}`;
        if (!SKIP_OSS) {
          url = await putOss(oss, objectKey, dest, mime);
          console.log(`OSS ${note.styleNo}/${destName}`);
        }
        mediaRows.push({ objectKey, size: st.size, mime, url });
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

      const productId = uuid();
      const coverIds = mediaRows.map(() => uuid());

      if (!DRY) {
        await conn.execute(
          `INSERT INTO products
            (id, tenant_id, style_no, name, description, material, level_id, price_display, share_policy,
             cover_media_ids, tags, status, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'show', NULL, CAST(? AS JSON), CAST(? AS JSON), 'on_sale', 0)`,
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

        for (let mi = 0; mi < mediaRows.length; mi++) {
          const m = mediaRows[mi];
          await conn.execute(
            `INSERT INTO media_assets
              (id, tenant_id, product_id, type, provider, object_key, mime_type, size_bytes, status)
             VALUES (?, ?, ?, 'image', ?, ?, ?, ?, 'active')`,
            [
              coverIds[mi],
              TENANT,
              productId,
              (SKIP_OSS && !(process.env.OSS_BUCKET && process.env.OSS_PROVIDER === 'aliyun')) ? 'local' : 'aliyun',
              m.objectKey,
              m.mime,
              m.size,
            ],
          );
        }

        const skuCodes = new Set();
        for (const color of colors) {
          const skuCode = `${note.styleNo}-${color || 'NA'}`;
          if (skuCodes.has(skuCode)) continue;
          skuCodes.add(skuCode);
          await conn.execute(
            `INSERT INTO product_skus
              (id, tenant_id, product_id, sku_code, color, size, price, stock, status)
             VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, 'active')`,
            [uuid(), TENANT, productId, skuCode, color],
          );
        }
      }

      report.products.push({
        styleNo: note.styleNo,
        name,
        imageCount: mediaRows.length,
        skuColors: colors.filter(Boolean),
        sizes: sizes.filter(Boolean),
        sampleUrl: mediaRows[0]?.url,
        coverUrls: mediaRows.map((m) => m.url),
      });
    }

    if (!DRY) await conn.commit();
    else await conn.rollback();
  } catch (e) {
    try {
      await conn.rollback();
    } catch (_) {}
    throw e;
  } finally {
    await conn.end();
  }

  // Verify sample URLs
  console.log('--- verify ---');
  let broken = 0;
  for (const p of report.products) {
    for (const url of p.coverUrls) {
      const code = await headOk(url);
      const ok = code >= 200 && code < 300;
      if (ok) report.verify.ok++;
      else {
        broken++;
        report.verify.broken.push({ url, code });
        console.log(`BROKEN ${code} ${url}`);
      }
    }
  }
  report.verify.brokenCount = broken;
  console.log(`verify ok=${report.verify.ok} broken=${broken}`);

  const reportPath = path.join(ROOT, 'docs', 'wechat_notes_recreate_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`report ${reportPath}`);
  if (broken > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
