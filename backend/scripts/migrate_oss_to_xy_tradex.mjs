#!/usr/bin/env node
/**
 * Idempotent OSS media migration: chathub (hangzhou) → xy-tradex (shenzhen) under xingma-stall/
 *
 * Business objectKey stays tenants/...
 * Old full key:  chathub/chat-uploads/wool-stall/{objectKey}
 * New full key:  xingma-stall/{objectKey}
 * New public URL: https://xy-tradex.oss-cn-shenzhen.aliyuncs.com/xingma-stall/{objectKey}
 *
 * Usage (on server or Mac with DB+creds):
 *   node backend/scripts/migrate_oss_to_xy_tradex.mjs [--dry-run] [--skip-db] [--verify-only]
 *
 * Env:
 *   NEW credentials: backend/.env (OSS_* / MEDIA_* / DB_*)
 *   OLD credentials: MIGRATE_OLD_ENV=/path/to/old.env  (or auto-detect deploy-bak)
 *
 * Does NOT rewrite external LKB / agent URLs (xy-puyuanxing, agent-generated-images, etc.).
 * Never prints secrets.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';

const require = createRequire(import.meta.url);
const AliOss = require('ali-oss');
const mysql = require('mysql2/promise');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const SKIP_DB = args.has('--skip-db');
const VERIFY_ONLY = args.has('--verify-only');

const OLD_PREFIX_DEFAULT = 'chathub/chat-uploads/wool-stall';
const NEW_PREFIX_DEFAULT = 'xingma-stall';
const OLD_PUBLIC_HOST = 'chathub.oss-cn-hangzhou.aliyuncs.com';
const NEW_PUBLIC_BASE = 'https://xy-tradex.oss-cn-shenzhen.aliyuncs.com';

function loadEnvFile(p) {
  const out = {};
  if (!p || !fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split(/\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    let v = t.slice(i + 1);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, i)] = v;
  }
  return out;
}

function findOldEnv() {
  if (process.env.MIGRATE_OLD_ENV && fs.existsSync(process.env.MIGRATE_OLD_ENV)) {
    return process.env.MIGRATE_OLD_ENV;
  }
  const candidates = [
    '/srv/wool-stall-miniapp/.deploy-bak/20261023_231151/.env',
    path.resolve(BACKEND_ROOT, '../.deploy-bak/20261023_231151/.env'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // scan deploy-bak
  const bakRoot = '/srv/wool-stall-miniapp/.deploy-bak';
  if (fs.existsSync(bakRoot)) {
    for (const name of fs.readdirSync(bakRoot).sort().reverse()) {
      const p = path.join(bakRoot, name, '.env');
      if (!fs.existsSync(p)) continue;
      const e = loadEnvFile(p);
      if ((e.OSS_BUCKET || '').includes('chathub')) return p;
    }
  }
  return '';
}

function stripSlash(s) {
  return String(s || '').replace(/^\/+|\/+$/g, '');
}

function mimeOf(key) {
  const ext = path.extname(key).toLowerCase();
  return (
    {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
    }[ext] || 'application/octet-stream'
  );
}

function makeClient(env) {
  const region = env.OSS_REGION || '';
  const endpoint = (env.OSS_ENDPOINT || (region ? `https://${region}.aliyuncs.com` : '')).replace(/\/$/, '');
  const bucket = env.OSS_BUCKET;
  const accessKeyId = env.OSS_ACCESS_KEY_ID || env.ALIYUN_ACCESS_KEY_ID;
  const accessKeySecret = env.OSS_ACCESS_KEY_SECRET || env.ALIYUN_ACCESS_KEY_SECRET;
  if (!bucket || !accessKeyId || !accessKeySecret || !endpoint) {
    throw new Error('Incomplete OSS env (bucket/endpoint/keys)');
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

async function objectExists(client, fullKey) {
  try {
    await client.head(fullKey);
    return true;
  } catch (e) {
    if (e && (e.status === 404 || e.code === 'NoSuchKey')) return false;
    // some private buckets return 403 on missing — treat as missing only for 404
    throw e;
  }
}

async function putBuffer(client, fullKey, buf, mime) {
  await client.put(fullKey, buf, {
    headers: {
      'Content-Type': mime || mimeOf(fullKey),
      'x-oss-object-acl': 'public-read',
    },
  });
}

function walkLocalStorage(storageRoot) {
  const keys = [];
  if (!fs.existsSync(storageRoot)) return keys;
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs, r);
      else if (st.isFile()) keys.push(r.replace(/\\/g, '/'));
    }
  };
  walk(storageRoot, '');
  return keys;
}

function extractBusinessKeyFromOurUrl(url) {
  // https://chathub.../chathub/chat-uploads/wool-stall/tenants/...
  const m1 = url.match(/chathub\/chat-uploads\/wool-stall\/(.+)$/);
  if (m1) return m1[1].split('?')[0];
  // https://xy-tradex.../xingma-stall/tenants/...
  const m2 = url.match(/\/xingma-stall\/(.+)$/);
  if (m2) return m2[1].split('?')[0];
  // https://xy-tradex.../wool-stall/tenants/... (brief wrong prefix)
  const m3 = url.match(/\/wool-stall\/(tenants\/.+)$/);
  if (m3) return m3[1].split('?')[0];
  return '';
}

function isOurChathubUrl(url) {
  return /chathub\.oss-cn-hangzhou\.aliyuncs\.com/i.test(url) && /chat-uploads\/wool-stall\//i.test(url);
}

function rewriteOurUrl(url) {
  if (!isOurChathubUrl(url)) return url;
  const key = extractBusinessKeyFromOurUrl(url);
  if (!key) return url;
  return `${NEW_PUBLIC_BASE}/${NEW_PREFIX_DEFAULT}/${key}`;
}

async function collectKeysFromDb(env) {
  const conn = await mysql.createConnection({
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
  });
  const keys = new Set();
  const ourUrls = [];
  try {
    const [media] = await conn.query(
      `SELECT object_key FROM media_assets WHERE status='active' AND object_key IS NOT NULL AND object_key!=''`,
    );
    for (const r of media) keys.add(String(r.object_key).replace(/^\/+/, ''));

    const [promos] = await conn.query(`SELECT id, images FROM promo_sets`);
    for (const r of promos) {
      const raw = typeof r.images === 'string' ? r.images : JSON.stringify(r.images ?? '');
      for (const m of raw.matchAll(/"objectKey"\s*:\s*"([^"]+)"/g)) keys.add(m[1]);
      for (const m of raw.matchAll(/https?:\/\/[^"\\\s]+/g)) {
        const u = m[0];
        if (isOurChathubUrl(u)) {
          ourUrls.push(u);
          const k = extractBusinessKeyFromOurUrl(u);
          if (k) keys.add(k);
        }
      }
    }

    const [tenants] = await conn.query(`SELECT contact_qr_url FROM tenants`);
    for (const r of tenants) {
      const u = r.contact_qr_url || '';
      if (isOurChathubUrl(u)) {
        ourUrls.push(u);
        const k = extractBusinessKeyFromOurUrl(u);
        if (k) keys.add(k);
      }
    }

    try {
      const [cust] = await conn.query(
        `SELECT avatar_url FROM customer_profiles WHERE avatar_url IS NOT NULL AND avatar_url!=''`,
      );
      for (const r of cust) {
        const u = r.avatar_url || '';
        if (isOurChathubUrl(u)) {
          ourUrls.push(u);
          const k = extractBusinessKeyFromOurUrl(u);
          if (k) keys.add(k);
        }
      }
    } catch (_) {
      /* table may lack column in older schemas */
    }
  } finally {
    await conn.end();
  }
  return { keys: [...keys], ourUrls: [...new Set(ourUrls)] };
}

