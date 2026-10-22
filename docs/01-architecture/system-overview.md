# RelayGate 系统架构总览

> 定位：单人自托管的**多平台账号池网关**。把 Trae / WorkBuddy / ZCode / Qoder / Raccoon
> 五个上游渠道的账号聚合成池，对外暴露 OpenAI / Anthropic / Codex 三套兼容协议。
> 本文是模块地图与请求链路的**单一入口**；具体做法见 `02-technical/`，边界与取舍见 [known-limitations.md](known-limitations.md)。
>
> 基线：`package.json` version 3.1.0 · 单进程 Express + `node:sqlite`

---

## 1. 分层结构

```
┌──────────────────────────────────────────────────────────────┐
│  web/  React 管理面板（Vite + TS + Tailwind，构建到 web/dist） │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTP（同进程静态托管）
┌───────────────────────────▼──────────────────────────────────┐
│  src/routes/        HTTP 薄层：解析入参 → 调领域模块 → 输出    │
├──────────────────────────────────────────────────────────────┤
│  src/middleware/    鉴权 / 模型 ACL / 限流                     │
├──────────────────────────────────────────────────────────────┤
│  领域层                                                        │
│   credentials/  账号库、调度池、密钥、积分          ← 源数据    │
│   model-router/ 虚拟模型解析、候选池、健康度、流闸 ← 选路上游  │
│   upstream/     Trae/WB 的转发与签到原语                       │
│   workbuddy/ zcode/ qoder/ raccoon/  各渠道专有协议            │
│   transform/    请求归一 ↔ 三协议输出（纯函数，无 IO）          │
├──────────────────────────────────────────────────────────────┤
│  src/lib/   crypto / paths / sse / token 估算 / 原子写 等基础件 │
│  src/log/   traffic / audit / crash / task 落盘                 │
│  src/jobs/  定时任务（签到、保活、余额、备份、轮换、成长）       │
│  src/notify/ Webhook / Server酱 / PushPlus / Telegram          │
└──────────────────────────────────────────────────────────────┘
                            │
                    ┌───────▼────────┐
                    │ 五个上游渠道   │
                    └────────────────┘
```

**依赖方向铁律**：`routes → 领域 → lib`。反向依赖只允许 `platform/variant.js`
被所有渠道模块读取（它是渠道能力的单一事实源）。

---

## 2. 转发请求链路

一次 `/v1/chat/completions` 的完整路径：

```
1. 入口鉴权        middleware/auth.js       访问密钥（sk-…）校验
2. 模型 ACL        middleware/model-access  密钥的 platform/resources 边界
3. 限流            middleware/rate-limit    按密钥 RPM
4. 模型解析        model-router/index.js    对外模型名 → 候选上游列表
                                             （虚拟模型映射见 model-router.json）
5. 选号            credentials/pool.js      优先级 → FEFO → 成本分层 → 余额 → 闲置
                                             单账号并发上限 / 模型级冷却 / 指数退避
6. 请求归一        transform/request.js     OpenAI 请求体 → 渠道请求体
7. 上游转发        upstream/client.js 或
                   workbuddy/chat.js 等      SSE 流式，工具调用透传
8. 流解析与出口    transform/sse.js +
                   transform/emitters.js     上游 SSE → OpenAI / Anthropic / Codex 三种输出
9. 记账            log/traffic.js           token 用量、成本、账号归属
                   credentials/store.js     余额与健康度回写
```

路由器层面的两个关键组件：

- `model-router/dispatch.js` — 按协议与渠道分发到具体转发实现
- `model-router/stream-gate.js` — 流中途失败时的处理（不再把错误渲染成模型输出文本）

---

## 3. 账号与凭据模型

```
accounts 表（SQLite）
  ├─ edition        渠道标识：trae | workbuddy | zcode | qoder | raccoon
  ├─ 凭据列         上游 token / cookie / 密码，**列级 AES-256-GCM 加密**
  ├─ 能力位         capability.chat / checkin / balance（由 platform/variant.js 定义）
  └─ 健康度         lastRefreshAt / lastKeepaliveAt / 冷却与失败计数
```

- **渠道能力的单一事实源**：`src/platform/variant.js`。新增渠道 = 加一个变体条目
  （realms / hosts / identity / paths / errors / capability），不散落 if-else。
