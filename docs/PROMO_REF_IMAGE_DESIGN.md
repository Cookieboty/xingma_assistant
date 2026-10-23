# 宣传素材向导 · 风格参考图（上传「我要这种风格」）产品+技术设计

> **状态**：**已定稿 / 已实现**（Ethan 决策已落地；代码见下方「实现备注」）。  
> **对齐代码**：`miniprogram/pages/product/promo/`、`backend/src/promo/promo.service.ts`、`image-gen.client.ts`、`promo.templates.ts`、`media/*`；既有模板说明见 [生图模板设计.md](./生图模板设计.md)。  
> **读者**：产品 / 研发。  
> **同步副本**：`/workspace/wool-docs/PROMO_REF_IMAGE_DESIGN.md`（与本仓库 `docs/` 保持同步）。

---

## Ethan 决策（绑定，2026-10）

| # | 决策 | 落地 |
|---|------|------|
| 1 | 风格样例最多 **4** 张 | `STYLE_REF_RULE.max=4`；前后端双重校验 |
| 2 | UI 放在现有 **「选参考图」卡片内**（商品参考下方可选区）；**不**新增向导步骤 | `promo.wxml` reference 卡内 `style-ref-block` |
| 3 | 增加 **风格强弱**：弱 / 中 / 强，默认 **中** | 字段 `styleStrength: 'weak'\|'medium'\|'strong'` |
| 4 | Prompt **明确禁止**从风格样例抄 **人脸 / 品牌 logo / 商标** | `buildStyleRefPrompt` |
| 5 | 按本设计开始实现 | 本文件状态 → 已实现 |

---

## 1. 背景与问题

当前宣传向导「选参考图」步（`stepKey === 'reference'`）只从**本商品已有图**（`media_assets` / `coverMediaIds`）勾选，经 `referenceAssetIds` 传入生图。这些图的语义是 **服装保真（KEEP）**：颜色、织纹、领型等必须与参考一致（见 `promo.templates.ts` 的 `KEEP` / `KEEP_COLOR_VARIANT`）。

档口日常还需要另一类输入：**「我要这种风格」**——从朋友圈/小红书/竞品截图里挑 1～N 张样例，表达构图、光线、色调、场景氛围、镜头感，而**不是**让模型把样例里的衣服画出来。

本设计把这类图定义为 **风格参考图（style refs）**，与既有 **商品参考图（product refs）** 严格区分，并规定二者如何与模板步骤、上游 `image-to-image` 拼装。

| 概念 | 字段 | 来源 | 职责 |
|------|------|------|------|
| 商品参考图 | `referenceAssetIds[]`（已有） | 本商品 `media_assets` | 服装身份 / KEEP；多色时 1 色 1 图 |
| 风格参考图 | `styleRefObjectKeys[]`（新增） | 用户相册/聊天上传 | 构图·光影·氛围·镜头；**禁止**抄样例服装 / 人脸 / logo |
| 风格强弱 | `styleStrength`（新增） | 弱/中/强（默认中） | 调节 STYLE_REF 段措辞强度 |

---

## 2. 用户流程

### 2.1 入口（不变）

详情「宣传素材」→ `promo-gallery` →「新建」→ `pages/product/promo` → 选模板 → 按 `tpl.steps` 走向导 → `POST …/promo/generate` → 任务中心 / 组列表轮询。

### 2.2 向导内位置（已定：卡片内）

在现有 **「选参考图」** 卡片内增加次级区块，避免多一步、也不打乱 `steps` 枚举：

1. **上方（必选区）**：选商品参考图（逻辑与今天完全一致：`tpl.reference.min/max`、多色 1:1）。
2. **下方（可选区）**：标题「风格样例（可选）」；副文案：「上传你喜欢的成片风格，系统尽量学构图和氛围；衣服仍以商品图为准」；其下「风格强弱」弱/中/强。

### 2.3 主路径

```
选模板
  → 选商品参考图（必选，规则同现网）
  → [可选] 上传 / 管理风格样例 1～4 张 + 选强弱
  → 颜色 / 特征 / 模特 / 姿势场景 / 张数…（按模板）
  → 提交 generate（带上 styleRefObjectKeys + styleStrength）
  → 生图 job；结果进 promo_sets（params 持久化风格键与强弱，便于重生）
```

### 2.4 空态 UX（无风格样例）

- 展示虚线「+ 上传风格样例」按钮 + 一行说明。
- **可不上传直接下一步**；行为与现网 100% 一致（仅商品参考图进上游）。
- 无「必须上传」校验；校验只约束商品参考图。

### 2.5 有样例 UX

- 缩略网格：已上传图可预览、删除（首期不实现拖序；顺序=添加顺序）。
- 达到上限时「+」置灰，toast「最多 4 张」。
- 提交前若仍有本地未传完的文件：toast「风格样例上传中…」，禁止提交。
- 重生（整组 / 单张）：默认**沿用**该 `promo_set.params` 里的 `styleRefObjectKeys` + `styleStrength`；UI 不强制用户重新上传。

