# RelayGate 整改总方案
**整合两轮审查（奥卡姆剃刀存在性审查 2026-10-15 / Product Professor 全面审计 2026-10-10）的全部发现，输出可执行、可验证、无遗漏的整改计划。**

> 基线：commit `2a2ec43` · 单机单人自托管网关（Trae/WorkBuddy/ZCode 凭据池 → OpenAI/Anthropic/Codex 兼容转发）
> 总览：**87 个发现项 → 4 条 P0 主线 → 6 个工作日（7 个工作段）** · 预期总分 **54 → 80**
> 前置答案（决策锁定，见 §0）

---

## 0. 六个前置问题的答案（整改方案的决策基础）

Product Professor 审计留下 6 个"需用户确认"的问题。以下答案是本方案的**默认决策**；若与你的真实意图不符，只影响被标注的 3 个条目，其余不受影响。

| # | 问题 | 锁定决策 | 影响的条目 |
|---|---|---|---|
| Q1 | 是否把 `HOST` 改成非 127.0.0.1？ | **否，保持本机**。OAuth 注入面与无限流的严重性按"默认部署"定级，但**仍修**（防御性，成本极低） | P1-004、P1-008 维持 P1 而非 P0 |
| Q2 | 成长中心是真需求吗？ | **保留后台 job + 通知，删除全部手动 UI 写操作**（抽奖/稀有度/Buddy/补登卡/一键执行） | W5-1 |
| Q3 | 需要审计日志可见吗？ | **需要**（密钥 reveal/凭据导出必须可追溯）。接通已有端点 | W3-3 |
| Q4 | 需要"手动跑一次"吗？ | **需要**（排障刚需）。接通已有端点 | W3-4 |
| Q5 | 用户只有你自己？ | **是**。因此"多用户协作"类需求全部不立项；单人视角下的冗余全部可删 | 全篇 |
| Q6 | docs 里的 AI 报告保留吗？ | **归档到 `docs/archive/`**，不删除（可追溯），但移出主目录 | W6-4 |

---

## 1. 全量发现清单（87 项，去重后 71 个唯一项）

### 1.1 两轮审查的产出物

| 轮次 | 产出 | 发现数 |
|---|---|---:|
| 第一轮（Hai Razor 存在性审查，2026-10-15） | [frontend-existence-audit-2026-10-15.md](../04-reviews/frontend-existence-audit-2026-10-15.md) | 31 个概念裁决（Keep 21 / Merge 9 / Delete 15 / Replace 8 / Prove-first 5） |
| 第二轮（Product Professor 全面审计，2026-10-10） | [product-audit-2026-10-10](../04-reviews/product-audit-2026-10-10/)（8 份报告 + 16 个 issue） | 87 个发现项（P0×2 / P1×8 / P2×4 / P3×2 + 未单列观察项 20） |

**去重说明**：两轮有 16 处重叠发现（如 Overview 重复、FEFO 镜像、口径文案），已合并；Razor 轮的"Delete 裁决"与 Professor 轮的"伪需求清单"交叉验证后合并为 §1.2 的 Z 类。

### 1.2 分类汇总总表

严重程度定义：
- **🔴 阻断**：数据损坏 / 安全边界 / 崩溃级可靠性 —— 发布前必须修
- **🟠 严重**：核心流程断裂 / 用户无法完成任务 / 明确契约缺口 —— 第一个可用版本前必须修
- **🟡 一般**：体验损伤 / 冗余 / 一致性缺陷 —— 影响评分但不阻断使用
- **🔵 建议**：改进机会 / 归档 / 防回归设施

#### A 类：数据与可靠性（后端正确性）

| ID | 级别 | 模块 | 问题 | 根因 | 整改波次 |
|---|---|---|---|---|---|
| P0-001 | 🔴 | credentials/store | `update()` 全列读-改-写，跨进程丢失更新（**机制修正：非单进程竞态**，`pick()` 无 await、`node:sqlite` 同步） | AI 生成时未建模"多写入方"；测试未覆盖并发 | W4 |
| P0-002 | 🔴 | log/crash + index | 信号处理器在 flush 前 `process.exit(0)`；无 `server.close()`；调度器无跨进程防重 | 优雅停机不是功能需求，测试不发现 | W4 |
| P2-003 | 🟠 | transform/emitters + routes | 流中途失败被渲染成 `delta.content` 的 `[Error...]` 文本（HTTP 200）；`anthropic.js:134/145` 时序 bug 使 `/v1/messages` 流内限流永不回灌；`consumeStream` 无 reader 清理 | 三份协议骨架独立手写，只有一份错了错误路径 | W5 |
| P3-001 | 🟡 | index + crypto | 启动链静默降级：`/health` 的 `status:'ok'` 硬编码；`encrypt.key` 丢失静默新建（不可逆数据丢失）；model-*.json 损坏静默兜底 | "宁可崩溃也不静默"原则只在 1 处（`API_KEY===ADMIN_KEY`）被应用 | W5 |
| P0-001b | 🔴 | credentials/pool | `explainCandidates`/`snapshot` 这两个**只读**函数对每账号全列 UPDATE；`GET /status` 免鉴权可触发 N 次写库 | 只读接口混入副作用 | W4（并入 P0-001） |

#### B 类：安全与配置

| ID | 级别 | 模块 | 问题 | 根因 | 整改波次 |
|---|---|---|---|---|---|
| P1-008 | 🟠 | middleware/rate-limit | 转发面默认无限流（`KEY_DEFAULT_RPM` 未设→0；密钥创建 UI 从不发 `rpmLimit`）；每请求 10MB 上限 | 文件头声称对齐 OWASP API4，但默认值违反它 | W4 |
| P1-004 | 🟠 | credentials/oauth | 本地回调监听器 `:17388` 的 GET 分支无 Origin 校验、state 不匹配仅告警不拒绝 → 任意本地进程/网页可注入凭据 | state 纪律只在 POST 路径应用 | W4 |
| P2-002 | 🟠 | config + .env.example | **`model-fallback.json` 零消费者**（用户以为配了降级）；幽灵 env：`PROJECTION_ENABLED`、`PROJECTION_MAX_SYSTEM`、`STATS_CACHE_OFF`（**复核修正**：`TASK_LOG_MAX_ENTRIES`、`SCHEDULER_ENABLED` 是真实消费的，勿删） | 配置面 7 层无 schema、无交叉校验 | W5 |
| P2-010 | 🟡 | lib/crypto + notify | 登录密钥无盐 SHA-256；`encrypt.key`/`backup.key` 与密文同目录；`notify-settings.json` 明文 webhook token 且 API 原样返回 | 单机假设下无威胁模型，但密钥材料管理未收紧 | W6（记录型，接受现状+脱敏） |
| P2-009 | 🟡 | credentials/api-keys | 无盐哈希 + `normalizeKey` 对短 key 静默 pad `'0'` 而非报错 | 同上 | W6（记录型） |
| P1-008b | 🟡 | express | `express.json({limit:'10mb'})` 与无限流叠加放大 DoS 面 | — | W4（并入 P1-008） |

