#!/usr/bin/env node
/**
 * 把 product_view_events / inquiries / share_events / promo_sets / jobs.payload
 * 里指向已删除商品 UUID 的记录，按 styleNo（来自 jobs）或 round-robin 映射到现有 11 款。
 *
 * Usage: node scripts/remap_orphaned_product_refs.mjs [--dry-run] [--tenant tenant_dev_001]
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const dry = process.argv.includes('--dry-run');
const tenant = (() => {
  const i = process.argv.indexOf('--tenant');
  return i >= 0 ? process.argv[i + 1] : 'tenant_dev_001';
})();

function mysql() {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || '3306',
    user: process.env.DB_USER || 'wool',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'wool_stall',
  };
}
function sql(q) {
  const c = mysql();
  return execFileSync(
    'mysql',
    ['-h', c.host, '-P', String(c.port), `-u${c.user}`, `-p${c.password}`, c.database, '-N', '-B', '-e', q],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}
function rows(q) {
  const out = sql(q).trim();
  if (!out) return [];
  return out.split('\n').map((l) => l.split('\t'));
}

function buildStyleMapFromJobs() {
  // oldProductId -> Counter(styleNo)
  const out = sql(
    `SELECT CAST(payload AS CHAR), CAST(IFNULL(result,'') AS CHAR) FROM jobs WHERE tenant_id='${tenant}'`,
  );
  const map = new Map();
  const rePid = /"productId"\s*:\s*"([0-9a-f-]{36})"/gi;
  const reStyle = /"styleNo"\s*:\s*"([^"]+)"/i;
  const reDraft = /"draftStyleNo"\s*:\s*"([^"]+)"/i;
  const reName76877 = /款号\s*76877|styleNo"\s*:\s*"76877/i;
  for (const line of out.split('\n')) {
    const styles = [];
    const sm = line.match(reStyle);
    const dm = line.match(reDraft);
    if (sm) styles.push(sm[1]);
    if (dm) styles.push(dm[1]);
    // V-draft that is really 76877
    if (styles.includes('V202610231928408A') || reName76877.test(line)) styles.push('76877');
    const pids = [...line.matchAll(rePid)].map((m) => m[1]);
    for (const pid of pids) {
      if (!map.has(pid)) map.set(pid, new Map());
      const ctr = map.get(pid);
      for (const s of styles) {
        // normalize draft codes away when 76877 present
        const key = s.startsWith('V20') && styles.includes('76877') ? '76877' : s;
        if (key.startsWith('V20')) continue;
        ctr.set(key, (ctr.get(key) || 0) + 1);
      }
    }
  }
  const best = new Map();
  for (const [pid, ctr] of map) {
    let top = null;
    let n = -1;
    for (const [s, c] of ctr) {
      if (c > n) {
        n = c;
        top = s;
      }
    }
    if (top) best.set(pid, top);
  }
  return best;
}

function tableExists(name) {
  const r = rows(
    `SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='${name}' LIMIT 1`,
  );
  return r.length > 0;
}

/** 已核对 jobs.payload 的旧商品→款号（覆盖自动抽取冲突） */
const VERIFIED_OLD_TO_STYLE = {
  '29e2b052-0119-4555-bee5-9575479b0330': '72733',
  '51368ccc-105b-4b53-94ad-fa5591ada49a': '72516',
  'a36f87ba-d1e2-4bce-89c3-abd82536647e': '76877',
  '34c1af58-894e-45fc-a54a-b186ad8e1a83': '72769',
  '1f5621b6-b14b-4d6e-9a77-f7d51cdc963c': '76877',
  'fe530a30-d068-451d-9dd6-f42597dd68cd': '79922',
  'c795ac97-e612-4db3-9b0b-fdcaffcb67a6': '69322',
};

