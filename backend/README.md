# 后端（NestJS）— 羊毛衫档口 SaaS API

## 本地启动

```bash
cd backend
cp .env.example .env
npm install
npm run build
npm run start:dev
```

默认 `DB_ENABLED=false`：不连 MySQL，各模块使用**内存 Repository**，重启即丢数据。

## 登录模式

| 变量 | 说明 |
|------|------|
| `DEV_FAKE_LOGIN=true` | 本地开发：不调微信，按 code 派生假 openid；`preferRole=staff/owner` 时自动建成员 |
| `DEV_FAKE_LOGIN=false`（生产） | 用 `WECHAT_APP_ID` + `WECHAT_APP_SECRET`（或 `tenants.wx_app_secret`）调 `jscode2session` |

缺 secret 时 `POST /api/auth/login` 返回 503：「未配置 AppSecret：请在 WECHAT_APP_SECRET 或 tenants.wx_app_secret 中配置」。
openid 命中 `tenant_members` → owner/staff；否则作为客户写入 `customer_profiles`（默认等级）。
AppID 取请求头 `X-Wx-Appid`（小程序自动带）或 body.appId；未注册 AppID 返回 404。

## 连接 MySQL（DB 模式）

```bash
# 1. 建库与账号
mysql -uroot -p -e "CREATE DATABASE wool_stall DEFAULT CHARSET utf8mb4;
  CREATE USER 'wool'@'localhost' IDENTIFIED BY '<密码>';
  GRANT ALL ON wool_stall.* TO 'wool'@'localhost';"

# 2. 按序执行迁移（002/003 幂等，可重复执行）
for f in migrations/001_init_skeleton.sql migrations/002_product_material_tags.sql migrations/003_seed_default_tenant.sql; do
  mysql -uwool -p wool_stall < "$f"
done

# 3. .env：DB_ENABLED=true + DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME
npm run build && npm run start:prod

# 4. 冒烟（需 DEV_FAKE_LOGIN=true）
BASE=http://127.0.0.1:3000 bash scripts/smoke-db.sh
```

- 003 种子：租户 `tenant_dev_001` ↔ AppID `wx394d23ea099d8a01`，客户等级 `cl_default/cl_vip`，商品等级 `pl_open/pl_vip/pl_match`
- `synchronize=false`，表结构以 `migrations/*.sql` 为准；兼容 MySQL 8 与 MariaDB（`rank` 已加反引号）
- `.env` 由 `src/load-env.ts` 在所有模块加载前读入，所以写在 `.env` 里的 `DB_ENABLED` 也会生效

## DB 模式下各模块的持久化

| 模块 | 内存实现 | DB 实现 |
|------|----------|---------|
| auth/login | 内存成员表 | `tenants` / `tenant_members` / `customer_profiles` |
| products | `MemoryProductsRepository` | `TypeOrmProductsRepository`（products + product_skus） |
| levels | `MemoryLevelsRepository` | `TypeOrmLevelsRepository` |
| customers | `MemoryCustomersRepository` | `TypeOrmCustomersRepository`（含跟进、例外规则） |
| shares | Map | `share_events`；首访绑定用 `UPDATE ... WHERE bound_customer_id IS NULL` 条件更新，防并发重复绑定 |
| inquiries | 数组 | `inquiries`（客户只能看自己的） |

## 主要接口前缀

- `POST /api/auth/login`
- `GET/POST/PATCH/DELETE /api/products`（含 SKU、复制、批量上下架）
- `GET/POST/PATCH/DELETE /api/levels/customer|product`
- `GET/PATCH /api/customers`（跟进、批量等级、例外规则）
- `POST /api/shares` / `GET /api/shares/:shareId/open`
- `POST /api/inquiries` / `GET /api/inquiries`
- `POST /api/media/upload-credential` / `POST /api/media/sign`

部署见 `../docs/部署.md`。