#### C 类：前端架构与死代码（Razor 轮主产出）

| ID | 级别 | 模块 | 问题 | 整改波次 |
|---|---|---|---|---|
| R-D1 | 🟡 | shared/ui | `EmptyState` 组件 0 引用，而空态 div 被手抄 6 次 | W1 |
| R-D2 | 🟡 | shared/lib/format + ui | 死导出：`formatTimeShort`、`PLATFORM_LABEL`、`STATE_PILL_CLASS`（含 Overview re-export）、`businessFailureReason`、`isTransportError`、`accountsOf/EditionFilter/editionOf` | W1 |
| R-D3 | 🟡 | shared/api | **15 个零导入导出**：`getSseDebugStatus`、`getNotifyEvents`、`saveNotifyEvents`、`upsertProvider`、`deleteProvider`、`modelRouter.getRouteCheck`、`getAvailableModels`、`resetDevice`、`oauthComplete`、`wbRefresh`、`wbCheckinStatus`、`wbCheckinAll`、`growthStatus`、`growthStreak`、`growthChances`、`growthDepart` | W1 |
| R-D4 | 🟡 | api/types + admin | 死类型字段：`Account.verifiedBalance/verified/userRegion/action/region`、`ModelInfo.feeLevel/scene/peak`、`DailyStat.officialSessions/Requests/Covered`、`SseDebug.total/enabled/hint`、`RotateStatus.settings/scheduler`、`intervalMinutes` | W1 |
| R-D5 | 🟡 | hooks | `useBalanceAutoRefresh` 的 `intervalMs` 参数 0 调用方传值（投机参数） | W1 |
| R-D6 | 🟡 | 全局 | `accountState` 逐字双实现（format.ts:6 与 types.ts:120） | W1 |
| R-D7 | 🟡 | css | 三处幽灵引用：`--rg-bg-primary`、`--rg-state-ok` 未定义；`.t-label` 类 0 定义（2 处使用）；`tailwind.config.ts` 指向不存在的 `tokens.css` 且 palette 0 使用 | W1 |
| R-D8 | 🟡 | app/nav + OpsPage | TABS 与 nav.ts 声明两遍（注释声称收敛，实现是平铺） | W2 |
| R-D9 | 🟡 | ui | `KeyCards`/`KeyCardGroups`/`KeyValue` 三套键值渲染；`FieldRow` 与 `Field` 两套表单原语 | W2（低优先） |

#### D 类：重复与口径漂移（Razor 轮 + Professor 轮交叉确认）

| ID | 级别 | 模块 | 问题 | 整改波次 |
|---|---|---|---|---|
| R-M1 | 🟠 | OverviewPage | 账号表是 CredentialsPage 的只读子集（5/7 列重叠、无操作列）；「运行状态」9 项与 `/ops` 第一屏 **9/9 重复**（同一 `/runtime` 端点） | W1 |
| R-M2 | 🟠 | accountPacks + ModelRouterPage | 前端两处复刻后端算法（FEFO 排序、轮转池计算），后端一改 UI 静默错标 | W2 |
| R-M3 | 🟠 | accountPacks vs 后端 | 三套"到期"口径：后端 `expiring3d/7d` 是**积分额度**、前端 `expirySummary` 是**账号数**、pack 级 urgency 是第三套 —— 同名不同义 | W2 |
| R-M4 | 🟡 | CredentialsPage | 行内「权益包」取 `packs[0]`（任意第一包），PackDialog 用完整 FEFO → 同账号两处口径不一致 | W2 |
| R-M5 | 🟡 | CredentialsPage | 「最近操作与保活」6 列表与主表"最近选用/最近签到"重复；硬编码 `slice(0,8)` | W2 |
| R-M6 | 🟡 | 多页 | 同一 caveat 重复 3-4 次（Trae 账单滞后 ×4、token 历史脱敏 ×4、业务层失败 ×2） | W1（并入文案） |
| R-M7 | 🟡 | 多处 | "业务失败处理"三种写法并存：OpsPage 手写布尔、GrowthPanel 手写 `r?.ok===false`、`isBusinessFailure`+`businessFailureReason` 已定义却零调用 | W2 |
| R-M8 | 🟡 | OpsPage | 同一事实最多 3 处呈现（调度器开关 ×3、管理密钥分离 ×2、池化策略 ×2、签到保活时刻两个来源两控件） | W2 |

#### E 类：UX 与核心流程断裂（Professor 轮主产出）

| ID | 级别 | 模块 | 问题 | 整改波次 |
|---|---|---|---|---|
| P1-002 | 🟠 | 全局 | 首登引导在"创建密钥"处断裂 → 空总览零引导；完整首用路径 4 次跳转 + 2 模态零提示 | W2 |
| E-2 | 🟠 | ImportWbDialog | WB 导入后账号默认停用，弹窗已关，无指向/高亮/跳转 | W2 |
| E-3 | 🟠 | CredentialsPage | 最常见故障"需重新登录"无行内修复入口（修复入口在页面上方独立 Panel） | W2 |
| E-4 | 🟠 | 三页互链断裂 | mint 密钥（/access-keys）→ 配 IDE（/ops/config 第5段）→ 验证（/traffic）三页 0 交叉链接 | W2 |
| P1-003 | 🟠 | 全局 | **21 个空状态 19 个无下一步**；30+ 错误提示零"下一步"；11 处"后端未给出原因"占位串 | W1 |
| E-6 | 🟠 | OpsPage + TokenStats | 真 bug：空池渲染永久"加载中"（OpsPage:536）；4 张口径卡加载中显示 `0`（TokenStats:263/285/313/333） | W1 |
| E-7 | 🟡 | TrafficPage | 死交互：点成功行无反馈但有 cursor-pointer；「按模型筛选」是假控件（后端不读 `model` 参数，已实读复核 admin-traffic.js 全部 query 读取点） | W1 |
| P1-007 | 🟠 | AppLayout + 全部表格 | 移动端零断点：390px 主区仅 ~174px，10 列表格不可用 | W6 |
| E-9 | 🟡 | AccessKeysPage | 密钥「轮换」`graceMs:0` 硬编码但文案说宽限期；创建密钥疑似缺 `platform` 400（**未运行验证，见 §6 回归门**） | W2 |
| E-10 | 🟡 | GrowthPanel | 兑换按钮硬编码 tier `'1'` | W5（并入成长中心） |
| E-11 | 🟡 | 多处 | 12 个 disabled 按钮无解释；toast 3200ms 固定时长截断长错误文本 | W1/W2 |

#### F 类：文案与信息架构

