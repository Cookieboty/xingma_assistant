#!/usr/bin/env node
/**
 * 批量重算封面：对每个 on_sale 商品创建 cover_reselect job，轮询至完成。
 * Usage: node scripts/reselect_covers.mjs [--style 76877,81029] [--token JWT]
 */
import 'dotenv/config';

const BASE = process.env.APP_BASE_URL?.includes('127')
  ? 'http://127.0.0.1:3000'
  : process.env.MEDIA_PUBLIC_BASE || 'http://127.0.0.1:3000';
const api = BASE.replace(/\/$/, '');

async function login() {
  if (process.env.TOKEN) return process.env.TOKEN;
  const appId = process.env.WECHAT_APP_ID || '';
  const r = await fetch(`${api}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Wx-Appid': appId },
    body: JSON.stringify({ code: 'dev_reselect_covers', preferRole: 'owner' }),
  });
  const j = await r.json();
  if (!j.token) throw new Error('login failed: ' + JSON.stringify(j));
  return j.token;
}

async function main() {
  const stylesArg = process.argv.find((a, i) => process.argv[i - 1] === '--style');
  const token = await login();
  const list = await fetch(`${api}/api/products?pageSize=50`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  let items = list.items || list.data || [];
  if (stylesArg) {
    const set = new Set(stylesArg.split(','));
    items = items.filter((p) => set.has(p.styleNo));
  }
  console.log(`products=${items.length}`);
  for (const p of items) {
    const created = await fetch(`${api}/api/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'cover_reselect', payload: { productId: p.id } }),
    }).then((r) => r.json());
    console.log(`enqueued ${p.styleNo} job=${created.id}`);
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await fetch(`${api}/api/jobs/${created.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json());
      if (['succeeded', 'failed', 'cancelled'].includes(st.status)) {
        console.log(
          `  ${st.status} via=${st.result?.via} ${st.result?.beforeCoverId?.slice(0, 8)}→${st.result?.afterCoverId?.slice(0, 8)} ${st.result?.reason || st.error || ''}`,
        );
        break;
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
