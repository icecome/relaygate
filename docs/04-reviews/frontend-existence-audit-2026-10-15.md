# Hai Razor: RelayGate 前端（web/src）功能存在性审查

## Verdict

- **Verdict**：保留核心 / 合并若干 / 延后一批 / 删除一批 / 替换若干 / 先证明若干（整体：**合并与删除优先于新增**，无一条「保留」是因为它大）
- **一句话理由**：这个前端 99% 的能力都接着真实后端端点，不是空壳；真正的过度设计集中在**三处**——(1) Overview 页把 Credentials 页的表又抄了一遍并叠了 KPI 重复；(2) api 层有 **15 个零导入的导出函数**与 **30+ 个后端无人调用的端点**互相证明对方存在；(3) 三套「到期」口径、两套 accountState、两处 FEFO 排序、两个「缓存」共用一个按钮文案。
- **所用剃刀原则**：每个概念必须挣得存在——删除它会破坏真实目标、抹掉真实区分、隐藏真实风险、或把不可避免的复杂度推给更差的归属。只因习惯/恐惧/对称性/想象中的未来/审美完整而存在的一律砍、合并、延后或要求举证。
- **未审查范围（防误砍）**：`src/`（Node 后端）内部实现仅用于验证前端接线的真实性，不做后端存在性裁决；`docs/`、`design/`、`preview/`、`scripts/`、`output/`、构建产物一律不审；视觉/交互风格、色彩令牌、暗色主题、移动端适配属另一条审查线（见 `docs/04-reviews/ui-review-2026-10-04.md`），本轮只裁决**功能存在性**。

## Audit Scope

- **被裁的链条**：`web/src` 全部 47 个 ts/tsx 文件 + 其所依赖的后端端点契约。
- **声称服务的目标**：一个自托管 LLM 网关（Trae / WorkBuddy / ZCode 多账号凭据池 → OpenAI/Anthropic/Codex 兼容转发）的**单机管理员控制台**。真实用户只有一个：机器主人本人；真实业务目标只有：接入更多账号、别让账号掉线、看清楚花了多少积分、修好出问题的转发。
- **关键前提**：单机、单人、本地进程、浏览器 `sessionStorage` 会话。这一前提决定了大量「多租户/协作/审计/审批」式设计本就不该存在——而项目里也确实没有它们，这是好事；问题出在别处（见下）。

---

## Evidence

| 来源 | 看到的事实 | 支撑 / 削弱哪个裁决 | 置信度 |
|---|---|---|---|
| `web/src/features/*`（10 个页面，5 个 dialog）全量精读 | 页面与后端一一对应，无虚构页面 | 支撑「页面级 Keep」 | 高 |
| `web/src/shared/api/*.ts` 与 `src/routes/*.js` 双向 grep 交叉核对 | 后端约 30 个端点 UI 从不调用；UI 有 15 个导出函数零导入 | 支撑 Delete（两侧同时清） | 高 |
| `web/src` 全量符号引用统计 | EmptyState / formatTimeShort / PLATFORM_LABEL / STATE_PILL_CLASS / accountsOf / isTransportError / businessFailureReason 等 0 引用 | 支撑 Delete | 高 |
| `src/routes/admin-traffic.js:27-56` 的 `req.query` 全量读取点 | 后端**不读** `model` 参数；前端 `TrafficPage.tsx:61` 却在发 | 支撑 Delete（假筛选控件） | 高 |
| `src/routes/api-keys.js:119-123` 要求 `platform`，`AccessKeysPage.tsx:109` 只发 `{label}` | 「创建访问密钥」疑似 400 契约缺口（**未运行时验证**） | 支撑 Prove first（需实测） | 中 |
| `src/credentials/pool.js:448-479`（权威调度排序）vs `accountPacks.tsx:99-107`、`ModelRouterPage.tsx:339-359` | 前端两处重实现了后端的 FEFO / 轮转池排序，仅为高亮 | 支撑 Delete（显示侧镜像） | 高 |
| `format.ts:6-13` 与 `types.ts:120-124` | `accountState` 逐字重复实现两次 | 支撑 Merge | 高 |
| `docs/04-reviews/code-review-2026-10-05/05-综合审查报告-2026-10-05.md` m-32 | 轮换双开关（rotate-settings.enabled 与 scheduler-settings.rotateEnabled 共用 env），面板两处 UI | 支撑 Replace（单事实源） | 高 |
| `src/jobs/scheduler.js:578-602` vs `GrowthPanel.tsx:123-185` | 一键成长任务已有定时器；手动「一键执行」是同一 job 的第二入口 | 支撑 Merge/Replace | 高 |
| `NotifyBackupPanel.tsx:466-482` vs `src/notify/settings.js:39-54` | 事件开关 UI 只有 10 项，后端有 13 项（zcode 三项）且 rotate_fail 不可关停 | 支撑 Replace（事件清单单一事实源） | 高 |
| `admin-traffic.js:151/166/185` 返回 `cached`，`stats.ts:72-77` 类型未声明 | 面板唯一「清理缓存」按钮清的是 client-logs 缓存，stats-cache 无入口无信号 | 支撑 Replace（缓存语义） | 高 |
| 缺失的证据：真实用户访谈、埋点、访问日志、账号规模分布 | 本项目**没有**任何用户行为数据；全部功能的存在性只能靠「代码自身论证 + 单人单机约束」判断 | 所有「想象未来」型概念一律 Prove first / Delete | — |