| ID | 级别 | 模块 | 问题 | 整改波次 |
|---|---|---|---|---|
| P1-005 | 🟠 | TokenStatsPage + 多页 | `DSH` 内部代号泄漏到 footer；R² 方法论塞进面板底部；同一警告重复 4 次；「口径」一词 28 次/5 文件 | W1 |
| F-2 | 🟡 | 多页 | 页面 description 是分段标签的顿号拼接（OpsPage:423、TrafficPage:129、OverviewPage:87、CredentialsPage:217） | W1 |
| F-3 | 🟡 | 多页 | 术语墙：FEFO、轮转池大小、业务层失败 直接作为 UI 文本无解释 | W1 |
| F-4 | 🟡 | AccessKeysPage | 「旧密钥将进入宽限期后失效」与 `graceMs:0` 行为不符 | W2 |

#### G 类：产品定位（Razor 轮 + Professor 轮一致判定）

| ID | 级别 | 模块 | 问题 | 整改波次 |
|---|---|---|---|---|
| P2-001 | 🟡 | GrowthPanel + cat-trip | **1860 行 scope creep**：网关 UI 里的抽奖/稀有度/Buddy/补登卡；后端 15 写端点 vs UI 3 按钮；定时器已在跑同一 job；功能自承"建议按需手动执行" | W5 |
| G-2 | 🟡 | OpsPage | 1603 行 / ~40 控件 / 24 面板；「调度预演」33 只读字段、「粘性会话」「FEFO 到期信号」内部术语做面板标题 | W2 |
| G-3 | 🟡 | 全局 | 单机单人前提下仍保留 5 个密钥生命周期按钮（其中 3 个永不使用） | W6（记录型，接受） |

#### H 类：能力缺口（后端已有、UI 不可达 —— Razor 轮 Prove-first 已确认需要）

| ID | 级别 | 模块 | 问题 | 整改波次 |
|---|---|---|---|---|
| H-1 | 🟠 | 全局 | **无 onboarding 状态机**：不知道用户走到了哪一步 | W2 |
| H-2 | 🟠 | audit | `GET /v1/admin/audit` 后端已实现，UI 零入口（密钥 reveal/凭据导出不可追溯） | W3 |
| H-3 | 🟠 | scheduler | `POST /v1/admin/scheduler/:action`（checkin/keepalive/probe）后端已实现，UI 零入口 | W3 |
| H-4 | 🟡 | 全局 | 无 README（根目录与 web/ 均无）；UI 无版本号（根 3.0.0 vs web 1.0.0）；零 changelog | W6 |
| H-5 | 🟡 | api-keys | `ApiKeyRow.scopes/resources/rpmLimit` 后端有、UI 不显示 —— 与 M-S5（已修复）同域，UI 无法看出密钥能调什么 | W6（Prove-first，随 M-S5 修复顺带评估） |

#### I 类：测试与工程设施

| ID | 级别 | 模块 | 问题 | 整改波次 |
|---|---|---|---|---|
| P3-002 | 🟠 | 全局 | **三个转发路由零测试**（openai/anthropic/responses 在全部测试中 0 require）；无 HTTP 层测试；前端零测试；`src/` 108 文件无 linter（lint 脚本只覆盖 web/）；无 CI | W3 起，贯穿 |
| I-2 | 🟡 | ci | **CI 陷阱**：`unit.test.js` 失败时 stdout 仍打印 `N passed`（FAIL 走 stderr）→ CI 必须查 exit code | W3 |
| I-3 | 🔵 | 仓库 | 无 CI 配置；调试产物入库（dev.log/tsbuildinfo/.playwright-cli）；`docs/` 有完全重复文件（37737 字节 ×2） | W3/W6 |
| I-4 | 🔵 | tailwind | tailwind 被降级为"间距工具"，色彩全部走 CSS 变量 + 241 处内联 —— 已在 R-D7 一并处理 | W1 |

#### J 类：后端协议架构（已确认分叉，重构延后）

| ID | 级别 | 模块 | 问题 | 整改波次 |
|---|---|---|---|---|
| P2-004 | 🟡 | 4 个路由文件 | 8 项职责 × 4 出口手写重复；已产生 4 处行为分叉：`markIncompleteToolArgs`（openai 传 config、dispatch 硬编码 false）、`AUTO_CONTINUE` 只在 openai 生效、`responses.js` 无条件 `status:'completed'` 不区分截断、流错误出口质量不一 | W7（独立执行，前置条件见 §4） |
| J-2 | 🟡 | pool.js | `store.list()` 自述 1000 账号 27ms，热路径单次调用最多 4 次，同步阻塞；每请求另有 3 次同步 stat（stats-cache invalidate） | W7（随协议重构顺带） |
| J-3 | 🟡 | rotate | 轮换系统是真实现（Windows 会话模型按实测写就），但 Session 0 服务形态下 `startClient` 必然失败（代码自认）→ 实际产出是"auth 文件来回换" | 不整改（Q5 决策：单机前台运行形态下成立，记录为已知限制） |

---

## 2. 根因分析（为什么会产生这 87 项）

五条根因解释了全部发现的分布，也解释了为什么"功能分 82 而 UX 分 38"：

### 根因 1：**"先生成后接线"的 AI 工作流指纹**（解释 A/C/D 类）
AI 先把 API 层铺满（对称、完整），再随手做几个按钮。证据链：15 个零导入的 api 导出、后端 15 写端点 vs UI 3 按钮、`EmptyState` 组件存在却手抄空态 6 次、`isBusinessFailure` 已导出却各页手写布尔。**修复模式**：先删死代码（W1），再补接线（W3），最后补 UI（W2）。

### 根因 2：**单人产品用了多人假设**（解释 G 类 + E 类的一部分）
5 个密钥生命周期按钮、33 个只读配置字段、"调度预演"——这些是"网关应该有的完整性"，在"我就是唯一用户"的前提下全部失效。**修复模式**：按 Q5 决策，单机视角下冗余可删；但**不删后端能力**（留 CLI/脚本通道）。

### 根因 3：**防御性代码替代了状态设计**（解释 E6/E7、P3-001）
`catch {}` 静默（OAuth 轮询、余额轮询）、空态渲染 `<LoadingBlock/>` 永久转、`/health` 硬编码 ok、加载中显示 0 —— 都是"用兜底行为回避设计失败路径"的产物。**修复模式**：W1 统一三态规范，W5 修启动链。

### 根因 4：**文档写作习惯渗入 UI**（解释 F 类）
R² 方法论进 footer、`DSH` 代号泄漏、同一 caveat 重复 4 次、「口径」成为分类学——这是 AI 把"对齐后端实现"的注释写给了终端用户。**修复模式**：W1 一次性清理 + 建立"UI 文案 ≠ 技术文档"的边界规则。

