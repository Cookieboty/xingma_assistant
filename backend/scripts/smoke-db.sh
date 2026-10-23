#!/usr/bin/env bash
# DB 模式冒烟：需 DB_ENABLED=true + DEV_FAKE_LOGIN=true 启动的服务。用法：BASE=http://127.0.0.1:3000 bash scripts/smoke-db.sh
set -u
BASE=${BASE:-http://127.0.0.1:3000}
H=(-H 'Content-Type: application/json' -H 'X-Wx-Appid: wx394d23ea099d8a01')
j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);console.log($1)}catch(e){console.log('PARSE_ERR',s)}})"; }
login() { curl -s "${H[@]}" -X POST $BASE/api/auth/login -d "{\"code\":\"$1\",\"preferRole\":\"$2\"}"; }
TS=$(date +%s)
echo "--- 1 auth"
STAFF=$(login dev_staff_a staff); echo "$STAFF" | j 'o.role+" "+o.memberId+" "+o.openid'
ST=$(echo "$STAFF" | j o.token)
C1=$(login dev_customer_a customer); echo "$C1" | j 'o.role+" "+o.customerId'
C1T=$(echo "$C1" | j o.token)
C2T=$(login dev_customer_b customer | j o.token)
A=(-H "Authorization: Bearer $ST")
echo "--- 2 levels"
curl -s "${H[@]}" "${A[@]}" $BASE/api/levels/product | j 'o.map(x=>x.id).join(",")'
NL=$(curl -s "${H[@]}" "${A[@]}" -X POST $BASE/api/levels/customer -d "{\"code\":\"L9_$TS\",\"name\":\"测试等级\",\"rank\":9}"); echo "$NL" | j 'o.id+" "+o.code'
echo "--- 3 products"
P=$(curl -s "${H[@]}" "${A[@]}" -X POST $BASE/api/products -d "{\"styleNo\":\"S$TS\",\"name\":\"测试羊毛衫\",\"levelId\":\"pl_vip\",\"status\":\"on_sale\",\"material\":\"羊毛\",\"tags\":[\"新款\"],\"skus\":[{\"color\":\"红\",\"size\":\"M\",\"price\":99,\"stock\":5}]}")
echo "$P" | j 'o.id+" "+o.styleNo+" "+JSON.stringify(o.tags)'
PID=$(echo "$P" | j o.id)
curl -s "${H[@]}" "${A[@]}" "$BASE/api/products?q=S$TS" | j '(o.items||o).length+" found"'
curl -s "${H[@]}" "${A[@]}" -X PATCH $BASE/api/products/$PID -d '{"name":"测试羊毛衫-改"}' | j o.name
curl -s "${H[@]}" "${A[@]}" $BASE/api/products/$PID | j 'o.name+" skus="+(o.skus||[]).length'
echo "--- 4 shares (designated_only)"
SH=$(curl -s "${H[@]}" "${A[@]}" -X POST $BASE/api/shares -d "{\"productId\":\"$PID\"}"); echo "$SH" | j 'o.shareId+" "+o.path'
SID=$(echo "$SH" | j o.shareId)
curl -s "${H[@]}" -H "Authorization: Bearer $C1T" $BASE/api/shares/$SID/open | j 'o.access+" bound="+(o.share&&o.share.boundCustomerId)+" "+(o.message||"")'
curl -s "${H[@]}" -H "Authorization: Bearer $C1T" $BASE/api/shares/$SID/open | j '"revisit: "+(o.access||o.message)'
curl -s "${H[@]}" -H "Authorization: Bearer $C2T" $BASE/api/shares/$SID/open | j '"other customer: "+(o.statusCode||"")+" "+(o.message||o.access)'
echo "--- 5 inquiries"
curl -s "${H[@]}" -H "Authorization: Bearer $C1T" -X POST $BASE/api/inquiries -d "{\"productId\":\"$PID\",\"content\":\"多少钱\"}" | j 'o.id+" "+o.status'
curl -s "${H[@]}" "${A[@]}" $BASE/api/inquiries | j 'o.length+" inquiries (staff)"'
echo "--- 6 customers"
CID=$(echo "$C1" | j o.customerId)
curl -s "${H[@]}" "${A[@]}" $BASE/api/customers | j '(o.items||o).length+" customers"'
curl -s "${H[@]}" "${A[@]}" -X PATCH $BASE/api/customers/$CID/level -d '{"levelId":"cl_vip"}' | j 'o.levelCode+" rank="+o.rank'
curl -s "${H[@]}" "${A[@]}" -X POST $BASE/api/customers/$CID/follow-ups -d '{"content":"电话回访"}' | j 'o.id+" "+o.content'
curl -s "${H[@]}" "${A[@]}" $BASE/api/customers/$CID | j 'o.levelCode+" firstShare="+o.firstShareEventId+" followUps="+o.followUps.length'
echo "--- 7 secret missing check (DEV_FAKE_LOGIN 下跳过)"
