# Hai Razor：RelayGate 产品功能梳理与瘦身专项审查（v3 最终复查版）

> 审计日期：2026-11-25 · 基线：当前工作树（v3.1.0，`package.json`）· 视角：产品经理 + 剃刀裁决
> v1 / v2 保留作历史记录；本文件是针对“删除 / 可折叠 / 隐藏 / 后置”条目做代码级复查后的最终版。**v3 的结论优先。**

## 0. v3 复查修正摘要

| v2 条目 | 复查结果 | v3 裁决 |
|---|---|---|
| D2 删除零引用 API 导出（约 15 个） | **结论过期**。当前代码里历史上被点名的 `getRouteCheck`、`getAvailableModels`、`upsertProvider`、`deleteProvider`、`wbRefresh`、`wbCheckinStatus`、`getSseDebug`、`triggerScheduler`、`seedRotate`、`getAuditLog`、`clearStatsCache`、`clearClientStatsCache`、`clearOfficialUsageCache`、`clearModelsStatus`、`businessFailureReason` 全都有真实消费者 | **撤销批量删除**。仅保留经当前扫描确认的 `growthProgressList` 为“可删”；`getStatsCache` 被 `src/test/wiring.test.js` 引用，属于契约测试入口，**不删** |
| D3 删除 `ModelInfo.feeLevel/scene/peak` | **已被清理**。当前 `ModelInfo` 无这些字段；注释只描述 peak 恒 null，不是字段声明 | **撤销该项** |
| D3 删除 `DailyStat.officialSessions/officialRequests/officialCovered`、`verifiedBalance`、`userRegion` | 当前仍存在：`stats.ts:47-50`、`workbuddy.ts:45`、`types.ts:71`；在 `web/src/features/**` 中零渲染 | **保留为低风险可删**，但必须逐字段 `tsc` 验证；名称容易与历史“零引用列表”混淆，执行前重新 grep |
| H1 “客户端接入”独立分段隐藏/合并 | **证据不足**。当前 `ClientAccessPanel` 已在 `/ops/config` 页内（`OpsPage.tsx:1717`），导航里没有独立的“客户端接入”项；它只是 config tab 内的一块 Panel | **撤销隐藏/合并**。若要降低可见性，只能把它折叠，收益低，不建议本轮做 |
| H2 debug 中 `TOOL_PROTOCOL` 展示隐藏 | **证据更强了**。当前 `web/src` 只有 `admin.ts:347` 的 `toolProtocol: string` 类型声明，没有任何 UI 文案或组件读取它；后端 `admin-debug.js:250` 仍返回该字段 | **保留删除方向，但动作要收敛**：删 `.env.example` 注释块 + 后端 config 返回 + 前端类型；`config.js` 的读入可为兼容保留 |
| v2 新增 F1/F2/F3（成长中心修正） | 已逐行复核：自动/手动共用 `runAccount`、自动失败无当天重试、手动不写 last-run、面板注释“每 4 小时”过期 | **全部保留**，见 §6.2 |

> 方法论：v2 对成长中心的修正是对的，但对“删除清单”的其余部分仍沿用 10 月审查结论。v3 只承认**当前代码可证**的项：不据历史报告删代码。

---

## Verdict

- **裁决**：保留绝大多数核心与观测功能；只删除**当前代码可证的死配置和极少数零引用导出/字段**；折叠/隐藏类动作只保留“默认收起 + 次级入口”，不把低频误判成无价值。
- **一句话理由**：RelayGate 的低可见性功能里，很多是**后台供给链路或一次性配置入口**（成长活动、客户端接入、手动补跑、探测/连通性测试），不是伪需求；真正该剃的是“配了不生效”“代码声明但没人读”“展开后重复拉数据却没有新增决策价值”的部分。
- **剃刀原则**：删除它会破坏真实目标、抹掉真实区分、隐藏真实风险、或把复杂度推给更差归属的，必须保留；只因对称性、想象未来、历史报告或“看起来不像网关”而想删的，不删。
- **未审范围**：安全漏洞整改、性能压测、移动端适配、文档/脚本资产整理、真实用户行为埋点。

---

## 1. 关键证据表（仅列影响裁剪裁决的证据）

