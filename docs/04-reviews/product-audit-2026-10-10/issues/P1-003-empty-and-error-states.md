# P1-003 — 19/20 空状态无指引，30+ 错误提示无下一步

| 字段 | 值 |
|---|---|
| **Priority** | P1 |
| **Category** | UX / 文案 |
| **Labels** | `ux`, `p1`, `frontend`, `copy`, `empty-state` |
| **Difficulty** | 中（约 2 小时） |
| **Risk** | 极低 |
| **来源** | product-professor full audit 2026-10-10 |

---

## Evidence

### 全部 20 个空状态（19 个零指引）

| 位置 | 文案 | 有下一步？ |
|---|---|---|
| [OverviewPage.tsx:180](../../../../web/src/features/overview/OverviewPage.tsx#L180) | 暂无账号数据 | ❌ |
| [CredentialsPage.tsx:316](../../../../web/src/features/accounts/CredentialsPage.tsx#L316) | 没有符合条件的账号 | ❌（且不区分首启/筛选空） |
| [AccessKeysPage.tsx:227](../../../../web/src/features/accounts/AccessKeysPage.tsx#L227) | 暂无访问密钥 | ❌ |
| [AccessKeysPage.tsx:366](../../../../web/src/features/accounts/AccessKeysPage.tsx#L366) | 未配置 | ❌ |
| [accountPacks.tsx:259](../../../../web/src/features/accounts/accountPacks.tsx#L259) | 该账号没有权益包记录。 | ❌ |
| [ModelRouterPage.tsx:243](../../../../web/src/features/models/ModelRouterPage.tsx#L243) | 尚未配置上游 | ❌ |
| [ModelRouterPage.tsx:312](../../../../web/src/features/models/ModelRouterPage.tsx#L312) | 暂无虚拟模型 | ❌ |
| [ModelPoolPage.tsx:320](../../../../web/src/features/models/ModelPoolPage.tsx#L320) | 没有符合条件的模型 | ❌ |
| [TokenStatsPage.tsx:364](../../../../web/src/features/stats/TokenStatsPage.tsx#L364) | 暂无数据 | ❌ |
| [TokenStatsPage.tsx:459](../../../../web/src/features/stats/TokenStatsPage.tsx#L459) | 暂无账单数据 | ❌ |
| [TokenStatsPage.tsx:560](../../../../web/src/features/stats/TokenStatsPage.tsx#L560) | 暂无模型数据 | ❌ |
| [TokenStatsPage.tsx:620](../../../../web/src/features/stats/TokenStatsPage.tsx#L620) | 暂无账号数据 | ❌ |
| [TokenStatsPage.tsx:744](../../../../web/src/features/stats/TokenStatsPage.tsx#L744) | 暂无标定样本：等待官方账单缓存积累 | ⚠️ 有原因，无动作 |
| [TrafficPage.tsx:178](../../../../web/src/features/stats/TrafficPage.tsx#L178) | 区间内无请求记录 | ❌（不区分"真无"与"筛太窄"） |
| [TrafficPage.tsx:279](../../../../web/src/features/stats/TrafficPage.tsx#L279) | 暂无调试记录 | ❌ |
| [OpsPage.tsx:1065](../../../../web/src/features/ops/OpsPage.tsx#L1065) | 暂无任务记录 | ❌ |
| [OpsPage.tsx:610](../../../../web/src/features/ops/OpsPage.tsx#L610) | 当前没有粘性会话 | ❌ |
| [NotifyBackupPanel.tsx:410](../../../../web/src/features/ops/NotifyBackupPanel.tsx#L410) | 未配置任何渠道 | ❌ |
| [NotifyBackupPanel.tsx:631](../../../../web/src/features/ops/NotifyBackupPanel.tsx#L631) | 暂无备份文件 | ❌ |
| [GrowthPanel.tsx:267](../../../../web/src/features/accounts/GrowthPanel.tsx#L267) | 暂无已启用的 WorkBuddy 账号。成长中心仅对启用账号生效。 | ✅ **唯一正确**：解释了原因 |
| [OpsPage.tsx:1368](../../../../web/src/features/ops/OpsPage.tsx#L1368) | 本机 auth 目录里没有可用账号备份，可先点「生成种子」写入。 | ✅ **唯一带 CTA** |

**19/21 无任何行动指引（GrowthPanel 解释了原因但无按钮）。**

### 全部错误提示：零"下一步"

最差的 10 条：

| 位置 | 原文 | 缺什么 |
|---|---|---|
| [ImportTraeDialog.tsx:75](../../../../web/src/features/accounts/ImportTraeDialog.tsx#L75) | `批量导入完成：成功 N，更新 M，失败 K` | **`r.failed` 逐条数组只取 `.length`，失败原因与失败项完全丢弃**。10 条导入 8 条失败，用户只知道"失败 8" |
| [CredentialsPage.tsx:132](../../../../web/src/features/accounts/CredentialsPage.tsx#L132) | `${label}失败` | 这是签到/查余额/删除/启停的**唯一包装**（:113-138）。所有失败都可能只显示"签到失败"四字，无账号名、无原因 |
| [CredentialsPage.tsx:205](../../../../web/src/features/accounts/CredentialsPage.tsx#L205) | `重置完成：成功 X，失败 Y` | 同上，失败 uid 列表丢弃 |
| [OpsPage.tsx:316](../../../../web/src/features/ops/OpsPage.tsx#L316) | `切换未成功：${r.msg ?? '后端未给出原因'}` | **"后端未给出原因"是开发者 TODO 泄漏到 UI**（全库 11 处） |
| [OpsPage.tsx:283](../../../../web/src/features/ops/OpsPage.tsx#L283) | `轮换完成但有异常：成功 X，失败 Y，跳过 Z` | 看似详实但不可操作：**失败账号列表未展示**，用户不知道去查哪一行 |
| [OauthTraeDialog.tsx:76-78](../../../../web/src/features/accounts/OauthTraeDialog.tsx#L76-L78) | `catch {}` | **轮询失败完全静默** → 上游已授权但面板永远停在"等待授权结果" |
| [ImportTraeDialog.tsx:50](../../../../web/src/features/accounts/ImportTraeDialog.tsx#L50) | `e.message \|\| '导入失败'` | 四字兜底，无排查提示。而输入是"浏览器 storage.json"，用户大概率不知道去哪导 |
| [GrowthPanel.tsx:157](../../../../web/src/features/accounts/GrowthPanel.tsx#L157) | `任务失败：${p.errors?.join('；') ?? '未给出原因'}` | 成长任务涉 4 种操作 × N 账号，无账号级归因 |
| [NotifyBackupPanel.tsx:313](../../../../web/src/features/ops/NotifyBackupPanel.tsx#L313) | `校验未通过：${r.reason ?? '后端未给出原因'}` | 备份校验失败无恢复建议 |
| [AccessKeysPage.tsx:92](../../../../web/src/features/accounts/AccessKeysPage.tsx#L92) | `${label}失败` | 吊销/删除失败原因（已被吊销？无权限？仍在使用？）全丢 |

**共同缺陷：全库 30+ 条错误提示，无一条含"接下来做什么"。**

### 相关的两个真 bug

- **B6 永久 loading**：[OpsPage.tsx:536-538](../../../../web/src/features/ops/OpsPage.tsx#L536-L538) 账号池快照空数组渲染 `<LoadingBlock/>` → "没有账号"永远显示"加载中…"
- **B7 加载中显示 0**：[TokenStatsPage.tsx:263,285,313,333](../../../../web/src/features/stats/TokenStatsPage.tsx#L263) 4 张口径卡**全无 loading 分支**，数据加载中直接显示「0 credits」—— 一个明确的错误信号

### 相关：死交互

- [TrafficPage.tsx:201-203](../../../../web/src/features/stats/TrafficPage.tsx#L201-L203) —— 点**成功**行 `onClick={() => setFailed(bad ? r : null)}` 什么都不发生，但行上有 `cursor-pointer`
- 12 个按钮 disabled 无解释：[AccessKeysPage.tsx:263-272](../../../../web/src/features/accounts/AccessKeysPage.tsx#L263-L272)、[ModelRouterPage.tsx:432](../../../../web/src/features/models/ModelRouterPage.tsx#L432)（"解冻"灰 = 无需解冻还是被冻结？）、[GrowthPanel.tsx:344-356](../../../../web/src/features/accounts/GrowthPanel.tsx#L344-L356) 等
- [useBalanceAutoRefresh.ts:47-49](../../../../web/src/shared/hooks/useBalanceAutoRefresh.ts#L47-L49) `catch {}` 静默失败，但 Overview:102 与 Credentials:220 的「每 60 秒自动刷新」chip **持续暗示健康**

---

## Why it matters

**空状态与错误状态是产品与用户对话的两个时刻。** 项目在这两个时刻说的是"什么都没有"和"失败了"，而不是"接下来这样做"。

用户抱怨统计（见 USER_COMPLAINTS.md）：5 个角色共 20 条抱怨中，**9 条根因是"缺少引导与状态说明"** —— 这是所有抱怨里占比最高的一类。

它也是 True Score（45/100）被硬规则压到 80 以下的原因之一。

---

## Expected behavior

- 每个空状态回答两个问题：**"为什么是空的？"** 和 **"我现在该做什么？"**
- 每条错误回答三个问题：**"发生了什么？" "为什么？" "接下来怎么办？"**
- disabled 的按钮在 disabled 时能看出**为什么**
- 空状态与"筛选无结果"在视觉上可区分

---

## Acceptance criteria

1. 全部 21 个空状态中，**至少 19 个**含一个可点击的动作或一条明确的原因说明。
2. `CredentialsPage` 与 `TrafficPage` 的空状态能区分"首次使用"与"筛选无结果"。
3. 全库不再出现 `后端未给出原因` / `未给出原因` 字样（替换为面向用户的兜底文案，如"网关拒绝了这次操作，请稍后重试或查看运维日志"）。
4. `ImportTraeDialog` 批量导入失败时，**逐条列出失败的 label 与原因**（若后端返回结构不支持，需先确认 `r.failed` 的实际形状）。
5. `OpsPage:536` 空池显示明确的空状态而非永久"加载中"。
6. `TokenStatsPage` 的 4 张口径卡在加载中显示「—」而非 `0`。
7. `OauthTraeDialog` 轮询失败时显示 toast，且连续失败 10 次后显示"可能已完成授权，请粘贴回调 URL"的提示。
8. `TrafficPage` 成功行去掉 `cursor-pointer`，或让点击有可见反馈。
9. `useBalanceAutoRefresh` 连续失败 3 次后在 chip 上显示"连续失败"状态。

---

## Implementation notes

**建议先修这 6 个（覆盖 80% 的场景）：**

| # | 位置 | 改法 |
|---|---|---|
| 1 | OverviewPage:180 | 「还没有接入任何账号」+ 「接入第一个账号」按钮 → `/credentials` |
| 2 | CredentialsPage:316 | 分两种情况（见 acceptance #2） |
| 3 | AccessKeysPage:227 | 「还没有访问密钥」+ 「创建第一把」按钮 |
| 4 | OpsPage:1368（已有正确写法） | 把这个文案模式**推广**到其他 19 处 |
| 5 | ImportTraeDialog:75 | 展开 `r.failed` |
| 6 | TokenStatsPage:263/285/313/333 | 加 loading 分支 |

**通用原则建议写进代码注释：**
> 空状态 = 为什么空 + 下一步动作。错误 = 发生了什么 + 为什么 + 下一步。disabled = 给出原因（title 或 tooltip）。

**关于 `EmptyState` 组件：** [shared/ui/index.tsx:445](../../../../web/src/shared/ui/index.tsx#L445) 已有一个 `EmptyState` 组件，但**全库 0 引用**，而空态 div 被手抄 6 次。建议扩展 `EmptyState` 支持 `action?: {label, onClick}`，然后替换掉那 6 处手抄 —— 一举解决两个问题。

---

## 可直接执行的修复提示词

```
修复 RelayGate 的空状态与错误提示。

现状：21 个空状态里 19 个是纯灰字「暂无X」，零下一步；30+ 条错误提示无一含
「接下来做什么」；全库 11 处使用「后端未给出原因」这类开发者占位串。

分四步做：

【第 1 步：把现有 EmptyState 组件变成可用工具】
web/src/shared/ui/index.tsx:445 的 EmptyState 目前全库 0 引用，而空态 div 被手抄 6 次
（OverviewPage:179、GrowthPanel:266、ModelRouterPage:242、TrafficPage:177 等）。
扩展它：
  <EmptyState label="..." action={{ label: '接入第一个账号', onClick: () => ... }} />
  <EmptyState label="..." hint="原因说明（可选，显示在 label 下方的小字）" />
保持向后兼容（action/hint 均可选）。

【第 2 步：替换 6 处手抄空态并补充 action】
- OverviewPage.tsx:180 「暂无账号数据」→ 用 EmptyState，
  label: '还没有接入任何账号'，action: 「接入第一个账号」→ navigate('/credentials')
- ModelRouterPage.tsx:243 「尚未配置上游」→ EmptyState + 「配置上游」按钮
- ModelRouterPage.tsx:312 「暂无虚拟模型」→ EmptyState + 「创建虚拟模型」按钮
- TrafficPage.tsx:177 「区间内无请求记录」→ 区分两种情况：
    traffic.data.data.length === 0 → 「该区间还没有请求记录」
    有筛选条件 → 「当前筛选条件下没有请求」+ 「清除筛选」按钮
- GrowthPanel.tsx:266 → 保留现有说明文案，补一个 action

【第 3 步：区分首启空与筛选空】
CredentialsPage.tsx:314-317：
  list.data?.length === 0  → 「还没有接入任何账号」+「接入新账号」按钮
  list.data?.length > 0    → 「当前筛选条件下没有匹配账号」+「清除筛选」按钮（重置三个筛选状态）
同理处理 ModelPoolPage.tsx:320 与 AccessKeysPage.tsx:227。

【第 4 步：错误提示补「下一步」，删除开发者占位串】
全库 grep 替换 '后端未给出原因' 与 '未给出原因'（共 11 处，分布在 CredentialsPage、
OpsPage、ImportWbDialog、ModelRouterPage、NotifyBackupPanel、ModelPoolPage、GrowthPanel），
改为面向用户的文案，例如「网关拒绝了这次操作，请稍后重试；若持续失败请查看运维 → 任务日志」。
批量导入的具体改动：ImportTraeDialog.tsx:75 当前只取 r.failed.length，
改为把失败项渲染成列表（label + 后端给出的原因）而不是一个 toast 计数。
若 toast 放不下，改用 Modal 或 ErrorState 展示明细。

【配套修两个真 bug】
B6: OpsPage.tsx:536-538 —— 账号池快照在数组为空时渲染 <LoadingBlock/>，
    导致「没有账号」永远显示「加载中…」。改为 runtime.loading 时显示 LoadingBlock，
    !loading 且为空时显示 EmptyState「当前没有账号」+ 说明「请先接入账号，或点『生成种子』写入本机 auth 目录」。
B7: TokenStatsPage.tsx 的 4 张 CaliberCard（263/285/313/333 行）全无 loading 分支，
    数据加载中直接显示「0 credits」。给 CaliberCard 加 loading prop，
    加载中时 value 显示「—」而不是 0。

完成后运行 npx tsc -b --force && npm run lint 确认零错误。
```