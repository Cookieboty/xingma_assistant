# 羊毛衫档口小程序 — 技术说明（TECH）

> 与当前仓库实现对齐。密钥**只写变量名，不写值**。下列接口与表均为已落地。

## 1. 架构

```
微信小程序 (AppID wx394d23ea099d8a01)
  ├─ 管理端：商品 / 客户 / 任务 / 发品 / 宣传 / 设置
  └─ 客户：share/landing 静默鉴权 → product/detail
           │ HTTPS + JWT + X-Wx-Appid
           ▼
NestJS API (:3000，生产 Nginx → https://xingma.visitworld.me/api/*)
  ├─ login/auth/wechat/tenants
  ├─ products + publish + product-access
  ├─ promo（模板/生图/promo_sets）
  ├─ jobs（scheduler + handlers）
  ├─ media + OssClient
  ├─ vision（封面/发品识图）
  └─ customers / levels / shares / inquiries
           │
     ┌─────┼──────┐
     ▼     ▼      ▼
  MySQL  本地storage  阿里云 OSS（OSS_PROVIDER=aliyun）
  (jobs/  (OCR/开发)   前缀 OSS_PREFIX + tenants/...
   业务表)
```

技术栈：原生微信小程序 + **NestJS** + **MySQL** + **OSS** + **jobs** 表调度（Redis 配置预留，会话/限流暂未强依赖）。

`DB_ENABLED=false` 时部分模块走内存 Repository（开发）；生产必须 `true` + 迁移。

---

## 2. 数据表（migrations）

按序执行：

| 文件 | 内容 |
|------|------|
| `001_init_skeleton.sql` | tenants, tenant_members, customer_levels/profiles, product_levels, products, product_skus, rules, share_events, inquiries, media_assets, follow_ups, view_events… |
| `002_product_material_tags.sql` | 材质/标签相关补丁 |
| `003_seed_default_tenant.sql` | 租户 `tenant_dev_001` ↔ AppID；默认客户/商品等级 |
| `004_jobs.sql` | `jobs` / `job_events` |
| `005_allow_customer_download.sql` | `products.allow_customer_download` |
| `006_promo_sets.sql` | `promo_sets`；`media_assets.promo_set_id` |
| `007_tenant_contact_qr.sql` | `tenants.contact_qr_url` |
| `008_product_groups.sql` | `product_groups`；`products.group_id`；种子本季/过季 |
| `009_member_invites.sql` | `member_invites`（邀请码/角色/次数/过期/小程序码 key） |

### 关键字段速记

**products**：`style_no`（租户内唯一）、`cover_media_ids`（JSON 图序）、`share_policy`、`allow_customer_download`、`price_display`、`status`（`on_sale|off_sale|draft`）、`level_id`、`group_id`

**jobs**：`type`（`publish_product|promo_image|cover_reselect|…`）、`status`、`progress` JSON、`payload`/`result`、`attempts`/`max_attempts`、`next_run_at`

**promo_sets**：`template_id`、`params`、`caption`、`job_id`、`status`（`generating|done|partial|failed`）、`images` JSON

**media_assets**：`object_key`、`provider`、`product_id`、`promo_set_id`

**share_events**：分享策略、`bound_customer_id`（首访绑定）

实体代码：`backend/src/common/entities/`。

---

## 3. 主要 API（前缀 `/api`）

鉴权：除 health 等外，管理接口 `Authorization: Bearer` + 角色守卫；客户接口经分享上下文。