---

## Razor Map

### A. 页面与路由（8 条）

| 概念 | 声称目的 | 删除后具体坏在哪 | 隐含归属 | 裁决 | 理由 |
|---|---|---|---|---|---|
| `/` 总览 | 一眼看清凭据池与运行态 | 无处可去 | — | **保留** | 登录后第一落点 |
| `/credentials` 凭据池 | 账号全生命周期 | 无处接入/维护账号 | — | **保留** | 核心目标 |
| `/access-keys` 访问密钥 | 对外发放 sk- 密钥 | 无法给客户端发钥匙 | — | **保留** | 核心目标 |
| `/model-router` 路由与虚拟模型 | 虚拟模型编排 | 多上游无统一入口 | — | **保留** | 转发面核心 |
| `/model-pool` 模型池状态 | 探活/清理/刷新目录 | 模型可用性不可见 | — | **保留** | 与 router 分工真实（目录 vs 策略） |
| `/token-stats` 用量与成本 | 花了多少 | 无法对账 | — | **保留** | 核心目标 |
| `/traffic` 请求日志 | 排障 | 出错查不到 | — | **保留** | 排障不可替代 |
| `/ops/*` 五段（运行/任务/轮换/通知备份/配置） | 运维收敛 | 侧栏 12 项过长 | — | **Merge** | 五个分段对应五个后端域，保留分段**内容**，但 TABS 在 `OpsPage.tsx:67` 与 `nav.ts:61-67` 声明两遍 → 单一事实源 |
| SetupGate 四态（loading/gate/creating/ready） | 首登引导 | 无密钥进不去 | — | **Replace** | 它实际只是「输入一把合法密钥」+「本机创建首把」两条路；`phase` 四态应收敛为「有本地会话→进 / 无→二选一」 |
| `/ops/config` 内的「客户端接入」面板 | 展示三种协议环境变量 | 无 | — | **Merge** | 与「网关配置」同属配置域，可合并为一页两段；且其 `OPENAI_API_KEY` 是占位串 `'<你的 API_KEY>'`（`admin-overview.js:103`）却提供「复制」按钮 = 复制到占位符 |

### B. 交互步骤与业务规则

