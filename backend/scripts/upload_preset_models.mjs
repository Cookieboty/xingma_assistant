/**
 * Upload preset model face refs to xy-tradex under xingma-stall/presets/models/
 * Usage: node scripts/upload_preset_models.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AliOss = require('ali-oss');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (process.env[m[1]] != null && process.env[m[1]] !== '') continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

const OSS_PREFIX = String(process.env.OSS_PREFIX || 'xingma-stall').replace(/^\/+|\/+$/g, '');
const PUBLIC_BASE = (process.env.MEDIA_PUBLIC_BASE || 'https://xy-tradex.oss-cn-shenzhen.aliyuncs.com').replace(/\/$/, '');
const IDS = ['f_young', 'f_fresh', 'f_mature', 'f_mom', 'm_young', 'm_mature'];
const srcDir = path.join(root, 'assets/preset-models');

function makeOss() {
  const region = process.env.OSS_REGION || '';
  return new AliOss({
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET,
    region: region.startsWith('oss-') ? region : region ? `oss-${region}` : undefined,
    endpoint: process.env.OSS_ENDPOINT || undefined,
    timeout: 120000,
  });
}

async function main() {
  const oss = makeOss();
  const out = [];
  for (const id of IDS) {
    const local = path.join(srcDir, `${id}.jpg`);
    if (!fs.existsSync(local)) throw new Error(`missing ${local}`);
    const objectKey = `presets/models/${id}.jpg`;
    const ossKey = `${OSS_PREFIX}/${objectKey}`;
    const buf = fs.readFileSync(local);
    await oss.put(ossKey, buf, {
      headers: { 'Content-Type': 'image/jpeg', 'x-oss-object-acl': 'public-read' },
    });
    const url = `${PUBLIC_BASE}/${ossKey}`;
    out.push({ id, objectKey, url, bytes: buf.length });
    console.log(`ok ${id} -> ${url}`);
  }
  const report = path.join(root, '../docs/preset_models_upload_report.json');
  fs.writeFileSync(report, JSON.stringify({ at: new Date().toISOString(), items: out }, null, 2));
  console.log('wrote', report);
}
main().catch((e) => { console.error(e); process.exit(1); });