### 根因 5：**测试覆盖错位**（解释 P0 全部 + P2-003/P2-004）
288 断言覆盖的是**容易测的**（纯函数、数据转换），漏掉的是**难测但核心的**（三个转发路由 0 require、并发写、停机、流序列）。P0-001 和 P2-003 都是被测试盲区放过的。**修复模式**：W3 先建 CI + 后端 linter 守住存量，W5 建 P0/协议回归测试。

**根因→整改的映射**：W1 治根因 3+4（状态与文案）、W2 治根因 2+4（IA 与重复）、W3 治根因 5（守门设施）、W4 治 P0（数据与停机）、W5 治根因 1 残余（协议正确性）、W6 治体验兜底（移动端与文档）、W7 治根因 1 的架构层（协议收敛）。

---

## 3. 整改方案总览（7 波次 / 6 个工作日）

| 波次 | 主题 | 覆盖发现 | 工作量 | 依赖 |
|---|---|---|---|---|
| **W1** | 死代码清除 + 三态规范 + 文案清理 | C 类全部、E6/E7、P1-003、P1-005、F 类 | 1 天 | 无 |
| **W2** | 信息架构收敛 + onboarding + 交叉链接 | R-M1~M8、P1-002、E-2/3/4、H-1、R-D8、G-2 部分 | 1 天 | W1 |
| **W3** | 守门设施（CI + linter + 审计页 + 手动触发） | I 类全部、H-2、H-3 | 1 天 | 无（可与 W2 并行） |
| **W4** | 两个 P0 + 两条 P1 安全项 | P0-001/b、P0-002、P1-008、P1-004 | 2 天 | W3（必须有 CI 才能动后端） |
| **W5** | 协议正确性 + 成长中心取舍 + 幽灵配置 | P2-003、P2-001、P2-002、P3-001、E-10 | 2 天 | W3 + W4 |
| **W6** | 移动端 + 发布基线（README/版本/changelog）+ 记录型安全项 | P1-007、H-4、P2-009/010 记录、G-3 记录、I-3 清理 | 2 天 | W1 |
| **W7** | 协议适配层重构（独立执行） | P2-004、J-2 | 2-3 天 | **W5 完成 + 协议测试就位** |

**关键排序原则**：
1. **W1 最先**：全部是删除与文案，零行为风险，立刻提升 True Score（45→58），且为 W2 清场。
2. **W3 与 W1/W2 可并行**：CI 不依赖任何代码改动，且必须在 W4 之前就位（W4 动的是 `src/`，没有 CI 就是裸奔）。
3. **W4 必须在 W5 之前**：`encrypt.key` 校验（P3-001 的一部分）提前到 W4 一起做，因为它同样是"数据不可逆丢失"级别。
4. **W7 单独执行且可放弃**：它是唯一"高风险高收益"的项，若协议测试写不出行为等价断言，就停在 W5（记录为技术债），**不要强行重构**。

---

## 4. 各波次执行明细（改正方向 + 实施步骤 + 验收标准）

> 每个条目格式：**方向 → 步骤 → 验收**。详细的可复制修复提示词已在两个来源中，此处只引用：Professor 轮 [issues/](../04-reviews/product-audit-2026-10-10/issues/) 16 个 issue 文件、[PROMPTS.md](../04-reviews/product-audit-2026-10-10/PROMPTS.md) 的 4 批次提示词；Razor 轮 §裁剪清单。

### W1 —— 死代码清除 + 三态规范 + 文案清理（1 天）

#### W1-1 清除死代码（方向：删，不是注释）

**步骤**：
1. 删 15 个零导入 api 导出（R-D3 清单；每个删前 `grep -r "符号名" web/src` 确认仅定义处命中）。
2. 删死导出与死状态（R-D1/D2/D5）。
3. 删死类型字段（R-D4）——注意 `Account.verifiedBalance` 在 `workbuddy.ts` 有类型复用，删时同步清引用。
4. `accountState` 双实现合一（R-D6）：保留 [format.ts:6](../../web/src/shared/lib/format.ts)，`types.ts:120` 改 re-export。
5. CSS 幽灵修复（R-D7）：`--rg-bg-primary`→`--rg-bg-base`、`--rg-state-ok`→`--rg-state-success`、补 `.t-label` 定义或改用等价类、删 `tailwind.config.ts` 死 palette 与指向不存在文件的注释。
6. 新增 `scripts/check-css-tokens.mjs`（正则提取 `global.css` 的 `--rg-*:` 定义与 `web/src` 的 `var(--rg-*)` 引用，断言引用 ⊆ 定义）+ `web/package.json` 加 `check:tokens` script。

**验收**：
- [ ] `npx tsc -b --force` 零错误（未使用 import/变量会被捕获）
- [ ] `npm run lint` 零错误
- [ ] `npm run build` 成功，chunk 数量不增
- [ ] `npm run check:tokens` 通过（若实现）
- [ ] grep 验证：`web/src` 中 `DSH`=0、`EmptyState` 的引用数 = 定义数、15 个 api 符号 0 命中

#### W1-2 三态规范落地（方向：先修 2 个真 bug，再统一组件）