| 概念 | 声称目的 | 删除后坏在哪 | 隐含归属 | 裁决 | 理由 |
|---|---|---|---|---|---|
| 三种账号接入（OAuth / WorkBuddy 本机 / 粘贴 JSON） | 覆盖不同凭据来源 | 部分账号无法接入 | — | **保留** | 后端三条路径真实存在 |
| 行内「签到」按 `platformOf` 分发端点 | 修复 m-39 | WorkBuddy 按钮全坏 | — | **保留** | `CredentialsPage.tsx:145-153` |
| 「全部签到」跨平台聚合 + 三态 toast | 真实反馈 | 只知道成没成 | — | **保留** | 分平台明细是真区分 |
| 每 60s `useBalanceAutoRefresh`（含可见性暂停） | 余额只有真调上游才变 | 数字永不更新 | — | **保留** | 这是「读 DB 拿不到新余额」的真实约束 |
| 「重置全部设备标识」批量操作 | 换机/被风控后重置 | — | — | **Replace** | 后端只作用于**已启用**账号，UI 写「全部」→ 命名与语义不符，改为「重置已启用账号的设备标识」 |
| 「签到」按钮对 ZCode 隐藏 | 平台能力差异 | 点了必失败 | — | **保留** | 真实区分 |
| 「删除」/「轮换」/「重载配置」前 `prompt` 二次确认 | 防误操作 | 误删凭据、误重建模型池 | — | **保留** | 不可撤销操作 |
| 成长中心 领奖/抽奖/兑换（tier 硬编码 `'1'`） | 消耗型操作 | — | — | **Replace** | 兑换固定 1 档；要么暴露可选档位要么删掉「兑换」按钮（`GrowthPanel.tsx:353`） |
| 成长中心「一键执行」手动触发 | 立即跑 | — | 调度器 `growthPollIntervalHours` | **Merge** | 已有定时任务，手动是同一 job 的第二入口；应合并为「立即执行一次（复用同一 job）」 |
| TrafficPage「按模型筛选」输入框 | 缩小结果集 | — | — | **Delete** | 后端 `admin-traffic.js` 从不读 `model`，输入只触发重取全量数据（假控件，比没有更坏） |
| TrafficPage「连通性测试」（test-chat） | 手测一条链路 | — | — | **Merge** | 与 ModelPoolPage 的「模型探测」是同一诉求，合并为一处更合适 |
| ModelPoolPage「每行探测」+「手动探测面板」 | 探活模型 | — | — | **Merge** | 两个入口一个动作（`ModelPoolPage.tsx:409` 与 `:429`） |
| ModelPoolPage 状态筛选缺「未探测」 | 三态只给两态 | 新目录进来的模型被归错 | — | **Replace** | 后端 availability 有三态，筛选应补齐 |
| AccessKeysPage「轮换」硬编码 `graceMs:0` 但文案说宽限期 | 无缝换钥 | 文案与行为不符 | — | **Replace** | 行为与文案二选一：要么真给宽限，要么改文案 |
| 运维「切换账号」prompt 入口 + 列表行内「切到该账号」 | 手动切号 | — | — | **Delete**（prompt 入口） | 列表行内按钮已覆盖，代码注释自承「保留原有入口」 |
| 任务日志前端分页（后端一次 200 条） | 长日志可读 | — | 后端分页 | **Merge** | 已有后端 `page/page_size`，前端切片属重复机制；且 `safeLogPage` 与 `logPage` 判定不一致（`OpsPage.tsx:403` vs `:1136`）|

### C. 数据字段

| 概念 | 声称目的 | 删除后坏在哪 | 隐含归属 | 裁决 | 理由 |
|---|---|---|---|---|---|
| `accountState` 三态 ok/cool/off | 账号可用性 | — | — | **保留** | 真实区分，且后端调度同源 |
| `packs[].unlimited` 独立于 `remaining` | 不限量不等于 0 | 误读成「无额度」 | — | **保留** | 真实不变量 |
| ZCode `tokenBuckets/tokenRemaining` 与 `packs/balance` 分列 | 两套计量口径 | 把 1e8 token 汇进积分 → 成本全错 | — | **保留** | 本项目最重要的字段边界 |
| `expiredAt` / `refreshExpiredAt`（keepaliveOf 四态） | 保活链路可诊断 | 账号悄悄失效无告警 | — | **保留** | 真实区分（token 可自愈 vs refresh 过期需重登） |
| `packs[0]` 作为行内「权益包」展示 | 一格一值 | — | `accountPacks.packsOf` | **Replace** | 列表取「任意第一个包」而 PackDialog 用完整 FEFO 排序 → 同一账号两处口径不一致；应统一取 `packsOf()[0]`（可用优先 + 最早到期） |
| `summary.expiring3d/7d`（积分**额度**）vs `expirySummary`（**账号**数） | 两种「临期」 | 同名不同义，读数打架 | — | **Replace** | 必须二选一并改名（额度 vs 账号数） |
| `lastCheckinAt/lastCheckinResult` 与 `lastKeepaliveAt/lastKeepaliveResult` | 两条不同链路 | — | — | **Merge** | 六列（账号/最近选用/最近签到/签到结果/最近保活/保活结果）可并为两张「链路卡」，或至少收进折叠区 |
| `Account.verifiedBalance` / `verified` / `userRegion` / `action` / `region` | 后端字段镜像 | 无 | — | **Delete**（类型字段） | `verifiedBalance` 全库零渲染；`userRegion` 是 `unknown`；`action` 只在导入响应里用 |
| `ModelInfo.feeLevel / scene / peak` | 模型元数据 | 无 | — | **Delete** | 后端恒返回 null，前端从不渲染 |
| `DailyStat.officialSessions/officialRequests/officialCovered`、`SseDebug.total/enabled/hint` | 统计附加口径 | 无 | — | **Delete** | 类型里声明，页面零读取 |
| 后端 `priority / costTier / group / tags`（PATCH 白名单 6 项） | 调度可调 | — | — | **Prove first** | 前端只发 `enabled`。这是真实能力缺口还是不需要，取决于主人是否真要手工定优先级 |
| `ApiKeyRow.scopes/resources/rpmLimit/expiresAt` | 密钥限权 | 面板看不出密钥能调什么 | — | **Prove first** | 与 `M-S5`（平台密钥 resources 失效）同域，先证明这字段在 UI 里需不需要 |

