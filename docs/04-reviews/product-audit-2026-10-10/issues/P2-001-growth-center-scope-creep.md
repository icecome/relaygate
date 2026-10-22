# P2-001 — 成长中心 scope creep（含抽奖按钮）

| 字段 | 值 |
|---|---|
| **Priority** | P2 |
| **Category** | 产品定位 / 功能价值 |
| **Labels** | `product`, `p2`, `scope-creep`, `frontend`, `backend` |
| **Difficulty** | 低（删 UI 1 小时；删全栈 3 小时） |
| **Risk** | 中（**取决于这是否为真需求 —— 见下方"先确认"**） |
| **来源** | product-professor full audit 2026-10-10 |

---

## ⚠️ 先确认

**这个功能对你来说是真需求还是 AI 加的？**

- **是真需求**（你确实想自动领 WorkBuddy 的旅行奖励/连登/抽奖）→ 只做下面的「方案 B」（删 UI 写操作，保留后台 job）。
- **不是**（你从没点过那个面板）→ 做「方案 A」（删整个 UI，保留后台 job 与通知）。

**在回答这个问题之前不要动手。** 它有 1860 行代码、22 个端点、2 个后台 job 和 286 行测试——删错了代价不小。

---

## Evidence

### 规模

| 文件 | 行数 |
|---|---:|
| [web/src/features/accounts/GrowthPanel.tsx](../../../../web/src/features/accounts/GrowthPanel.tsx) | 372 |
| [src/routes/cat-trip.js](../../../../src/routes/cat-trip.js) | 190 |
| [src/workbuddy/cat-trip.js](../../../../src/workbuddy/cat-trip.js) | 430 |
| [src/jobs/growth-auto.js](../../../../src/jobs/growth-auto.js) | 237 |
| [src/jobs/growth-progress.js](../../../../src/jobs/growth-progress.js) | 169 |
| [src/test/growth.test.js](../../../../src/test/growth.test.js) | 286 |
| [web/src/shared/api/growth.ts](../../../../web/src/shared/api/growth.ts) | 178 |
| **合计** | **~1862 行** |

### 产品定位问题

界面元素（[GrowthPanel.tsx](../../../../web/src/features/accounts/GrowthPanel.tsx)）：