- **分池收口**：`pool.editionOk` 用 `variant.canChat` 判断，跨渠道账号不可能被选错。
- **加密密钥**：`TRAE_API_ENCRYPT_KEY`（64 hex，AES-256-GCM）。丢失 = 全部凭据不可解，
  必须与备份一起保管，见 [key-management.md](../02-technical/key-management.md)。

---

## 4. 数据落盘位置

| 位置 | 内容 | 是否入库 |
|---|---|---|
| `output/.trae-api/trae-relay.db` | SQLite：账号、密钥、用量、调度状态 | 否 |
| `output/.trae-api/*.json` | 运行期设置（调度时刻、通知渠道、任务日志） | 否 |
| `output/model-router.json` | 虚拟模型与路由运行态（根目录同名文件是种子） | 否 |
| `logs/<YYYY-MM-DD>/` | `traffic.jsonl` / `audit.jsonl` / `crash.jsonl` | 否 |
| `logs/relay.out.log`·`relay.err.log` | `start.bat` 的服务 stdout/stderr（含启动轮转） | 否 |
| `backups/` | 全量加密备份（`jobs/backup.js` 的输出契约） | 否 |
| `web/dist/` | 面板构建产物 | 否 |

状态目录规则见 `src/lib/paths.js`：**状态 = `<WORKSPACE_DIR>/.trae-api`**，
读取时回退到仓库根旧位置，写入只写新位置（测试因此可完全隔离）。
日志目录默认 `<ROOT>/logs`，可用 `LOGS_DIR` 覆盖（测试必须覆盖，否则污染统计面板）。

---

## 5. 定时任务

`src/jobs/scheduler.js` 是唯一调度器；任务各自幂等，并用 `scheduler-lock.js`
做跨进程单实例（两个进程并行会让非幂等任务——备份、轮换——重复执行）。

| 模块 | 作用 |
|---|---|
| `jobs/scheduler.js` | 调度核心：签到、保活、余额、备份、轮换的时序编排 |
| `jobs/scheduler-lock.js` / `scheduler-settings.js` | 跨进程锁 / 调度时刻设置 |
| `jobs/balance-refresh.js` | 余额定时刷新（错峰） |
| `jobs/credit-alerts.js` | 积分临期与池空告警 |
| `jobs/zcode-rewards.js` / `qoder-rewards.js` | 限时套餐 / 每日积分探测与领取 |
| `jobs/growth-auto.js` / `growth-progress.js` | WorkBuddy 成长任务与进度 |
| `jobs/raccoon-keepalive.js` | Raccoon 账号保活 |
| `jobs/backup.js` | 全量加密备份（输出到 `backups/`） |
| `jobs/rotate-accounts.js` + `rotate-*.js` | 账号轮换、凭据目录轮换与种子 |
| `jobs/checkin-log.js` / `task-log.js` | 任务日志（面板「任务日志」读取） |

---

## 6. 管理面板结构

```
web/src/
  app/         App.tsx / AppLayout.tsx / nav.ts   —— 路由与导航
  features/    accounts models ops overview security setup stats
  shared/      api/（各领域 API 封装）hooks/ lib/ ui/
  styles/      global.css（设计令牌）
```

面板与转发面**同进程**：`src/index.js` 用 `express.static()` 托管 `web/dist`，
默认只监听 `127.0.0.1`。

---

## 7. 测试与质量门

| 命令 | 内容 |
|---|---|
| `npm test` | 16 个后端套件（`src/test/`），单测 + 集成，无网络 |
| `npm run lint` | 前端 ESLint + 后端 Biome（`src`、`scripts`） |
| `npm run check` | 上面两条一起跑 |
| CI | `.github/workflows/ci.yml`：backend test + lint、frontend lint/tsc/build、依赖审计 |

测试隔离靠 `src/test/isolation-guard.js`：强制 `WORKSPACE_DIR`、`LOGS_DIR`、`BACKUP_DIR`
指向临时目录，防止再出现「测试污染真实库」事故
（见 [../05-incidents/incident-2026-10-14-test-db-pollution.md](../05-incidents/incident-2026-10-14-test-db-pollution.md)）。

---

## 8. 相关文档

- 边界与取舍：[known-limitations.md](known-limitations.md)
- 计量口径：[token-credit-metering.md](token-credit-metering.md)
- 新增渠道：[../02-technical/channel-onboarding.md](../02-technical/channel-onboarding.md)
- 密钥体系：[../02-technical/key-management.md](../02-technical/key-management.md)
- 整改与审查：[../03-development/remediation-plan.md](../03-development/remediation-plan.md)、[../04-reviews/](../04-reviews/)