### D. 状态与管理机制

| 概念 | 声称目的 | 删除后坏在哪 | 隐含归属 | 裁决 | 理由 |
|---|---|---|---|---|---|
| `SetupGate` 全局闸门 + `relaygate:auth-lost` 事件 | 密钥失效回引导 | 页面停在无数据态 | — | **保留** | `http.ts:75-89` 精确区分「登录密钥 401」与「转发密钥 401」，这是真实的信任边界 |
| `SummaryProvider` 单例 `/summary` | 消除重复请求 | 多组件重复拉取 | — | **保留** | 真实问题（Overview/AppLayout/Credentials 三处消费） |
| `useAsyncData`（取消 + 错误暴露 + reload） | 竞态与错误可见性 | 旧响应覆盖新数据 | — | **保留** | 取消 = 真实竞态防护 |
| `http.ts` GET in-flight 去重 + 30s 超时 | 合并并发、防止挂死 | — | — | **保留** | 行为真实 |
| `isBusinessFailure`（HTTP 200 但 `ok:false`） | 轮换/模型保存的业务失败 | 把业务失败说成网络错误 | — | **Replace** | 概念保留但**机制**要统一：OpsPage:281 手写布尔、GrowthPanel:78 手写 `r?.ok===false`、`businessFailureReason` 零调用 —— 收敛为一个 `runBusiness()` |
| `PromptProvider`（Modal 化 confirm/prompt） | 替代 `window.confirm` | 全库无原生 confirm | — | **保留** | 全站唯一实现，无重复 |
| `lib/store.ts` 自造外部 store | 全局登录密钥 | — | — | **Replace** | 唯一消费者是 `auth.ts` 的一个字符串字段；`useSyncExternalStore` 用得对，但一个 30 行的通用 store 只服务一个布尔值 → 应收敛为 Context 或更小的实现 |
| 四个 `xxxDirty` 草稿标志（scheduler/balance/rotate/notify） | 防止回填冲掉编辑 | — | — | **Merge** | 四个同构模式 → 一个 `useDraft(source)` hook，行为等价 |
| `useBalanceAutoRefresh` 第三个 `intervalMs` 参数 | 可调间隔 | 无调用方传值 | — | **Delete**（参数） | 投机参数（LLM tell #2），固定 60s |
| `useAsyncData.isTransportError` | 区分传输/业务错误 | 无消费者读取 | — | **Delete** | 死状态（`ErrorState` 统一文案） |
| `SummaryProvider.accountsOf / EditionFilter / editionOf` | 按平台过滤 | 无消费者 | — | **Delete** | 筛选已在 CredentialsPage 本地做 |
| `lastAbortReason` 模块级单槽 | 还原超时原因 | 并发下互相覆盖 | — | **Replace** | 这是真实竞态隐患（两个并发 GET 会串 reason），应改为 per-request 局部变量 |

### E. 组件与共享层