### 认证 / 租户

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/login` | code → JWT；开发 `DEV_FAKE_LOGIN` + `dev_*` code |
| GET/PATCH | `/auth/me` | 当前昵称头像；客户/员工回写 |
| GET | `/tenants/resolve` | AppID → 租户 |
| GET | `/tenants/current` | 当前租户（含 contactQrUrl） |
| PATCH | `/tenants/current/contact-qr` | 设置联系二维码 URL |
| GET | `/health` | 健康检查（`app.controller`：`/api/health`） |

### 员工邀请 invites

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/invites` | **业主**创建邀请 `{ role: owner|staff, maxUses?, expiresInDays? }` → code + wxacodeUrl |
| GET | `/invites` | **业主**邀请列表 |
| GET | `/invites/members` | 业主/员工：当前成员 |
| POST | `/invites/accept` | 已登录用户用 `{ code }` 绑定成员 |
| POST | `/invites/:id/revoke` | **业主**撤销 |
| POST | `/auth/login` | 可带 `inviteCode`：登录同时接受邀请并签发成员 JWT |

小程序：`pages/invite/accept/accept`（wxacode `page`，scene=`c=CODE`）；设置页「员工邀请」替换原占位。客户仍走商品分享，不扫此码。

### 商品

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/products` | 列表（`groupId` 过滤）/ 创建（默认进最新组） |
| GET | `/products/:id/views` | 访问日志 |
| GET/PATCH/DELETE | `/products/:id` | 详情 / 更新（含 coverMediaIds、groupId、allowCustomerDownload） |
| GET/POST | `/product-groups` | 分组列表 / 新建（sortOrder=max+10，可多组） |
| PATCH | `/product-groups/:id` | 改名（可选改 code） |
| PATCH | `/product-groups/:id/latest` | 设为最新组（本季） |
| DELETE | `/product-groups/:id` | 软删（空组、非唯一活跃组；删本季则自动提升另一组） |
| POST | `/product-groups/move-product` | 商品调组 |
| POST | `/products/parse-note` | 大文本解析 |
| POST | `/products/batch-status` | 批量上下架 |
| POST | `/products/:id/copy` | 复制为新款 |
| POST/DELETE | `/products/:id/images`… | 加图 / 删图 |
| POST/PATCH/DELETE | `/products/:id/skus`… | SKU |

### 发品 publish

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/products/publish/async` | **主路径**：multipart `files` → 草稿 + 入队，返回 jobId+productId |
| POST | `/products/publish/:batchId/enqueue` | 已有 batch 入队 |
| POST | `/products/publish/upload` | 仅攒图（兼容） |
| POST | `/products/publish/:batchId/analyze` | 分析角色/SKU/吊牌建议 |
| POST | `/products/publish/confirm` | 人工确认建品（旧路径） |

### 宣传 promo

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/promo/templates` `/promo/models` `/promo/presets` | 模板与预设 |
| POST | `/products/:id/promo/start` | 开始向导数据 |
| GET/PUT | `/products/:id/promo/feature` | 特征草案 |
| POST | `/products/:id/promo/generate` | 创建 promo_set + job |
| GET | `/products/:id/promo/sets` `/sets/:setId` | 列表 / 详情 |
| DELETE | `/products/:id/promo/sets/:setId` | 删组 |
| POST | `…/sets/:setId/regenerate` | 整组重生成 |
| POST | `…/sets/:setId/images/:index/regenerate` | 单张重生成 |
| GET | `/products/:id/promo/jobs`… | 兼容旧 job 查询 |
| POST | `…/promo/jobs/:jobId/save` | 选图保存进商品（兼容） |

### 任务 jobs

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/jobs` | 创建（内部/扩展） |
| GET | `/jobs` | 列表（筛选 type/status） |
| GET | `/jobs/meta/handlers` | 已注册 handler |
| GET | `/jobs/:id` `/jobs/:id/events` | 详情 / 事件 |
| POST | `/jobs/:id/retry` `/cancel` | 重试 / 取消 |
| POST | `/jobs/reclaim-orphans` | 业主：回收孤儿/陈旧 running → 重排队 |

### 其他