function main() {
  const products = rows(`SELECT id, style_no FROM products WHERE tenant_id='${tenant}' ORDER BY style_no`);
  if (!products.length) throw new Error('no products');
  const styleToId = new Map(products.map(([id, s]) => [s, id]));
  // round-robin 只用正式款号（排除草稿 V20…）
  const ids = products.filter(([, s]) => /^\d+$/.test(s)).map(([id]) => id);
  console.log(`tenant=${tenant} products=${products.length} demoIds=${ids.length} dry=${dry}`);
  console.log('styles', [...styleToId.keys()].join(','));

  const autoMap = buildStyleMapFromJobs();
  const styleMap = new Map(autoMap);
  for (const [old, style] of Object.entries(VERIFIED_OLD_TO_STYLE)) {
    styleMap.set(old, style);
  }
  console.log('old→style (verified overrides auto):');
  for (const [old, style] of styleMap) {
    console.log(`  ${old} → ${style} (${styleToId.get(style) || 'MISSING'})`);
  }

  const tables = [
    ['product_view_events', 'product_id'],
    ['inquiries', 'product_id'],
    ['share_events', 'product_id'],
    ['promo_sets', 'product_id'],
    ['customer_product_rules', 'product_id'],
  ].filter(([table]) => {
    const ok = tableExists(table);
    if (!ok) console.log(`skip missing table ${table}`);
    return ok;
  });

  const orphanIds = new Set();
  for (const [table, col] of tables) {
    const r = rows(
      `SELECT DISTINCT t.${col} FROM ${table} t LEFT JOIN products p ON p.id=t.${col} WHERE t.tenant_id='${tenant}' AND p.id IS NULL`,
    );
    for (const [id] of r) if (id) orphanIds.add(id);
  }
  console.log(`orphan product ids: ${orphanIds.size}`);

  // assign mapping
  const rr = [...ids];
  let rrI = 0;
  const oldToNew = new Map();
  for (const old of orphanIds) {
    const style = styleMap.get(old);
    let neu = style && styleToId.get(style);
    if (!neu) {
      neu = rr[rrI % rr.length];
      rrI += 1;
      console.log(`  round-robin ${old} → ${neu}`);
    } else {
      console.log(`  style-map ${old} → ${style} → ${neu}`);
    }
    oldToNew.set(old, neu);
  }

  const summary = { at: new Date().toISOString(), tenant, dry, oldToNew: Object.fromEntries(oldToNew), updates: {} };

  for (const [table, col] of tables) {
    let n = 0;
    for (const [old, neu] of oldToNew) {
      const cntRow = rows(
        `SELECT COUNT(*) FROM ${table} WHERE tenant_id='${tenant}' AND ${col}='${old}'`,
      );
      const cnt = Number(cntRow[0]?.[0] || 0);
      if (!cnt) continue;
      n += cnt;
      if (!dry) {
        sql(`UPDATE ${table} SET ${col}='${neu}' WHERE tenant_id='${tenant}' AND ${col}='${old}'`);
      }
      console.log(`  ${table}: ${cnt} ${old.slice(0, 8)}→${neu.slice(0, 8)}`);
    }
    summary.updates[table] = n;
  }

  // jobs payload/result productId string replace (best-effort)
  let jobHits = 0;
  if (!dry) {
    for (const [old, neu] of oldToNew) {
      // MySQL JSON: replace in text then cast back — payload is json NOT NULL
      const before = Number(
        rows(
          `SELECT COUNT(*) FROM jobs WHERE tenant_id='${tenant}' AND (CAST(payload AS CHAR) LIKE '%${old}%' OR CAST(IFNULL(result,'') AS CHAR) LIKE '%${old}%')`,
        )[0][0],
      );
      if (!before) continue;
      jobHits += before;
      sql(
        `UPDATE jobs SET payload=CAST(REPLACE(CAST(payload AS CHAR), '${old}', '${neu}') AS JSON), result=IF(result IS NULL, NULL, CAST(REPLACE(CAST(result AS CHAR), '${old}', '${neu}') AS JSON)) WHERE tenant_id='${tenant}' AND (CAST(payload AS CHAR) LIKE '%${old}%' OR CAST(IFNULL(result,'') AS CHAR) LIKE '%${old}%')`,
      );
    }
  } else {
    for (const [old] of oldToNew) {
      jobHits += Number(
        rows(
          `SELECT COUNT(*) FROM jobs WHERE tenant_id='${tenant}' AND (CAST(payload AS CHAR) LIKE '%${old}%' OR CAST(IFNULL(result,'') AS CHAR) LIKE '%${old}%')`,
        )[0][0],
      );
    }
  }
  summary.updates.jobs = jobHits;
  console.log(`jobs touched≈${jobHits}`);

  // verify
  for (const [table, col] of tables) {
    const left = Number(
      rows(
        `SELECT COUNT(*) FROM ${table} t LEFT JOIN products p ON p.id=t.${col} WHERE t.tenant_id='${tenant}' AND p.id IS NULL`,
      )[0][0],
    );
    console.log(`orphan left ${table}: ${left}`);
  }

  const outPath = path.join(root, '..', 'docs', 'remap_orphaned_product_refs_report.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log('report →', outPath);
}

main();