| 来源 | 当前事实 | 支撑裁决 | 置信度 |
|---|---|---|---|
| `src/jobs/growth-auto.js:64-285` | 成长六段（旅行/任务/补登/兑换/抽奖/Buddy）产出 credit/energy | 成长活动 Keep | 高 |
| `src/jobs/growth-progress.js:64-120` | 手动补跑复用 `runAccount`，写 task-log，不写 last-run | F1/F3 Keep | 高 |
| `src/jobs/scheduler.js:920-979` | 自动每天墙钟一次 + catchup；失败无当天重试 | F1/F2 Keep | 高 |
| `src/jobs/scheduler-settings.js:23-29` | 默认 08:00，可配置 | F2 Keep | 高 |
| `web/src/features/accounts/GrowthPanel.tsx:4,73,165-203` | 注释仍写“每 4 小时”；摘要读 last-run；按钮已实现 | F2/F3 | 高 |
| `web/src/app/nav.ts:59-69` | 运维组只有 `/ops` 下的 runtime/jobs/rotate/notify/config 与 `/audit`，**没有独立“客户端接入”项** | 撤销 H1 | 高 |
| `web/src/features/ops/OpsPage.tsx:1717` | `ClientAccessPanel` 在 config tab 内 | 撤销 H1 | 高 |
| `.env.example:104-108`、`src/config.js:247-251`、`src/routes/admin-debug.js:250`、`web/src/shared/api/admin.ts:347` | `TOOL_PROTOCOL` 明确“仅用于展示”，前端只有类型声明无 UI 读取 | D1 可删 | 高 |
| `grep -rlw` 当前复查 | 历史“零引用 15 个”中绝大多数当前已有消费者 | 撤销 D2 批量删 | 高 |
| `web/src/shared/api/growth.ts:208` | `growthProgressList` 只有定义，无消费者 | 可删导出 | 高 |
| `web/src/shared/api/stats.ts:47-50`、`workbuddy.ts:45`、`types.ts:71` | `officialSessions/officialRequests/officialCovered`、`verifiedBalance`、`userRegion` 仍在类型层，但 feature 层零读取 | 低风险可删（需 tsc） | 中高 |
| `web/src/features/stats/TrafficPage.tsx:408-425` | 连通性测试发真实 chat，验证 key + model + 全链路 | 不删 | 高 |
| `web/src/features/models/ModelPoolPage.tsx:635-662` | 模型探测发真实请求并改变可用性判定 | 不删，说明差异 | 高 |
| `src/jobs/rotate-accounts.js:445-452` | 无备份时自动轮换会 seedAll | “生成种子”按钮不是纯死入口 | 高 |
| `src/test/checkin-scheduling.test.js:187-196` | `scheduleCatchup` 会重判，手动标记后不重复跑 | `scheduleCatchup` 是必要复杂性 | 高 |

---

## 2. 深度裁决：删除 / 折叠 / 隐藏 / 后置

### 2.1 可直接删除（当前代码可证，低风险）

| # | 对象 | 当前证据 | 动作 | 风险 |
|---|---|---|---|---|
| D1 | `TOOL_PROTOCOL` 展示面 | `.env.example:104-108` 写明“仅用于展示、不改变行为”；`admin-debug.js:250` 返回；`admin.ts:347` 类型声明；`web/src` 无任何 UI 文案读取 | 删 `.env.example` 注释块；从 `/v1/admin/config` 响应删除 `toolProtocol`；删 `admin.ts` 类型字段。`config.js` 读入可保留静默兼容，但从 debug 输出移除 | 低。无行为分支；注意旧 env 不要报错 |
| D2 | `growthProgressList` 前端导出 | `web/src/shared/api/growth.ts:208` 定义；全前端零引用。后端 `/progress-list` 与测试 W-07 仍存在，删前端封装不影响后端契约测试 | 删除前端 `growthProgressList` 导出即可；**不删后端端点/测试** | 低。不影响自动/手动补跑主链路 |
| D3 | 三个 `DailyStat` 官方口径字段：`officialSessions/officialRequests/officialCovered` | `stats.ts:47-50` 声明，feature 层零读取；后端若有返回，前端不消费 | 从 `DailyStat` 接口删除，跑 `tsc -b --force` | 低-中。若未来要展示官方口径需补回；保留 git 历史即可 |
| D4 | `verifiedBalance` / `userRegion` 类型残留 | `workbuddy.ts:45`、`types.ts:71` 声明，feature 层零读取 | 与 D3 同批处理；`tsc` 验证 | 低-中。`userRegion` 应从 API 契约层确认是否仍返回 |