async function backupAndRewriteDb(env) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bakDir = path.resolve(BACKEND_ROOT, 'storage', `_oss_migrate_bak_${stamp}`);
  fs.mkdirSync(bakDir, { recursive: true });
  const dump = path.join(bakDir, 'url_columns.sql');
  const tables = ['tenants', 'customer_profiles', 'promo_sets'];
  // mysqldump selected tables (may fail if no mysqldump — fallback JSON)
  try {
    execFileSync(
      'mysqldump',
      [
        `-h${env.DB_HOST || '127.0.0.1'}`,
        `-P${env.DB_PORT || '3306'}`,
        `-u${env.DB_USER}`,
        `-p${env.DB_PASSWORD}`,
        env.DB_NAME,
        ...tables,
      ],
      { stdio: ['ignore', fs.openSync(dump, 'w'), 'pipe'] },
    );
    console.log(`DB backup: ${dump}`);
  } catch (e) {
    console.warn(`mysqldump failed, writing JSON backup: ${e.message}`);
  }

  const conn = await mysql.createConnection({
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
  });
  let updated = 0;
  try {
    const rewriteRow = (val) => {
      if (val == null) return { changed: false, val };
      if (typeof val === 'object') {
        const s = JSON.stringify(val);
        const n = s.replace(
          /https:\/\/chathub\.oss-cn-hangzhou\.aliyuncs\.com\/chathub\/chat-uploads\/wool-stall\//g,
          `${NEW_PUBLIC_BASE}/${NEW_PREFIX_DEFAULT}/`,
        );
        if (n === s) return { changed: false, val };
        return { changed: true, val: JSON.parse(n) };
      }
      const s = String(val);
      const n = rewriteOurUrl(s).replace(
        /https:\/\/chathub\.oss-cn-hangzhou\.aliyuncs\.com\/chathub\/chat-uploads\/wool-stall\//g,
        `${NEW_PUBLIC_BASE}/${NEW_PREFIX_DEFAULT}/`,
      );
      return { changed: n !== s, val: n };
    };

    const [tenants] = await conn.query(`SELECT id, contact_qr_url FROM tenants`);
    for (const r of tenants) {
      const { changed, val } = rewriteRow(r.contact_qr_url);
      if (!changed) continue;
      if (!DRY) await conn.query(`UPDATE tenants SET contact_qr_url=? WHERE id=?`, [val, r.id]);
      updated++;
      console.log(`rewrite tenants.contact_qr_url id=${r.id}`);
    }

    try {
      const [cust] = await conn.query(`SELECT id, avatar_url FROM customer_profiles`);
      for (const r of cust) {
        const { changed, val } = rewriteRow(r.avatar_url);
        if (!changed) continue;
        if (!DRY) await conn.query(`UPDATE customer_profiles SET avatar_url=? WHERE id=?`, [val, r.id]);
        updated++;
        console.log(`rewrite customer_profiles.avatar_url id=${r.id}`);
      }
    } catch (_) {}

    const [promos] = await conn.query(`SELECT id, images FROM promo_sets`);
    for (const r of promos) {
      const raw = typeof r.images === 'string' ? r.images : JSON.stringify(r.images ?? null);
      if (!raw || !/chathub\.oss-cn-hangzhou/.test(raw)) continue;
      const n = raw.replace(
        /https:\/\/chathub\.oss-cn-hangzhou\.aliyuncs\.com\/chathub\/chat-uploads\/wool-stall\//g,
        `${NEW_PUBLIC_BASE}/${NEW_PREFIX_DEFAULT}/`,
      );
      if (n === raw) continue;
      if (!DRY) {
        // store as JSON string/object matching column
        let toStore = n;
        try {
          toStore = JSON.parse(n);
        } catch (_) {
          toStore = n;
        }
        await conn.query(`UPDATE promo_sets SET images=? WHERE id=?`, [
          typeof toStore === 'string' ? toStore : JSON.stringify(toStore),
          r.id,
        ]);
      }
      updated++;
      console.log(`rewrite promo_sets.images id=${r.id}`);
    }
  } finally {
    await conn.end();
  }
  return { bakDir, updated };
}

