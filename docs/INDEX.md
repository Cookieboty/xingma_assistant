# 羊毛衫档口小程序 — 文档索引

> 给人看也给模型看。改功能前先读本页 → [PRD](./PRD.md) → [TECH](./TECH.md)；模型最短读序见 [AGENTS](./AGENTS.md)。

## 一句话产品

多租户微信小程序：档口业主/员工管商品与客户，客户经分享卡片静默打开详情；支持选图异步发品、宣传素材多组、任务中心。

## 关键标识

| 项 | 值 |
|----|----|
| 仓库根 | `wool-stall-miniapp/` |
| 生产域名 / API | `https://xingma.visitworld.me`（路径 `/api/*`） |
| 小程序 AppID | `wx394d23ea099d8a01` |
| 默认租户 | `tenant_dev_001`（见 `backend/migrations/003_seed_default_tenant.sql`） |
| 后端进程名（生产） | `wool-api`（pm2）；**部署只重启/替换该进程，勿动同机其他服务** |
| 小程序 baseUrl | `miniprogram/app.js` → `globalData.baseUrl` |

## 目录树（关键路径）

```
wool-stall-miniapp/
├── docs/                      # INDEX / PRD / TECH / AGENTS + 历史中文稿
├── backend/                   # NestJS API
│   ├── src/
│   │   ├── login/ auth/ wechat/ tenants/
│   │   ├── products/          # CRUD + product-access
│   │   ├── products/publish/  # 选图发品 / batch / 异步入队
│   │   ├── promo/             # 宣传图模板、生图、promo_sets
│   │   ├── jobs/              # 通用异步任务 + handlers/
│   │   ├── media/             # 上传、签名、OSS
│   │   ├── vision/            # 看图选封面 / 发品识图
│   │   ├── customers/ levels/ shares/ inquiries/
│   │   └── common/entities/   # TypeORM 实体
│   ├── migrations/            # 001…008 SQL
│   ├── storage/               # 本地媒体落盘（OCR/开发）
│   └── .env.example
└── miniprogram/               # 原生微信小程序（开发者工具打开此目录）
    ├── app.js / app.json
    ├── utils/request.js / saveAlbum.js
    ├── components/sku-list/
    └── pages/
        ├── index/             # 员工登录分流
        ├── product/{list,detail,edit,publish,promo,promo-gallery}/
        ├── customer/{list,detail}/
        ├── jobs/list/         # 任务中心 Tab
        ├── inquiry/{list,detail}/
        ├── share/landing/     # 分享静默落地
        └── settings/index/
```

历史文档（仍可参考，以 PRD/TECH 为准）：`技术方案.md`、`部署.md`、`发品与迁移.md`、`生图模板设计.md`；风格样例见 `PROMO_REF_IMAGE_DESIGN.md`（已实现）。

## 本地怎么跑

### 后端

```bash
cd backend
cp .env.example .env
# 本地联调建议：DEV_FAKE_LOGIN=true；可先 DB_ENABLED=false 用内存仓
npm install && npm run build && npm run start:dev
```

- 监听：`http://127.0.0.1:3000`
- 健康检查：`GET /api/health`
- 连 MySQL：`DB_ENABLED=true` + 按序执行 `migrations/001`…`008`（见 TECH）

### 小程序

1. 微信开发者工具导入 `miniprogram/`
2. AppID 已是 `wx394d23ea099d8a01`
3. 本地：`app.js` 临时 `baseUrl: 'http://127.0.0.1:3000'`，详情 → 本地设置 → **不校验合法域名**
4. 上线前改回 `https://xingma.visitworld.me`

### 生产

- API：`https://xingma.visitworld.me/api/*`（Nginx → 本机 Nest `:3000`）
- 代码目录常见：`/srv/wool-stall-miniapp`
- 文档同步目录：`/srv/wool-stall-miniapp/docs/`
- 改后端：**只动 `wool-api`**（build + `pm2 restart wool-api`），勿重启同机其他 pm2 应用

## 文档导航