> 不再建议批量删除“15 个零引用导出”。当前代码已证明该清单过期。

### 2.2 保留但必须修正（成长中心）

| # | 对象 | 动作 | 证据 | 风险 |
|---|---|---|---|---|
| F1 | 「立即执行一轮」 | 保留。文案改为「立即补跑一次」，说明“自动每天 HH:MM 执行；失败当天不会自动重试，可补跑” | `scheduler.js:920-956` 失败只通知；`growth-progress.js:94` 共用 runAccount | 低 |
| F2 | 成长面板缺定时提示 | 摘要行显示下次运行时间；修正 `GrowthPanel.tsx:4` “每 4 小时”为“每天墙钟一次，默认 08:00” | `scheduler-settings.js:23-29`、`OpsPage.tsx:931` 已有 nextGrowthAt | 低 |
| F3 | 手动补跑后 last-run 不更新 | `startAuto()` 完成后写 `growth-last-run.json`，或面板改从 progress-list 读 | `growth-progress.js:104-116` 不写 last-run；面板 `GrowthPanel.tsx:165-167` 读 last-run | 中。需测试，且不得影响 `dailyRunState` 的 catchup 判据 |

### 2.3 可折叠 / 默认收起（保持现状即可，不新增动作）

| # | 对象 | 裁决 | 理由 |
|---|---|---|---|
| C1 | 成长面板明细 | **保持默认收起** | `GrowthPanel.tsx:66-87`：收起态仅读 last-run，展开才打 3 组上游请求。当前设计已经是最合适的折叠策略 |
| C2 | `ClientAccessPanel` | **不隐藏、不后置；保持 config tab 内 Panel** | 它已在 `/ops/config` 页内，不是独立导航项；再折叠收益小，且会影响首次接入可见性 |
| C3 | 成长面板只读字段（Buddy/稀有度/能量/补登卡/抽奖机会/旅行状态） | **不折叠删除，保持当前合并表 + 行内 details** | 上游真实活动，属于额度供给链路观测面；v2 已修正 |

### 2.4 不建议删除，但应明确差异（避免未来误删）

| 对象 | 为什么看起来重复 | 实际差异 | 处理 |
|---|---|---|---|
| `TrafficPage` 连通性测试 vs `ModelPoolPage` 模型探测 | 两者都发真实请求 | 前者验证访问密钥 + 模型名 + 全链路 chat 是否通；后者验证单个模型可用性并改写 availability 表 | 在两处 UI 各加一句边界说明；不合并 |
| `OpsPage` 生成种子 vs 自动 seedAll | `rotateAllInner()` 无备份会自动 seed | 手动按钮可在已有备份时重建种子；自动分支只在无备份时触发 | 保留；文案改为“重建种子备份（可选）”更准确 |
| `seedRotate` API/按钮 | 历史上曾被建议删 | 当前有 UI 按钮、后端 `/admin/rotate/seed`、且运行链路依赖 seedAll 语义 | 保留 |
| `triggerScheduler` | 历史上说无入口 | 当前 `OpsPage.tsx:390` 已真实调用 | 保留 |
| `clearStatsCache` 等缓存按钮 | 历史上说无入口 | 当前 `TokenStatsPage.tsx:261-280` 已真实调用 | 保留 |

---

## 3. 三维分类（v3 精简版）

### 3.1 强需求（保留）

- 三协议转发、SSE/工具调用/续写、账号池调度、凭据池、访问密钥、虚拟模型、用量成本、请求日志。
- WorkBuddy 成长活动六段与只读观测面板、手动补跑入口。
- 定时任务、通知、备份、健康检查、鉴权/ACL/限流、跨进程锁。

### 3.2 弱需求但保留（低频不等于无价值）

- 客户端接入面板（首次配置必需，之后低频）。
- 成长面板明细（默认收起，展开才打上游）。
- 模型探测、连通性测试、任务手动触发、种子生成。
- Qoder/ZCode 限时奖励后台 job（保留观察）。

### 3.3 隐性必需（不主动访问但不可剃）

