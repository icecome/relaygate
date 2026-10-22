# AI_GENERATED_FEEL — AI 生成感分析
**Product Professor · 2026-10-10 · commit `2a2ec43`**

# **AI-Generated Feel Badness: 6.5 / 10**（0=完全手作，10=纯 AI demo）

---

## 判决：这不是"AI demo"，是"AI 深度参与、极度克制地生成了大量冗余"

先说清它**不是**什么：它没有空壳页面、没有 Lorem Ipsum、没有假数据、没有"敬请期待"、没有 emoji 墙、没有紫蓝渐变 hero。这些是 AI demo 的标准指纹，**本项目一个都没有**（全部经全量扫描验证）。

它的问题是另一种：**AI 把"一个网关该有的完整功能"枚举了出来并全部实现，而真实用户只需要其中五件。** 完整的方式是枚举出来的，不是长出来的。

---

## 一、最硬的证据：CSS 引用了不存在的东西（人不会犯，AI 会）

这是比任何文案分析都实的一条，因为它证明**生成之后没有人打开页面看过一眼**。

| # | 证据 | 复核结果 |
|---|---|---|
| 1 | [shared/ui/index.tsx:126](../../../web/src/shared/ui/index.tsx#L126) Stepper 使用 `var(--rg-bg-primary)` | ✅ **已独立复核**：全库扫描 CSS 变量，DEFINED 48 个、USED 23 个；`--rg-bg-primary` **不在定义中**（token 层只有 `--rg-bg-base`）→ Stepper 背景实际不生效 |
| 2 | [shared/ui/index.tsx](../../../web/src/shared/ui/index.tsx) 与 TokenStatsPage 使用 `var(--rg-state-ok)` | ✅ **已独立复核**：定义中只有 `--rg-state-success`，`--rg-state-ok` 不存在（此处有 fallback 值，不致命） |
| 3 | [ClientAccessPanel.tsx:59,142](../../../web/src/features/ops/ClientAccessPanel.tsx#L59) 使用 `.t-label` 类 | ✅ **已独立复核**：`global.css` 全 560 行中 `t-label` **0 命中** → 这两处标签**根本没有样式** |
| 4 | [tailwind.config.ts:3](../../../web/tailwind.config.ts#L3) 注释写"色值权威来源为 styles/tokens.css" | ✅ **已独立复核**：`web/src/styles/tokens.css` **不存在**；token 实际在 `global.css`。且该 config 定义的完整 palette（brand/ink/ok/warn/danger/line/surf 全套）在 `web/src` 中 **0 处使用**（全库 0 处 `bg-brand-*`、`text-ink-*`、`border-line`） |

**为什么这算 AI 味**：生成流程是"agent 一次性产出完整 tailwind theme → 之后的迭代全部改走 CSS 变量 + `style={{}}` 内联 → 没有人回来清理"。结果是 254 处 `text-[Npx]` 任意值类 + 241 处内联样式，Tailwind 被降级成"间距 + flex 工具"，而它的颜色/字体 API 成了化石。

---

## 二、结构性指纹：8/8 页面同一套模板

统计每页 `<table>` 数量：

```
TokenStatsPage.tsx:  7   ModelRouterPage.tsx: 4   OpsPage.tsx:  4
CredentialsPage.tsx: 2   GrowthPanel.tsx:     2   TrafficPage.tsx: 2
AccessKeysPage.tsx:  1   ModelPoolPage.tsx:   1   OverviewPage.tsx: 1
```

**19 个表格。8 个页面全部由 `PageShell → (MetricGrid) → Panel → table` 堆叠而成**（[PageShell.tsx:15-33](../../../web/src/shared/ui/PageShell.tsx#L15-L33) 就是 title + description + actions + toolbar + flex-col gap-4）。

模板本身对运维台是合理的。暴露 AI 味的是**每个 Panel 的 description 都被填成了脚注**（见第四节）——批量生成时"数据"和"对数据的论文式注解"被一起复制了 19 次。

---

## 三、「口径」：AI 处理数据不一致时的语言习惯

`口径` 一词在 `web/src` 中出现 **28 次**，横跨 5 个文件：

| 文件 | 次数 |
|---|---:|
| TokenStatsPage.tsx | 12 |
| accountPacks.tsx | 4 |
| OverviewPage.tsx | 3 |
| types.ts | 2 |
| format.ts | 1 |

连 CSS 注释都在用它：[global.css:461](../../../web/src/styles/global.css#L461) `/* ---- 提示条：仅用于真实风险与口径提醒 ---- */`

**为什么这是 AI 味**：真实的单人运维工具不会用"口径"做信息架构的第一性分类。这是 AI 面对"多个数字来源不一致"时的典型反应——**把技术债的成因直接写进 UI 分类法**，而不是解决"到底该信哪个数"这个问题。

---

## 四、论文脚注体文案（引用原文）

界面 description / footer / Note 大量写成方法论声明而非 UI 文案：

### 4.1 `TokenStatsPage.tsx:738`（面板 footer）

> 系数单位为「积分 / token」，按未缓存输入 / 输出 / 缓存读三个桶分别计价（**DSH token-meter 分桶口径**）。R²≈1 表示三系数可精确还原账单；R² 偏低说明上游账单本身有抹零噪声（如 Trae 会话级 DeepSeek）。

**问题**：(a) 一整段回归分析方法论塞进面板底部；(b) **内部项目代号 `DSH` 泄漏给终端用户**；(c) 对唯一用户的运营决策零行动价值。

### 4.2 `TokenStatsPage.tsx:786-790`（页面底部 Note，连续三行）

> 口径说明：官方账单积分（Trae 逐会话 / WorkBuddy 逐请求）为上游精确值，是积分主口径；带 * 的估算成本由账单标定系数推算（无标定时回退费率表），仅作对照，**不建议与官方值相加**。Token 三分类中「上游真值」可当计量口径，「补算」与「未计量」只反映覆盖情况。

**问题**：「不建议与官方值相加」——用户本来就不会把两个数加起来。这是**对想象中错误的防御**。

### 4.3 `TokenStatsPage.tsx:4-8`（文件头注释写成设计文档）

> 信息架构按「口径」分组，而不是按数据来源堆面板：- 口径卡片区：官方账单积分（主口径）与 Token / 请求（计量口径）分开呈现，- 流量区：模型 / 账号两张表，估算列集中且明确标注为对照口径。

### 4.4 `accountPacks.tsx:4-11`

> 关键口径（对齐后端 src/credentials/credits.js 与 src/upstream/balance.js）：...「积分」口径（单位 credit，量级 1e3）。ZCode 的额度是 token 计量（量级 1e8）

**在前端源码注释里对齐后端文件路径**——这是写给下一个 AI 看的口径说明，不是给人读的。

### 4.5 同一 caveat 的重复密度

| caveat | 出现位置 | 次数 |
|---|---|---:|
| 「Trae 账单 1~2 天入账滞后」 | TokenStatsPage `:354`、`:453`、`:788` + 代码 `:203` | 4 |
| 「token 历史脱敏导致 0 不可信」 | `:436`、`:355`、`:789`（隐含）、TrafficPage `:80-87` | 4 |
| 「保存可能返回业务层失败」 | OpsPage `:1434`、ModelRouterPage `:306` | 2（近乎逐字） |
| 「不限量包不计入金额」 | OverviewPage `:99`、`:170` | 2 |

**重复不是谨慎，是没人负责去重。** 手作工具会在第二次写下同一句话时意识到"这句该放进 tooltip"。

---

## 五、"AI 觉得应该有"的功能（对照真实需求）

真实操作员每天做的事（按频次）：

1. 看还有多少积分 ✓ **做到了**（Overview 双卡）
2. 账号掉线了，修好 ✓ **做到了**（CredentialsPage）——但"需重新登录"没有行内修复按钮
3. 转发报错，看日志 ✓ **做到了**（TrafficPage）
4. 接入新账号 ✓ **做到了**（三条路径）
5. 偶尔改签到时间 ✓ **做到了**（OpsPage）

**前 5 件都做到了。以下是"网关应该有的"和"AI 觉得该有的"的混合体：**

| 功能 | 为什么可疑 | 证据 |
|---|---|---|
| **抽奖 / 稀有度 / 补登卡 / Buddy 盲盒** | 一个网关 UI 里的游戏元素；后端 15 个写端点 vs UI 3 个按钮；定时器已在跑同一 job | [GrowthPanel.tsx:344-356](../../../web/src/features/accounts/GrowthPanel.tsx#L344-L356)、[cat-trip.js:181-188](../../../src/routes/cat-trip.js#L181-L188) |
| **调度预演** | "如果现在发请求会选谁"——排障时直接看失败日志更轻；这是 AI 想象的"可解释性"功能 | [OpsPage.tsx:484-529](../../../web/src/features/ops/OpsPage.tsx#L484-L529) |
| **积分标定系数表（R²、三系数、5 位小数）** | 对运营决策零意义；它的存在是为了让"估算"看起来科学 | [TokenStatsPage.tsx:730-784](../../../web/src/features/stats/TokenStatsPage.tsx#L730-L784) |
| **密钥 5 个生命周期按钮** | 单机单人，"轮换"（带宽限期的无缝换钥）和"重置"几乎永远不会被点；且前端硬编码 `graceMs:0` 使轮换≈重置 | [AccessKeysPage.tsx:263-277](../../../web/src/features/accounts/AccessKeysPage.tsx#L263-L277)、`:130` |
| **33 个只读配置字段** | 单用户改配置直接编辑 JSON 更快；纯展示面板是"完整性"的产物 | [OpsPage.tsx:1455-1586](../../../web/src/features/ops/OpsPage.tsx#L1455-L1586) |
| **成长中心"一键执行"手动按钮** | 定时器已自动跑同一 job；按钮是第二入口，且自带一套 4 state/4 ref 的轮询状态机 | [GrowthPanel.tsx:123-185](../../../web/src/features/accounts/GrowthPanel.tsx#L123-L185) |
| **"最近操作与保活"独立 6 列表** | 与主表的"最近选用/最近签到"列重复，且硬编码 `rows.slice(0,8)` | [CredentialsPage.tsx:471-502](../../../web/src/features/accounts/CredentialsPage.tsx#L471-L502) |
| **growth.ts 的 4 个零引用导出** | `growthStatus/growthStreak/growthChances/growthDepart` 在任何 tsx 中 0 引用——"先生成后使用"的指纹 | [growth.ts:100-122](../../../web/src/shared/api/growth.ts#L100-L122) |

---

## 六、过度抽象（单调用者抽象）

| 抽象 | 规模 | 真实调用者 |
|---|---|---|
| [lib/store.ts](../../../web/src/lib/store.ts) 自写外部 store | 23 行 | **1 个**（`auth.ts` 存一个 sessionStorage 字符串） |
| `useBalanceAutoRefresh` 的 `intervalMs` 参数 | — | **0 个调用方传值**（投机参数） |
| `useAsyncData.isTransportError` 字段 | — | **0 个消费者**（全库无一处读取；而 ErrorState/Note 文案反复宣讲"区分传输失败与业务失败"） |
| `EmptyState` 组件 | 27 行 | **0 引用**——与此同时空态 div 被手抄 6 次（OverviewPage:179、GrowthPanel:266、ModelRouterPage:242、TrafficPage:177…） |
| `STATE_PILL_CLASS` | — | 仅被 OverviewPage re-export，**无真实消费** |
| `KeyCards` / `KeyCardGroups` / `KeyValue` 三套键值渲染 | — | 前两者只服务 OpsPage |
| `businessFailureReason` | — | 仅 re-export，0 调用（各页面手写 reason 读取） |

**模式**：AI 生成了"完整-looking"的工具层，然后每个页面各自手写了一遍本该用它的代码。**抽象存在，纪律不存在。**

---

## 七、为对称性存在的完整 CRUD

- `AccessKeysPage` 的 5 个行内按钮（查看/轮换/重置/吊销/删除）——单人单机场景下 3 个永不会被点
- `cat-trip.js` 的 15 个 `handle()` 写端点 vs UI 3 个按钮——**API 层比 UI 层完整**的镜像不对称
- 后端 PATCH `/v1/credentials/:id` 白名单支持 `label/priority/tags/group/costTier` 6 项，前端只发 `enabled`——**5/6 的可写能力无 UI**
- 后端 `/v1/admin/notify/events` 三端点（自定义事件增删）+ 前端封装 `getNotifyEvents/saveNotifyEvents`——UI 完全不可达，事件开关实际走另一条路径
- 后端 `POST /v1/admin/scheduler/:action`（手动触发签到/保活/探测）、`GET /v1/admin/audit`、`GET /v1/admin/credentials/export`——**三个真实能力零 UI 入口**

**方向性观察**：AI 先把 API 铺满（对称、完整），再随手做几个按钮；而真实用户的方向相反——先有痛点，再有入口。这解释了为什么这个项目"该有的没有、不该有的一堆"。

---

## 八、值得为作者记录的正面项（经全量扫描验证）

| 检查 | 结果 |
|---|---|
| emoji | **0 处**（Unicode 范围扫描） |
| TODO / FIXME / coming soon / 敬请期待 | **0 处**（唯一命中是测试断言字符串） |
| 占位文案 / Lorem | **0 处** |
| 泛化 loading 文案 | 无（都是具体的"加载模块…""执行中…"） |
| CSS token 层 | **有真实设计判断**：语义字号阶梯（[global.css:128-146](../../../web/src/styles/global.css#L128-L146)）、`:focus-visible` 全局 ring、`prefers-reduced-motion` 降级、`.table-fixed` 布局约束 + `:has()` 横向滚动兜底 |
| 注释质量 | 多数是 why 不是 what（`useAsyncData.ts:36` 解释 ref 固定 fetcher 的原因；`global.css:353-366` 解释 table-layout 约束） |
| 装饰性设计 | 无渐变、无卡片墙滥用、单一强调色 |
| 后端真实性 | 288 断言全绿；所有功能真实接线；`npm audit` 0 漏洞 |

**这说明问题不在"AI 随手生成"，而在"AI 认真生成了没人要的部分"。** 后者更难发现，也更难修。

---

## 九、修复方向（按投入产出排序）

| # | 动作 | 消除的指纹 | 成本 |
|---|---|---|---|
| 1 | 修三处 CSS 幽灵引用（`--rg-bg-primary`→`--rg-bg-base`、`--rg-state-ok`→`--rg-state-success`、给 `.t-label` 定义或删类名） | "生成后没人看过页面" | 10 分钟 |
| 2 | 删 [tailwind.config.ts](../../../web/tailwind.config.ts) 的死 palette 与指向不存在文件的注释（或真正迁移过去） | 化石配置 | 30 分钟 |
| 3 | 全局搜删「DSH」等内部代号；「口径」降频：每页最多保留 1 处必要警告，其余删或进 tooltip | 论文体 + 内部泄漏 | 1 小时 |
| 4 | 同一 caveat 全局去重（"Trae 滞后"只保留 `:354` 一处） | 复读机 | 30 分钟 |
| 5 | 删 GrowthPanel 的抽奖/稀有度/补登卡 UI（保留后台 job + 通知） | 产品定位漂移 | 1 小时 |
| 6 | 删 `EmptyState` 或开始用它（6 处手抄空态改用组件） | 抽象与使用脱节 | 30 分钟 |
| 7 | 删 4 个零引用 growth 导出、`isTransportError`、`STATE_PILL_CLASS`、`businessFailureReason` | 死代码 | 20 分钟 |
| 8 | OpsPage 只读配置 33 字段折叠为一个"查看生效配置"详情块 | 噪音密度 | 1 小时 |
| 9 | 显示版本号 + 写 README + changelog | "没有人的项目"感 | 2 小时 |

**做完 1-4（约 3 小时），AI 感可从 6.5 降到 4.5。做完 1-9（约 1 天），可降到 3.0——达到"看不出来"的阈值。**

---

## 十、一句话总结

> 这个项目最像 AI 的地方，不是它做错了什么，而是它**没有停下来的机制**：每个面板都完整、每个警告都写了、每个端点都实现了、每个边界情况都考虑了——然后没有人（也没有机会）问一句"用户真的需要这个吗"。真实的手作工具缺东西；这个不缺东西，**缺重点**。