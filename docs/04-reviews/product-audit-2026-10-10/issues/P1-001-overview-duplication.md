# P1-001 — Overview 重复凭据池表与运行状态 9 项

| 字段 | 值 |
|---|---|
| **Priority** | P1 |
| **Category** | 产品清晰度 / 信息架构 |
| **Labels** | `ux`, `p1`, `frontend`, `information-architecture` |
| **Difficulty** | 低（15 分钟） |
| **Risk** | 低（纯删除 + 替换为链接） |
| **来源** | product-professor full audit 2026-10-10 |

---

## Evidence

### 重复 A：账号表是 CredentialsPage 的只读子集

[OverviewPage.tsx:175-248](../../../../web/src/features/overview/OverviewPage.tsx#L175-L248) 的「账号池」表 7 列：
账号 / 状态 / 平台 / 可用积分 / 最近选用 / 最近签到 / 错误数

[CredentialsPage.tsx:319-467](../../../../web/src/features/accounts/CredentialsPage.tsx#L319-L467) 的主表 10 列：
启用 / 账号 / 状态 / 平台 / 权益包 / 权益到期 / 账号到期 / 余额额度 / 冷却至 / **操作**

**重叠 5/7 列**，且 Overview 版本**全部是只读 `<td>`，零操作按钮**（[OverviewPage.tsx:203-243](../../../../web/src/features/overview/OverviewPage.tsx#L203-L243)）。用户在这里发现异常账号后，**必须跳转到 /credentials 才能做任何事**。

### 重复 B：运行状态 9 项 9/9 与 /ops 第一屏完全相同

| 字段 | Overview | OpsPage |
|---|---|---|
| 调度器 | [:262](../../../../web/src/features/overview/OverviewPage.tsx#L262) | [:409](../../../../web/src/features/ops/OpsPage.tsx#L409) |
| 下次签到 | [:267](../../../../web/src/features/overview/OverviewPage.tsx#L267) | [:410](../../../../web/src/features/ops/OpsPage.tsx#L410) |
| 粘性条目 | [:268](../../../../web/src/features/overview/OverviewPage.tsx#L268) | [:412](../../../../web/src/features/ops/OpsPage.tsx#L412) |
| 不可用模型 | [:269](../../../../web/src/features/overview/OverviewPage.tsx#L269) | [:469](../../../../web/src/features/ops/OpsPage.tsx#L469) |
| 运行时长 | [:270](../../../../web/src/features/overview/OverviewPage.tsx#L270) | [:406, :453](../../../../web/src/features/ops/OpsPage.tsx#L406) |
| 节点 | [:271](../../../../web/src/features/overview/OverviewPage.tsx#L271) | [:450](../../../../web/src/features/ops/OpsPage.tsx#L450) |
| 池化策略 | [:272](../../../../web/src/features/overview/OverviewPage.tsx#L272) | [:457](../../../../web/src/features/ops/OpsPage.tsx#L457) |
| 通知 | [:273](../../../../web/src/features/overview/OverviewPage.tsx#L273) | [:473](../../../../web/src/features/ops/OpsPage.tsx#L473) |
| 管理密钥分离 | [:274](../../../../web/src/features/overview/OverviewPage.tsx#L274) | [:477](../../../../web/src/features/ops/OpsPage.tsx#L477) |

**两处都读同一个 `GET /v1/admin/runtime`。** Overview 的这块 Panel 零独立价值。

### 附带成本

- 重复拉取：Overview 与 OpsPage 各持一个 `useAsyncData(getRuntime)` 实例
- 重复维护：账号字段改一次要改两处渲染

---

## Why it matters

用户打开总览页看到的不是"今天有什么问题"，而是**两张别处已有的表**。这直接导致：

1. **判断困惑**：同一个账号在 Overview 与 Credentials 显示不同列（Overview 没有"权益到期"与"账号到期"），用户会怀疑哪个是真的
2. **行动断裂**：看到异常账号但无法就地修复
3. **认知负荷**：页面越滚越长，真正的信号（积分额度）被淹没

这也违反了项目自己的重构计划 —— [docs/03-development/frontend-refactor-plan.md:101](../../../../docs/03-development/frontend-refactor-plan.md) 定义总览职责为「全局读数、账号健康分布、模型路由概览、长任务与告警摘要」，**不是明细表**。

---

## Expected behavior

总览页只回答一个问题：**"现在有什么需要我处理的？"**

- 保留：4 个 KPI（凭据总数/可用/冷却/3日到期）、积分额度双卡
- 删除：账号池明细表、运行状态 9 项
- 新增：异常摘要条 —— 「3 个账号需重新登录 · 1 个账号冷却中」+ 一个「去凭据池处理」按钮
- 新增：一行链接「查看运行状态 →」

---

## Acceptance criteria

1. `OverviewPage.tsx` 不再包含 `<table>` 元素。
2. `OverviewPage.tsx` 不再调用 `getRuntime`。
3. 存在异常账号时，总览显示可点击的摘要条，点击跳转 `/credentials`。
4. `npx tsc -b --force` 与 `npm run lint` 零错误（注意删除后清理未使用的 import 与变量）。
5. 无账号时，总览显示带 CTA 的空状态（见 P1-003）。

---

## 可直接执行的修复提示词

```
删除 web/src/features/overview/OverviewPage.tsx 中的两个 Panel：

1) 「账号池」表格（第 175-248 行）—— 它是 CredentialsPage 账号表的只读子集，
   5/7 列重叠且无操作列，用户看到异常后仍必须跳转才能修复。
   改为一条异常摘要（仅当有异常时显示）：
   - 统计 accounts 中 keepaliveOf(a).tone === 'danger'（需重新登录）的数量
   - 统计 accountState(a) === 'cool' 的数量
   - 渲染为一行 Chip + 一个「去凭据池处理」按钮（useNavigate → '/credentials'）
   - 无异常时不渲染该块（不要显示「一切正常」占位）

2) 「运行状态」KeyValue（第 250-278 行）—— 9 项字段与 /ops 第一屏 9/9 完全重复，
   删除，改为一行链接「查看运行状态 →」（useNavigate → '/ops'）。

同时清理因此不再使用的代码：
- useAsyncData(getRuntime) 调用与 runtime 变量
- 相关 import（getRuntime、KeyValue、LoadingBlock 若不再使用）
- perAccountCredits useMemo 若仅被该表使用

删除后运行 npx tsc -b --force && npm run lint 确认零错误（特别注意未使用变量）。
另外在文件头部注释里加一行约束：
「本页不得复制凭据池的表格或运维页的运行状态；发现异常请链接过去。」
```