| 前缀 | 说明 |
|------|------|
| `/shares` | POST 创建；GET `:shareId/open` 首访绑定 |
| `/customers` | 列表/等级/跟进/例外规则 |
| `/levels/customer|product` | 等级 CRUD |
| `/inquiries` | 询价 |
| `/media/upload-credential` `/media/sign` | 上传凭证与签名 |

---

## 4. 核心流程时序

### 4.1 选图异步发品

```
员工                小程序                 API                    jobs/vision/OSS
 |-- 选图累加 ------>|                      |                         |
 |-- 提交 ---------->|-- POST publish/async -->| 落盘(+OSS) media_assets |
 |                   |                      |-- 建 draft product       |
 |                   |                      |-- enqueue publish_product|
 |                   |<-- jobId,productId --|                         |
 |                   |-- 跳转编辑页 ------->|                         |
 |                   |                      |     scheduler claim ---->|
 |                   |                      |<---- 识图/选封面/补全 ---|
 |                   |                      |     patch product        |
 |-- 任务中心查看 -->|-- GET /jobs -------->|                         |
```

batch：内存 Map，TTL≈2h；主路径可不停留在确认页。

### 4.2 宣传素材组

```
详情「宣传素材」→ promo-gallery →「新建」→ promo 向导
  → POST …/promo/generate
  → 写 promo_sets(status=generating) + jobs(type=promo_image)
  → handler 调 IMAGE_GEN_* → 回写 images/caption/media
  → 列表轮询；可整组/单张 regenerate；caption 复制；勾选存相册
```

详情页缩略：`GET …/promo/sets` 取 thumb 展示，点击带 setId 进 gallery。

风格样例（已实现）：向导「选参考图」卡内可选上传 0～4 张 + 强弱弱/中/强；API `styleRefObjectKeys` / `styleStrength`；见 [PROMO_REF_IMAGE_DESIGN.md](./PROMO_REF_IMAGE_DESIGN.md)。

### 4.3 分享指定客户

```
员工 POST /shares { designated_only } → shareId
客户打开 landing?shareId
  → 静默 login → GET /shares/:id/open
  → ensureProfile；若 unbound 则绑定当前客户
  → 他人再开同 shareId → 拒绝
  → redirect detail?id&shareEventId
```

公开分享：创建时策略为 open（或商品本身 open），不要求绑定同一人。

### 4.5 员工/业主邀请

```
业主 设置→生成邀请(role) → member_invites + getwxacodeunlimit(scene=c=CODE)
邀请人扫码 → pages/invite/accept → wx.login + POST /auth/login{inviteCode}
  → acceptByCode → tenant_members(role) → JWT owner|staff → 工作台
```

### 4.4 封面选择（禁下图）

`cover-select`：排除 size_chart / lab_report / hangtag / coupon / 纯文字等；展示桶：主图 → 细节 → 场景 → 文档类沉底。可走 VISION_* 多模态；失败有启发式兜底。

---

## 5. 环境变量（只列名）

来源：`backend/.env.example`（生产放服务器 `.env`，**不入仓**）。

