# AUDIT_REPORT — RelayGate 管理面板
**Product Professor 完整审计 · 2026-10-10 · 审计基线 commit `2a2ec43`**

---

## 1. 执行判决

### Product Professor Score: **54 / 100** — 等级 **C**

### 一句话判决

这是一个**功能极其完整、但没有重点**的 AI 深度参与项目：它把 288 个后端断言、12 万行前端代码和 24 个运维面板做出来了，却从未回答过"这台机器的主人今天早上打开它，究竟该看哪一个数字"。

### 为什么是 C 而不是 B

不是任何一项做得差，而是**每一项都停在"能跑"而没有到"该用"**：
- 8 个页面**没有一个**能在一次滚动内完成它宣称的职责；
- 19/20 的空状态是"暂无X"，**零下一步**（唯一正确的是 [OpsPage.tsx:1368](../../../web/src/features/ops/OpsPage.tsx#L1368)）；
- 30+ 条错误提示里，**没有一条**告诉用户"接下来做什么"；
- 面板说明文字在 6 处反复陈述同一个"Trae 账单滞后"警告；
- 有一个叫「网关」的界面里放着**抽奖**、**Buddy 稀有度**、**补登卡**按钮。

### 为什么不是 D

它有真实的骨架，也真的接了线：8 条路由全部可达、路由分包真实生效（entry 195.84 kB / gzip 64.46 kB，15 个 chunk）、eslint 与 tsc 零错误、后端 236+11+41 断言全绿、`npm audit` 0 漏洞、CSP 严格且 `script-src` 无 unsafe-inline、M-S5/M-S6 两个历史高危已修复并有回归测试。

**它是"过度完成的草稿"，不是"未完成品"。** 这两者对用户的伤害完全不同：未完成品让人不敢用；过度完成的草稿让人**不知道该信任哪个数字**。

---

## 2. 这个产品实际上是什么

代码（而非 README）呈现的事实：

- 一个跑在 Windows 本机的 Node 进程（`start.bat`），默认绑 `127.0.0.1:19900`。
- 池化多个**AI 编程助手的账号凭据**（Trae IDE / WorkBuddy / ZCode），自动刷新它们的免费额度、自动每日签到领积分。
- 把这些账号包装成 OpenAI / Anthropic / Codex 三种兼容接口，供本地 IDE 使用。
- 唯一的用户是机器主人本人。**没有团队、没有云、没有多租户、没有付费用户。**

在这个约束下，产品的真实价值排序应该是：
1. 还有多少额度能用 → 2. 账号有没有死 → 3. 转发有没有出错 → 4. 接入新账号 → 5. 偶尔改签到时间。

**这五件事，前四件项目做到了，第五件做到了。** 剩下的全部是"网关应该有的完整功能"与"AI 觉得该有的"之间的混合物。

---

## 3. 检测到的技术栈

| 层 | 技术 | 证据 |
|---|---|---|
| 前端 | React 18.3 + TypeScript 5.6 + Vite 5.4 + Tailwind 3.4 | [web/package.json](../../../web/package.json) |
| 路由 | react-router-dom 6.28（8 条 lazy 路由） | [app/App.tsx](../../../web/src/app/App.tsx) |
| 状态 | 无状态库；自写 23 行 `useSyncExternalStore` + Context ×3 | [lib/store.ts](../../../web/src/lib/store.ts) |
| 样式 | CSS 变量 token 层（560 行）+ Tailwind 间距工具 | [styles/global.css](../../../web/src/styles/global.css) |
| 后端 | Node ≥22.5 + Express 4.21 + `node:sqlite`（同步 API） | [package.json](../../../package.json) |
| 依赖 | 6 个生产依赖（dotenv / express / node-fetch / js-tiktoken / 代理 agent ×2） | `npm audit` → 0 漏洞 |
| 测试 | 3 个自写测试文件，288 断言，**零 HTTP 层测试、零前端测试** | [src/test/](../../../src/test) |

**栈判断：极简、克制、没有过度工程**。这一点值得肯定——AI 生成项目通常会塞进 Redux + axios + UI 库 + 图表库，这里一个都没有。

---

## 4. 分数总览

| 类别 | 权重 | 得分 | 加权 |
|---|---|---|---|
| Product clarity | 10% | 55 | 5.5 |
| Core functionality | 15% | 82 | 12.3 |
| UX and user flow | 15% | 38 | 5.7 |
| Visual polish | 10% | 58 | 5.8 |
| Architecture | 12% | 60 | 7.2 |
| Security and privacy | 12% | 55 | 6.6 |
| Performance | 8% | 62 | 5.0 |
| Reliability and tests | 8% | 52 | 4.2 |
| Feature completeness | 6% | 85 | 5.1 |
| Business / launch readiness | 4% | 30 | 1.2 |
| **合计** | 100% | | **58.6** |

**Product Professor Score: 54/100**（对"没有单一 P0 数据损坏缺陷"与"288 断言全绿"给予工程底座加分；但对 UX 严重低于及格线与安全面的两条真实攻击面给予重扣）。

| 派生指标 | 分数 |
|---|---|
| **Launch Readiness** | **42 / 100** |
| **True Score**（是否像一个严肃的真产品） | **45 / 100** |
| **AI-Generated Feel Badness** | **6.5 / 10** |
| **Expected User Complaint Severity** | **7.5 / 10** |

### 评分硬上限检查（skill 规则）

| 规则 | 结论 |
|---|---|
| build 失败则 Launch Readiness ≤ 80 | 构建通过；Launch 42 分远低于上限，无约束 |
| 未审 auth/DB 权限则 Security ≤ 75 | 已完整审；Security 55 |
| 未审移动端则 UX ≤ 80 | 移动端为 CRITICAL 缺陷（见 §10）；UX 38 |
| 缺失空/错/加载态则 True Score ≤ 80 | 缺失严重；True 45 |
| 存在未解决 P0 则 Overall ≤ 85 | 有 2 个 P0（见 §7）；**该规则生效**，Overall 已在 85 以下 |

---

## 5. Launch Readiness 判决：42/100 — **不建议发布**

**"发布"对单机自托管工具意味着：用户能跑起来、能理解、能信任、坏了能自救。四条里目前只有第一条成立。**

| 判据 | 状态 | 说明 |
|---|---|---|
| 能跑起来 | ✅ | `start.bat` / `start.sh` 双平台脚本、`npm run build` 通过 |
| 能理解 | ⚠️ | 无 README（根目录与 `web/` 均无）；13 篇文档全是 AI 审查报告与竞品对比，含一份 37737 字节的完全重复文件；零篇 changelog |
| 能信任 | ❌ | 成本页自己写了 6 处"这个数字不可信/不可相加"；轮换开关可能永远显示"开"；`model-fallback.json` 配了不生效 |
| 坏了能自救 | ❌ | 30+ 条错误提示零"下一步"；19/20 空状态零引导；`/health` 的 `status:'ok'` 是硬编码字符串，不是真实健康检查 |

**上线后用户的第一印象会是："功能真全啊。" 第二印象会是："所以我现在该看哪儿？"**

---

## 6. Top 10 修复（按影响排序）

| # | 修复 | 影响面 | 详见 |
|---|---|---|---|
| 1 | **建立 onboarding 状态机**：首登后按"是否接账号 → 是否 mint 密钥 → 是否验证过链路"引导，完成前总览页顶部显示进度条 | 修复首登 4 次跳转 + 2 个模态的死链 | P1-002 |
| 2 | **删掉 Overview 的账号表与「运行状态」9 项**（后者 9/9 与 `/ops` 第一屏重复），改为"今天有什么坏了 + 直达修复" | 消除最大的一处功能冗余与判断困惑 | P1-001 |
| 3 | **给全部 20 个空状态补下一步动作**，给 30+ 条错误补"接下来做什么" | 直接决定 True Score 能否从 45 上到 70 | P1-003 |
| 4 | **修 `store.update` 的读-改-写竞态**：加乐观版本号或改用局部列更新 | 消除并发下的静默字段回滚（虽为同步代码，但跨进程可触发） | P0-001 |
| 5 | **加 SIGTERM 优雅停机**：`server.close()` → 停调度器 → flush 日志/缓存 → 退出；并对定时任务加跨进程防重 | 消除硬切 SSE、重复触发签到 | P0-002 |
| 6 | **收掉 OAuth `:17388` 监听器的 GET 凭据注入面**（加 Origin 校验 + 强制 state 匹配） | 消除唯一的真实未授权写入面 | P1-004 |
| 7 | **把"口径"脚注从 footer 移到字段旁**，同一个警告只说一次；删除泄漏的内部代号「DSH token-meter」 | 修复"论文塞进 footer"与内部代号外泄 | P1-005 |
| 8 | **修三处 CSS 引用了不存在的东西**（`--rg-bg-primary`、`--rg-state-ok`、`t-label` 类），删掉指向不存在 `styles/tokens.css` 的 tailwind 化石配置 | 这些是"没人看过页面"的最硬证据 | P1-006 |
| 9 | **移动端可用性**：侧栏在 <900px 折叠、表格卡片化 | 当前 390px 下主区仅剩约 190px，表格完全不可用 | P1-007 |
| 10 | **删掉「成长中心」的抽奖/稀有度/补登卡 UI**，保留后台静默 job + 通知 | 移除最伤产品定位的一块；省约 1860 行 | P2-001 |

---

## 7. P0 / P1 / P2 / P3 发现

### P0 — 必须在任何"发布"前解决（2 项）

#### P0-001 `store.update()` 全列读-改-写，存在跨进程静默数据回滚
- **证据**：[src/credentials/store.js:206-231](../../../src/credentials/store.js#L206-L231) —— `update(id, patch)` 先 `get(id)` 全列读取、merge、再 `UPDATE` 全部 34 列。无版本列、无事务、无 CAS。
- **触发路径**：[pool.js:422](../../../src/credentials/pool.js#L422) `store.list()` 读全表 → [pool.js:487](../../../src/credentials/pool.js#L487) `store.update(chosen.id, { lastPickedAt })` 用**陈旧快照**写回全部列。中间窗口内任何另一写入方（面板改 priority、另一进程跑 `scripts/login-key.js`）刚写入的字段会被本次 update 覆盖回旧值。
- **加重**：[pool.js:725](../../../src/credentials/pool.js#L725) 与 [pool.js:750](../../../src/credentials/pool.js#L750) 在 `explainCandidates` / `snapshot` 这两个**只读**函数里对每个账号做全列 UPDATE。`GET /v1/admin/runtime` 与 `GET /status` 都会触发；`/status` 在 `STATUS_PUBLIC=true` 时**免鉴权**。
- **重要修正**：架构审查员最初将其判为"跨 `await` 窗口的 TOCTOU"。我复核发现 [`pick()` 全文 417-490 行无 `await`、无 `async`](../../../src/credentials/pool.js#L417-L490)，且 `node:sqlite` 的 `DatabaseSync` 是同步的——**单进程内不存在异步窗口**。真实风险是**跨进程**（同一 Windows 账户下的第二个 node 进程）与**多客户端同时写库**。
- **裁决**：保留 P0（数据静默回滚是真实不变量破坏），但**严重性机制需修正**——不是竞态条件，是"丢失更新"。

#### P0-002 无优雅停机；唯一信号处理器在 flush 之前退出；定时任务无跨进程防重
- **证据**：[src/log/crash.js:78-83](../../../src/log/crash.js#L78-L83) —— `for (const sig of ['SIGTERM','SIGINT']) process.on(sig, () => { writeEvent(...); process.exit(0); })`。`src/index.js` 全文无 `server.close()`、无 flush。
- **后果**：Windows 服务管理器停止时，在途 SSE 被硬切；SQLite 连接从不 close；stats-cache / sticky / 池冷却状态全丢；客户端看到的是"连接重置"而非明确终止。
- **叠加**：[src/index.js:143](../../../src/index.js#L143) `scheduler.start()` 在每次进程启动时无条件排程，且**无 pidfile、无文件锁、无"上次运行时刻"持久化**。进程在 `CHECKIN_HOUR` 前后重启可能重复签到（幂等，影响小），但在备份/轮换上会重复执行（**非幂等**）。`start.bat` 自身注释承认可能出现 "two schedulers run side by side"。
- **裁决**：保留 P0。它不是理论问题——这是每晚都会经过的路径。

---

### P1 — 严重，影响可信度或安全（8 项）

| ID | 问题 | 证据 | 状态 |
|---|---|---|---|
| P1-001 | Overview 的账号表是 Credentials 的只读子集（5/7 列重叠、无操作列）；「运行状态」9 项与 `/ops` 第一屏 **9/9 完全重复** | [OverviewPage.tsx:175-248, 250-278](../../../web/src/features/overview/OverviewPage.tsx#L175-L278) | 已复核确认 |
| P1-002 | 首登引导在"创建完登录密钥"处断裂——落进空总览"暂无账号数据"，零下一步；WorkBuddy 导入后账号默认停用，弹窗已关，无跳转/高亮/toast 指向 | [SetupGate.tsx:224-250](../../../web/src/features/setup/SetupGate.tsx#L224-L250)、[ImportWbDialog.tsx:59,187](../../../web/src/features/accounts/ImportWbDialog.tsx#L59) | 已复核确认 |
| P1-003 | 20 个空状态里 19 个无行动指引；30+ 条错误提示无一含"下一步"；11 处使用"后端未给出原因"这类开发者占位串 | 见 §11 | 已复核确认 |
| P1-004 | OAuth 本地回调监听器 `127.0.0.1:17388` 的 **GET 分支无 Origin 校验、state 不匹配仅告警不拒绝** → 任意本地进程或恶意网页可注入任意凭据进池 | [src/credentials/oauth.js:152-155, 245-260](../../../src/credentials/oauth.js#L152-L260) | **需确认可达性**（见 §17） |
| P1-005 | 面板 footer/Note 是论文体：`TokenStatsPage.tsx:738` 把整段 R² 回归方法论塞进面板底部；`:786-790` 连续三行口径声明；`:738` **泄漏内部代号「DSH token-meter」**；"口径"一词出现 28 次横跨 5 文件 | [TokenStatsPage.tsx:738, 786-790](../../../web/src/features/stats/TokenStatsPage.tsx#L738) | 已复核确认 |
| P1-006 | 三处 CSS 引用了不存在的东西：`--rg-bg-primary`（Stepper 背景）、`--rg-state-ok`（有 fallback，不致命）、`.t-label` 类（ClientAccessPanel 两处标签**根本没有样式**）；`tailwind.config.ts` 注释指向不存在的 `styles/tokens.css`，且其整套 palette **0 处使用** | [index.tsx:126](../../../web/src/shared/ui/index.tsx#L126)、[ClientAccessPanel.tsx:59,142](../../../web/src/features/ops/ClientAccessPanel.tsx#L59)、[tailwind.config.ts:3](../../../web/tailwind.config.ts#L3) | **已独立复核：DEFINED 48 个变量，USED 23 个，`--rg-bg-primary` 与 `--rg-state-ok` 确未定义；`.t-label` 在 `global.css` 中 0 命中；`styles/tokens.css` 不存在** |
| P1-007 | 移动端完全不可用：`flex h-screen` + 固定 `w-[216px]` 侧栏，390px 视口主区仅剩约 190px；10 列表格的凭据表在该视口下不可读 | [AppLayout.tsx:34-35](../../../web/src/app/AppLayout.tsx#L34-L35)、[CredentialsPage.tsx:321-332](../../../web/src/features/accounts/CredentialsPage.tsx#L321-L332) | 已复核确认 |
| P1-008 | 转发面限流**默认无限制**（`KEY_DEFAULT_RPM` 未设 → 0 = 不限），任何持有一把访问密钥者可无限消耗真实额度 | [src/middleware/rate-limit.js:11-17](../../../src/middleware/rate-limit.js#L11-L17) | **已独立复核代码确认**；风险等级取决于是否对外暴露 |

---

### P2 — 中等（10 项）

| ID | 问题 | 证据 |
|---|---|---|
| P2-001 | 「成长中心」是 scope creep：约 1860 行、22 个后端端点、2 个后台 job；UI 有抽奖/稀有度/补登卡按钮；后端 15 个写端点 vs UI 3 个；定时器已在跑同一 job | [GrowthPanel.tsx](../../../web/src/features/accounts/GrowthPanel.tsx)、[src/routes/cat-trip.js](../../../src/routes/cat-trip.js)、[scheduler.js:578-602](../../../src/jobs/scheduler.js#L578-L602) |
| P2-002 | `model-fallback.json` **无消费者**：仅被 [config.js:27,111,182](../../../src/config.js#L27) 读入并挂到 `config.fallbackConfig`，全库无其他读取点。用户以为配了降级，实际从未生效 | **已独立复核：config.js 外仅 admin-debug.js:259（reload 时重新读取）与 backup.js（备份文件）** |
| P2-003 | 面板「账号轮换开关」可能永远显示为开：`OpsPage` 读 `rotate-settings.js` 的 `enabled`（该 SPECS 存在），但 `scheduler-settings.js` 已删除 `rotateEnabled`（m-32 收敛）→ 若读的是 scheduler 快照则 `undefined !== false` 恒真 | [OpsPage.tsx:225-233](../../../web/src/features/ops/OpsPage.tsx#L225-L233) vs [rotate-settings.js:22](../../../src/jobs/rotate-settings.js#L22)。**注**：我复核后确认前端读的是 `getRotateSettings()`（rotate-settings），该路径正确 → **降级为 P3 观察项** |
| P2-004 | 三条转发路由（openai/anthropic/responses）+ `model-router/dispatch.js` 四份手写协议骨架，ACL/pool/SSE/error/logRequest 逐项重复；已产生行为分叉：`openai.js:431` 传 `config.markIncompleteToolArgs` 而 `dispatch.js:407` 硬编码 `false`；`AUTO_CONTINUE` 只在 openai 生效；`responses.js` 无条件写 `status:'completed'` 不区分截断 | [src/routes/openai.js](../../../src/routes/openai.js)、[anthropic.js](../../../src/routes/anthropic.js)、[responses.js](../../../src/routes/responses.js)、[dispatch.js](../../../src/model-router/dispatch.js) |
| P2-005 | 流中途失败在 OpenAI 协议下被渲染成 `delta.content` 里的 `[Error 3004: ...]` **文本**，HTTP 仍是 200，无 `finish_reason`、无 `[DONE]`、无标准 error 对象；agent 客户端会把错误文案当模型输出 | **已独立复核 [emitters.js:48-50](../../../src/transform/emitters.js#L48-L50)** 与 [openai.js:510-513](../../../src/routes/openai.js#L510-L513)。对比 `anthropic.js:172` 用正确的 `{type:'error'}` |
| P2-006 | `anthropic.js` 的 `streamAccountId` 时序错误：赋值在 `pool.run` 返回后（[:145](../../../src/routes/anthropic.js#L145)），使用在 `pool.run` 内部回调（[:134](../../../src/routes/anthropic.js#L134)）→ 此时恒为 `null` → **`/v1/messages` 的流内限流错误永不回灌账号池** | **已独立复核行号与时序**。openai/responses 两种写法均正确 → 单点 bug |
| P2-007 | SQLite 无 `WAL`（仅 `busy_timeout=5000`）；`node:sqlite` `DatabaseSync` 全同步，每次 `touchLastUsed` 阻塞事件循环 | [src/credentials/db.js:194-203](../../../src/credentials/db.js#L194-L203) |
| P2-008 | `store.list()`（自述 1000 账号 ≈27ms）在每次转发请求的 pick 路径上最多执行 4 次（[pool.js:422,495,140,161](../../../src/credentials/pool.js#L422)），同步阻塞；每请求另有 3 次同步 `existsSync`（stats-cache invalidate） | 同上 |
| P2-009 | 登录密钥用无盐 SHA-256；高熵随机密钥尚可，但 `ADMIN_KEY` 引导值常被用户设成短口令，DB 泄露即可离线还原 | [src/credentials/api-keys.js:57-59](../../../src/credentials/api-keys.js#L57-L59) |
| P2-010 | `encrypt.key` / `backup.key` 与密文 DB 同目录，无 OS keystore/DPAPI；`notify-settings.json` 存放 webhook Bearer 明文且 `GET /v1/admin/notify/settings` 原样返回渠道密钥 | [src/lib/crypto.js](../../../src/lib/crypto.js)、[src/jobs/backup.js:84-106](../../../src/jobs/backup.js#L84-L106) |

---

### P3 — 观察项（10 项）

| ID | 问题 |
|---|---|
| P3-001 | DB 损坏 → **静默半死**：bootstrap 被 catch，之后每个需要 DB 的请求 500；`/health` 也 500 但 `status:'ok'` 是硬编码字符串 |
| P3-002 | `encrypt.key` 丢失 = 全部账号 token 不可逆解不开，且**无启动期校验**（"DB 有密文行但 key 是新建的 → 拒绝启动"） |
| P3-003 | 上游流式读取阶段无超时保护：[client.js:224,243](../../../src/upstream/client.js#L224-L243) 响应头到达即 `clearTimeout`；`consumeStream` 无 `finally { reader.cancel() }` |
| P3-004 | 幽灵 env：`PROJECTION_ENABLED`、`PROJECTION_MAX_SYSTEM`、`STATS_CACHE_OFF`（真正生效的是 `STATS_CACHE`）全库零引用。**已独立复核**：`TASK_LOG_MAX_ENTRIES` 实际在 [task-log.js:17](../../../src/jobs/task-log.js#L17) 被消费 → 从幽灵清单移除 |
| P3-005 | `SCHEDULER_ENABLED` 被 [scheduler.js:606](../../../src/jobs/scheduler.js#L606) 真实消费 → **不是幽灵**（审查员原判有误，已复核修正）。但 `.env.example` 未提及面板关闭它后 `scheduler.start()` 打印 `[scheduler] disabled` 而非退出 |
| P3-006 | 前端零测试；`src/` 108 文件无 linter/无 formatter/无 TS 检查（`npm run lint` 只覆盖 `web/`） |
| P3-007 | `package.json` version 3.0.0 但 `web/package.json` 1.0.0，UI 无任何版本显示 |
| P3-008 | 无 README；`docs/` 中 `wb-ecosystem-comparison-2026-04.md` 与 `... (2).md` 内容完全相同（均 37737 字节） |
| P3-009 | `OpsPage.tsx` 打开即发 10 个并发请求（9 个 `useAsyncData` 全部 `enabled:!!key`，与当前 tab 无关），其中 `getRouteCheck` 触发 pool 的只读写库 |
| P3-010 | 前端 `TrafficPage`「按模型筛选」是死控件——后端 [admin-traffic.js](../../../src/routes/admin-traffic.js) 从不读 `req.query.model`（已复核其全部 `req.query` 读取点为 days/account/status/page/page_size/limit），输入只触发重取全量 |

---

## 8. Bugs 与断裂流程

| # | 流程 | 断裂点 | 证据 |
|---|---|---|---|
| B1 | **首登 → 首次可用** | 创建登录密钥 → 落进空总览"暂无账号数据" → 用户不知道要接账号 → 接完 WB 账号默认停用且弹窗已关 → 不知道要去点"开" | [SetupGate.tsx:224-250](../../../web/src/features/setup/SetupGate.tsx#L224-L250)、[OverviewPage.tsx:180](../../../web/src/features/overview/OverviewPage.tsx#L180)、[ImportWbDialog.tsx:59](../../../web/src/features/accounts/ImportWbDialog.tsx#L59) |
| B2 | **客户端接入** | mint 密钥（`/access-keys`）→ 想知道放哪（`/ops/config` 第 5 个分段）→ 想验证（`/traffic` 的连通性测试）= **3 页 0 交叉链接** | [AccessKeysPage.tsx](../../../web/src/features/accounts/AccessKeysPage.tsx)、[OpsPage.tsx:1588](../../../web/src/features/ops/OpsPage.tsx#L1588)、[TrafficPage.tsx:311-376](../../../web/src/features/stats/TrafficPage.tsx#L311-L376) |
| B3 | **成本信任** | 主口径"今日"必然偏低（Trae 账单 1~2 天滞后），但卡片上**无任何标记**，只有底部一句 footer | [TokenStatsPage.tsx:261-280](../../../web/src/features/stats/TokenStatsPage.tsx#L261-L280)、`:354` |
| B4 | **Token 总量卡误导** | 大数字是 token 数，下方三行 `上游真值/补算/未计量` 是**请求数**，单位标注在最后 | [TokenStatsPage.tsx:283-308](../../../web/src/features/stats/TokenStatsPage.tsx#L283-L308) |
| B5 | **死交互** | `/traffic` 点成功行 `onClick={() => setFailed(bad ? r : null)}` → 什么都没发生，但行上有 `cursor-pointer` | [TrafficPage.tsx:201-203](../../../web/src/features/stats/TrafficPage.tsx#L201-L203) |
| B6 | **永久 loading** | `/ops` 账号池快照：空数组渲染 `<LoadingBlock/>` → 用户永远无法区分"没账号"与"还在加载" | [OpsPage.tsx:536-538](../../../web/src/features/ops/OpsPage.tsx#L536-L538) |
| B7 | **加载中显示 0** | TokenStats 的 4 张口径卡**全无 loading 分支**，`official.loading` 时直接显示 `0 credits` | [TokenStatsPage.tsx:263,285,313,333](../../../web/src/features/stats/TokenStatsPage.tsx#L263) |
| B8 | **静默卡死** | OAuth 轮询 `catch {}` 完全静默 → 上游已授权但面板永远停在"等待授权结果" | [OauthTraeDialog.tsx:76-78](../../../web/src/features/accounts/OauthTraeDialog.tsx#L76-L78) |
| B9 | **健康检查是假的** | `/health` 的 `status:'ok'` 硬编码，DB 坏了也返回 ok | [src/index.js:72](../../../src/index.js#L72) |
| B10 | **最常见的故障无修复入口** | 凭据表显示红色"需重新登录"，同行只有签到/查余额/删除；修复入口（重新导入/OAuth）在页面上方的独立 Panel | [CredentialsPage.tsx:390-426, 444-462](../../../web/src/features/accounts/CredentialsPage.tsx#L390-L426) |

---

## 9. 架构问题

| # | 问题 | 判断 |
|---|---|---|
| A1 | **四份手写协议骨架** | 8 项职责（ACL/pool 包裹/SSE 头/流处理器/流内 error 回灌/已发头错误帧/logRequest/finish 改写）× 4 个出口逐项重复，且已产生 3 处行为分叉。**协议适配层缺失是真实缺陷**（P2-004） |
| A2 | **配置面 7 层无交叉校验** | `.env` + 3 个根 JSON + 3 个 `.trae-api/*.json` + 面板保存。无 schema，`parseInt` 的 NaN 静默传播。`config.reload()` 与初始加载是两份独立的解析代码（[config.js:174-214](../../../src/config.js#L174-L214)）——注释自承曾因此丢失字段 |
| A3 | **前端重复实现了后端业务规则** | `accountPacks.packsOf` 复刻 FEFO 排序；`ModelRouterPage:339-359` 复刻 `orderCandidates` 轮转池计算。后端算法一改，UI 静默错标 |
| A4 | **`accountState` 逐字写了两遍** | [format.ts:6-13](../../../web/src/shared/lib/format.ts#L6-L13) 与 [types.ts:120-124](../../../web/src/shared/api/types.ts#L120-L124) |
| A5 | **前端分层是真的** | ✅ `shared/api` 内核（取消/超时/GET 去重）被 10 个 feature 使用；`useAsyncData` 43 处；`format.ts` 112 处。这是本项目的亮点 |
| A6 | **单一根 ErrorBoundary** | 任一 feature 渲染期抛错 → 整应用白屏，无路由级兜底 |
| A7 | **`model-fallback.json` 是幽灵配置文件** | 用户会花时间配一个从未生效的降级策略（P2-002） |

---

## 10. UX / 设计问题

| # | 问题 | 严重度 |
|---|---|---|
| U1 | **移动端零断点** | CRITICAL。390px 视口主区约 190px；10 列表格完全不可用。手机上看这个面板（出差时排障）等于不可用 |
| U2 | **19/20 空状态是"暂无X"** | 严重。用户停在任一空状态都不知道下一步 |
| U3 | **30+ 条错误零"下一步"** | 严重。"签到失败"四个字后用户无事可做 |
| U4 | **12 个按钮无解释 disabled** | 中等。`解冻` 灰 = "无需解冻"还是"被冻结"？用户无法分辨 |
| U5 | **同一 caveat 重复 3-4 次** | "Trae 账单滞后"在 TokenStats 文案里出现 3 次 + 代码 1 次 |
| U6 | **内部代号泄漏到用户界面** | `DSH token-meter` 出现在面板 footer |
| U7 | **同页两套"可用"定义** | `/model-pool` 的"可用"= 探测成功过；`/model-router` 的"可用"= 另一套；跨页对照会误判 |
| U8 | **同页两套"到期"口径** | 后端 `expiring3d/7d` 是**积分额度**；前端 `expirySummary` 是**账号数**；同名不同义 |
| U9 | **术语墙** | `FEFO 到期信号`、`口径`、`轮转池大小`、`业务层失败` 直接作为 UI 文本，无中文解释 |
| U10 | **零持久错误反馈** | 所有 toast 3200ms 自动消失；轮换明细、通知失败列表、批量导入明细 3.2 秒后不可读 |
| U11 | **密钥"轮换"文案与行为不符** | 前端硬编码 `graceMs:0`（无宽限），弹窗却说"旧密钥将进入宽限期后失效" |
| U12 | **通知密钥"不回显"是假的** | 注释称不回显，实际 `value` 绑定真实明文，仅 `type=password` 视觉遮挡，选中即可复制 |

---

## 11. 安全与隐私

| # | 问题 | 严重度 | 暴露场景 |
|---|---|---|---|
| S1 | OAuth 回调监听器 GET 分支可被任意本地进程/网页注入凭据 | P1（需确认可达性） | 本机即 P2；`HOST≠127.0.0.1` 时 **P0** |
| S2 | 转发面默认无限流 | P1 | 持有一把访问密钥者可烧光真实额度 |
| S3 | 登录密钥无盐 SHA-256 | P2 | DB 泄露 + 弱 `ADMIN_KEY` → 离线还原 |
| S4 | 加密密钥与密文同目录 | P2 | 同用户任意进程可读全部 token |
| S5 | `notify-settings.json` 明文存 webhook Bearer，且 API 原样返回 | P2 | admin 会话即可读到全部渠道密钥 |
| S6 | `/health` 免鉴权泄露池计数 | P3 | 本机枚举池健康 |
| S7 | **正面**：CSP 严格（`script-src 'self'`，无 unsafe-inline）、X-Frame-Options DENY、nosniff、Referrer-Policy、登录密钥存 sessionStorage、已提交配置无明文密钥、M-S5/M-S6 已修复并有回归测试、`npm audit` 0 漏洞 | — | — |

---

## 12. 性能问题

| # | 问题 | 影响 |
|---|---|---|
| PF1 | `store.list()` 在转发热路径上每次最多 4 次全表读，同步阻塞事件循环 | 高并发下秒级停顿 |
| PF2 | 每请求 3 次同步 `existsSync`（stats-cache invalidate），与注释中"避免每请求 mkdir syscall"的优化意图自相矛盾 | 中 |
| PF3 | 上游流式读取阶段无超时，`reader.read()` 可永久挂起 → 连接与 inFlight 租约不释放 | 中 |
| PF4 | `OpsPage` 打开即发 10 个并发请求，与当前 tab 无关 | 低（本地） |
| PF5 | **正面**：前端分包真实生效，entry gzip 64 kB；`useAsyncData` 有取消与竞态守卫；`SummaryProvider` 合并了重复请求 | — |

---

## 13. 测试与可靠性缺口

**288 个断言全绿，但绿灯覆盖的不是产品核心。**

| 覆盖 | 未覆盖 |
|---|---|
| transform / upstream client / pool / credits / oauth / stats / retention / atomic-write / backup / rotate / scheduler / model-router / variant / zcode + **依赖方向不变量静态扫描** | **`routes/openai.js`、`routes/anthropic.js`、`routes/responses.js` 三个文件一个 require 都没有** |
| 41 个安全用例（含 M-S5 回归、403 守门） | **零 HTTP 层测试**（无 supertest/依赖） |
| 11 个成长用例 | **三协议的完整流序列**未测；**流中途失败整条路径**未测 |
| | **前端零测试**（无 vitest/jest） |
| | `store.js` 并发写、`db.js` schema 迁移、`rate-limit.js`、`health.js` rpm 滑窗 全无测试 |
| | `src/` 108 文件无 linter / 无 TS 检查 |

**注意**：`unit.test.js` 失败时也只打印 `N passed`，`FAIL` 走 stderr。CI 必须严格检查 exit code，否则会误判为全绿。

---

## 14. 值得补上的能力（真的缺）

| 能力 | 为什么值得 |
|---|---|
| **README** | 目前跑起来只能读 `start.bat`。这是发布的第一道门 |
| **版本号显示** | 用户需要知道"我跑的是哪一版，才能去查 changelog" |
| **changelog** | 13 篇文档零篇面向用户 |
| **只读审计页** | `GET /v1/admin/audit` 后端已实现，UI 不可达。密钥 reveal / 凭据导出都写审计，但用户看不到 |
| **手动触发定时任务** | `POST /v1/admin/scheduler/:action` 后端已实现，UI 不可达。"不等定时器，现在手动跑一次"是真实需求 |
| **空状态的操作指引** | 见 U2 |
| **移动端布局** | 见 U1 |

---

## 15. 预期的用户抱怨

完整版见 [USER_COMPLAINTS.md](USER_COMPLAINTS.md)。最尖锐的三条：

> **首次使用者**："我创建了密钥，进去一片空白，写着'暂无账号数据'。我该点什么？"

> **日常运维者**："面板上显示'可用 12'，但我发请求就是 429。哪个是真的？"

> **怀疑型技术用户**："一个叫网关的工具里有个抽奖按钮？"

---

## 16. Issue 索引

| ID | 标题 | 优先级 | 类别 |
|---|---|---|---|
| [P0-001](issues/P0-001-store-update-lost-update.md) | `store.update()` 读-改-写导致跨进程丢失更新 | P0 | 架构/数据 |
| [P0-002](issues/P0-002-no-graceful-shutdown.md) | 无优雅停机 + 定时任务无跨进程防重 | P0 | 可靠性 |
| [P1-001](issues/P1-001-overview-duplication.md) | Overview 重复凭据池表与运行状态 9 项 | P1 | 产品清晰度 |
| [P1-002](issues/P1-002-onboarding-dead-end.md) | 首登引导断裂，核心流程需 4 次跳转 | P1 | UX |
| [P1-003](issues/P1-003-empty-and-error-states.md) | 19/20 空状态无指引，30+ 错误无下一步 | P1 | UX |
| [P1-004](issues/P1-004-oauth-listener-injection.md) | OAuth 本地监听器 GET 凭据注入面 | P1 | 安全 |
| [P1-005](issues/P1-005-docs-as-ui-copy.md) | 论文体脚注、内部代号泄漏、caveat 重复 4 次 | P1 | 文案 |
| [P1-006](issues/P1-006-css-fossil-and-undefined-vars.md) | 三处 CSS 引用不存在的东西 + tailwind 化石 | P1 | 设计系统 |
| [P1-007](issues/P1-007-mobile-unusable.md) | 移动端零断点，390px 主区仅 190px | P1 | UX |
| [P1-008](issues/P1-008-unlimited-default-ratelimit.md) | 转发面默认无限流 | P1 | 安全 |
| [P2-001](issues/P2-001-growth-center-scope-creep.md) | 成长中心 scope creep（含抽奖按钮） | P2 | 产品定位 |
| [P2-002](issues/P2-002-ghost-config.md) | `model-fallback.json` 无消费者 + 幽灵 env | P2 | 配置 |
| [P2-003](issues/P2-003-stream-error-as-text.md) | 流中途失败被渲染成模型输出文本 | P2 | 协议正确性 |
| [P2-004](issues/P2-004-no-protocol-adapter.md) | 四份手写协议骨架，已产生行为分叉 | P2 | 架构 |
| [P3-001](issues/P3-001-silent-degraded-startup.md) | 启动链静默降级：DB 损坏 / key 丢失 / 假 health | P3 | 可靠性 |
| [P3-002](issues/P3-002-test-coverage-gap.md) | 三个转发路由零测试 + 前端零测试 | P3 | 测试 |

---

## 17. 实现路线图

**第 1 批（1 天，只改 UI，立刻提升信任感）**
P1-001 删重复 → P1-003 补空状态与错误下一步 → P1-005 文案清理 → P1-006 CSS 修漏 → B6 永久 loading → B7 加载中显示 0

**第 2 批（1 天，接通已有后端能力）**
P1-002 onboarding 状态机 → 审计页 → 手动触发任务 → B2 客户端接入三页互链

**第 3 批（2 天，后端正确性）**
P0-001 乐观锁 → P0-002 优雅停机 → P1-008 默认限流 → P1-004 OAuth 面

**第 4 批（2 天，产品取舍）**
P2-001 成长中心 → P2-002 配置面清理 → P1-007 移动端 → README/版本号/changelog

**不建议现在做**：P2-004 协议适配层重构（收益真实但风险高，应在前四批稳定后单独进行）

---

## 18. 接下来运行的确切 prompt

见 [PROMPTS.md](PROMPTS.md)。

---

## 19. 仍需用户确认的问题

| # | 问题 | 为什么必须问 |
|---|---|---|
| Q1 | **是否打算把 HOST 改成非 127.0.0.1？** | 这决定 P1-004（OAuth 注入面）与 P1-008（无限流）的实际严重性。若只跑本机，两者都是 P2；若要跨机访问，两者立即升为 P0 |
| Q2 | **「成长中心」对你来说是真需求还是 AI 加的？** | 它有 1860 行代码、22 个端点、2 个后台 job 与完整测试。如果它是真需求（你确实想自动领 WorkBuddy 奖励），我不该建议删 UI，只该建议删抽奖按钮 |
| Q3 | **是否需要审计日志可见？** | 后端已写审计但 UI 不可达。如果只有你一个人用且密钥操作都有 prompt 确认，可以明确记为"不做" |
| Q4 | **是否需要"不等定时器、手动跑一次签到/保活"？** | 后端已实现无入口。若不需要，应删端点而非留着 |
| Q5 | **目标用户只有你自己吗？** | 全部产品判断（单人假设下的"功能冗余"结论）基于此。若要分享给他人，空状态/错误文案/移动端/审计的优先级会显著上升 |
| Q6 | **12 KB 规模的 `docs/` 里那些 AI 审查报告要保留吗？** | 它们对下一个开发者是噪音还是资产？含一份完全重复的文件 |

---

## 20. 本次审计未验证的声明

按证据门禁规则，以下项标注为 **needs confirmation**，未计入 P0/P1 定级依据：

1. OAuth `:17388` GET 分支是否真能在浏览器场景被利用（`no-cors` 导航 + 200 响应的实际行为未实测）。
2. 流中途 3004 是否真会导致重复 role 帧 + 内容拼接（依赖上游是否在流中途发限流码，未实测）。
3. `store.list()` 的 27ms 停顿在真实账号规模下的实际幅度（该数字来自代码自述注释，未独立复测）。
4. `reader.read()` 永久挂起在上游是否真实发生。
5. 轮换系统在 Windows Session 0 服务形态下是否真能拉起客户端（代码注释倾向"不能"，未实测）。
6. `AccessKeysPage` 创建访问密钥是否真会 400（前端只发 `{label}`，后端要求 `platform`，静态读码推断，未运行时验证）。

---

## 21. 覆盖范围声明

**已读**：8 个路由页面全部组件、5 个 dialog、全部 `shared/api` 模块、全部 `shared/ui` 导出、`global.css` 全 560 行、`app/*`；后端 `middleware/*`、`credentials/{pool,store,db,api-keys,oauth,credits}`、`routes/{openai,anthropic,responses,credentials,api-keys,admin-*}`、`jobs/*`、`log/*`、`model-router/*`、`config.js`、`index.js`。

**已实跑**：`npm test` 三套（236+11+41 全绿）、`npm run build`（通过）、`npm run lint`（0 error）、`npx tsc -b`（0 error）、`npm audit`（0 漏洞）、11 项独立证据复核（详见各 finding 的"已复核"标注）。

**未保证**：`design/` 静态原型未审计；`docs/` 内容仅抽样；未启动浏览器实测渲染（移动端判断基于布局代码静态分析）；未做并发压测；未运行真实上游调用（会消耗额度）。