| 概念 | 声称目的 | 删除后坏在哪 | 隐含归属 | 裁决 | 理由 |
|---|---|---|---|---|---|
| `Button/Field/Panel/Chip/Segmented/Note/ErrorState/LoadingBlock/MetricGrid/Modal/Toast/Prompt/PageShell/ErrorBoundary` | 基础件 | 全站重写 | — | **保留** | 高复用（Button 16 文件/196 次） |
| `KeyCards` 与 `KeyCardGroups` 并存 | 逐字段卡 vs 分组卡 | — | — | **Merge** | 两者只服务 OpsPage，同一职责两套 API；`KeyValue` 也在做第三遍同样的事 |
| `FieldRow` | 标签 + 任意 children | OpsPage 25 处 | — | **Merge** | 应收进 `Field` 的 children 支持或独立留用，现状是三套表单原语 |
| `Stepper` | 紧凑整数步进 | ModelRouterPage 单处 | — | **Replace** | 单点使用但逻辑非平凡（clamp）→ 保留逻辑，改为该页内联组件，去掉通用组件的身份 |
| `EmptyState` / `formatTimeShort` / `PLATFORM_LABEL` / `STATE_PILL_CLASS`（Overview 的 re-export） | 完整性 | 无 | — | **Delete** | 0 引用（对称性填充，LLM tell #7） |
| `accountState` 双实现（format.ts 与 types.ts） | — | 两处会漂移 | — | **Merge** | 逐字重复 |
| `accountPacks.tsx` 的 FEFO 排序 + `urgencyOf(3/7 天)` | 对齐后端 | — | `src/credentials/pool.js` | **Delete（排序部分）** | 后端是权威；前端排序只影响显示顺序，却制造了「UI 排序 = 消耗顺序」的错觉（PackDialog 脚注已越界宣称） |
| `ModelRouterPage.tsx:339-359` 轮转池复算 | 高亮轮转池行 | — | `src/model-router/index.js:83-126` | **Delete** | 纯展示镜像，算法一改就漂移 |

---

## To Cut or Merge（含最强生存论证）

| 概念 | 动作 | 最强生存论证 | 为何仍不成立 |
|---|---|---|---|
| Overview 账号表（7 列） | **Delete / 降级为摘要条** | 总览页要看「谁在池里、状态如何」 | `docs/04-reviews/ui-review-2026-10-04.md` [MAJOR] 已点名同一问题；该表是 CredentialsPage 的只读子集（5/7 列重叠），且**无操作列**——主人看到异常后仍要跳走，唯一增量是「不必跳页就能发现异常」，这与一个「异常账号 N 个 → 点这里」的摘要条等价 |
| Overview 的 `credit-history`「今日消耗」 | **Delete** | 总览要一眼看今日花多少 | TokenStatsPage 已有同端点、按 range、按账号的更细版本；总览再放一个不同窗口的同源数字 = 两个口径的同一事实 |
| Overview「运行状态」9 项 KeyValue | **Delete** | 登录后要知道网关是否活着 | 与 OpsPage「服务与实例」逐项重复（同 `/v1/admin/runtime`） |
| AppLayout 侧栏「可用/冷却」徽章 | **保留但降级** | 侧栏应常驻池健康 | 与 Overview KPI 同源；建议只保留一处（侧栏），Overview 改为链接 |
| TrafficPage「按模型筛选」 | **Delete** | 请求多时需要按模型缩小 | 后端不实现该参数 = 它不是筛选器，是「一个让人以为筛过了的输入框」。要么后端补 `model` 过滤，要么前端删框 |
| api 层 15 个零导入函数 | **Delete** | 未来会用到 | 无一有调用方；「未来」不是证据 |
| 后端 30+ 个 UI 从不调用的端点 | **逐个定级** | 脚本/CLI 可能用 | 已核实 `scripts/*.js` 零 `fetch(`，直连 SQLite → 这些端点**在本仓库内无任何消费者**。其中 `GET /v1/admin/audit`、`POST /v1/admin/scheduler/:action`、`GET /v1/admin/credentials/export` 是**真实能力缺入口**（见下） |
| 「一键成长任务」手动按钮 | **Merge 进调度器** | 主人想立刻跑一次 | 已有定时器；手动 = 同一 job 的第二入口，且它自己也维护了一套轮询状态机（4 个 ref/state） |
| `EMPTY_STATE` / 三个零用导出 / `accountsOf` / `isTransportError` | **Delete** | — | 0 引用，无区分、无目标、无风险 |
| `businessFailureReason` | **Delete**（函数），概念**保留** | 统一错误文案 | 已有 `isBusinessFailure` + 各页手写 reason 读取 —— 要么用它，要么删它，不要两者并存 |