| 分组 | 变量名 |
|------|--------|
| 服务 | `PORT` `NODE_ENV` `APP_BASE_URL` |
| 微信 | `WECHAT_APP_ID` `WECHAT_APP_SECRET` `DEV_FAKE_LOGIN` |
| MySQL | `DB_ENABLED` `DB_HOST` `DB_PORT` `DB_USER` `DB_PASSWORD` `DB_NAME` |
| Redis（预留） | `REDIS_HOST` `REDIS_PORT` `REDIS_PASSWORD` |
| JWT | `JWT_SECRET` `JWT_EXPIRES_IN` |
| OSS | `OSS_PROVIDER` `OSS_REGION` `OSS_ENDPOINT` `OSS_BUCKET` `OSS_PREFIX` `OSS_ACCESS_KEY_ID` `OSS_ACCESS_KEY_SECRET`；签名过期 `OSS_SIGNED_URL_EXPIRES`（默认 3600，兼容 `OSS_SIGNED_TTL`）；对象 ACL `OSS_OBJECT_ACL=private`；可选 `MEDIA_PUBLIC_BASE` `MEDIA_SERVE_LOCAL` `OSS_PUBLIC_READ`；兼容别名 `ALIYUN_*` |
| 生图 | `IMAGE_GEN_BASE_URL` `IMAGE_GEN_API_KEY` `IMAGE_GEN_MODEL` `IMAGE_GEN_REF_MODE` `IMAGE_GEN_CONCURRENCY` `IMAGE_GEN_TIMEOUT_MS` |
| 视觉 | `VISION_BASE_URL` `VISION_API_KEY` `VISION_MODEL` `VISION_TIMEOUT_MS` `VISION_MAX_CANDIDATES` `VISION_OCR_CONCURRENCY` `ENABLE_MAC_VISION_OCR` |
| 宣传视频 | `VIDEO_GEN_BASE_URL`(默认 VISION) `VIDEO_GEN_API_KEY`(默认 VISION) `VIDEO_GEN_MODEL` `VIDEO_GEN_SECONDS` `VIDEO_GEN_SIZE` `VIDEO_GEN_TIMEOUT_MS` `VIDEO_GEN_POLL_MS` |
| 任务 | `JOB_SCHEDULER` `JOB_CONCURRENCY` `JOB_POLL_MS` `JOB_AUTO_RETRY` `JOB_STALE_MS`（默认 2700000=45min） `DEFAULT_PRODUCT_LEVEL_ID` |

生产检查：`DEV_FAKE_LOGIN=false`；`WECHAT_APP_SECRET` 或 `tenants.wx_app_secret` 已配置；`JWT_SECRET` 非默认串。

---

## 6. 小程序要点

| 项 | 位置 / 值 |
|----|-----------|
| baseUrl / appId | `miniprogram/app.js` → 生产 `https://xingma.visitworld.me` / `wx394d23ea099d8a01` |
| Tab | 商品 list、客户 list、任务 jobs/list |
| 请求封装 | `utils/request.js`（带 token、`X-Wx-Appid`、静默 login） |
| 存相册 | `utils/saveAlbum.js` |
| SKU UI | `components/sku-list` |

合法域名（mp 后台）：request = `xingma.visitworld.me`；uploadFile / **downloadFile** 均需配置 `chathub.oss-cn-hangzhou.aliyuncs.com`（存相册走 `wx.downloadFile`）。

### 私有 OSS 读链接

- Bucket `chathub` 私有读：`OssClient.publicUrl` / `signGetUrl` 对 aliyun 一律返回短时签名 GET（默认约 1h，`OSS_SIGNED_URL_EXPIRES`）。
- 商品/促销/分享/任务缩略图等 API 已通过 `oss.publicUrl(objectKey)` 出链，小程序一般无需改。
- 直传 PostObject / 服务端 put 使用 `OSS_OBJECT_ACL=private`；写权限仍靠 PostObject policy / AK，与私有读无关。
- 临时调试公开桶可读可设 `OSS_PUBLIC_READ=1`（不推荐生产）。

---

## 7. 部署注意（只动 wool-api）

服务器目录：`/srv/wool-stall-miniapp`。同机可能跑**多个** pm2 应用。

**规则**：更新本项目后端时：

1. 同步/拉取 `backend` 代码与依赖  
2. `npm ci && npm run build`（在 backend 目录）  
3. **仅** `pm2 restart wool-api`（或等价只重启该 name）  
4. **不要** `pm2 restart all`，不要动其他项目进程与 Nginx 无关 server  

文档可单独同步到 `/srv/wool-stall-miniapp/docs/`，**无需**重启进程。

迁移：新 SQL 在维护窗口执行；`synchronize=false`，以 `migrations/*.sql` 为准。

更完整的 Nginx/证书清单见历史稿 `部署.md`。

---

