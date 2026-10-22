# 聚合虚拟模型（Auto-Tier）上下文窗口管理设计

> 适用场景：使用聚合虚拟模型（如 `vm/unified-chat`）时，如何做到「合理且最大」的上下文窗口与最大输出 token。

## 1. 背景与需求

聚合虚拟模型把多个上游真实模型聚合成一个对客户端暴露的模型名。早期实现中，虚拟模型的候选模型是**手动添加**的，存在两个痛点：

1. 候选模型随上游目录变化需要人工维护（新增 / 删除）。
2. 无法按「上下文窗口大小」自动分层，也难以按「倍率 / 账号剩余」有序调度。

用户最终确认的需求（1A2A3A）：

- **配置 + 代码增强**：在 `model-router` 中落地自动分层。
- **三层聚合虚拟模型**：
  - `vm/unified-chat`（默认池，窗口下限 116K）
  - `vm/large-context`（大窗口池，窗口下限 200K）
  - `vm/long-context`（超长上下文池，窗口下限 1M，含 Trae `__max` 与 WorkBuddy 原生 1M 模型）
- **放开 Trae `__max` 1M 分层**，并实测验证。

## 2. 核心设计：按上下文窗口自动分层

聚合虚拟模型不再是「手动添加候选」，而是**按上游模型的上下文窗口（context window）自动分层生成候选**：

- 候选不可手动增删，只能**禁用**（开关），重同步时保留禁用状态。
- 分层阈值见 `src/model-router/autotier.js` 的 `TIERS`：

| 虚拟模型 | 窗口下限 (minWindow) | 落入条件 | 典型候选 |
|---|---|---|---|
| `vm/unified-chat` | 116000 | `116K ≤ win < 200K` | Trae dev 档、WorkBuddy 标准模型 |
| `vm/large-context` | 200000 | `200K ≤ win < 1M` | 大窗口模型 |
| `vm/long-context` | 1000000 | `win ≥ 1M` | Trae `__max` 档、WorkBuddy 1M 原生模型 |

窗口归属为左闭右开区间 `[tier.min, nextTier.min)`。每个虚拟模型写入一个**声明窗口**（`contextWindow`），作为该层的硬门控阈值。

## 3. Trae `__max` 1M 分层

Trae 网关同一模型有两个档位（`modelName__dev`=116K~256K、`modelName__max`=1M）。自动分层时：

- 普通层取 `__dev`（默认，`prompt_max_tokens` 硬编码 168000）。
- `vm/long-context` 层对支持 `maxTier` 的 Trae 模型**额外生成一条 `@max` 候选**（映射到上游 `__max`），请求体写入 `prompt_max_tokens = 936000`、最大输出 64000。
- 客户端可在模型名后加 `@max` 后缀强制走 1M 档（见 `src/upstream/client.js` 的 `@max` 支持）。

WorkBuddy 模型多为 1M 原生，直接落入 `vm/long-context`。

## 4. 有序调度：倍率优先 + 账号剩余优先

### 4.1 候选排序（虚拟模型内）

开启 `sort: 'rate'` 时，候选按**倍率升序**排列（倍率越低越优先），无倍率信息的排在最后：

`hy3(0) → hunyuan-2.0-thinking(0.04) → hy3-x(0.05) → glm-5.3-flash(0.06) → …`

### 4.2 账号级调度（账号池内，FEFO 先到期先用）

多账号的选取由 `src/credentials/pool.js` 的 `least_balance` 策略负责，排序为：

`优先级 → FEFO 最近到期时刻（升序）→ 同一到期时刻按临期金额 → d3/d7 金额分档 → 计费档（免费优先）→ 余额（高者优先）→ 空闲时间`

**为什么用 FEFO 而不是纯余额排序**：临期积分作废是硬损失。若按余额高低选号，余额多的账号会持续被优先调用，其临期包可能在被轮到之前就过期。FEFO（First-Expiry-First-Out）直接以「账号最近一个未用尽权益包的到期时刻」为第一排序键，**先到期的账号先被调度**，从根上避免浪费。

判定口径（`summarizeFefo`，位于 `src/credentials/credits.js`）：

- 只统计 `remaining > 0` 且未过期的包；已用尽、已过期、无到期时间的包跳过。
- 多个包取 `expireTime` 最小者作为该账号的「最近到期时刻」。
- 仅有 `unlimited` 包时视为「不会过期」（`never: true`），排后不与临期账号抢额度。
- 没有任何可计量到期包的账号排在所有临期账号之后。