## 必须保留的复杂性（不要碰）

| 复杂性 | 为什么必要 | 边界：越过哪里开始变成伤害 |
|---|---|---|
| 积分口径 vs ZCode token 口径的强制分离（`accountPacks.tsx:10-13`、`types.ts:17/64`） | 把 1e8 token 当成积分求和 = 成本统计全错且难发现 | 可简化的是注释篇幅，不是这条规则 |
| `isLoginKeyRejection`（`http.ts:75-89`） | 管理密钥 401 与转发密钥 401 语义完全不同；一律登出会把用户反复踢出并掩盖真实原因 | 不要把它并回 `if (r.status===401)` |
| 请求取消（AbortSignal 贯穿） | 路由切换后旧响应覆盖新数据 | — |
| `unlimited` 不等于 0 | 显示成 0 会被读成「无额度」，是决策性误读 | — |
| 消耗型操作（成长中心、探测、备份恢复）的二次确认 + `safetyBackup` | 不可撤销且消耗真实额度 | — |
| 三条账号接入路径 | 覆盖真实不同的凭据来源 | — |
| 长任务进度轮询（growth auto） | 上游任务秒级不返回 | 可简化状态机，不可去掉进度 |
| `TRAE_LAG_DAYS` 入账滞后判定 | 不判定就会算出「差异 1000%+」的假差异 | — |
| `exact / estimated / none` 三拆 token 口径 | 把估算当真值 = 成本判断错误 | — |
| 明文密钥「仅内存/一次性展示」 | 一旦落盘即长期泄露面 | — |

---

## 伪需求识别清单（AI 生成特征最重的一批）

1. **`/v1/admin/stats/cache`、`/stats/cache/clear`、`/stats/pricing-calibration/clear`、`/stats/official-usage/cache/clear`** —— 为了「缓存可管理」而生的四组端点，前端一个入口都没有，而唯一可见的「清理缓存」按钮清的是**另一个缓存**（client-logs）。典型：为了完整性而对称地造端点。
2. **`GET/POST/DELETE /v1/admin/notify/events` + 前端封装 `getNotifyEvents/saveNotifyEvents`** —— 事件开关实际走 `notify/settings` 的 `events` 字段，于是「自定义事件增删」这条能力在 UI 上完全不可达，同时后端还多了一套并行的数据结构。
3. **`rotateSettings.intervalMinutes`、`RotateStatus.settings/scheduler`、`SchedulerSnapshot.rotateEnabled/rotateSettings`、`rotateRows.backup`** —— 保存接口回传快照字段，前端类型照抄后从不读。
4. **`NotifyBackupPanel` 事件开关只列 10 项**（后端 13 项）—— 说明这层 UI 是凭想象写的清单，不是读后端枚举。
5. **`KeyCards` / `KeyCardGroups` / `KeyValue` 三套键值渲染** —— 同一职责三次发明。
6. **`accountState` 写两遍、`accountPacks` 排序重写后端 FEFO、`ModelRouterPage` 复算轮转池** —— 为了「前端也要懂业务」而复制业务规则。
7. **`FieldRow`（25 处只在 OpsPage）与 `Field` 两套表单原语** —— 组件粒度按文件边界而非职责切分。
8. **`useBalanceAutoRefresh` 的 `intervalMs` 参数** —— 投机参数，0 个调用方。

---

## 具体裁剪 / 证明修复清单（可执行）

### P0 — 假控件与契约缺口（用户会直接踩）

| # | 动作 | 文件 | 验收 |
|---|---|---|---|
| 1 | 删除「按模型筛选」输入框，或在后端 `/v1/admin/traffic` 实现 `req.query.model` 过滤 | `TrafficPage.tsx:61,149-158` + `src/routes/admin-traffic.js` | 输入模型名后行数确实变少（或框不存在） |
| 2 | 实测「创建访问密钥」：`AccessKeysPage.tsx:109` 只发 `{label}`，而 `api-keys.js:119-123` 要求 `platform` | — | 补 `platform` 选择或改为后端允许缺省；实测创建成功 |
| 3 | 「轮换」按钮 `graceMs:0` 与「旧密钥将进入宽限期后失效」文案二选一 | `AccessKeysPage.tsx:123,130` | 文案与实际行为一致 |
| 4 | 「重置全部设备标识」改名为「重置已启用账号的设备标识」，或后端改为作用于全部 | `CredentialsPage.tsx:306` | 命名不再与 `credentials.js:296-308` 冲突 |
| 5 | 成长「兑换」按钮硬编码 tier `'1'`：暴露可选档位或删除该按钮 | `GrowthPanel.tsx:353` | 不再出现只有一个值的「兑换」 |
| 6 | ModelPoolPage 状态筛选补「未探测」 | `ModelPoolPage.tsx:233-242` | 三态与 `availability.js` 对齐 |