## 8. 目标态设计（未实现或仅占位）

### 8.1 客户昵称 / 头像

- **表**：`customer_profiles.nickname` / `avatar_url` 已存在  
- **缺口**：landing 或详情引导 `getUserProfile` / 头像昵称填写 → `PATCH` 客户资料 API（若缺则补 staff/self 可写接口）  
- **约束**：拒绝授权不阻断 `open` 与看商品  

### 8.2 订阅消息

- 在 mp 后台申请模板；后端存 `touser` openid + template_id  
- 任务 `succeeded` 时可选下发（员工）；需用户先 `requestSubscribeMessage`  
- 失败只记日志，不影响 job 状态  

### 8.3 业主二维码

- `tenants` 或业主成员扩展 `qr_media_id` / URL  
- 设置页上传走现有 media  
- 客户详情「联系业主」读该字段；空则占位  

### 8.4 宣传视频组（phase-1 已实现）

- job type `promo_video`；`promo_sets.params.kind=video`；`media_assets.type=video`  
- 上游：xytoken `POST /v1/videos`（`VIDEO_GEN_*` 默认复用 `VISION_*`），模型 `doubao-seedance-2-5-260628`，约 15s、`720x1280`  
- 小程序：详情/素材列表「新建视频」→ `promo?type=video` → 选参考图+特征 → generate；gallery 可播放  
- 后续：更好 prompt → 模特出镜  

---

## 9. 相关代码索引

| 主题 | 路径 |
|------|------|
| 发品 | `src/products/publish/` `jobs/handlers/publish-product.handler.ts` |
| 封面 | `src/vision/cover-select.ts` |
| 宣传 | `src/promo/` `jobs/handlers/promo-image.handler.ts` |
| 任务标题 | `src/jobs/job-display-title.ts` |
| OSS | `src/media/oss.client.ts` |
| 访问控制 | `src/products/product-access.service.ts` |
| 邀请 | `src/invites/` `pages/invite/accept` `pages/settings` |



### 任务孤儿回收（running 卡死）

单进程 worker：调度器只 claim `queued`；进程死亡后 `running` 会永久卡住。

- **启动**：`JobSchedulerService.onModuleInit` 调用 `JobsService.reclaimOrphanedRunning({ onlyStale: false })`，把**全部** `running` 改回 `queued`（清 `lockedBy`，进度消息「进程中断，已重新排队继续」；`attempts` 减 1 抵消 claim，不轻易烧尽 `maxAttempts`）。
- **运行中**：约每 20 tick / 60s 对 `updated_at` 早于 `JOB_STALE_MS`（默认 45 分钟）的 `running` 同样重排队。活任务靠 `updateProgress`→`save` 刷新 `updated_at`。
- **不**因孤儿/陈旧标记 `failed`；仅 handler 抛错且 attempts 用尽、或用户取消才结束。
- `promo_image`：关联 `promo_sets` 若误为 `failed`，重排队时改回 `generating`；本来就是 `generating` 则保持。
- 手动：`POST /api/jobs/reclaim-orphans`（owner）。

## 附录：宣传多色与去重

- `buildJobDisplayTitle`：`templateId=multi_color` → `多色展示 · 款号… · N色`，不用「场景里的模特」。
- 多色展示：N 色 → N 张上身图（同模特/姿态/场景，每张只喂该色参考）；非拼贴。
- `promo.generate`：同商品+模板已有 generating/queued 任务则**复用**，不双开。
- `listJobs`：进行中框架 job 与挂 `_frameworkJobId` 的 legacy `pj_*` 去重，只留一条。
- 任务列表 / `listSets`：进行中同 setId 或同模板只展示一条；隐藏空壳 generating 幽灵组。

## 附录：媒体中转上传

- `POST /api/media/upload` multipart `file`（员工）：落盘 `storage/tenants/...` + OSS `putObjectSafe`，返回 `{ url, objectKey }`。