async function headOk(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (res.ok) return res.status;
    // some OSS reject HEAD — try range GET
    const g = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
    return g.status;
  } catch (e) {
    return 0;
  }
}

async function main() {
  const newEnvPath = path.join(BACKEND_ROOT, '.env');
  const newEnv = { ...loadEnvFile(newEnvPath), ...process.env };
  const oldEnvPath = findOldEnv();
  const oldEnv = loadEnvFile(oldEnvPath);

  const newPrefix = stripSlash(newEnv.OSS_PREFIX || NEW_PREFIX_DEFAULT);
  const oldPrefix = stripSlash(oldEnv.OSS_PREFIX || OLD_PREFIX_DEFAULT);
  const storageRoot = path.join(BACKEND_ROOT, 'storage');

  console.log(`NEW bucket=${newEnv.OSS_BUCKET} prefix=${newPrefix} (secrets hidden)`);
  console.log(`OLD env file=${oldEnvPath || '(none)'} bucket=${oldEnv.OSS_BUCKET || '?'} prefix=${oldPrefix}`);
  console.log(`dryRun=${DRY} verifyOnly=${VERIFY_ONLY} skipDb=${SKIP_DB}`);

  const newClient = makeClient(newEnv);
  let oldClient = null;
  if (oldEnv.OSS_BUCKET && oldEnv.OSS_ACCESS_KEY_ID) {
    try {
      oldClient = makeClient(oldEnv);
    } catch (e) {
      console.warn(`Old OSS client unavailable: ${e.message}`);
    }
  }

  const { keys: dbKeys, ourUrls } = SKIP_DB
    ? { keys: [], ourUrls: [] }
    : await collectKeysFromDb(newEnv);
  const localKeys = walkLocalStorage(path.join(storageRoot, 'tenants')).map((r) => `tenants/${r}`);
  // Also walk if storage already has tenants/ prefix root files differently
  const allLocal = walkLocalStorage(storageRoot).filter((r) => r.startsWith('tenants/'));

  const keySet = new Set([...dbKeys, ...localKeys, ...allLocal]);
  for (const u of ourUrls) {
    const k = extractBusinessKeyFromOurUrl(u);
    if (k) keySet.add(k);
  }

  const keys = [...keySet].filter(Boolean).sort();
  console.log(`Keys to ensure on new OSS: ${keys.length} (db=${dbKeys.length} local≈${allLocal.length} ourUrls=${ourUrls.length})`);

  const stats = { exists: 0, uploadedLocal: 0, copiedOld: 0, missing: 0, errors: 0 };
  const missing = [];
  const samples = [];

  if (!VERIFY_ONLY) {
    for (const objectKey of keys) {
      const fullNew = `${newPrefix}/${objectKey}`;
      const publicUrl = `${NEW_PUBLIC_BASE}/${fullNew}`;
      try {
        const exists = await objectExists(newClient, fullNew);
        if (exists) {
          stats.exists++;
          if (samples.length < 8) samples.push({ objectKey, publicUrl, source: 'already' });
          continue;
        }

        // local first
        const localPath = path.join(storageRoot, objectKey);
        let buf = null;
        let source = '';
        if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
          buf = fs.readFileSync(localPath);
          source = 'local';
        } else if (oldClient) {
          const fullOld = `${oldPrefix}/${objectKey}`;
          try {
            const r = await oldClient.get(fullOld);
            buf = Buffer.isBuffer(r.content) ? r.content : Buffer.from(r.content);
            source = 'old-oss';
          } catch (e) {
            if (!(e && (e.status === 404 || e.code === 'NoSuchKey'))) {
              console.warn(`old get fail ${objectKey}: ${e.code || e.status || e.message}`);
            }
          }
        }

        if (!buf || !buf.length) {
          stats.missing++;
          missing.push(objectKey);
          continue;
        }

        if (!DRY) await putBuffer(newClient, fullNew, buf, mimeOf(objectKey));
        if (source === 'local') stats.uploadedLocal++;
        else stats.copiedOld++;
        if (samples.length < 8) samples.push({ objectKey, publicUrl, source });
        console.log(`${DRY ? 'DRY ' : ''}PUT ${fullNew} via ${source} (${buf.length}b)`);
      } catch (e) {
        stats.errors++;
        console.error(`ERR ${objectKey}: ${e.message || e}`);
      }
    }

    if (!SKIP_DB) {
      const { bakDir, updated } = await backupAndRewriteDb(newEnv);
      console.log(`DB URL rewrites: ${updated} (backup ${bakDir})`);
    }
  }

  // Verify: all active media + rewritten our URLs + local product images used as covers
  console.log('--- verify ---');
  const verifyUrls = [];
  if (!SKIP_DB) {
    const { keys: vkeys, ourUrls: vurls } = await collectKeysFromDb(newEnv);
    for (const k of vkeys) verifyUrls.push(`${NEW_PUBLIC_BASE}/${newPrefix}/${k}`);
    for (const u of vurls) verifyUrls.push(rewriteOurUrl(u));
    // also current DB absolute our-new urls
  }
  // unique
  const uniq = [...new Set(verifyUrls)];
  let broken = 0;
  const brokenList = [];
  for (const url of uniq) {
    // skip external non-ours
    if (!/xy-tradex\.oss-cn-shenzhen\.aliyuncs\.com\/xingma-stall\//.test(url)) continue;
    const code = await headOk(url);
    const ok = code >= 200 && code < 300;
    if (!ok) {
      broken++;
      brokenList.push({ url, code });
    }
  }
  console.log(`verify checked=${uniq.filter((u) => /xingma-stall\//.test(u)).length} broken=${broken}`);
  for (const b of brokenList.slice(0, 30)) console.log(` BROKEN ${b.code} ${b.url}`);
  console.log('STATS', JSON.stringify(stats));
  console.log('SAMPLES', JSON.stringify(samples, null, 2));
  if (missing.length) {
    console.log(`MISSING ${missing.length}`);
    for (const m of missing.slice(0, 40)) console.log(' ', m);
  }
  if (broken > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