| 文档 | 用途 |
|------|------|
| [INDEX.md](./INDEX.md) | 本页：入口、跑法、概念、速查 |
| [PRD.md](./PRD.md) | 产品需求：目标 / 角色 / 验收；含「目标态」标注 |
| [TECH.md](./TECH.md) | 架构、表、API、时序、环境变量、部署注意 |
| [AGENTS.md](./AGENTS.md) | 给模型的最短读序与改码约束 |
| [PROMO_REF_IMAGE_DESIGN.md](./PROMO_REF_IMAGE_DESIGN.md) | 宣传向导「风格参考图」产品+技术设计（已定稿/已实现） |

## 关键概念

| 概念 | 含义 |
|------|------|
| **tenant** | 一个档口/一个小程序 AppID；业务表均带 `tenant_id`，请求头 `X-Wx-Appid` 解析 |
| **batch** | 发品上传批次（内存，TTL≈2h）：`batchId` 聚合未确认前的一组图；主路径上传后立刻建草稿商品并入队 |
| **job** | 通用异步任务（表 `jobs`）：类型如 `publish_product` / `promo_image` / `cover_reselect`；状态 queued→running→succeeded/failed/cancelled；进程中断/陈旧 running 由调度器 **reclaim 重排队继续**（不轻易 failed） |
| **promo_set** | 宣传素材组（表 `promo_sets`）：一商品多组；含模板、参数、caption、图片 JSON、关联 `job_id` |
| **coverMediaIds** | 商品封面/图序：`products.cover_media_ids` JSON 数组，顺序即展示序；编辑页可调序写回 |

其他常用：`shareEvent`（分享首访绑定）、`allowCustomerDownload`（客户是否可存图）、`sharePolicy`（`open` / `level_match` / `designated_only`）。

## 「改 XX 功能看这些文件」速查

| 要改的功能 | 优先打开 |
|------------|----------|
| 登录 / 假登录 / 首位业主 | `backend/src/login/` `wechat/` `tenants/`；`miniprogram/pages/index/` `utils/request.js` |
| 商品列表/CRUD/复制/上下架 | `backend/src/products/`；`miniprogram/pages/product/list|edit/` |
| 选图异步发品 / batch | `backend/src/products/publish/` `jobs/handlers/publish-product.handler.ts` `vision/`；`pages/product/publish/` |
| 图序 / 封面 / 禁尺码表下图 | `vision/cover-select.ts`；编辑页调 `coverMediaIds`；`products.entity` |
| SKU 一色一行 / 复制价格 | `miniprogram/components/sku-list/`；商品详情/编辑 SKU API |
| 商品访问鉴权 / 分享策略 | `products/product-access.service.ts` `shares/`；`pages/share/landing/` `pages/product/detail/` |
| 管理员 vs 客户详情 UI | `miniprogram/pages/product/detail/detail.{wxml,js}` |
| 客户可否存相册 | `products.allow_customer_download`；编辑页开关；`utils/saveAlbum.js` |
| 宣传图模板 / 生图 | `backend/src/promo/`；`pages/product/promo/`；历史稿 `生图模板设计.md`；风格样例设计 `PROMO_REF_IMAGE_DESIGN.md` |
| 宣传多组 / 缩略 / 存相册 / 文案 | `promo_sets` + `promo.service`；`pages/product/promo-gallery/`；详情页素材缩略入口 |
| 任务中心友好标题 | `jobs/` `job-display-title.ts`；`pages/jobs/list/` |
| OSS / 媒体 URL | `media/oss.client.ts` `media.service.ts`；环境变量 `OSS_*` |
| 客户档案 / 等级 / 询价 | `customers/` `levels/` `inquiries/`；对应 pages |
| 部署 / Nginx / 合法域名 | `docs/部署.md` + TECH「部署注意」 |

## 不做（首期明确边界）

交易支付物流、读微信好友/笔记客户端、跨档口大厅、聊天直达；宣传**视频**组 UI 已留位，生成链路标目标态。
