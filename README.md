# RelayGate

多平台账号池网关：把 Trae / WorkBuddy / ZCode 账号聚合为一个稳定的
OpenAI / Anthropic / Codex 兼容接口，自动维护账号可用性（token 续期、每日
签到、额度刷新），自带 Web 管理面板。

> 单人自托管工具：跑在自己的 Windows 机器上，面板与转发面同进程，
> 默认只监听 127.0.0.1。

---

## 功能一览

| 能力 | 说明 |
|---|---|
| 账号池调度 | 按优先级 → FEFO（先到期先用）→ 成本分层 → 余额 → 闲置时间选号；单账号并发上限、模型级冷却、指数退避 |
| 三协议转发 | `/v1/chat/completions`（OpenAI）、`/v1/messages`（Anthropic）、`/v1/responses`（Codex）；SSE 流式、工具调用、截断续写 |
| 虚拟模型 | 在 `model-router.json` 里把一个对外模型名映射到多个上游候选，带健康度统计与 pinned/轮转池 |
| 账号保活 | 每日签到、token 临期自动刷新、余额定时刷新（错峰）、积分临期与池空告警 |
| 运维面板 | 凭据池 / 访问密钥 / 路由与虚拟模型 / 模型池 / 用量与成本 / 请求日志 / 运行状态 / 定时任务 / 通知与备份 / 审计日志 |
| 通知 | Webhook / Server酱 / PushPlus / Telegram；事件级开关 + 去重 + 合并窗口 |
| 备份 | 全量加密备份（AES-256-GCM + 校验和），一键恢复（恢复前自动做安全快照） |

## 快速开始

前置：Node ≥ 22.5（用了 `node:sqlite`）。

```bat
git clone <repo>
cd RelayGate
npm install
copy .env.example .env      :: 按需修改（默认即可跑）
npm run build:web           :: 构建管理面板（首次必须）
start.bat
```

打开 `http://127.0.0.1:19900/`：

1. 首次访问会引导创建**登录密钥**（管理面板专用，只在创建时显示一次明文，立即保存）；
2. 「账号 → 凭据池」接入第一个上游账号（OAuth / 抓取本机登录态 / 粘贴凭据），
   接入后把它启用；
3. 「账号 → 访问密钥」创建一把**访问密钥**（`sk-…`，给 IDE/脚本用）。
   创建成功后页面下方直接给出 base URL、环境变量与 curl 示例，可一键复制；
4. 想确认链路能通，在「请求日志 → 连通性测试」发一次真实请求。

## 给客户端配置

面板「账号 → 访问密钥」页在创建/查看密钥时会直接展示以下配置（可复制）：

```bash
export OPENAI_BASE_URL=http://127.0.0.1:19900/v1
export OPENAI_API_KEY=sk-…            # 访问密钥，不是登录密钥
```

```bash
curl http://127.0.0.1:19900/v1/chat/completions \
  -H "Authorization: Bearer sk-…" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'
```

两种密钥不能混用：

| | 登录密钥（`sk-admin-…`） | 访问密钥（`sk-…`） |
|---|---|---|
| 用途 | 打开管理面板 | 调用转发接口 |
| 创建位置 | 首登引导 / 访问密钥页 | 「账号 → 访问密钥」页 |

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm start` | 启动服务（`start.bat` 同） |
| `npm run dev` | watch 模式启动（改代码自动重启） |
| `npm run build:web` | 构建管理面板（`web/dist`） |
| `npm test` | 全部后端测试（9 个套件，349 断言） |
| `npm run lint` | web eslint + 后端 biome |
| `npm run check` | test + lint 一起跑（提交前建议） |
| `node scripts/login-key.js create` | CLI 创建登录密钥（面板进不去时的救援通道） |

## 目录速览

```
src/                 Node 后端
  routes/            HTTP 端点（薄层）
  transform/         请求归一化 / SSE 流解析 / 双协议输出（纯函数）
  credentials/       账号存储（SQLite）、导入、OAuth、调度池
  model-router/      虚拟模型解析与转发
  jobs/              定时任务（签到/保活/余额/备份/成长/轮换）
  log/               traffic / audit / task / crash 落盘
  middleware/        鉴权、限流
web/                 React 管理面板（Vite + TS + Tailwind）
docs/                设计与审查文档
output/              运行数据（.trae-api/ 数据库与密钥、logs/ 日志）——勿提交
```

## 配置

所有配置集中在 `.env`（模板见 `.env.example`），运行时可改项会落盘到
`.trae-api/*.json` 且文件值优先于 env。关键项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `19900` / `127.0.0.1` | 监听地址；跨机访问需显式改 HOST 并自担安全 |
| `TRAE_API_ENCRYPT_KEY` | 自动生成 | 凭据加密密钥（64 hex）。**丢失 = 所有账号凭据永久不可解**，建议固定设置并纳入备份 |
| `KEY_DEFAULT_RPM` | `60` | 访问密钥默认每分钟请求上限（0=不限，不推荐） |
| `STATUS_PUBLIC` | `false` | `/status` 是否免鉴权 |
| `SCHEDULER_ENABLED` | `true` | 定时任务总开关 |
| `GROWTH_POLL_ENABLED` / `GROWTH_HOUR`+`GROWTH_MINUTE` | `true` / `8:00` | WorkBuddy 成长任务（派猫旅行等）每天墙钟执行一次的时刻 |

完整列表与语义见 `.env.example`（每个变量都有注释）。

## 已知限制

见 [docs/known-limitations.md](docs/known-limitations.md)（安全边界、Windows
服务形态、多进程约束等）。

## 文档

- `docs/` — 架构设计、审查报告（含两轮独立审查与整改方案）
- `.env.example` — 全部环境变量
- `docs/known-limitations.md` — 设计边界与接受理由