- 成长自动化幂等键、`scheduleCatchup`、`client_token` 日粒度种子。
- 积分/token 双口径、`unlimited` 语义、`isLoginKeyRejection`、AbortSignal、stream-gate、跨进程锁、`safetyBackup`。
- 启动期健康检查与密钥失配熔断。

### 3.4 当前代码可证的弱需求/残留

- `TOOL_PROTOCOL` 配置项与 debug 输出（删展示，保留兼容读入可选）。
- `growthProgressList` 前端导出（删）。
- 少量前端类型字段残留（`DailyStat` 三字段、`verifiedBalance`、`userRegion`）。

---

## 4. 必须保留的复杂性

| 复杂性 | 原因 | 不可越过的边界 |
|---|---|---|
| 成长活动六段 + `client_token` 幂等 | 自动/手动补跑不重复入账，补登卡多张互不吞掉 | 不改 seed 粒度 |
| 自动失败当天不重试 + 手动补跑 | 上游失败后仍有可恢复路径 | 不把补跑判成重复入口 |
| `scheduleCatchup` 的重判 | 防止同一天重复起任务 | 测试 `checkin-scheduling.test.js:187-196` 必须保持 |
| 积分/token 双口径 | 成本信任 | 不统一单位 |
| `unlimited` 语义 | 避免“无额度”误读 | 不折叠 |
| 两类 401 区分 | 管理密钥与转发密钥语义不同 | 不合并 |
| 请求取消 / stream-gate | 防止旧响应覆盖新数据、错误被当模型输出 | 不删 |
| 跨进程锁 / `safetyBackup` | 防重复与非可逆操作 | 不删 |

---

## 5. 可落地清单（v3 最终）

### 5.1 第一批次：可直接删除

| # | 动作 | 验收 |
|---|---|---|
| D1 | 删 `TOOL_PROTOCOL` 展示面：`.env.example` 注释块、`admin-debug.js` config 输出、`admin.ts` `toolProtocol` 类型 | `npm test && npm run lint && npx tsc -b --force`；三协议工具调用行为不变 |
| D2 | 删 `growthProgressList` 前端导出 | `tsc` 零错误；后端 `/progress-list` 与 W-07 测试仍通过 |
| D3 | 删 `DailyStat.officialSessions/officialRequests/officialCovered`、`verifiedBalance`、`userRegion` 类型残留 | 逐字段 grep + `tsc`；API 响应多余字段被忽略，不影响渲染 |
| D4 | 更正 `GrowthPanel.tsx:4` 注释“每 4 小时”→“每天墙钟一次，默认 08:00” | 文本准确；不删任何逻辑 |

### 5.2 第一批次：修正但不删

| # | 动作 | 验收 |
|---|---|---|
| F1 | 「立即执行一轮」改「立即补跑一次」，说明自动任务每天 HH:MM 执行、失败当天不自动重试 | 文案显示；逻辑未变 |
| F2 | 成长面板摘要显示下次运行时间 | `runtime.nextGrowthAt` 可见；无额外上游请求 |
| F3 | 手动补跑后更新 last-run | 手动执行完成即更新摘要；自动/手动不互相覆盖；409 分支仍正确 |

### 5.3 不执行项（明确撤销）

| 项 | 原因 |
|---|---|
| 批量删 15 个零引用 API 导出 | 当前代码证明大多数已有消费者 |
| 删 `ModelInfo.feeLevel/scene/peak` | 当前已不存在 |
| 隐藏/合并客户端接入面板 | 当前已在 `/ops/config`，不是独立导航 |
| 删成长中心、删手动补跑、改游戏化字段 | v2 已撤销，v3 维持 |
| 删 `getStatsCache` | 被 `src/test/wiring.test.js` 引用 |
| 删除连通性测试或模型探测 | 语义不同，均验证真实链路 |
| 删除种子生成 | 当前有真实 UI/后端/自动语义 |

---

## 6. 一句话结论

> 针对“删除 / 折叠 / 隐藏 / 后置”的深度复查结论是：**能删的很少，且只删当前代码可证的死展示与类型残留；低频入口（成长补跑、客户端接入、连通性测试、模型探测、种子生成）都应保留，只需修提示、消歧义、默认收起。** v3 最重要的一次纠偏是撤销了 v2 沿用的历史“零引用导出”清单——当前代码里那些函数已经被真实页面消费。
