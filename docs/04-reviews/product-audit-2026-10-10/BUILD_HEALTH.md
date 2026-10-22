# BUILD_HEALTH — 构建与仓库健康
**Product Professor · 2026-10-10 · commit `2a2ec43` · Node v24.21.0**

---

## 1. 实跑命令与结果（全部本次执行）

| 命令 | 结果 | 输出摘要 |
|---|---|---|
| `node src/test/unit.test.js` | ✅ exit 0 | **236 passed** |
| `node src/test/growth.test.js` | ✅ exit 0 | **11 passed** |
| `node src/test/security.test.js` | ✅ exit 0 | **41 passed**（末行 lifecycle exit code 0） |
| `cd web && npm run build` | ✅ exit 0 | 76 modules → 15 chunk，**1.15s** |
| `cd web && npm run lint` | ✅ exit 0 | eslint **零输出**（0 error / 0 warning） |
| `cd web && npx tsc -b --force` | ✅ exit 0 | **0 type error** |
| `npm audit`（根） | ✅ | **found 0 vulnerabilities**（prod 86 / total 85） |

**合计 288 个后端断言全绿，前端零 lint/type 错误，构建成功，依赖零漏洞。**

### 构建产物明细

```
dist/index.html                          0.60 kB │ gzip  0.47 kB
dist/assets/index-CBRNcGkK.css          21.86 kB │ gzip  5.47 kB
dist/assets/index-Bcoc3emJ.js          195.84 kB │ gzip 64.46 kB  ← 入口（React + router）
dist/assets/OpsPage-*.js                49.46 kB │ gzip 13.86 kB
dist/assets/CredentialsPage-*.js        25.06 kB │ gzip  8.70 kB
dist/assets/TokenStatsPage-*.js         21.12 kB │ gzip  7.18 kB
dist/assets/ModelRouterPage-*.js        13.13 kB │ gzip  4.68 kB
dist/assets/ModelPoolPage-*.js           8.15 kB │ gzip  3.41 kB
dist/assets/TrafficPage-*.js             8.09 kB │ gzip  2.95 kB
dist/assets/AccessKeysPage-*.js          7.62 kB │ gzip  3.30 kB
dist/assets/OverviewPage-*.js            6.72 kB │ gzip  2.76 kB
dist/assets/accountPacks-*.js            4.88 kB │ gzip  2.19 kB
dist/assets/PageShell-*.js               3.43 kB │ gzip  1.58 kB
dist/assets/admin-*.js                   3.18 kB │ gzip  1.23 kB
dist/assets/stats-*.js                   0.64 kB │ gzip  0.28 kB
```

**判断：路由级代码分割真实生效**（10 个 feature chunk，首屏只需 entry + OverviewPage ≈ 67 kB gzip）。这是重构计划（[docs/03-development/frontend-refactor-plan.md](../../../docs/03-development/frontend-refactor-plan.md) §5）里承诺的项，已兑现。

---

## 2. ⚠️ CI 陷阱：测试失败也会打印 `N passed`

`unit.test.js` 的失败路径把 `FAIL` 写到 **stderr**，而 stdout 仍然打印 `N passed`。**只看 stdout 会把失败读成成功。**

**必须**：CI 严格检查 exit code（当前 `npm test` 用 `&&` 串联三个文件，这一点是对的）。

---

## 3. 仓库卫生问题