### P1 — 删除死重量（零行为风险）

| # | 动作 | 位置 |
|---|---|---|
| 7 | 删除 15 个零导入导出：`getSseDebugStatus`、`getNotifyEvents`、`saveNotifyEvents`、`upsertProvider`、`deleteProvider`、`modelRouter.getRouteCheck`、`getAvailableModels`、`resetDevice`、`oauthComplete`、`wbRefresh`、`wbCheckinStatus`、`wbCheckinAll`、`growthStatus`、`growthStreak`、`growthChances`、`growthDepart`、`businessFailureReason` | `shared/api/*.ts` |
| 8 | 删除零引用 UI 件与字段：`EmptyState`、`formatTimeShort`、`PLATFORM_LABEL`、`STATE_PILL_CLASS`（含 Overview re-export）、`useAsyncData.isTransportError`、`SummaryProvider.accountsOf/EditionFilter/editionOf`、`Account.verifiedBalance/verified/userRegion/action/region`、`ModelInfo.feeLevel/scene/peak`、`DailyStat.officialSessions/officialRequests/officialCovered`、`SseDebug.total/enabled/hint`、`useBalanceAutoRefresh` 的 `intervalMs` | `shared/ui/index.tsx`、`shared/lib/format.ts`、`SummaryProvider.tsx`、`types.ts`、`admin.ts`、`stats.ts`、`useAsyncData.ts` |
| 9 | 删除两处对后端算法的显示侧镜像：`accountPacks.packsOf` 的排序（保留字段派生）、`ModelRouterPage:339-359` 轮转池复算 | — |
| 10 | `accountState` 只留一份（`shared/lib/format.ts`），`types.ts` 改为 re-export | — |
| 11 | `http.ts` 的 `lastAbortReason` 从模块级单槽改为 per-request 局部 | — |
| 12 | 删除 OpsPage「切换账号」prompt 入口（保留行内按钮）与「生成种子」（`rotate/run` 内部已 seedAll） | `OpsPage.tsx:1439-1444` |
| 13 | TABS 与 nav.ts 合并为单一事实源 | `OpsPage.tsx:67-73` / `nav.ts:61-67` |
| 14 | `KeyCards/KeyCardGroups/KeyValue` 三选一；`FieldRow` 并入 `Field` | `shared/ui/index.tsx` |

### P2 — 合并重复（降低口径漂移）

| # | 动作 |
|---|---|
| 15 | Overview 页：删账号表（保留异常摘要条 + 链接到凭据池）、删「今日消耗」（指向 TokenStatsPage）、删「运行状态」9 项（指向 OpsPage）。总览只留：4 个 KPI + 积分额度两块 + 异常摘要 |
| 16 | 「临期」二选一：建议统一为**积分额度**口径（与后端 `expiring3d/7d` 一致），把账号数口径改名为「N 个账号有额度 7 日内到期」 |
| 17 | 凭据列表「权益包」改用 `packsOf(a)[0]`，与 PackDialog 同源 |
| 18 | 「最近操作与保活」6 列并为 2 行折叠或两段 |
| 19 | 统一业务失败处理：所有写操作经一个 `runBusiness()`（复用 `isBusinessFailure` + `businessFailureReason`） |
| 20 | 四个 `xxxDirty` 抽成一个 `useDraft` |
| 21 | 「客户端接入」并入「网关配置」；去掉对占位符 `'<你的 API_KEY>'` 的「复制」按钮 |
| 22 | 删除「一键成长任务」按钮与轮询状态机，改为运维页提供「立即执行一次」（复用同一 job） |
| 23 | OpsPage：调度器开关/池化策略/管理密钥分离/签到保活时刻各去掉重复呈现（env 只读 Chip 与 config 只读值留一处） |

