/**
 * Directly exercise buildPublishSuggestion against real product images.
 * Usage: node scripts/smoke_publish_analyze.mjs
 */
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
process.chdir(root);

// Prefer compiled dist; fall back to registering ts-node if needed
let buildPublishSuggestion;
const dist = path.join(root, 'dist/products/publish/publish-analyze.js');
if (fs.existsSync(dist)) {
  ({ buildPublishSuggestion } = await import(dist));
} else {
  console.error('dist missing — run nest build first');
  process.exit(1);
}

const BASE = path.join(root, 'storage/tenants/tenant_dev_001/products');

function asset(p, i) {
  return {
    mediaId: `m${i}`,
    objectKey: p,
    url: 'file://' + p,
    filename: path.basename(p),
    mimeType: 'image/jpeg',
    sizeBytes: fs.statSync(p).size,
    localPath: p,
  };
}

async function run(label, files) {
  console.log('\n========', label, '========');
  const assets = files.map((f, i) => asset(f, i + 1));
  const sug = await buildPublishSuggestion(assets, { runOcr: true });
  console.log('styleNo:', sug.styleNo);
  console.log('colors:', sug.colors);
  console.log('colorSource:', sug.colorSource, sug.colorSourceNote || '');
  console.log('material:', sug.material);
  console.log('sizeText:', sug.sizeText);
  console.log('ocrUsed:', sug.ocrUsed, '|', sug.ocrNote);
  for (const im of sug.images) {
    console.log(
      `  [${im.role} c=${im.roleConfidence}] ${im.filename} hint=${im.colorHint || '-'} ocr=${(im.ocrText || '').slice(0, 80)}`,
    );
  }
}

const hang = path.join(BASE, '81029/11.jpg');
const mains = [1, 2, 3, 7, 10, 20, 23].map((n) =>
  path.join(BASE, `81029/${String(n).padStart(2, '0')}.jpg`),
);
const nr48 = path.join(
  BASE,
  '_needs_review/微信图片_20261020161900_48.jpg',
);
const hangtagLike = path.join(BASE, '69322/03.jpg');

await run('A: 81029 多色挂拍单独（应笔记回填多色）', [hang]);
await run('B: 81029 挂拍+角标主图', [hang, ...mains]);
await run('C: needs_review 三色挂拍', [nr48]);
await run('D: 69322 吊牌式主图', [hangtagLike, path.join(BASE, '69322/04.jpg'), path.join(BASE, '69322/05.jpg')]);