**步骤**：
1. 修 E6 两个真 bug：
   - [OpsPage.tsx:536](../../web/src/features/ops/OpsPage.tsx#L536) 空池 `<LoadingBlock/>` → 拆分 `runtime.loading` 与空态两个分支
   - [TokenStatsPage.tsx](../../web/src/features/stats/TokenStatsPage.tsx) 4 张 CaliberCard 加 `loading` prop，加载中显示 `—` 而非 `0`
2. 扩展 `EmptyState`：支持 `action?: {label, onClick}` 与 `hint?: string`，保持向后兼容。
3. 替换 6 处手抄空态 div 为 `EmptyState`，并逐个补下一步动作（W1-4 的文案清单）。
4. 修 E7 死交互：TrafficPage 成功行去 `cursor-pointer` 或加点击反馈；「按模型筛选」假控件 → **删除输入框**（后端过滤为可选后续，不在本波次）。
5. 全库替换 11 处"后端未给出原因"/"未给出原因"为面向用户文案（"网关拒绝了这次操作，请稍后重试；若持续失败请查看运维 → 任务日志"）。

**验收**：
- [ ] 手动验证：清空账号后 `/ops` 第一屏显示空态文案而非"加载中…"
- [ ] 手动验证：TokenStats 4 张卡在断网/慢网下显示 `—` 而非 `0`
- [ ] grep：`后端未给出原因`=0、`未给出原因`=0
- [ ] 全库空状态盘点表（21 项）逐项打勾，19 项含 action 或原因

#### W1-3 文案清理（方向：内部代号出 UI，重复警告合一）

**步骤**（详细逐条改法见 [P1-005 issue](../04-reviews/product-audit-2026-10-10/issues/P1-005-docs-as-ui-copy.md)）：
1. 删 TokenStatsPage:738 整段 footer（R² 方法论 + DSH 代号）。
2. 「Trae 账单滞后」保留 :354 一处（并移到"官方账单积分"卡片内部），删 :453、:788。
3. 删 :436 图表 footer（历史 bug 说明）；表格 :406 已有数据点旁标注，保留。
4. 删 OpsPage:1434 与 ModelRouterPage:306 的"业务层失败"footer（近乎逐字重复）。
5. OpsPage:1598 全局 Note 移入 `rotate`/`config` 分支内。
6. 重写 4 处"顿号拼接"页面 description（OpsPage:423、TrafficPage:129、OverviewPage:87、CredentialsPage:217）。
7. 「口径」降频：28 次 → ≤10 次。

**验收**：
- [ ] grep：`DSH`=0（UI 区域）
- [ ] grep：`口径` ≤ 10
- [ ] 「Trae 滞后」在 TokenStatsPage 出现恰好 1 次
- [ ] 每 8 个页面的 description 人工过一遍，无标签拼接
- [ ] `npx tsc -b --force` 零错误

### W2 —— 信息架构收敛 + onboarding（1 天，依赖 W1）

#### W2-1 Overview 瘦身（[P1-001](../04-reviews/product-audit-2026-10-10/issues/P1-001-overview-duplication.md)）

**步骤**：删账号表（:175-248）与「运行状态」9 项（:250-278）→ 改为异常摘要条（`keepaliveOf(a).tone==='danger'` 计数 + `accountState(a)==='cool'` 计数 + "去凭据池处理"按钮）+ 一行"查看运行状态 →"链接；清理 `getRuntime` 调用与相关 import；文件头加约束注释"本页不得复制凭据池的表格或运维页的运行状态"。

**验收**：OverviewPage 无 `<table>`；无 `getRuntime` 引用；有异常账号时摘要条出现且按钮跳转正确；tsc/lint/build 零错误。

#### W2-2 onboarding 状态机（[P1-002](../04-reviews/product-audit-2026-10-10/issues/P1-002-onboarding-dead-end.md)）

**步骤**：
1. 新建 `web/src/features/setup/onboarding.ts`：`useOnboarding()` 返回 3 步（account / key / verify）状态与 next 指针。
2. AppLayout 主区顶部渲染进度条（仅当有未完成步骤；完成自动消失；**不用弹窗**）。
3. ImportWbDialog 导入成功不自动关闭：改 success 态 +「立即启用」按钮（调 `patchAccount(id,{enabled:true})`）。
4. CredentialsPage 行内「重新登录」按钮（`keepaliveOf(a).label==='需重新登录'` 时出现，打开 OauthTraeDialog）。
5. 三页互链：AccessKeysPage 密钥创建成功后展示 baseUrl + curl +「验证连通性」；ClientAccessPanel footer 加"密钥在访问密钥页创建"；TrafficPage 连通性测试成功后 `localStorage.setItem('rg_verified','1')` + 反向链接。

**验收**：
- [ ] 新会话首次登录：总览顶部出现"还差 3 步"进度条，逐步完成逐步消失
- [ ] WB 导入后不关弹窗，点"立即启用"后凭据表该行变可用
- [ ] 凭据行有"需重新登录"时该行出现"重新登录"按钮且能打开 OAuth 流程
- [ ] mint→配置→验证三步每一步都能看到下一步的入口
- [ ] 完成全部步骤后刷新页面，进度条不再出现

#### W2-3 信息架构收敛（R-M1~M8、R-D8、G-2 部分）

**步骤**：
1. R-D8：nav.ts 与 OpsPage TABS 合并为单一事实源（nav.ts 导出 ops 组项，OpsPage 引用）。
2. R-M2：删两处后端算法镜像（`accountPacks.packsOf` 排序保留字段派生、`ModelRouterPage:339-359` 轮转池复算改读后端返回的池标记或直接删标记）。
3. R-M3：到期口径统一为**积分额度**（与后端一致），账号数口径改名"N 个账号有额度 7 日内到期"。
4. R-M4：凭据行「权益包」改用 `packsOf(a)[0]`。
5. R-M5：「最近操作与保活」6 列并为折叠区或两段。
6. R-M7：新建 `runBusiness()` 包装（复用 `isBusinessFailure`+`businessFailureReason`），替换 OpsPage/GrowthPanel 的手写判定。
7. R-M8：OpsPage 调度器开关/池化策略/管理密钥分离/签到保活时刻各留一处（env 只读 Chip 或 config 只读值，不重复）。
8. G-2 部分：OpsPage「网关配置」33 只读字段折叠为一个"查看生效配置"详情块。

**验收**：
- [ ] grep `schedulerEnabled` 在 OpsPage UI 中只出现一处 Chip
- [ ] PackDialog 与凭据行的"权益包"显示来自同一派生函数
- [ ] 全库 `isBusinessFailure` 调用点 ≥ 3（此前 0）、手写 `ok===false` 判定为 0
- [ ] ModelRouterPage 不再包含排序算法（grep `.sort(` 在该文件仅剩展示排序）
- [ ] 移动端无关；`npx tsc -b --force` 零错误

### W3 —— 守门设施（1 天，可与 W1/W2 并行）

#### W3-1 CI + 后端 linter（[P3-002 阶段 1](../04-reviews/product-audit-2026-10-10/issues/P3-002-test-coverage-gap.md)）

**步骤**：
1. `.github/workflows/ci.yml`（windows-latest；`npm ci → npm test → web ci/lint/build → npm audit --audit-level=high`；**严禁 `|| true`**）。
2. `src/` 接入 Biome（`@biomejs/biome` devDep + `biome.json` recommended 规则、不开格式化避免大规模 diff）。
3. `package.json` lint 脚本改为 `npm --prefix web run lint && npx biome check src`。
4. 首次运行按两类处理：真实问题修掉；风格问题 overrides 压住并标 TODO。

**验收**：
- [ ] CI 在 GitHub 上跑通一次全绿（或本地 `act` 等效验证）
- [ ] `npx biome check src` 退出码 0
- [ ] 故意制造一个失败断言并 push，确认 CI 红灯（验证 exit code 陷阱已规避）

#### W3-2 审计页 + 手动触发（H-2、H-3）

**步骤**：
1. `shared/api/admin.ts` 加 `getAudit(params)` 封装（后端 `GET /v1/admin/audit` 已实现，[admin-security.js:59](../../src/routes/admin-security.js#L59)）。
2. 新建 `web/src/features/security/AuditPage.tsx`：时间/事件/结果/ip 表格；路由 `/audit`；nav「运维」组加"审计日志"。
3. OpsPage「定时任务」分段顶部加三个按钮「立即签到」「立即保活」「立即探测」→ `POST /v1/admin/scheduler/:action`，结果刷新任务日志。

**验收**：
- [ ] 手动触发一次 `checkin`，任务日志出现对应记录
- [ ] 审计页能看到历史 `key.reveal` 事件
- [ ] `npx tsc -b --force` 零错误

#### W3-3 协议层测试（P2-004 的前置，本波次只建测试不重构）

**步骤**：见 [P3-002 issue 阶段 2](../04-reviews/product-audit-2026-10-10/issues/P3-002-test-coverage-gap.md)。mock `upstream/client.js` 的 `llmUtilsChat`；每协议 3 用例（正常流/中途错误/截断）；断言含"OpenAI 出口无 `[Error` 文本 chunk + `[DONE]` 收尾 + 截断时 `finish_reason:'length'`"与"anthropic 流内 `pool.record` 的 accountId 非 null"（此断言在 P2-003 修复前会失败 —— **这是故意的红灯**，作为 W5 的驱动测试）。

**验收**：
- [ ] `npm test` 出现新套件；OpenAI/Anthropic/Responses 三组中，**流错误用例在 W5 之前是失败态并被 CI 临时豁免**（或直接安排在 W5 一并提交）
- [ ] 正常流与截断用例全绿

### W4 —— 两个 P0 + 两条 P1 安全项（2 天，依赖 W3 CI）

#### W4-1 丢失更新修复（[P0-001](../04-reviews/product-audit-2026-10-10/issues/P0-001-store-update-lost-update.md)）

**方向**：乐观版本列 + 按需 SET 子句 + CAS 重试 + 移除只读接口写库。

**步骤**：见 issue 的 6 步提示词。要点：`db.js` 幂等 ALTER 加 `version INTEGER NOT NULL DEFAULT 0`；`store.js` 新增 `buildSetClause(patch)`；`update()` 改 `WHERE id=? AND version=?`，`changes===0` 时重读重试 ≤3 次后抛 `WRITE_CONFLICT`；**`pool.js:725/:750` 的只读写库下沉到 balance-refresh 任务**；新增 `src/test/store-concurrency.test.js`（用例 A/B/C）。

**验收**：
- [ ] 并发测试：A 改 enabled + B 改 priority，两者最终都生效
- [ ] 跨进程测试：子进程写 priority → 主进程写 enabled → priority 未被回滚
- [ ] `GET /v1/admin/runtime` 后 accounts 表 `total_changes` 增量为 0
- [ ] 288 既有断言 + 新用例全绿，exit 0

#### W4-2 优雅停机 + 跨进程防重（[P0-002](../04-reviews/product-audit-2026-10-10/issues/P0-002-no-graceful-shutdown.md)）

**步骤**：`crash.js` 的 `process.exit(0)` 改为 `shutdown(signal)`（5s 兜底强退）；`index.js` shutdown 链 `server.close → 4 个定时器 stop → flush → db.close → exit`（缺失的 `stop()` 在各模块补）；`output/.trae-api/scheduler.lock` 文件锁（写 PID，启动时 `process.kill(pid,0)` 探活）；新增 `src/test/shutdown.test.js` 3 用例。

**验收**：
- [ ] `start.bat` 运行中 Ctrl+C：控制台出现 shutdown 序列、无 unhandled rejection、退出码 0
- [ ] 双进程启动：第二个进程日志出现"another instance holds the lock"且调度器不启动
- [ ] 288 既有断言 + 3 新用例全绿

#### W4-3 默认限流 + OAuth 面（[P1-008](../04-reviews/product-audit-2026-10-10/issues/P1-008-unlimited-default-ratelimit.md)、[P1-004](../04-reviews/product-audit-2026-10-10/issues/P1-004-oauth-listener-injection.md)）

**步骤**：
1. `rate-limit.js:14` fallback `0 → 60`；`.env.example` 加 `KEY_DEFAULT_RPM=60` 及注释；`KEY_IP_RPM`（默认 0=关）作为可选 IP 兜底。
2. OAuth：GET 分支补 Origin/Referer 白名单（与 POST 分支同一份，抽共享常量）；`completeLogin` state 不匹配**拒绝**（删"仅告警不拒绝"）；拒绝事件走 `writeEvent`；`security.test.js` 加 3 用例（错 state/无 Origin/正常流程）。
3. `express.json` limit `10mb → 2mb`（配合限流）。

**验收**：
- [ ] 未设 rpmLimit 的密钥第 61 次请求 429（新测试）
- [ ] `curl "http://127.0.0.1:17388/authorize?refreshToken=X&state=wrong"` 返回 4xx 且 accounts 无新增
- [ ] 正常 OAuth 流程回归通过（41 个 security 断言 + 3 新用例全绿）

### W5 —— 协议正确性 + 成长中心取舍 + 幽灵配置（2 天，依赖 W3+W4）

#### W5-1 流错误修复（[P2-003](../04-reviews/product-audit-2026-10-10/issues/P2-003-stream-error-as-text.md)，同时让 W3-3 的红灯转绿）

**步骤**：`emitters.js` 的 `exportOpenAI().error` 改为 `[finish_reason:'stop' 空 chunk, 顶层 error 对象 chunk, [DONE]]`；`anthropic.js` 的 `streamAccountId` 时序修复（对齐 responses.js 模式）；`consumeStream` 加 `finally { reader.cancel() }`；流读取软超时 `STREAM_IDLE_TIMEOUT_MS`（默认关闭）。

**验收**：
- [ ] W3-3 的 9 个协议用例**全部转绿**
- [ ] grep：`emitters.js` 中 `content:` 不再出现在 error() 内
- [ ] 288 既有断言全绿

#### W5-2 成长中心取舍（[P2-001](../04-reviews/product-audit-2026-10-10/issues/P2-001-growth-center-scope-creep.md)，按 Q2 决策 = 方案 B）

**步骤**：删「抽奖」按钮及 `draw()`、删 Buddy/稀有度/补登卡/能量列、删「一键执行」按钮与整个轮询状态机（4 state + 4 ref + runAuto）、清理 `growthDraw/growthAuto/growthProgress` import；**保留**定时器（scheduler.js:578-602）、后台 job、11 个 growth 断言、只读概览（连登/可参与账号）。

**验收**：
- [ ] `GrowthPanel.tsx` 中 grep「抽奖|稀有度|Buddy|补登卡」= 0
- [ ] `npm run test:growth` 11 断言全绿
- [ ] tsc/lint 零错误

#### W5-3 幽灵配置清理（[P2-002](../04-reviews/product-audit-2026-10-10/issues/P2-002-ghost-config.md)，方案 A）

**步骤**：删 `config.js` 三处 `fallbackConfig` 引用；删 `model-fallback.json`；`.env.example` 删 `PROJECTION_ENABLED`/`PROJECTION_MAX_SYSTEM`、把 `STATS_CACHE_OFF` 改为 `STATS_CACHE=off`（以代码为准）；**保留** `TASK_LOG_MAX_ENTRIES` 与 `SCHEDULER_ENABLED`；启动时检测到该文件存在打警告日志；backup.js 对该文件的引用改条件处理；确认 `TOOL_PROTOCOL` 是否有行为分支，无则从 .env.example 移除。

**验收**：
- [ ] `src/` 中 `fallbackConfig` 0 引用
- [ ] grep `PROJECTION_` 全库 0 命中
- [ ] 老用户升级路径：遗留文件存在时启动日志有明确警告
- [ ] 288 断言全绿

#### W5-4 启动链健康化（[P3-001](../04-reviews/product-audit-2026-10-10/issues/P3-001-silent-degraded-startup.md)）

**步骤**：`/health` 重写为真实检查（db/modelConfig/modelRouter/encryptKey 四项，全过 200 / 任一失败 503，checks 只返回布尔枚举不泄敏感）；`ensureSchema` 纳入启动 try/catch，DB 失败退出码 1；`crypto.js` 暴露"本次是否新建 key"，启动时若新建且 DB 有密文行 → 明确报错退出；配置文件损坏 → WARN + `/health` degraded + `/v1/admin/config` 返回 warnings 数组；`pruneAtStartup` 移到 `scheduler.start()` 之前；新增 `src/test/startup.test.js`。

**验收**：
- [ ] 手动改名 `encrypt.key` 后重启：进程拒绝启动并打印明确原因
- [ ] 破坏 `model-router.json` 后：`/health` 503 且 `checks.modelRouter=false`
- [ ] 正常启动 `/health` 200；288+新增断言全绿

### W6 —— 移动端 + 发布基线（2 天，依赖 W1）

#### W6-1 移动端（[P1-007](../04-reviews/product-audit-2026-10-10/issues/P1-007-mobile-unusable.md)）

**步骤**：AppLayout `<768px` 侧栏改 fixed 抽屉（44px 汉堡 + 遮罩，useState，零新依赖）；`global.css` 加 `card-table` 媒体查询块（thead 隐藏/tr 变卡/td 用 `data-label::before`）；全部 10+ 个表格的 `<td>` 加 `data-label`；`.btn-sm` 移动端 `min-height:44px`、danger 按钮加边框分离；Clock 移动端降为 60s。

**验收**：
- [ ] Chrome devtools 390×844 走通全部 8 条路由，无横向滚动
- [ ] 凭据表/任务日志/请求明细在移动端为可读卡片
- [ ] 1920×1080 桌面端视觉零回归（截图对比）

#### W6-2 发布基线（H-4）

**步骤**：写根 README（定位/快速开始/首登取钥/常见问题）；版本统一（根 3.0.0 为准，web 同步，AppLayout 侧栏底部显示 `v3.0.0`）；写 CHANGELOG.md（从 git log 最近 10 commit 整理为用户语言）；`docs/wb-ecosystem-comparison*.md` 去重；删调试产物（web/dev.*.log、tsbuildinfo、.playwright-cli）并补 web/.gitignore。

**验收**：
- [ ] 新人按 README 从 clone 到首次 API 调用 ≤ 15 分钟（实测）
- [ ] UI 任何页面可见版本号
- [ ] `git status` 无调试产物

#### W6-3 记录型安全与定位项（P2-009/010、G-3、H-5、J-3）

**方向**：不整改，落档为"已知限制与接受理由"。
**步骤**：新建 `docs/01-architecture/known-limitations.md`，逐条记录：无盐 SHA-256（高熵随机钥下可接受 + `ADMIN_KEY` 应为长随机值的提示）、密钥与密文同目录（单机信任域）、5 个密钥按钮保留（多设备场景）、`scopes/resources` 无 UI（随 M-S5 已修复，UI 展示延后）、轮换在服务形态下的 Session 0 限制。

**验收**：
- [ ] 文件存在且每条含"现状 + 接受理由 + 触发重新评估的条件"

### W7 —— 协议适配层重构（2-3 天，独立，可放弃）

**前置条件（全部满足才开工）**：
- [ ] W5-1 完成（流错误出口已修）
- [ ] W3-3 的协议测试全绿（行为基线已锁定）
- [ ] W4 完成（数据层/停机层稳定）

**步骤**：见 [P2-004 issue](../04-reviews/product-audit-2026-10-10/issues/P2-004-no-protocol-adapter.md) 的三阶段提示词（第 0 步建测试 → 第 1 步抽 pipeline 行为等价 → 第 2 步统一 4 处分叉每处一个 commit → 第 3 步 dispatch.js 并入）。

**验收**：
- [ ] 三路由各 ≤150 行
- [ ] 4 处分叉消除（markIncomplete / AUTO_CONTINUE / 截断状态 / 错误事件），每处有对应用例
- [ ] 全量测试绿 + 人工冒烟三协议各一次真实请求
- [ ] **若任一步行为等价无法保证：停止并报告，不强行继续**（保留 W5 状态即可，W7 是优化不是修复）

---

## 5. 时间节点规划与责任划分

### 5.1 日历（6 个工作日 + 1 个可选日）

```
Day 1   W1 死代码/三态/文案        ──┐
Day 1   W3-1 CI+linter（并行）      ──┤→ 当日验收：build 绿 + CI 绿
Day 2   W2 IA收敛+onboarding       ──┤  W3-2 审计页/手动触发（并行）
Day 3   W4-1 丢失更新              ──┤  W4-2 优雅停机
Day 4   W4-3 限流+OAuth            ──┤  W5-3 幽灵配置
Day 5   W5-1 流错误 ─ W5-2 成长中心 ──┤  W5-4 启动链
Day 6   W6-1 移动端 ── W6-2 发布基线 ──┘  W6-3 known-limitations
Day 7+  W7 协议重构（可选，独立分支）
```

### 5.2 责任划分

本项目是单机单人项目，"责任划分"按**执行角色**而非人头：

| 角色 | 负责波次 | 职责 | 交付物 |
|---|---|---|---|
| **执行者**（你 / AI 会话） | W1-W6 全部 | 按 issue 提示词逐条实施；每条目完成即跑该条目验收清单 | 代码 + 每波次验收打勾表 |
| **验证者**（独立 AI 会话或次日自查） | 每波次末 | 只拿验收清单做黑盒验证，不看实现过程；对"grep 类"验收逐条跑 | 验证记录（过/不过 + 证据） |
| **决策者**（你） | 3 个决策点 | ① W5-1 前确认 W3-3 测试基线可接受；② W6 后决定是否启动 W7；③ 任何"行为等价无法保证"时的停止/继续 | 决策记录（写入 CHANGELOG） |
| **回归门**（CI + 全量测试） | 每次提交 | `npm test` 全绿 + `npm run build` + web lint + （W3 后）CI 绿 | 提交记录 |

**单条目完成定义（DoD）**：代码改完 → 该条目验收清单全打勾 → `npx tsc -b --force` + `npm run lint` 零错误 → `npm test` 全绿 exit 0 → 提交（一个条目一个 commit，便于回滚）。

---

## 6. 验证方案与回归检查

### 6.1 三层验证体系

| 层 | 内容 | 频率 | 工具 |
|---|---|---|---|
| **L1 自动回归** | 288 既有断言 + 各波次新增用例（并发/停机/启动/协议/限流/OAuth） | 每次提交 | `npm test`（exit code！） |
| **L2 静态守门** | tsc / web-lint / biome / build / check:tokens / npm audit | 每次提交 | CI（W3-1 后） |
| **L3 人工黑盒** | 每波次验收清单中的"手动验证"项（见 §4 各条） | 每波次末 | 验证者角色执行 |

### 6.2 波次回归矩阵（每波次完成后必跑）

| 波次完成后 | 必须回归的范围 | 特别验证点 |
|---|---|---|
| W1 | 全量 L1+L2 | 15 个删除符号 0 命中；`DSH`=0；空池显示空态；口径卡显示 `—` |
| W2 | L1+L2 + Overview/SetupGate/Credentials 手工走查 | onboarding 进度条出现与消失；WB 导入→立即启用；行内重新登录打开 OAuth |
| W3 | L1+L2 | CI 红灯测试（故意失败）；审计页可见 reveal 事件；手动触发写任务日志 |
| W4 | L1+L2 + **双进程场景** | 并发写测试 A/B/C；Ctrl+C 优雅退出；锁文件拒绝第二实例；61 次 429；错 state 注入被拒 |
| W5 | L1+L2 + **三协议真实冒烟** | W3-3 红灯全绿；GrowthPanel 无抽奖字样；`encrypt.key` 改名拒绝启动；幽灵文件警告 |
| W6 | L1+L2 + **390px 全路由走查 + 1920px 截图对比** | 无横向滚动；卡片可读；桌面零回归；README 新人 15 分钟走通 |
| W7 | L1+L2 + 协议测试 + 三协议真实冒烟 | 三路由 ≤150 行；4 分叉消除；行为等价 |

### 6.3 明确的"不回归"承诺（防止整改引入新问题）

| 资产 | 保证 |
|---|---|
| 288 个既有断言 | 全程绿灯，任何波次不得以"重构需要"为名跳过或删除（新增可，删改需在 commit message 说明理由） |
| `unlimited`≠0、积分 vs ZCode token 双口径、`isLoginKeyRejection` 401 分流、AbortSignal 取消、消耗型 prompt、`safetyBackup` | Razor 轮确认的"必须保留的复杂性"，任何波次不得触碰 |
| 后端 API 契约 | W1-W6 不改任何端点的 URL/方法/字段（W7 重构内部实现时行为等价） |
| `.env.example` 中真实生效的项 | `TASK_LOG_MAX_ENTRIES`、`SCHEDULER_ENABLED` 不删（复核确认） |

### 6.4 未决事项与风险门（诚实清单）

| 项 | 状态 | 处理 |
|---|---|---|
| AccessKeysPage 创建密钥缺 `platform` 疑似 400 | 静态推断，**未运行验证** | W2-2 实施时顺手实测；若 400 则一并修（issue 已附修法） |
| 流中途 3004 是否真实可达 | 未实测 | W5-1 修复覆盖该路径，无论可达与否都有收益（防御性） |
| `store.list()` 27ms 真实幅度 | 来自代码自述 | W7 才处理热路径；W4 的 CAS 重试对其无放大（重试仅在冲突时发生） |
| OAuth no-cors 导航可达性 | 未实测 | 修复为防御性收紧，不依赖该判断 |
| 轮换 Session 0 限制 | 代码自认 | J-3，已落档 known-limitations |
| W7 行为等价风险 | 结构性 | §4 W7 的停止条款；可整体放弃且不影响 W1-W6 的全部收益 |

### 6.5 完成定义（整体 DoD）

- [ ] 87 项发现中：**阻断 4 条主线全部关闭**（P0-001/b、P0-002）；**严重 14 项全部关闭**（P1×8、P2-002/003、E 类 4 项、H 类 3 项、I 类 2 项）
- [ ] 一般项：W1-W6 范围内全部关闭；G-3、P2-009/010、J-3 落档 known-limitations；W7 若执行则关闭 P2-004/J-2，若放弃则落档
- [ ] SCORECARD 复测：Overall ≥ 74（第 3 批后）/ ≥ 80（第 4 批后）；AI 感 ≤ 4.0；Launch Readiness ≥ 75
- [ ] 期望抱怨严重度 7.5 → ≤ 4（对照 USER_COMPLAINTS.md 的 5 角色重新模拟）
- [ ] CI 全绿连续 7 天

---

## 附录 A：两轮审查的裁决对照（防止漏项）

| Razor 轮裁决 | Professor 轮对应 | 本方案处置 |
|---|---|---|
| Delete：15 个 api 导出、EmptyState 等 8 个死件、FEFO 镜像 ×2、假控件 | P3-010 + 死代码清单 | W1/W2 |
| Merge：Overview 重复 ×3、TABS 双声明、Dirty×4→useDraft、accountState 合一、KeyCards 三合一 | P1-001 | W1/W2 |
| Replace：lastAbortReason 单槽、runBusiness 统一、兑换 tier、graceMs 文案、未探测筛选、isCurrent 乐观更新 | — | W2（lastAbortReason 并入 W4-1 提交） |
| Defer：密钥 scopes UI、priority/costTier UI | H-5 | W6-3 落档 |
| Prove-first：audit 页、手动触发、export 入口 | H-2/H-3（Q3/Q4 已答"要"） | W3-2（export 维持 CLI，不建 UI） |
| Keep（不可碰） | Professor "必须保留的复杂性" | §6.3 不回归承诺 |

## 附录 B：单文件改动热度预估（用于回滚预案）

| 文件 | 预计被触碰波次 | 回滚难度 |
|---|---|---|
| `web/src/features/stats/TokenStatsPage.tsx` | W1、W2 | 低（纯展示） |
| `web/src/features/ops/OpsPage.tsx` | W1、W2、W3 | 低 |
| `web/src/features/accounts/CredentialsPage.tsx` | W1、W2 | 低 |
| `web/src/features/accounts/accountPacks.tsx` | W1、W2 | 低 |
| `web/src/features/accounts/GrowthPanel.tsx` | W5（大删） | 低（整体删除式改动） |
| `web/src/shared/api/*.ts` | W1、W3 | 低 |
| `src/credentials/store.js` + `pool.js` | W4 | **中**（有并发测试守门） |
| `src/index.js` + `log/crash.js` | W4、W5 | 中（有停机测试守门） |
| `src/routes/openai.js` 等 4 路由 | W5-1、W7 | **高**（W7 有停止条款；W5-1 改动面小） |
| `src/lib/crypto.js` + `config.js` | W5-4 | 中（有启动测试守门） |

> 每个波次一个分支（`w1-cleanup` … `w7-protocol`），合并顺序即波次顺序；W7 独立分支永不阻塞 W1-W6 合入。