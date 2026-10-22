# P1-005 — 论文体脚注、内部代号泄漏、同一警告重复 4 次

| 字段 | 值 |
|---|---|
| **Priority** | P1 |
| **Category** | 文案 / 信息架构 |
| **Labels** | `copy`, `p1`, `frontend`, `ai-generated-feel` |
| **Difficulty** | 低（1 小时） |
| **Risk** | 极低 |
| **来源** | product-professor full audit 2026-10-10 |

---

## Evidence

### 1. 内部项目代号泄漏给终端用户

[TokenStatsPage.tsx:738](../../../../web/src/features/stats/TokenStatsPage.tsx#L738) —— 面板 footer 原文：

> 系数单位为「积分 / token」，按未缓存输入 / 输出 / 缓存读三个桶分别计价（**DSH token-meter 分桶口径**）。R²≈1 表示三系数可精确还原账单；R² 偏低说明上游账单本身有抹零噪声（如 Trae 会话级 DeepSeek）。

`DSH` 是内部项目代号，终端用户无从知晓其含义。

### 2. 把方法论说明塞进 UI

- [TokenStatsPage.tsx:738](../../../../web/src/features/stats/TokenStatsPage.tsx#L738) —— 整段 R² 回归方法论
- [TokenStatsPage.tsx:786-790](../../../../web/src/features/stats/TokenStatsPage.tsx#L786-L790) —— 页面底部 Note，**连续三行**口径声明，且含命令式告诫「**不建议与官方值相加**」（用户本来就不会把两个数加起来）
- [TokenStatsPage.tsx:436](../../../../web/src/features/stats/TokenStatsPage.tsx#L436) —— 图表 footer 印着历史 bug 说明：「注意：2026-10-10 之前修复的日志脱敏缺陷曾把 token 字段写成 '***'」—— 这是**开发笔记不是用户文案**（且 :406 的表格已在数据点旁标了「数据缺失」）
- [OpsPage.tsx:1434](../../../../web/src/features/ops/OpsPage.tsx#L1434) footer：「轮换可能返回业务层失败（请求成功但结果未成功）」—— "业务层失败"是后端概念
- [ModelRouterPage.tsx:306](../../../../web/src/features/models/ModelRouterPage.tsx#L306) footer：**与上一条近乎逐字重复**
- [OpsPage.tsx:1598](../../../../web/src/features/ops/OpsPage.tsx#L1598) 全局 Note 在**所有分段**渲染，包括 notify 分段（配置通知渠道时也在说"轮换会重新分配账号"）

### 3. 同一 caveat 重复 4 次

| caveat | 位置 | 次数 |
|---|---|---:|
| 「Trae 账单 1~2 天入账滞后」 | TokenStatsPage `:354`、`:453`、`:788` + 代码 `:203-208` | **4** |
| 「token 历史脱敏导致 0 不可信」 | `:436`、`:355`、`:789`（隐含）、TrafficPage `:80-87` | **4** |
| 「不限量包不计入金额」 | OverviewPage `:99`、`:170` | 2 |
| 「探测/测试真实消耗配额」 | TrafficPage `:374`、ModelPoolPage `:457` | 2 |

### 4. 「口径」成了信息架构的第一性分类

`口径` 在 `web/src` 出现 **28 次**，横跨 5 个文件（TokenStatsPage 12、accountPacks 4、OverviewPage 3、types.ts 2、format.ts 1）。连 CSS 注释都在用（[global.css:461](../../../../web/src/styles/global.css#L461)）。

真实运维工具不会用"口径"给页面分类。这是 AI 面对"多个数字来源不一致"时的典型反应——**把技术债的成因写进 UI 分类法**，而不是解决"该信哪个数"。

### 5. "标签拼接式"页面描述

- [OpsPage.tsx:423](../../../../web/src/features/ops/OpsPage.tsx#L423)：「运行状态、定时任务、账号轮换、通知备份与网关配置」—— **把 5 个分段标签用顿号拼一遍**，这是目录不是描述
- [TrafficPage.tsx:129](../../../../web/src/features/stats/TrafficPage.tsx#L129)：「网关转发记录、SSE 调试与连通性测试」—— 三个 Panel 标题的拼接
- [OverviewPage.tsx:87](../../../../web/src/features/overview/OverviewPage.tsx#L87)：「凭据池健康度与网关运行状态」—— 同义反复（标题"总览"已含此意）
- [CredentialsPage.tsx:217](../../../../web/src/features/accounts/CredentialsPage.tsx#L217)：「账号凭据的启用、签到、余额与设备标识管理」—— 列举操作，非说明目的

---

## Why it matters

界面文案的作用是让用户完成判断，不是解释实现。这批文案做了相反的事：

1. **稀释真正重要的警告**（"今日数字偏低"和"这是一个 beta"混在 12 处脚注里）
2. **暴露内部实现**（DSH、R²、上界行、抹零噪声）—— 用户读到的是"这东西的开发者自己都没搞清"
3. **增加认知负荷**：一个页面要滚过 4 段散文才能看到下一个 Panel

它也是 AI 生成感评分 6.5/10 的主要构成之一。

---

## Expected behavior

- 界面上最多保留 **1 处**关于数据可信度的关键警告，且必须在**用户会看那个数字的地方**，而不是页面底部。
- 内部代号、回归术语、实现细节不进 UI。
- 页面 description 说明**为什么来这个页面**，不是罗列它有什么。

---

## Acceptance criteria

1. `web/src` 中 `DSH` 出现 0 次（UI 区域；代码注释中的可保留）。
2. 「Trae 账单滞后」在 `TokenStatsPage` 出现**恰好 1 次**，且位于主口径卡片附近（不是 footer）。
3. `:436` 与 `:786-790` 的重复段落被删除或合并。
4. `OpsPage:1598` 的全局 Note 只在 `rotate` 与 `config` 分段显示。
5. 全部页面的 `description` 重写为"为什么来"，不再出现分段标签的顿号拼接。
6. 删减后「口径」出现次数 ≤ 10。

---

## Implementation notes

**逐条改法：**

| 位置 | 现状 | 改法 |
|---|---|---|
| TokenStatsPage:738 | R² 方法论 + DSH 代号 | **整段删除**。系数表的字段名已自带含义（`creditsPer1k`、`r2`、`n`），无需散文解释 |
| TokenStatsPage:786-790 | 连续三行口径声明 | **压缩为一行**，放在「官方账单积分」卡片内的 CaliberRow 区域；删掉「不建议与官方值相加」 |
| TokenStatsPage:436 | 历史 bug 说明 | **删除**。:406 表格已在数据点旁标「数据缺失」；折线图上标不出就不标 |
| TokenStatsPage:453 | 重复的滞后说明 | **删除**（保留 :354 一处） |
| OpsPage:1434 | "业务层失败"footer | **删除**。"轮换可能失败，此时会展示原因" 已在 doRotate 的 toast 里 |
| ModelRouterPage:306 | 同上（逐字重复） | **删除** |
| OpsPage:1598 | 全局 Note | 移到 rotate/config 分段内 |
| OpsPage:423 | 顿号拼接 | 改为「网关运行状态、定时任务与账号调度策略」 |
| TrafficPage:129 | 顿号拼接 | 改为「查看网关转发记录、定位失败请求与验证链路连通性」 |
| OverviewPage:87 | 同义反复 | 改为「今天的额度、账号健康与待处理事项」 |
| CredentialsPage:217 | 罗列操作 | 改为「接入、启用与排查上游账号凭据」 |

**「口径」的处理建议：** 不必全局消灭（有些地方确实需要说明两套计量），但要**降级**：只保留在真正需要解释的地方（OverviewPage 的双卡、TokenStatsPage 的主口径卡），其余删除。

---

## 可直接执行的修复提示词

```
清理 web/src 的论文体文案与内部代号泄漏。

现状（已核实）：
1) TokenStatsPage.tsx:738 面板 footer 是整段 R² 回归方法论，且含内部代号「DSH token-meter 分桶口径」
2) TokenStatsPage.tsx:786-790 页面底部 Note 连续三行口径声明，含命令式告诫「不建议与官方值相加」
3) TokenStatsPage.tsx:436 图表 footer 印着历史 bug 说明「2026-10-10 之前修复的日志脱敏缺陷……」
4) 「Trae 账单 1~2 天入账滞后」在 TokenStatsPage 出现 3 次（354/453/788）+ 代码 1 次
5) OpsPage.tsx:1434 与 ModelRouterPage.tsx:306 的 footer「可能返回业务层失败」近乎逐字重复
6) OpsPage.tsx:1598 的全局 Note 在所有分段渲染，包括 notify（配置通知渠道时也说「轮换会重新分配账号」）
7) 多个页面 description 是分段标签的顿号拼接（OpsPage:423、TrafficPage:129）

请执行：

【第 1 步：删掉内部代号与开发笔记】
- 删除 TokenStatsPage.tsx:738 整个 footer（含 R² 方法论与 DSH 代号）。
  系数表的列名（creditsPer1k / r2 / n）已自带含义，不需要散文解释。
- 删除 TokenStatsPage.tsx:436 的图表 footer（历史 bug 说明）。
  表格第 406 行已在数据点旁标了「数据缺失」，不需要在图表底部再说一遍。
- 全库 grep 确认 web/src 的 UI 区域不再出现「DSH」。

【第 2 步：把 4 次重复警告压到 1 次】
保留 TokenStatsPage.tsx:354 一处「账单积分是上游权威口径，Trae 按会话入账有 1~2 天滞后」。
删除 :453 与 :788 中的重复表述。
把这句警告从 footer 移到「官方账单积分」卡片内部（作为 CaliberRow 或 CaliberCard 的 children），
因为那是用户实际看到那个数字的地方。

【第 3 步：删掉纯实现说明】
- 删除 OpsPage.tsx:1434 的 footer（「轮换可能返回业务层失败……」）
- 删除 ModelRouterPage.tsx:306 的同类 footer
  （失败原因已经在 doRotate / saveVirtual 的 toast 里展示了，不需要额外解释）
- OpsPage.tsx:1598 的 Note 从全局位置移到 active==='rotate' || active==='config' 的分支内。

【第 4 步：重写页面 description（从「有什么」改为「为什么来」）】
- OpsPage.tsx:423   → 「网关运行状态、定时任务与账号调度策略」
- TrafficPage.tsx:129 → 「查看网关转发记录、定位失败请求与验证链路连通性」
- OverviewPage.tsx:87 → 「今天的额度、账号健康与待处理事项」
- CredentialsPage.tsx:217 → 「接入、启用与排查上游账号凭据」
- ModelPoolPage.tsx:208 保持不变（已经是好的写法）

【第 5 步：降频「口径」】
全库统计「口径」出现次数（当前 28 次）。目标 ≤ 10 次。
保留：OverviewPage 的积分双卡（确实需要说明两套计量）、TokenStatsPage 的主口径卡。
其余删除或改写为普通中文（如「这两套数不一样，不能相加」）。

完成后运行 npx tsc -b --force && npm run lint 确认零错误。
```