### 2.6 与模板的关系

- 所有现网模板均可选用风格样例（含 `multi_color`）。
- `multi_color`：每张出图仍只喂**该色商品参考图**；风格样例作为**整组共用**的附加输入，不按色拆分。

---

## 3. 限制（count / size / format）

| 项 | 值 | 说明 |
|----|-----|------|
| 张数 | **0～4** | Ethan 定稿 |
| 单张大小 | **≤ 5 MB** | 与 `POST /api/media/upload` limit 对齐 |
| 格式 | **jpg / jpeg / png / webp** | 与 `ImageGenClient.mimeOf` 一致；不收 gif/heic |
| 分辨率 | 建议最短边 ≥ 512；过小可 toast 警告但仍可传 | 首期不做硬拒 |
| 来源 | `wx.chooseMedia`（相册+拍照） | 与发品页一致 |
| 是否进商品图库 | **否** | 不写入商品 `coverMediaIds` / 不为风格图建 `media_assets` 商品行 |

超限：前端先拦；后端 `generate` 二次校验，失败 `400` 中文原因。

---

## 4. 风格样例 × 模板 × 商品图：如何组合

### 4.1 优先级原则（写进 prompt + 实现注释）

1. **服装身份**：只信商品参考图（KEEP 不变）。  
2. **版式意图**：模板 + 姿势/场景芯片/自由文案（`poseText`/`sceneText` + enrich）优先于风格样例。  
3. **风格样例**：只借鉴 lighting / color grading / framing / depth of field / lifestyle mood；**忽略样例中的服装、人脸身份、logo、商标、文字**。  
4. 冲突时：商品图 > 模板文案 > 风格样例。

### 4.2 上游 `refs` 拼装顺序

对单次 `ImageGenClient.generate({ prompt, size, refs })`：

```
refs = [
  ...商品参考图本地路径（multi_color 时仅当前色 1 张）,
  ...风格样例本地路径（整组相同，按用户顺序）
]
```

- `referenceCount = refs.length`（走现有 aijws task 链路）。  
- Prompt 追加 `buildStyleRefPrompt(...)`（`STYLE_REF`），明确前 K 张是 garment reference、后 M 张是 style-only，并按强弱措辞。

### 4.3 风格强弱 → prompt 映射

| strength | 措辞要点 |
|----------|----------|
| `weak` | 轻微借鉴光影/氛围；构图与镜头仍以模板+姿势/场景文案为主 |
| `medium`（默认） | 适度借鉴 lighting / grading / framing / mood，仍服从模板与姿势场景 |
| `strong` | 更强借鉴样例光影构图氛围，但仍不得压过 KEEP 与显式姿势/场景文案 |

### 4.4 空风格

未上传风格样例 → 不改 prompt、不改 refs（现网路径）。风格样例 `ensureLocal` 失败 → 降级去掉失败张继续；全部失败等同无风格；job 日志记 warn。

---

## 5. API（现有接口扩展）

鉴权不变：`JwtAuthGuard` + `owner|staff`。

### 5.1 上传（复用媒体层）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/media/upload-credentials` | `purpose: 'promo_style_ref'`，可选 `productId` / `batchId` / `count` |
| POST | `/api/media/upload` | 中转兜底；同 purpose + 可选 productId；单文件 ≤5MB |
| POST | `/api/media/sign-url` | 预览私有桶风格图（已有） |

小程序：`utils/oss-direct.js` 的 `uploadOneMedia({ purpose: 'promo_style_ref', productId })`（直传优先，失败走 media 中转）。

**首期不登记独立 style-refs 表**：上传拿到 `objectKey` 后存在页面 `data`，提交时塞进 `generate`；`promo_sets.params` 持久化。

### 5.2 生成（扩展）

`POST /api/products/:id/promo/generate` body 增加：

```ts
{
  // …既有字段…
  styleRefObjectKeys?: string[]; // 0～4；须 tenants/{tenantId}/promo_style_ref/ 前缀
  styleStrength?: 'weak' | 'medium' | 'strong'; // 默认 medium；无风格图时可省略
}
```

校验：

- 缺省或 `[]` → 合法（现网）。  
- length ≤ 4；每个 key 必须以 `tenants/${tenantId}/promo_style_ref/` 开头；后缀 jpg/jpeg/png/webp；拒绝 `..` / 跨租户。  
- **禁止**把风格 key 当作 `referenceAssetIds`。

`promo_sets.params` / job payload 一并写入，供 `regenerateSet` / `regenerateImage` 原样带回。

### 5.3 不变的接口

`GET templates|models|presets`、`POST start`、`feature`、`sets*`、`jobs*`、`save` 契约保持；`templateDto` 额外下发 `styleRef: { min:0, max:4, hint }`。

---

## 6. 存储（OSS keys）

### 6.1 风格样例

```
tenants/{tenantId}/promo_style_ref/{productId}/{batchSeg}/{ts}_{i}.{ext}
```