| # | 问题 | 证据 | 严重度 |
|---|---|---|---|
| H1 | **无 README**（根与 `web/` 均无） | `Get-ChildItem README*` 仅命中 `docs/04-reviews/code-review-2026-10-05/README.md`（审查报告索引） | 🟠 MAJOR |
| H2 | **无 CI**（`.github/workflows` 不存在） | 目录不存在 | 🟠 MAJOR |
| H3 | **`src/` 108 个文件无任何 linter / formatter / TS 检查** | [package.json:9](../../../package.json) `"lint": "npm --prefix web run lint"` — 只覆盖前端 | 🟠 MAJOR |
| H4 | 版本号不一致：根 `3.0.0` vs `web/package.json` `1.0.0`；**UI 内无任何版本显示** | [AppLayout.tsx:36-38](../../../web/src/app/AppLayout.tsx#L36-L38) 只渲染 `RELAYGATE` | 🟡 MINOR |
| H5 | `docs/` 有完全重复文件：`wb-ecosystem-comparison-2026-10-04.md` 与 `... (2).md` **均 37737 字节** | 文件大小一致 | 🟡 MINOR |
| H6 | 工作树有大量未提交改动（38 个 modified + 未跟踪脚本） | `git status --short` | 🟡 MINOR |
| H7 | `output/` 运行时数据（含 `.trae-api/trae-relay.db`、`encrypt.key`、日志、截图）与源码同仓目录树 | 已被 `.gitignore` 覆盖（✅ 已验证 `.env`/`output/`/`.trae-api/`/`backups/`/`*.db*`/`logs/` 全部忽略） | ✅ 无风险 |
| H8 | `design/relaygate-console/` 静态 HTML 原型（8 页 40-60KB + 生成树 JSON + validation-report）与实际 React 实现并存 | 目录存在 | 🟡 MINOR（agent 工作流残留物） |
| H9 | `web/tsconfig.tsbuildinfo`、`web/dev.err.log`、`web/dev.out.log`、`web/_dev_v4.out`、`web/.playwright-cli/*` 等构建/调试产物在目录树 | 文件存在 | 🟡 MINOR |
| H10 | 无 lockfile 一致性检查（`package-lock.json` 存在但无 `npm ci` 脚本） | [package.json](../../../package.json) scripts | 🟢 NIT |

---

## 4. 依赖健康

```
生产依赖（6 个直接）：dotenv ^16.4.5 / express ^4.21.0 / https-proxy-agent ^9.0.0
                    js-tiktoken ^1.0.21 / node-fetch ^2.7.0 / socks-proxy-agent ^10.0.0
overrides: qs 6.16.0（已修前次审查的 moderate 漏洞）
前端依赖（3 个）：react ^18.3.1 / react-dom ^18.3.1 / react-router-dom ^6.28.0
devDependencies: 无（后端）
```

**判断：依赖面极小且克制。** 没有引入状态库、UI 库、图表库、HTTP 客户端。`npm audit` 0 漏洞。这是同类 AI 生成项目里少见的优点——**AI 没有堆依赖**。

⚠️ 一处注意：`node-fetch ^2.7.0` 是维护模式的老版本（v2 分支），Node 22+ 已内置 `fetch`。可考虑移除。

---

## 5. 运行时健康检查（真实缺陷）

| # | 问题 | 证据 |
|---|---|---|
| R1 | **`/health` 的 `status:'ok'` 是硬编码字符串** → 它是 uptime 探针，不是 health check。DB 坏了它也返回 ok，服务管理器无法据此决定是否重启 | [src/index.js:72](../../../src/index.js#L72) |
| R2 | **DB 损坏 → 静默半死**：`index.js` 的 try/catch 只包住 bootstrap，`ensureSchema` 不在其中。进程启动成功、端口监听成功、调度器全部启动，但每个需要 DB 的请求 500 | [src/index.js:169-183](../../../src/index.js#L169-L183) |
| R3 | **`encrypt.key` 丢失 = 全部账号 token 不可逆解不开，且无启动期校验**（应检测"DB 有密文行但 key 是新建的 → 拒绝启动"） | [src/lib/crypto.js:51](../../../src/lib/crypto.js#L51) |
| R4 | `model-config.json` 损坏 → 静默 `{models:{}}`，所有物理模型走兜底分支；`model-router.json` 损坏 → 静默 `virtualModels:{}`，所有 `vm/*` 被当物理模型发给上游报 400，**但面板仍显示"路由正常"** | [src/config.js](../../../src/config.js) |
| R5 | **无优雅停机**（P0-002）：唯一信号处理器在 flush 之前 `process.exit(0)` | [src/log/crash.js:78-83](../../../src/log/crash.js#L78-L83) |
| R6 | 启动顺序反了：`retention.pruneAtStartup()`（[:152](../../../src/index.js#L152)）在 `scheduler.start()`（[:143](../../../src/index.js#L143)）**之后**执行，且同步阻塞 | 同上 |
| R7 | 唯一会让进程拒绝启动的错误是 `API_KEY===ADMIN_KEY`（[config.js:87](../../../src/config.js#L87) throw）——这个设计是对的 | ✅ |

---

## 6. 配置面健康

**7 层配置，无交叉校验，无 schema**：

```
.env  →  model-config.json  →  model-fallback.json  →  model-router.json
     →  .trae-api/scheduler-settings.json  →  rotate-settings.json
     →  notify-settings.json / balance-refresh.json / backup-state.json / zcode-settings.json
```

| # | 问题 | 复核 |
|---|---|---|
| C1 | **`model-fallback.json` 无消费者**（幽灵配置）。文件声明 `autoFallback:true`、`queueThreshold:300`、14 组降级映射 | ✅ **已独立复核**：`config.js` 外仅 `admin-debug.js:259`（reload）与 `backup.js`（备份该文件）读取 |
| C2 | 幽灵 env：`PROJECTION_ENABLED`、`PROJECTION_MAX_SYSTEM`、`STATS_CACHE_OFF`（真正生效的是 `STATS_CACHE`） | ✅ 已复核：全库零引用 |
| C3 | **修正审查员原判**：`TASK_LOG_MAX_ENTRIES` **并非幽灵**——[task-log.js:17](../../../src/jobs/task-log.js#L17) 真实消费 | ✅ 已复核并从幽灵清单移除 |
| C4 | **修正审查员原判**：`SCHEDULER_ENABLED` **并非幽灵**——[scheduler.js:606](../../../src/jobs/scheduler.js#L606) `if (started \|\| !config.schedulerEnabled) return` 真实消费 | ✅ 已复核 |
| C5 | `TOOL_PROTOCOL` 唯一消费点是 [admin-debug.js](../../../src/routes/admin-debug.js)（只显示在配置面板），无行为分支 | 需确认 |
| C6 | `config.reload()` 与初始加载是**两份独立的解析代码**（[config.js:174-214](../../../src/config.js#L174-L214)）；注释自承曾因此丢失字段 | ✅ |
| C7 | `.env` 与 3 个根 JSON **完全无 schema**；`parseInt` 的 NaN 静默传播 | ✅ |

---

## 7. 测试覆盖的真实边界

**广度确实超出同类个人项目**（44 个分组：transform / upstream-client / pool / credits / oauth / stats / retention / atomic-write / backup / rotate / scheduler / model-router（含 `dispatchTraeStream` 真流式）/ variant / zcode 全套），并且有一条**依赖方向不变量的静态扫描测试**——这是很好的工程实践。

**但零覆盖的正是产品核心**：

| 未覆盖 | 影响 |
|---|---|
| `routes/openai.js` / `anthropic.js` / `responses.js` **三个文件一个 require 都没有** | 三个协议出口是产品的对外契约，全部未测 |
| 无任何 HTTP 层测试（无 supertest，`devDependencies` 为空） | 中间件链（auth → rateLimit → ACL）只在单元层测 |
| 三协议的**完整流序列**（多块 + 工具调用 + 截断 + 错误） | 只测了 `exportOpenAI().text()` / `exportAnthropic().toolCall()` 的单块输出 |
| 流中途失败整条路径 | P2-005 的"错误当内容输出"缺陷正是因此漏出 |
| `store.js` 并发写 | **P0-001 因此漏出** |
| `db.js` schema 迁移 / `rate-limit.js` / `health.js` rpm 滑窗 | — |
| **前端零测试**（`web/package.json` 无 vitest/jest，无 `.test.tsx`） | 12107 行前端代码无自动化保护 |

---

## 8. Build Health 评分

| 维度 | 得分 | 说明 |
|---|---:|---|
| 构建可重复性 | 90 | build/lint/typecheck/test 全绿，1.15s |
| 依赖健康 | 92 | 6 个直接依赖，0 漏洞，无冗余库 |
| 仓库卫生 | 55 | 无 README、无 CI、调试产物与原型残留、重复文件 |
| 静态检查覆盖 | 40 | 前端全覆盖，**后端 108 文件零 linter** |
| 运行时健康可观测性 | 35 | 假 health check、静默降级、无优雅停机 |
| 配置面健康 | 40 | 7 层无校验 + 1 个幽灵配置文件 |
| **Build Health 综合** | **58 / 100** | |

**一句话**：**构建层面是健康的，运维层面是不健康的。** 项目能干净地编译和测试，但它不能干净地启动、运行、停止和被诊断。