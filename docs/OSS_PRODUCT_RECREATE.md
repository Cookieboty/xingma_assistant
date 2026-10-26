# 商品图重建（微信笔记 → xy-tradex）

## 路径约定

- 业务 `objectKey`：`tenants/{tenantId}/products/{款号}/01.jpg …`
- OSS 完整 key：`xingma-stall/{objectKey}`
- 公网 URL：`https://xy-tradex.oss-cn-shenzhen.aliyuncs.com/xingma-stall/tenants/...`

## 数据源

微信收藏 NoteCache：

`~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/lgd_lc_afe5/business/favorite/temp/NoteCache`

批次默认 `2026102017581854`（`temp_{batch}_{idx}_0.htm` ↔ `微信图片_{batch}_{idx}_*.jpg`）。

## 脚本

```bash
cd backend
# 本地：wipe 商品/SKU/media 后上传 OSS 并写库（不动 promo/jobs）
node scripts/recreate_products_from_wechat_notes.mjs

# 生产：NoteCache 已在机器上时，若对象已在 OSS，可只写库
WECHAT_FAVORITE_DIR=/tmp/xm_fav node scripts/recreate_products_from_wechat_notes.mjs --skip-oss
```

`--dry-run` / `--skip-wipe` / `--skip-oss` 可用。密钥只读 `.env`，不入库。

## 2026-10-26 执行结果

- 范围：仅 `tenant_dev_001` 商品（11 款 / 121 图）；promo/jobs 未重建
- 本地 + 生产 DB 均重建；图片上传 xy-tradex `xingma-stall`
- 校验：121 张 cover URL HEAD 均为 200