- `purpose = promo_style_ref` + `productId` 时由 `media.service` 拼上述前缀。  
- **不**落到 `…/products/{styleNo}/…` 与成片 promo 目录混放。  
- ACL：private；读用签名 URL。  
- **不**写入 `coverMediaIds` / 不为风格样例建商品 `media_assets`。

### 6.2 成片（不变）

```
tenants/{tenantId}/products/{styleNo}/promo/{legacyJobId|setJobId}/01.png
```

### 6.3 元数据

| 存哪儿 | 内容 |
|--------|------|
| `promo_sets.params` | `styleRefObjectKeys[]` + `styleStrength`（权威） |
| `jobs.payload` | 同上 |
| `media_assets` | **不为风格样例建行** |

### 6.4 生图前落盘

`executeGenerateJob` 对商品参考图与风格样例均走 **ensureLocal(objectKey)**（本地已有则复用，否则 OSS GET → `storage/`）。风格图失败降级；商品图失败则报错。

---

## 7. Prompt / 模型注意事项

| 项 | 说明 |
|----|------|
| 模型 | 仍用 `IMAGE_GEN_MODEL`；不新开环境变量 |
| Prompt | 保留 KEEP / PHOTOREAL / NO_TEXT；有风格图时追加 `buildStyleRefPrompt` |
| 多色 | 每张：`refs = [该色商品图, ...styleRefs]`；整组共用风格键与强弱 |
| 密钥 | 只在服务端 `.env` |

---

## 8. 失败与降级

| 场景 | 行为 |
|------|------|
| 选图超限 / 格式不对 | 前端 toast；后端 400；不建 set |
| OSS 直传失败 | 回退 `/api/media/upload`；仍失败则该张移除并 toast |
| 提交时风格 key 非法 | 400；不静默丢弃 |
| ensureLocal 风格图失败 | **降级**：去掉失败张继续；全部失败 ≡ 无风格 |
| 上游失败 / 未配置密钥 / 防重 | 与现网相同 |

---

## 9. 非目标（Non-goals）

- 不做「风格库 / 跨商品复用收藏夹」。  
- 不做从风格样例自动反推姿势/场景芯片。  
- 不做视频组风格参考。  
- 不把风格样例当作第二套商品图或写入详情轮播。  
- 不训练/微调自有模型；不换生图供应商。  
- 不实现「以图搜模板」。  
- 首期不做拖序、不做独立 `style_ref` 向导步、不做 `POST …/style-refs` 登记 API。

---

## 10. 开放问题（已决议）

| # | 原问题 | 决议 |
|---|--------|------|
| 1 | 张数上限 4？ | **4**（Ethan） |
| 2 | 卡片内 vs 独立步？ | **卡片内可选区**（Ethan） |
| 3 | 强弱开关？ | **要**：弱/中/强，默认中（Ethan） |
| 4 | 人脸？ | **是**：prompt 禁止抄样例人脸/身份，仍用所选预设模特（Ethan） |
| 5 | GC？ | 首期随租户长期留；后续可加未引用 GC |
| 6 | 登记 API？ | 首期 **不需要**；objectKey 直传 + params |
| 7 | ensureLocal 是否顺带修商品参考图？ | **是**：商品与风格均 ensureLocal |
| 8 | 多色 + 风格？ | **整组共用**同一组风格样例与强弱 |

---

## 11. 实现触点（已落地）

| 层 | 文件 / 点 |
|----|-----------|
| 小程序 | `pages/product/promo/promo.{js,wxml,wxss}`：可选上传区 + 强弱；submit 带字段；`utils/oss-direct.js` `uploadOneMedia` |
| API | `promo.service` `GenerateInput` + 校验；`executeGenerateJob` ensureLocal + refs 拼接 + STYLE_REF；params 持久化 |
| 模板 | `promo.templates.ts`：`buildStyleRefPrompt` / `STYLE_REF_RULE`；`templateDto.styleRef` |
| 媒体 | `media.service` purpose `promo_style_ref` + `productId` path |
| 文档 | 本设计；INDEX / PRD / TECH 指针 |

---

## 12. 验收

1. 不上传风格样例：出图与现网无差异。  
2. 上传 1～4 张后生成：任务成功；`promo_sets.params.styleRefObjectKeys` / `styleStrength` 有值；成片服装仍为本款。  
3. 超限/坏格式无法提交。  
4. 整组/单张重生无需重传，沿用 params。  
5. 风格图不出现在商品详情轮播 / 发品图序。  
6. Prompt 含 no-face/logo 规则与强弱措辞。

---

## 实现备注（研发）

- 空 `styleRefObjectKeys` / 省略字段：generate 路径与改动前等价。  
- 重生：`regenerateSet` / `regenerateImage` 已 spread `params`，自动带回风格字段。  
- 前端选图扩展名启发式拦截 gif/heic；后端再验后缀。  
- 未做：拖序、独立步骤、风格库、鉴黄、OSS GC。