| 行 | 内容 |
|---|---|
| [:347-349](../../../../web/src/features/accounts/GrowthPanel.tsx#L347-L349) | **「抽奖」按钮** |
| [:344](../../../../web/src/features/accounts/GrowthPanel.tsx#L344) | 「领奖」按钮 |
| [:279](../../../../web/src/features/accounts/GrowthPanel.tsx#L279) | 「补登卡」列 |
| [:288](../../../../web/src/features/accounts/GrowthPanel.tsx#L288) | 「稀有度」列 |
| [:275](../../../../web/src/features/accounts/GrowthPanel.tsx#L275) | 「Buddy」列 |
| [:276](../../../../web/src/features/accounts/GrowthPanel.tsx#L276) | 「能量」列 |

**一个叫 RelayGate 的 LLM 网关界面里，出现"抽奖"、"Buddy 稀有度"、"补登卡"。** 任何技术用户看到这个的第一反应是质疑产品定位。

### 三个结构性证据（比"有抽奖按钮"更硬）

**1. API 层比 UI 层完整 —— "先生成后使用"的指纹**

后端 [cat-trip.js:181-188](../../../../src/routes/cat-trip.js#L181-L188) 铺了 **15 个写端点**：
`depart` / `claim` / `buddy-open` / `draw` / `accept` / `task-claim` / `makeup` / `redeem-tier` …

UI 只做了 **3 个按钮**：领奖 / 抽奖 / 兑换。

且 [growth.ts:100-122](../../../../web/src/shared/api/growth.ts#L100-L122) 有 **4 个零引用导出**（`growthStatus`、`growthStreak`、`growthChances`、`growthDepart`）—— 在任何 tsx 中 0 引用。

**2. 定时器已在跑同一个 job —— 手动按钮是第二入口**

[src/jobs/scheduler.js:578-602](../../../../src/jobs/scheduler.js#L578-L602) 已有 `scheduleGrowthPoll`，每 `growthPollIntervalHours`（默认 4h）跑同一个 `runGrowthAuto`。

[GrowthPanel.tsx:254](../../../../web/src/features/accounts/GrowthPanel.tsx#L254) 的「一键执行」按钮调的是**同一个 job**，而它还自带一套 4 state + 4 ref 的轮询状态机（[:47-67, :123-185](../../../../web/src/features/accounts/GrowthPanel.tsx#L123-L185)）。

**3. 功能自己承认不合理**

[GrowthPanel.tsx:367-369](../../../../web/src/features/accounts/GrowthPanel.tsx#L367-L369)：

> 成长中心操作直连上游真实接口，会实际消耗账号额度并可能触发上游限流，**建议按需手动执行**。

一句话把整个面板的必要性否定了 —— 既然建议手动按需，那自动化定时器才是主路径，UI 只是偶尔用的调试入口。

### 隐藏成本

- 每次展开 GrowthPanel 就发 **3 个并发上游请求**（[:69-72](../../../../web/src/features/accounts/GrowthPanel.tsx#L69-L72)），对每个启用的 WorkBuddy 账号扇出（后端限并发 2 + 300ms 间隔）
- 面板藏在一个折叠按钮后面（[CredentialsPage.tsx:266-268](../../../../web/src/features/accounts/CredentialsPage.tsx#L266-L268)），**默认收起** —— 一个"一等公民功能"却要用户先发现它存在

---

## Why it matters

它不是"多了一个功能"，而是**改变了用户对这个产品的认知**：

- 网关 → 聚合面板 → 游戏外挂
- 用户会开始怀疑：作者到底想做什么？这个工具可靠吗？
- 一旦建立这种怀疑，其他做得好的部分（账号池、路由、协议兼容）也会被折扣看待

在 USER_COMPLAINTS.md 的怀疑型技术用户视角里，这是**最刺眼的一条**，也是他直接关闭页面的原因。

---

## Expected behavior（方案 B，推荐）

1. **UI 侧删除**：抽奖按钮、稀有度列、Buddy 列、补登卡列、能量列、一键执行按钮及其轮询状态机。
2. **保留**：后台 `scheduleGrowthPoll` 定时任务（它才是真正干活的）。
3. **保留**：只读的成长概览（连登天数、可参与账号数）—— 这是有意义的运营指标。
4. **补上**：奖励领取的通知（[growth-auto.js:75](../../../../src/jobs/growth-auto.js#L75) 已有 notify，确认默认开启）。
5. **删除**：4 个零引用导出、15 个无 UI 的写端点（或明确标注为"内部任务专用，不对外暴露"）。

---

## Acceptance criteria

**方案 B：**

1. `GrowthPanel.tsx` 中不再出现「抽奖」「稀有度」「Buddy」「补登卡」「能量」「一键执行」字样。
2. `GrowthPanel.tsx` 不再引用 `growthDraw` / `growthAuto` / `growthProgress`。
3. 后台定时任务不受影响（`npm test` 的 11 个 growth 断言全部通过）。
4. 面板展开后仍展示：可参与账号数、连登天数、抽奖机会（只读）、旅行状态（只读）。
5. `npx tsc -b --force` 与 `npm run lint` 零错误。

**方案 A（额外）：**

6. `CredentialsPage.tsx` 移除「成长中心」折叠按钮。
7. `web/src/features/accounts/GrowthPanel.tsx` 与 `web/src/shared/api/growth.ts` 删除或移入 `src/` 内部工具。
8. 奖励领取结果仍通过 notify 到达用户。

---

## Implementation notes

- **不要删后台 job**。无论方案 A 还是 B，`scheduler.js` 的 growth 轮询与 `growth-auto.js` 都是这个功能真正的价值所在（自动领奖 + 通知），成本很低、收益真实。
- **不要删 `growth.test.js`**。11 个断言覆盖的是后台 job 的逻辑，与 UI 无关。
- **如果要走方案 A**，注意 `CredentialsPage.tsx:68` 的 `growthOpen` state 与 `:266-268` 的按钮、`:504` 的渲染三处要一起删。
- **删 UI 后的 notify 确认**：查 [src/jobs/growth-auto.js](../../../../src/jobs/growth-auto.js) 的 notify 调用，确认默认是开启的（若默认关闭，需在 `.env.example` 里说明如何开启，否则用户会"奖励被领了但不知道"）。

---

## 可直接执行的修复提示词

```
【先回答一个问题再动手】
成长中心（GrowthPanel）对你是真需求还是 AI 加的？
如果你从没点过那个折叠面板 → 执行方案 A。
如果你确实用它手动领奖/抽奖 → 执行方案 B。
不要在未确认前删除后端 job 或测试。

—— 方案 B（保留功能，只删掉不体面的部分）——

修改 web/src/features/accounts/GrowthPanel.tsx：
1) 删除「抽奖」按钮（约 347-349 行）及其 onClick 处理函数 draw()（约 102-110 行）。
2) 删除「成长概览」表中的「Buddy」列（275 行）、「稀有度」列（276 行）、
   「能量」列（276 行）、「补登卡」列（279 行）。
   保留：账号、可兑换、连登、抽奖机会（只读展示）。
3) 删除「一键执行」按钮（254-256 行）与整个轮询状态机：
   - TaskProgress 接口（33-39 行）
   - task / polling state（47-48 行）
   - timerRef / startRef / stopTimer（52-64 行）
   - useEffect cleanup（67 行）
   - runAuto()（123-185 行）
   - 「一键成长任务」进度 Panel（217-244 行）
   理由：src/jobs/scheduler.js:578-602 已经在按 growthPollIntervalHours 自动跑同一个 job，
   手动按钮是第二入口，还自带 4 state + 4 ref。
4) 相应清理 import：growthDraw / growthAuto / growthProgress 不再需要。
5) 确认「旅行状态」表保留（它是只读的状态展示，有价值）。

修改后运行 npx tsc -b --force && npm run lint 确认零错误，
并运行 npm run test:growth 确认 11 个断言仍全部通过（后台 job 不受影响）。

—— 方案 A（额外，仅在确认不是真需求时）——

6) web/src/features/accounts/CredentialsPage.tsx：
   删除 growthOpen state（68 行）、工具条上的「成长中心」按钮（266-268 行）、
   <GrowthPanel /> 渲染（504 行）与 import（49 行）。
7) 删除 web/src/features/accounts/GrowthPanel.tsx 与 web/src/shared/api/growth.ts。
8) 保留 src/routes/cat-trip.js、src/jobs/growth-*.js、src/test/growth.test.js ——
   后台自动领奖 + 通知是这个功能真正的价值。
9) 检查 src/jobs/growth-auto.js 的 notify 调用，确认奖励领取结果默认会通知用户；
   若默认关闭，在 .env.example 中说明如何开启。
```