### P3 — 先证明（不要现在改，先拿证据）

| # | 问题 | 需要什么证据 |
|---|---|---|
| 24 | `GET /v1/admin/audit` 无 UI 入口 —— 审计日志是**真实能力缺口**（密钥 reveal / 凭据导出 / 目录 lifecycle 都会写 `audit()`），还是确实不需要？ | 主人是否需要「谁在什么时候 reveal 了一把密钥」的可见记录；密钥操作已有 prompt 确认，若不需要则明确记为「不做」，否则补一个只读审计页 |
| 25 | `POST /v1/admin/scheduler/:action`（手动跑签到/保活/探测）无入口 | 主人是否需要「不等定时器，现在手动跑一次」。需要 → 在运维页任务页加一行按钮；不需要 → 记录为刻意不做 |
| 26 | `credentials/export` 无入口 | 同上：是否需要导出全量账号（密文形态） |
| 27 | 账号 `priority/costTier/group/tags` 无 UI（后端 PATCH 白名单支持） | 是否真要手工调优先级；若要，只暴露 `priority` 一个字段，其余保持 env/config |
| 28 | `ApiKeyRow.scopes/resources/rpmLimit` 无 UI | 与 `M-S5`（平台密钥 resources 失效）一起决定：UI 要不要显示「这把密钥能调哪些模型」 |
| 29 | 后端 `notify/events` 三端点 + 前端 10 项事件清单 vs 后端 13 项 | 先确定事件清单的唯一事实源（建议后端 `EVENTS` 枚举），UI 直接渲染枚举 + 支持自定义增删；顺带修 `rotate_fail` 恒不可关停的问题 |
| 30 | stats-cache 无信号、无入口，而「清理缓存」按钮清的是别的缓存 | 若主人确实关心统计延迟 → 让 `/stats/daily` 返回的 `cached` 进类型并在 UI 标注，并给 stats-cache 一个独立按钮；否则删掉按钮文案里的「缓存」二字，改叫「重新解析客户端日志」 |
| 31 | 轮换双开关（`rotate-settings.enabled` 与 `scheduler-settings.rotateEnabled` 共用 env，`m-32`） | UI 现在只有一处开关（`OpsPage.tsx:1267`），看起来已规避；但后端双门控仍在，需确认不会再出现「面板显示开启但调度器跳过」 |

---

## Risks & Guardrails

- **最可能的反弹**：删掉 Overview 账号表后，下次改账号字段时会有人「顺手加回来」。→ 护栏：在 README 或 `web/src/features/overview/OverviewPage.tsx` 头部写一行约束：**「总览不得复制凭据池的表格；发现异常请链接过去」**。
- **误砍风险（务必别动）**：`unlimited` 判定、积分/token 双口径、`isLoginKeyRejection`、AbortSignal 取消、消耗型操作的 prompt、`safetyBackup`。这些看起来都是「防御性代码」，删掉会造成难以定位的静默错误。
- **行为保持闸门**：P1-9（删 FEFO 镜像）、P1-11（`lastAbortReason`）两处会改变可观察行为，需配套：前者确认 PackDialog 改为按后端顺序或接受「未排序」；后者确认并发超时仍能报出正确 reason。
- **归档不删除**：被删的 15 个 api 导出与约 30 个后端端点，若将来需要，从 git 历史取回即可；不要为「以后可能用」保留死代码。
- **本次未验证**：`AccessKeysPage` 创建密钥的 400 推断基于静态读码（未运行）；`/v1/admin/audit` 是否被主人需要属需求判断，不是技术判断；无任何用户行为数据支撑「某个页面被用得多」。

## Next Steps

1. 先做 P0（假控件 + 契约缺口）—— 全部是**用户会直接踩到**的，且改动面小。
2. 再做 P1（零引用删除）—— 机械、可脚本化、零行为风险，用一次 `npm run build && npx tsc --noEmit` + 现有 197 个后端用例把关。
3. P2 是本轮真正的价值所在（口径合并），建议逐条单独立项，不要和 P0/P1 混在一个提交里。
4. P3 需要主人回答问题才能定性；在回答之前不要动对应端点与字段。

> 落地为执行计划可转 `hai-goal`；若裁剪后需要重划 `shared/api` 与 `features/` 的边界，转 `hai-architecture`。