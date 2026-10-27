# 后端（NestJS）— 星马档口 SaaS API

## 本地启动

```bash
cd backend
cp .env.example .env
npm install
npm run build
npm run start:dev
```

默认 `DB_ENABLED=false`：不连 MySQL，各模块使用**内存 Repository**，重启即丢数据。

密钥（微信 / OSS / IMAGE_GEN / `OUTFIT_AGENT_*` / `VIDEO_LKB_*`）放 `.env` 或 `.secrets/`（已 gitignore），**勿提交**。

## 登录模式

| 变量 | 说明 |
|------|------|
| `DEV_FAKE_LOGIN=true` | 本地开发：不调微信，按 code 派生假 openid；`preferRole=staff/owner` 时自动建成员 |
| `DEV_FAKE_LOGIN=false`（生产） | 用 `WECHAT_APP_ID` + `WECHAT_APP_SECRET`（或 `tenants.wx_app_secret`）调 `jscode2session` |

缺 secret 时 `POST /api/auth/login` 返回 503。openid 命中 `tenant_members` → owner/staff；否则作为客户写入 `customer_profiles`。AppID 取请求头 `X-Wx-Appid` 或 body.appId。

登录可带 `inviteCode`：同时接受员工邀请并签发成员 JWT。

## 连接 MySQL（DB 模式）

```bash
# 1. 建库与账号（示例）
mysql -uroot -p -e "CREATE DATABASE wool_stall DEFAULT CHARSET utf8mb4;
  CREATE USER 'wool'@'localhost' IDENTIFIED BY '<密码>';
  GRANT ALL ON wool_stall.* TO 'wool'@'localhost';"

# 2. 按序执行迁移 001…017（见 migrations/；部分幂等）
for f in migrations/*.sql; do
  echo "== $f =="; mysql -uwool -p wool_stall < "$f" || true
done

# 3. .env：DB_ENABLED=true + DB_* 
npm run build && npm run start:prod

# 4. 冒烟（需 DEV_FAKE_LOGIN=true）
BASE=http://127.0.0.1:3000 bash scripts/smoke-db.sh
```

- 003 种子：租户 `tenant_dev_001` ↔ AppID `wx394d23ea099d8a01`
- `synchronize=false`，表结构以 `migrations/*.sql` 为准
- `.env` 由 `src/load-env.ts` 在模块加载前读入

## 模块与持久化（摘要）

| 模块 | 说明 |
|------|------|
| auth/login/wechat/tenants | 登录、租户解析、联系二维码、客户下载全局开关 |
| invites | 员工/业主邀请码、小程序码、兑换 |
| products + publish | CRUD、分组、异步发品 |
| promo | 宣传图/视频、`promo_sets`、LKB、外部穿搭 |
| jobs | 调度、reclaim、handlers |
| media / vision | OSS、上传、封面选图、媒体分析 |
| customers / levels / shares / inquiries | 客户、等级、分享名额、询价处理流 |

## 主要接口前缀

- `POST /api/auth/login`（可带 `inviteCode`）
- `/api/invites` · `/api/products` · `/api/product-groups` · `/api/products/publish/*`
- `/api/promo/*` · `/api/products/:id/promo/*`
- `/api/jobs` · `/api/shares` · `/api/customers` · `/api/levels/*`
- `/api/inquiries`（含 `claim` / `handled` / `unread-summary`）
- `/api/media/*` · `/api/health`

完整表与时序见 [../docs/TECH.md](../docs/TECH.md)；部署见 [../docs/部署.md](../docs/部署.md)。