`pool.snapshot()` 会为每个账号输出 `fefo` 字段（`soonestDays / soonestAmount / expiringAmount / never`），便于在管理面核对调度是否符合预期。

## 5. 两层上下文门控 + max_tokens 钳制

请求进入聚合路由后有两级门控（避免超出上游窗口导致失败）：

- **L1 虚拟层门控**：以声明的 `contextWindow` 估算输入，单独超出 75% 阈值即返回 `400 context_length_exceeded`。
- **L2 候选级门控**：每次尝试前，按每个候选自身的 `contextWindow` / `promptMaxTokens` / `maxOutputTokens` 过滤掉装不下的候选（`filterCandidatesByInput`）。
- **max_tokens 钳制**：客户端请求的 `max_tokens` 超过候选 `maxOutputTokens` 时自动钳制到上限（`clampMaxTokens`）。

无可用候选时返回 `400 context_length_exceeded`（窗口受限），让客户端明确感知而非盲目重试。

## 6. 数据流与文件

| 模块 | 职责 |
|---|---|
| `src/models/catalog.js` | 解析 Trae/WorkBuddy 目录，产出 `contextWindow / contextWindowMax / maxTier / maxOutputTokens` 等字段 |
| `src/upstream/client.js` | 支持 `@max` 后缀 → `__max`，按档位写 `prompt_max_tokens` |
| `src/credentials/credits.js` | `summarizeFefo` 计算账号最近到期权益包（FEFO 排序信号） |
| `src/credentials/pool.js` | 账号池选号：`least_balance` 以 FEFO 到期时刻为第一排序键 |
| `src/model-router/store.js` | 候选归一化（含 `contextWindow/promptMaxTokens/maxOutputTokens/rate`），虚拟模型增加 `auto/sort` |
| `src/model-router/autotier.js` | `TIERS / fetchAllModels / assignTiers / sortCandidates / syncAutoTiers / filterCandidatesByInput / clampMaxTokens / isAutoVm` |
| `src/model-router/index.js` | `orderCandidates`（rate 排序）、两级门控、max_tokens 钳制 |
| `src/routes/model-router.js` | `POST /v1/admin/model-router/virtual/resync-auto` 触发重同步 |
| `src/jobs/scheduler.js` | 模型探测完成后自动调用 `syncAutoTiers` 重分层 |
| `web/src/api/modelRouter.ts` | `resyncAutoTiers()`、候选/虚拟模型类型扩展 |
| `web/src/pages/ModelRouterPage.tsx` + `modelRouter/VirtualModelEditModal.tsx` | AUTO 徽标、重同步按钮、候选只读表格与禁用开关 |

生成产物：`output/model-router.json`（默认 16 / 20 / 25 个候选）。

## 7. 运维

- **手动重分层**：管理面板 → Model Router → 点「重同步分层」，或
  `POST /v1/admin/model-router/virtual/resync-auto`。
- **禁用模型**：在虚拟模型卡片的候选表格中取消勾选；重分层会保留禁用状态（按 `provider/model` 键匹配）。
- **重启服务**：RelayGate 以 Windows 服务运行（srvany 承载 `start.bat`），代码更新后需重启服务以加载新代码。

## 8. 验证记录（2026-10-06）

- 单元测试：174 项通过（含分层、钳制、候选过滤、rate 排序、字段持久化）。
- 服务重启后 `/overview` 返回 3 个 auto 虚拟模型：`vm/unified-chat`(16)、`vm/large-context`(20)、`vm/long-context`(25)。
- `/virtual/resync-auto` 返回 `ok:true`，三次分层候选数与声明窗口一致。
- 禁用候选后重同步，禁用状态保留；重新启用后恢复。
- FEFO 排序（2026-10-06 追加）：`/v1/admin/runtime` 返回 16 个账号的 `fefo` 字段；workbuddy 池按到期时刻正确排序（6.4d → 7.72d → 9.72d → 25.35d），修正了此前按 d3/d7 金额导致的错序。
- 实跑 e2e（`/v1/chat/completions` 流式）：
  - `vm/long-context` → Trae `__max` 档，回复「收到」；
  - `vm/large-context` → 回复「已收」；
  - `vm/unified-chat` → 正常流式返回。
