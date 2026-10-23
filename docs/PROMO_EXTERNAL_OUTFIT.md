# 外部穿搭工作流 Agent 对接（与自建羊毛衫流程并存）

> 品类原则：自建流程是 **羊毛衫（knitwear）专用**；外部 Agent 可作对照或备选引擎。鞋子/裤子/衬衣仍按品类另立，勿糊成一套泛用逻辑。

## 1. 关系

| 引擎 | 说明 | 开关 |
|------|------|------|
| `self` | 本仓库羊毛衫标准流程（`prepareRefsForCategory('knitwear')` + IMAGE_GEN） | 默认 `OUTFIT_ENGINE=self` |
| `external` | 仅调 LKB Agent `ai-adaptive-outfit-workflow` | `OUTFIT_ENGINE=external` 且 `OUTFIT_AGENT_ENABLED=true` |
| `both` | **同图对比**：同一组成衣参考图双跑，两边结果都落盘/留痕 | `OUTFIT_ENGINE=both` |

对比时：**同一批 garment 图**分别进自建链与外部 Agent；结果写入 `promo_sets.images[].compare`（见 TECH §6.3），便于人工并排看。

## 2. 外部 API（定稿）

```
POST http://api-lkb-agent.pymsfz.cn/api/invocations/sync
Authorization: Bearer <Agent 调用 Key>
Content-Type: application/json
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `agentCode` | 是 | 固定 `ai-adaptive-outfit-workflow`（可用 env 覆盖） |
| `messages` | 是 | OpenAPI 必填；`[{ role:"user", content: "<JSON字符串>" }]` |
| content JSON 内 `garmentImages` | 是 | 字符串数组，**1～9** 张成衣图 URL（公网或短时签名） |
| content JSON 内 `modelImageUrl` | 否 | 模特参考图 URL |
| content JSON 内 `instruction` | 否 | 自然语言指令（姿势/场景/氛围等） |

**实测**：`workflow.input.garmentImages` 只认 `messages[0].content` 里的 JSON；顶层再挂 `garmentImages` **无效**。  
成功时结果在 `responsePayload.output.artifacts[].uri`（`type=image`）。

鉴权：`Authorization: Bearer <Agent调用Key>`（缺 Key →「缺少 Agent 调用 Key」；非法 →「登录凭证无效」）。

## 3. Token / secrets（勿入仓）

| 方式 | 配置 |
|------|------|
| `.env` | `OUTFIT_AGENT_API_KEY=...`（`backend/.env` 已 gitignore） |
| 本机文件 | `OUTFIT_AGENT_API_KEY_FILE=.secrets/outfit-agent.key`，文件权限 `600` |

```bash
mkdir -p backend/.secrets
printf '%s' '<Agent调用Key>' > backend/.secrets/outfit-agent.key
chmod 600 backend/.secrets/outfit-agent.key
# backend/.env
OUTFIT_AGENT_ENABLED=true
OUTFIT_AGENT_API_KEY_FILE=.secrets/outfit-agent.key
OUTFIT_ENGINE=both
```

`backend/.secrets/` 已加入根目录 `.gitignore`。文档与代码**禁止**写死 Token。

## 4. 环境变量

见 `backend/.env.example`：

- `OUTFIT_AGENT_ENABLED` `OUTFIT_AGENT_BASE_URL` `OUTFIT_AGENT_API_KEY` / `_FILE`
- `OUTFIT_AGENT_CODE`（默认 `ai-adaptive-outfit-workflow`）
- `OUTFIT_AGENT_TIMEOUT_MS`
- `OUTFIT_ENGINE=self|external|both`

## 5. 代码位置

| 文件 | 职责 |
|------|------|
| `backend/src/promo/external-outfit.client.ts` | HTTP 客户端 + URL 抽取 |
| `backend/src/promo/garment-ref-prepare.ts` | 自建羊毛衫准备（分类/宫格/拒生） |
| `backend/src/promo/promo.service.ts` | 按 `OUTFIT_ENGINE` 调度；`both` 时写 compare 留痕 |

## 6. 同图对比留痕（目标结构）

```json
{
  "compare": {
    "engine": "both",
    "self": { "status": "ok|failed", "objectKey": "...", "prompt": "...", "promptZh": "..." },
    "external": { "status": "ok|failed", "imageUrls": ["https://..."], "requestId": "...", "ms": 12345, "error": null }
  }
}
```

- 默认仍以 `self` 结果作为主图槽位（`objectKey` / 列表展示）。
- `external.imageUrls` 一并返回给前端，便于并排预览（前端 UI 可后补）。
- 外部失败不阻断 self（`both` 模式）；`external` 单引擎失败则任务失败。

## 7. 验收清单

- [ ] 本机放入 Token，不出现在 git diff
- [ ] `OUTFIT_ENGINE=self`：行为与羊毛衫专用流程一致
- [ ] `OUTFIT_ENGINE=external`：仅外部，结果 URL 入库
- [ ] `OUTFIT_ENGINE=both`：同参考图双跑，`compare` 两侧都有记录
- [ ] 未配置 Key 时 external/both 有明确中文错误，不 500 堆栈泄露
