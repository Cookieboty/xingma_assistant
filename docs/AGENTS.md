# AGENTS — 给模型的最短读序

改羊毛衫档口（`wool-stall-miniapp`）代码前按此顺序，**勿编造未实现 API**。

## 读序

1. **[INDEX.md](./INDEX.md)** — 产品一句话、目录、怎么跑、概念、速查表  
2. **[PRD.md](./PRD.md)** — 需求与验收；标了「目标态」的先别当已上线  
3. **[TECH.md](./TECH.md)** — 表、API、时序、环境变量名、部署只动 `wool-api`  
4. **再改代码** — 用 INDEX 速查表打开对应目录；对照 `backend/src/**/*.controller.ts` 与小程序 `pages/`  

## 硬约束

- 密钥只出现在服务器 `.env` / 租户表；文档与小程序禁止写 Secret/Key 值  
- 生产域名 `https://xingma.visitworld.me`，AppID `wx394d23ea099d8a01`  
- 客户无登录 UI；分享落地静默鉴权  
- 部署/重启：**只动 pm2 进程 `wool-api`**  
- 新能力若未合入：PRD 标目标态，TECH 写目标设计，代码与文档同步更新  

## 历史稿

`技术方案.md` / `部署.md` / `发品与迁移.md` / `生图模板设计.md` 可作补充；冲突时以 **PRD + TECH + 当前代码** 为准。
