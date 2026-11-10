# 凭据池页 UI 审查与重构方案（2026-11-09）

> 审查对象：`web/src/features/accounts/` 下凭据池相关的 6 个文件
> （`CredentialsPage.tsx` 831 行 / `ChannelGrid.tsx` 218 行 / `GrowthPanel.tsx` 464 行 /
> `accountPacks.tsx` 457 行 / `KeepaliveBoard.tsx` 177 行 / `PackDialog.tsx` 64 行）
> 审查依据：后端**实际能力**（`src/routes/{credentials,admin-channels,cat-trip,zcode,qoder,raccoon}.js`、
> `src/upstream/balance.js`、`src/platform/variant.js`）与**线上真实数据**（本机 23 个账号、743 条权益包的快照），
> 不是页面上已有的文案。
> 方法：`ui-design-craft` 的 UX 十项启发式 + 令牌/布局/密度审查。
> 状态：**已实施并验证。** 实施清单见 §7。

---

## 0. 量化基线（先把数摆出来）

以下全部是本次实测，不是估计：

| 指标 | 实测值 | 出处 |
|---|---|---|
| 账号总数 / 启用 / 冷却 | 23 / 23 / 0 | `store.list()` |
| 权益包条目总数 | 743（平均 32.3 条/账号） | 快照聚合 |
| 其中已用尽或已过期 | 171 条（23%） | 同上 |
| `/v1/credentials` 响应体 | **121.2 KB** | 序列化实测 |
| `/v1/credentials/summary` 响应体 | **121.3 KB** | 同一批账号重复下发 |
| 两者每 60 秒合计 | **242.5 KB** | `useBalanceAutoRefresh` + `SummaryProvider` |
| 渠道卡片最高者估算高度 | **≈542px**（WorkBuddy，3 条接入方式、detail 合计 284 字符） | 按真实字符串排版估算 |
| 渠道区占首屏高度 | ≈ 640–700px（含面板头 + summary 行 + 卡网格） | 同上 |
| 内容区可用宽 | 1352px（`max-w-[1400px]` − `p-6`×2） | `AppLayout.tsx:94` |
| 凭据表固定列宽合计 | **1164px**，其中操作列仅 200px | `global.css:511-545` |
| 行内按钮总数 / 每行 | **98 个；3~5 个/行**（3 个的 2 行、4 个的 13 行、5 个的 8 行） | 按能力位 + 平台实测 |
| 「权益包」列显示「—」的账号 | **7 / 23**（ZCode 1 + Qoder 4 + Raccoon 2） | 派生计算 |
| 「权益到期」列显示「—」的账号 | **23 / 23（全部）** | 最近到期 8~22 天，全部落在 7 日窗口外 |
| 权限口径覆盖不到的额度 | Qoder 5,963 + Raccoon 7,787 + ZCode token | 三平台均不写 `packs` |
| 成长中心收起态默认 | `false`，内容渲染在**页面最底部** | `CredentialsPage.tsx:88, 771` |
| 成长中心展开一轮上游请求 | **≈104 次**（overview 40 + status 8 + daily 56） | `cat-trip.js:132-152`、`growth-daily.js:181` |

---

## 1. 结论

三个用户抱怨，对应三种完全不同的病，不能一起「调样式」了事：

| 用户感受 | 真实根因 | 层级 |
|---|---|---|
| 渠道卡片占空间大、文案堆叠 | 四列网格行高被最高卡（542px）通吃；平台自述、能力位标签、探测原因三层文字全部常驻 | **布局 + 文案**，纯前端 |
| 操作按钮排列混乱 | 单一 200px 列塞 3–5 个同权重灰按钮，`flex-wrap` 折成 2 行（行高 40→72px），危险操作与查询操作视觉等权 | **布局 + 视觉层级**，纯前端 |
| 权益包/到期只显示 Trae、WorkBuddy | 不是展示漏了，是**数据通道只有一条**：`packsOf()` 只读 `account.packs`，而 ZCode/Qoder/Raccoon 三个平台后端刻意写了三个隔离键（`tokenBuckets`/`quota`/`raccoonPoints`），前端一处都没读 | **数据建模**，1 行后端 + 1 个前端模块 |
| 成长中心要点底部展开 | 入口是工具栏 toggle，内容渲染在 `KeepaliveBoard` **之后**——点了以后视口内毫无变化，必须手动滚到底；且展开即 4 个并行请求、104 次上游 | **信息架构 + 请求成本** |

**一句判据**：本页现在把「平台能力」和「账号状态」混在同一屏同一权重里展示。平台能力是**低频、稳定**的（5 个渠道，一个月看一次），账号状态是**高频、多变**的（23 行，每 60 秒刷新）。两者放同一视线高度竞争，必然两边都读不清。

---

## 2. 问题清单

分级：**P0** 阻断日常操作 / **P1** 明显降低效率 / **P2** 观感与一致性。

### 2.1 渠道接入区（`ChannelGrid.tsx`）

**P0-1｜网格行高被最高卡通吃，一半卡片有 300px 死白**
`ChannelGrid.tsx:89` 用 `grid-cols-2 xl:grid-cols-4`，同一行卡片等高。实测 WorkBuddy 卡 ≈542px、ZCode 卡 ≈250px、Trae ≈282px —— Trae 与 ZCode 卡下方各有 ≈290px 空白，用户看到的是「四块大卡片里两块是空的」。渠道区因此吃掉 640–700px 首屏高度，**凭据列表（页面主任务）在 1440×900 下首屏不可见**。

**P0-2｜同一块区域三层解释文字常驻**
同一件事被说了三遍：

| 层 | 位置 | 内容 |
|---|---|---|
| 面板说明 | `CredentialsPage.tsx:505` | 「接入方式与可用性由后端探测；本机客户端未安装或未登录时，卡片上会说明原因」（24 字，解释 UI 自身行为） |
| 卡片自述 | `ChannelGrid.tsx:146-150` ← `variant.js:50,126,245,336,451` | 「Trae IDE 账号池；OAuth 登录换票或粘贴本机凭据 JSON」等 5 条，33–38 字符 |
| 逐条探测说明 | `ChannelGrid.tsx:196-203` | WorkBuddy detail 单条就 **109 字符**（`admin-channels.js:98-101`，含 `$wbEncrypted`、`docs/02-technical/...md` 路径） |

第三层最严重：那是**排障文档**，被 `break-all` 全量铺在按钮下方。

**P1-3｜能力位标签是给开发者读的**
`CAPABILITY_TAGS`（`ChannelGrid.tsx:23-36`）7 个标签 × 5 卡 = 最多 35 枚 Chip：「对话转发 / 每日签到 / 成长任务 / 活动领取 / 登录奖励 / **OAuth 登录** / **自动续期**」。后两个是内部机制词；其余 5 个的含义在别处已经有更强的表达（行内按钮、成长中心、权益总览）。用户不会读这排 Chip，它只负责把卡片撑高。

**P1-4｜「不可用」三字每个按钮重复一次**
`ChannelGrid.tsx:190-194` 在 `disabled` 按钮旁再渲染一段「不可用」。禁用态本身已经表达了不可用，重复的是一句零信息量的话。

**P1-5｜「接入」与「运营」两种语义挤在同一列**
`ChannelGrid.tsx:210-214` 的「套餐 / 活动领取」和 onboarding 按钮同列同形态。前者是**已接入账号的运营动作**，后者是**把账号接进来**，用户在同一个竖排里面对两个不同阶段的操作。

**P2-6｜加载文案与空态指向后端**
`ChannelGrid.tsx:56`「正在读取渠道与本机客户端状态」；`:170-174`「后端接口已就绪，可先用 API 接入（见该平台的接入文档）」—— 面向开发者，不是面向用户。

### 2.2 凭据列表（`CredentialsPage.tsx:547-759`）

**P0-7｜操作列 200px 塞 3–5 个按钮，折行导致行高翻倍**
`global.css:543-549` 的 `.col-actions{width:200px}` + `.td-actions{flex-wrap}`。实测：13 行 4 个按钮、8 行 5 个按钮；`btn-sm` 的「查余额」约 56px + `gap-1.5`(6px)，200px 只放得下约 3 个 —— 于是 21 行里有 21 行折成两行，`td py-2.5` 的 40px 行高变成 ≈72px，整表虚高 ≈670px。

**P0-8｜7 个按钮权重相同，危险操作不独立**
只有「删除」是 `variant="danger"`、「重新登录」是 `primary`，其余「签到/领取/查余额/属性/刷新 Token」全部落到 `VARIANT_CLASS.default = ''`（`shared/ui/index.tsx:17-22`），视觉权重完全一致。行内 5 个灰底按钮里，点错「删除」与点错「属性」的代价差三个数量级。

**P0-9｜「权益包」与「权益到期」两列在真实数据下一列半空、一列全空**
- 「权益包」列（`:611-626`）显示可用包数 —— 7 个账号恒为「—」（ZCode/Qoder/Raccoon 无 `packs`）。
- 「权益到期」列（`:627-637`）走 `worstExpiry()`（`accountPacks.tsx:142-149`），**只在 ≤7 天时返回非 null**。实测最近到期是 8~22 天 → **23 行全部显示「—」**。

且该单元格只渲染「3 日内 / 7 日内 / 已到期」三档 Chip，**没有日期也没有天数** —— 用户看不出「什么时候到期」。

**P1-10｜列语义重复，且有一个永恒空列**
9 个数据列里有 4 列在描述同一条时间线：状态、权益到期、账号到期、冷却剩余。
- 「冷却剩余」（`:694-700`）在 23 行全为「—」（cooling=0）却固定占 92px。
- 「启用/停用」按钮（`:576-586`）与「状态」列（`:599-603`）的「停用」是同一事实的两种表达。
- `a.id` 作为第二行**永久全量展示**（`:591-597`），23 行里 id 平均 20+ 字符，只在排查时有用。

**P1-11｜工具栏三组筛选挤成两行**
`toolbar`（`:418-492`）左侧：240px 搜索 + 6 项来源 Segmented（≈400px）+ 4 项状态 Segmented（≈200px）+ 分组 select（200px）≈ 1040px；右侧还有成长中心 toggle + 到期 Chip + 账号数 ≈ 300px。`.toolbar{flex-wrap}` 下必然换成 2 行，第一屏又被吃掉 40px。

**P1-12｜「每 60 秒自动刷新」是实现细节，被提升为一次操作**
`:406-408` 的 Chip 与「刷新」按钮并列在页头 actions。用户看到的是一个不可点的状态 Chip 紧邻一个可点按钮，两者都在「刷新」这件事上。

### 2.3 权益信息只覆盖 2 个平台（核心缺陷）

**P0-13｜`packsOf()` 是唯一入口，四平台里三个进不来**

```
前端唯一读取点：accountPacks.tsx:72  packsOf(account)  →  account.packs
                          ↓
后端唯一写入点：src/routes/credentials.js:42-60  withExpiry()
                packs: entitlementSnapshot.packs
                          ↓
四个平台各自写了什么（实测快照键）：
  Trae      → packs[34]                ✅ 进得来
  WorkBuddy → packs[54~65]             ✅ 进得来
  ZCode     → tokenBuckets + tokenRemaining   （balance.js:243-251 明确「不写 packs」）
  Qoder     → quota{base, addOn}              （balance.js:316）
  Raccoon   → raccoonPoints{available, packages}（raccoon/credits.js:102-110）
```

`web/src/shared/api/types.ts:74-82` **已经声明了** `tokenBuckets` 与 `quota` 两个字段，前端却零引用（全仓 grep 只在类型定义与注释里出现）。这是「后端口径做对了、前端没接线」，不是后端缺失。

**P0-14｜Raccoon 的明细在凭据池页根本拿不到（后端 1 行缺口）**

`withExpiry()` 透出的字段是 `packs / tokenRemaining / tokenBuckets / quota / entitlementSnapshotUpdatedAt`，**没有 `raccoonPoints`**。所以 Raccoon 只显示了 `balance`（总额 2,124 / 5,663），分池明细（奖励 1,524 / 每日 600）在 `/v1/raccoon/accounts` 里才有。修法见 §4.4。

**P0-15｜ZCode 快照里残留一条计量单位错误的 `packs`**

实测 ZCode 账号的快照同时含：
```json
{"packs":[{"name":"GLM-5.3-Flash","limit":100000000,"used":100000000,
           "remaining":0,"meter":"model_usage",...}],
 "tokenBuckets":[], "tokenRemaining":0}
```
这正是 `src/test/unit.test.js:4435-4483` 明令禁止的状态（「zcode 不得写积分口径 packs」）。只要任何人改 `packsOf()` 去读 `packs`，这 1 亿 token 就会立刻被当成积分总额。**归一模块必须对 ZCode 显式忽略 `packs`**，并加一条断言。

**P1-16｜额度汇总只覆盖两个平台，界面上没有任何说明**

`creditTotals()`（`accountPacks.tsx:187-220`）→ 总览页「可用额度 46,347」。这个数只含 Trae 12,974 + WorkBuddy 33,373；Qoder 5,963、Raccoon 7,787、ZCode token 全部不在内。口径隔离本身是**正确的**（`types.ts:73` 注释写得很清楚），但 UI 没有任何地方告诉用户「这个总额只覆盖 2 个平台」。用户看到 4 个平台有余额、总额却对不上，会认为面板算错了。

**P1-17｜快照陈旧完全不可见**

后端已透出 `entitlementSnapshotUpdatedAt`（`credentials.js:58`），前端零引用。实测 Raccoon 一个账号的快照停在 **2026-10-20**（20 天前），其余是当天 —— 页面上两者长得一模一样。

### 2.4 成长中心（`GrowthPanel.tsx` + `CredentialsPage.tsx:88,473,771`）

**P0-18｜入口在顶部、内容在底部，点击后视口内零变化**
`growthOpen` 默认 `false`（`:88`）；toggle 在工具栏（`:473-475`）；内容渲染在 `<Stack>` 的**最后一层**（`:771`，位于 `KeepaliveBoard` 之后）。用户点「成长中心」→ 按钮文案变成「收起成长中心」→ 屏幕内容一个像素都没动。必须手动滚到页面底部才知道展开了什么。这就是「需点击底部展开导致查看繁琐」的机械原因。

**P1-19｜四张表把同一批账号列了四遍**
`GrowthPanel.tsx:145`（成长任务运行）、`:206`（成长每日汇总，7 列）、`:363`（旅行状态，6 列）、`:411`（成长概览，6 列）。账号名列出现 4 次，同一账号的「连登」在 `:233` 与 `:425` 出现两次、「旅行状态」在 `:341-354` 与 `:386-405` 出现两次。`daily-progress` 的返回体（`growth.ts:93-132`）**本来就同时包含** growth/rewards/cat/checkin/active，四张表读的是同一份数据的四个切片。

**P1-20｜展开一次 = 104 次上游请求，收起前零信息**
4 个 `useAsyncData` 并行（`GrowthPanel.tsx:50-64`）。后端按账号并发 2、间隔 300ms（`cat-trip.js:132-152`）。8 个 WorkBuddy 账号实测 ≈104 次上游（overview 5×8 + status 1×8 + daily 7×8，后者见 `growth-daily.js:181` 的七路 `Promise.all`）。只有 `daily-progress` 有 60s TTL 缓存（`growth.ts:134-140`），`statusAll`/`overview` 每次挂载与每次点「刷新」都真打上游。

**P2-21｜任务明细塞进 `title`，等于不可发现**
`:262-271` 与 `:289-299` 把 taskCode 明细拼成多行字符串塞进 `title`。hover 才会出现、无法选中、移动端不存在。

**P2-22｜其余四个平台在这块区域完全空白**
成长只有 WorkBuddy 有（`variant.js:141` `growth:true`）。其余平台没有占位说明，用户切到 Trae 筛选后看这块会以为坏了。

### 2.5 跨页文案与实现不一致（P1）

**P1-23｜`KeepaliveBoard` 尾注与实现矛盾，且写死平台名**
`KeepaliveBoard.tsx:170-174`：「未纳入扫描的平台（**WorkBuddy** / Qoder / ZCode）的空记录不代表故障」。
但 `isKeepaliveScanned`（`:22-25`）= `tokenRefresh || oauthLogin`，而 `variant.js:160` 里 WorkBuddy `tokenRefresh: true` → **它是被扫描的**。实测 8 个 WorkBuddy 账号都有 `lastKeepaliveAt`（2026-11-07）。文案与实现相反，且三个平台名是硬编码的，新增平台即漂移。

**P2-24｜重复的尾注**
`GrowthPanel.tsx:459-461` 与同文件 `:146` 的 `description` 说同一件事。

---

## 3. 改进方向

### 3.1 一条主线

> **把「平台能力」压成一条横向 rail，把「账号状态」还给表格，把「权益」独立成可跨平台对照的一块。**

三块的信息频率不同，就不该共享同一视觉权重：

| 区块 | 变化频率 | 目标高度 | 默认状态 |
|---|---|---|---|
| 平台接入 rail | 月级（装/没装客户端） | **56px**（现 ≈640px） | 常驻，单行 |
| 凭据表 | 60 秒 | 视行数 | 常驻，主体 |
| 权益总览 | 60 秒 | ≈5×44px | 常驻，按平台一行 |
| 成长中心 | 4 小时 | **44px**（现 0 或 +1800px） | 收起为摘要行 |

首屏目标：**渠道 rail + 工具条 + 表格前 12 行**全部可见（1440×900）。

### 3.2 目标页面结构

```
凭据池                                          [导入/导出] [全部签到] [刷新]
────────────────────────────────────────────────────────────────────────────
23 账号 · 23 启用 · 0 冷却 │ 积分口径 46,347 │ 7 日内到期 32 │ 待处理 0
────────────────────────────────────────────────────────────────────────────
平台接入  Trae 8/8 [+接入 ⋯] │ WorkBuddy 8/8 [+接入 ⋯] │ ZCode 1/1 [...]
          Qoder 4/4 [...]   │ Raccoon 2/2 [...]                        ← 单行 56px
────────────────────────────────────────────────────────────────────────────
[搜索 200px] [平台▾] [全部│可用│冷却中│停用] [分组▾]            共 23 个
┌──────────────────────────────────────────────────────────────────────────┐
│ 启用 │ 账号      │ 平台      │ 状态 │ 权益            │ 额度   │ 有效期 │ 操作      │
│ ─── │ 19075795328│ Trae      │ 可用 │ 12 包 · 21 天后  │ 1,547 │ 11-19  │[签到][查余额]⋯│
│ ─── │ WorkBuddy… │ WorkBuddy │ 可用 │ 59 包 · 8 天后   │ 4,260 │ 12-08  │[签到][查余额]⋯│
│ ─── │ zcode-local│ ZCode     │ 可用 │ 未查询           │ 0 Token│ 长期  │[领取][查额度]⋯│
│ ─── │ nick3859…  │ Qoder     │ 可用 │ 赠送 1,621 · 长期│ 1,621 │ 11-16  │[领取][查额度]⋯│
│ ─── │ Raccoon…   │ Raccoon   │ 可用 │ 奖励 1,524 · 日清│ 2,124 │ 11-17  │[奖励][查余额]⋯│
└──────────────────────────────────────────────────────────────────────────┘
────────────────────────────────────────────────────────────────────────────
权益总览                                            按平台一行，可展开明细
Trae      ｜积分   12,974 ｜16 包 · 最近 21 天 ｜7 日内 0 ｜快照 10:22
WorkBuddy ｜积分   33,373 ｜475 包 · 最近 8 天 ｜7 日内 0 ｜快照 10:08
ZCode     ｜Token       0 ｜0 桶 · 未查询到额度          ｜快照 11-07 12:08
Qoder     ｜配额    5,963 ｜基础 0 + 赠送 5,963（4 号）  ｜快照 10:13
Raccoon   ｜积分    7,787 ｜奖励 5,987 + 每日 1,800      ｜快照 10-20 ⚠ 20 天未更新
────────────────────────────────────────────────────────────────────────────
成长中心 · WorkBuddy  可参与 8 · 今日活跃 6/8 · 最长连登 12 天 · 上次运行 10:00
                                                          [立即执行] [展开▾]  ← 44px
────────────────────────────────────────────────────────────────────────────
最近操作与保活（保留，按池分组）
```

### 3.3 平台接入 rail 规格

**结构**（5 段 `grid-cols-5`，间隙 1px 用 `--rg-border` 做分隔线，视觉上是一条连续的条，不是 5 张卡）：

```tsx
<div className="rail" role="list">
  {channels.map(c => (
    <div className="rail-item" role="listitem" data-state={c.accounts.total ? 'on' : 'off'}>
      <span className="rail-name">{c.label}</span>
      <span className="rail-meta">{total} 账号 · {enabled} 启用</span>
      <div className="rail-acts">
        <Button size="sm" variant="primary" onClick={primaryWizard}>接入</Button>
        <MenuButton label={`${c.label} 更多接入方式`} items={moreItems} />
      </div>
    </div>
  ))}
</div>
```

**尺寸与令牌**（全部复用既有令牌，不新增色值）：

| 属性 | 值 | 依据 |
|---|---|---|
| rail 高度 | 56px（`py-2` + 18px 标题 + 16px meta + 1px 分隔） | 与 `.panel-head` 的 44px 同级 |
| 每段内边距 | `px-3.5 py-2` | 与 `.subcard` 一致 |
| 平台名 | `text-[13px] font-semibold`，`--rg-text-primary` | 与 `.panel-title` 同档 |
| meta 行 | `text-aux`(12px)，`--rg-text-tertiary` | |
| 主按钮 | `.btn-sm`（26px），单段最多 1 个 | 只有一个「最高频接入方式」 |
| 溢出菜单 | 26×26 图标按钮，`⋯` | 收纳其余 onboarding + 运营面 |
| 已接入标识 | 不再用 Chip，用 meta 行数字 + 段左侧 2px 竖条（`--rg-state-success` / `--rg-text-disabled`） | 去掉 5 枚 Chip |

**主按钮的选择规则（不写死平台名，按后端 `onboarding` 数组顺序取第一条 `available===true` 的）**：
- Trae → `oauth`（OAuth 登录）
- WorkBuddy → `paste`（粘贴凭据导入）← **注意**：`local` 实测不可用（客户端已加密），按 `available` 过滤后 `paste` 自然胜出，不需要在前端写特例
- ZCode → `local`（读取本机客户端）
- Qoder → `local`（读取本机客户端）
- Raccoon → `login`（扫码登录）

**⋯ 菜单内容**：
1. 其余 onboarding（含 `available:false` 的，置灰 + 一行原因，全文进 `title`）
2. 分隔线
3. 运营面（仅 `capability.rewardClaim === true`）：「套餐 / 活动领取」
4. 「重新探测本机客户端」（原 `ChannelGrid.tsx:83-85` 的按钮，从常驻降级）

**文案处置表**：

| 原位置 | 原文 | 处置 |
|---|---|---|
| `CredentialsPage.tsx:505` 面板 description | 「接入方式与可用性由后端探测；本机客户端未安装或未登录时，卡片上会说明原因」 | **删**（解释 UI 行为，零信息） |
| `ChannelGrid.tsx:146-150` 卡片 note | 平台自述 5 条 | **删**（与平台名重复，能力已在表格与权益块表达） |
| `ChannelGrid.tsx:160-166` 能力 Chip | 7 类 | **删**（内部机制词；行内按钮已是更强的表达） |
| `ChannelGrid.tsx:190-194` | 「不可用」 | **删**（禁用态已表达） |
| `ChannelGrid.tsx:196-203` detail | 常驻、`break-all` 全量 | **降级**：可用时 1 行截断；不可用时在 ⋯ 菜单内给 1 行「动作 + 原因」+ 全文 `title` |
| `admin-channels.js:98-101` WorkBuddy 加密说明（109 字符） | 含 `$wbEncrypted`、docs 路径 | 界面文案压成「客户端凭据已加密，请改用「粘贴凭据导入」」；完整说明保留在后端 `detail`，进 `title` |
| `ChannelGrid.tsx:56` | 「正在读取渠道与本机客户端状态」 | → 「读取平台信息」 |
| `ChannelGrid.tsx:170-174` | 「后端接口已就绪，可先用 API 接入…」 | → 「暂无接入入口」+ `title` 给 API 路径 |
| `CredentialsPage.tsx:406-408` Chip | 「每 60 秒自动刷新」 | **移到**表格面板 `footer`：「余额每 60 秒自动刷新一次，仅在页面可见时执行」 |

### 3.4 凭据表规格

**列定义（9 列，`table-fixed`；账号列不定宽，吃剩余空间）**

| # | 列 | 宽 | 内容 | 变更 |
|---|---|---|---|---|
| 1 | 启用 | 56 | 开关式按钮（`启用` / `停用`），`aria-pressed` | 缩 64→56 |
| 2 | 账号 | `auto`（剩余） | 主行：label（`13px`，`truncate`，`title` 全量）；次行：**分组 · 成本档 · 标签** 中非空的前两项（`12px` tertiary）。`id` 移入 ⋯ 菜单与 `title` | 换掉常驻 id |
| 3 | 平台 | 88 | 平台名 | 104→88 |
| 4 | 状态 | 88 | Chip（可用/冷却中/停用）+ `errorCount>0` 时补「错误 N」 | 96→88，补 errorCount |
| 5 | 权益 | **168** | 跨平台统一：`{量} · {到期}`。例：`12 包 · 21 天后` / `59 包 · 8 天后` / `未查询` / `赠送 1,621 · 长期` / `奖励 1,524 · 日清` | **替换「权益包」+「权益到期」两列** |
| 6 | 额度 | 108 | 主读数 + 单位（`.cell-num`）。`1,547` / `0 Token` / `1,621 积分` / `2,124` | 116→108，单位进 `.text-unit` |
| 7 | 有效期 | 112 | 账号 Token 到期：`11-19`（`--rg-text-secondary`）+ 天数（warn/danger 变色）；无到期显示「长期」 | 124→112，**不折行** |
| 8 | 冷却 | 72 | 仅冷却中显示剩余；否则空（不渲染 `—`） | 92→72，**允许空** |
| 9 | 操作 | **248** | 2 个主按钮 + `⋯`，`flex-wrap: nowrap` | 200→248 |

合计固定 848 + 账号列自适应（1352 − 848 ≈ 504px）→ 1280 视口也不横向滚动。

**「权益」列的跨平台渲染规则（这是「支持多平台」的落点）**：

| 平台 | 来源字段 | 量 | 到期口径 |
|---|---|---|---|
| Trae / WorkBuddy | `account.packs`（经 `packsOf`） | 可用包数 | 可用包的最近 `expireTime` → `N 天后` |
| ZCode | `account.tokenBuckets` → 空则 `tokenRemaining` | `N 桶` 或 `未查询` | 桶最近 `expireTime`；无则「长期」 |
| Qoder | `account.quota` | `基础 {base.remaining}` / `赠送 {addOn.remaining}`（取非零那段） | `base.expiresAt` / `addOn.expiresAt`；均为 null → 「长期」 |
| Raccoon | `raccoonPoints`（**需后端补 1 行**，见 §4.4） | `{packages[0].label} {remaining}` | 无到期字段 → 「日清」（`raccoon/credits.js:23` 已说明每日积分次日整额清零） |

**到期着色的阈值（与后端 `summarizeExpiry` 对齐，不再自造）**：
- `days <= 0` → `--rg-state-error`，文案「已到期」
- `1..3` → `--rg-state-error`，`N 天后`
- `4..7` → `--rg-state-warning`，`N 天后`
- `>7` → `--rg-text-secondary`，`N 天后`
- `null` → `--rg-text-tertiary`，`长期` / `未查询`

**操作列：主次分层**

主按钮（最多 2 个，按能力位 + 平台推导，**不写死平台名**）：

| 平台 | 主按钮 1 | 主按钮 2 |
|---|---|---|
| Trae | 签到（`capability.checkin`） | 查余额 |
| WorkBuddy | 签到 | 查余额 |
| ZCode | 领取（`capability.rewardClaim`） | 查额度 |
| Qoder | 领取 | 查额度 |
| Raccoon | 登录奖励（`capability.loginReward`） | 查余额 |

`⋯` 菜单（统一顺序，危险项置底独立分组）：

```
查看权益明细
查看 / 编辑调度属性
复制账号 ID
─── 分隔 ───
重置设备标识        （capability.deviceFingerprint === true）
刷新 Token         （capability.tokenRefresh === true 且非 Trae）
重新登录            （keepaliveOf(a).tone === 'danger'，红色文字）
导出该账号          （transferExport，accountIds=[a.id]）
─── 分隔 ───
删除                （红色文字，二次确认）
```

**改动要点**：
- `.col-actions` 200 → 248，`.td-actions` 从 `flex-wrap` 改为 `flex-wrap: nowrap` —— 折行是行高翻倍的唯一起因，`nowrap` 后单行稳定 40px。
- `.btn` 新增 `variant="ghost"` 在表格内的复用：`⋯` 按钮用 `btn-ghost`（透明底、无边框），与两个实心主按钮形成层级。
- 删除按钮移出常驻区 → 危险操作从「每屏可见 23 次」降为「菜单内按需」。
- `errorCount`（`types.ts:50`，后端一直在返回）进「状态」列，非 0 才显示。

**工具栏调整**：

| 控件 | 变更 |
|---|---|
| 搜索 | 240 → 200px |
| 来源筛选 | 6 项 Segmented → **原生 `<select>`**，选项带计数（`全部来源 23` / `Trae 8` / …）。6 项 Segmented 独占 400px 是换行的主因 |
| 状态筛选 | 保留 Segmented 4 项 |
| 分组筛选 | 保留 `<select>`，仅在 `groupOptions.length > 1` 时出现（现状已如此） |
| 右侧 | 只留「共 N 个账号」；到期 Chip 上移到页头统计条 |

### 3.5 权益总览（新块，解决「多平台展示」）

**按平台一行，`grid-cols-[88px_60px_1fr_auto_auto]`，行高 44px，hover 高亮，点击展开明细行。**

```
Trae      ｜积分   ｜12,974 ｜16 包 · 最近 21 天 · 7 日内 0 ｜快照 10:22
WorkBuddy ｜积分   ｜33,373 ｜475 包 · 最近 8 天 · 7 日内 0 ｜快照 10:08
ZCode     ｜Token  ｜0      ｜未查询到额度                  ｜快照 11-07 12:08
Qoder     ｜配额   ｜5,963  ｜基础 0 + 赠送 5,963 · 4 个账号 ｜快照 10:13
Raccoon   ｜积分   ｜7,787  ｜奖励 5,987 + 每日 1,800       ｜快照 10-20 ⚠
```

**必须显示的口径声明**（面板 `footer`，一行，12px）：

> 积分口径合计 46,347，仅覆盖 Trae 与 WorkBuddy。ZCode 按 Token、Qoder 按配额、Raccoon 按积分分池计量，四类口径不可相加，故分列展示。

这一句是对 P1-16 的正面回答：**不把不可加的东西加起来，但要说清楚为什么没加。**

**快照陈旧标识**：`snapshotAt` 距今 > 24 小时 → 时间后加 `⚠` 并用 `--rg-state-warning`，`title` 写「该平台快照 N 天前更新，点「查余额」刷新」。这修掉 P1-17。

**展开明细**：展开后按平台渲染对应表格：
- 积分口径 → 复用现有 `PackTable`（`accountPacks.tsx:382-457`），但按平台汇总所有账号的包（列：账号 / 包名 / 剩余 / 到期 / 状态）
- Token 口径 → 桶表（桶名 / remaining / limit / 到期）
- 配额口径 → 两段表（基础 / 赠送 / 总量 / 已用 / 到期）
- Raccoon → 分池表（池名 / 剩余）

### 3.6 成长中心改造

**收起态（默认）—— 高度 44px，零上游请求**

```
成长中心 · WorkBuddy   可参与 8 · 今日活跃 6/8 · 最长连登 12 天 · 上次运行 10:00
                                                    [立即执行一轮] [展开 ▾]
```

数据来源只有两个，都是**不发上游请求**的：
- `growthLastRun()` → `readLastRun()`，纯文件读（`cat-trip.js:155-158`）
- WorkBuddy 账号数：从已在手的 `list.data` 派生

今日活跃 / 连登在收起态**不显示**（需要上游数据，收起态不发请求）——这一条要在方案里明确，不能为了好看在收起态偷偷打 104 次上游。

**展开态 —— 单表 8 列，替换现有 4 张表**

| 列 | 内容 | 来源 |
|---|---|---|
| 账号 | label | `daily-progress` |
| 成长进度 | `ProgressBar(ratio)` + `completed/total` | `growth` |
| 奖励 | `claimed/total`，`pending>0` 时补「待领 N」 | `rewards` |
| 今日签到 | Chip 已签/未签/未取到 | `checkin` |
| 今日活跃 | Chip「活跃 N 分」/「0 分」/「未取到」 | `active` |
| 连登 | 天数 | `active.streakDays` |
| Buddy / 旅行 | Chip（旅行中 / 待领奖 / 空闲 / 未解锁）+ Buddy 名 | `cat` + `overview` |
| 需手动 | `manualTasks.length` 项（`title` 列出） | `manualTasks` |

旅行状态表（原 `:363-409`）与成长概览表（原 `:411-457`）**合并进「Buddy / 旅行」列的展开行**（点击行展开 `<tr>` 显示位置/出发/到达/奖励额度/能量/补登卡/抽奖机会），不再单独成表。

**请求成本（改造后）**：

| 状态 | 请求 | 上游次数 |
|---|---|---|
| 收起（进页面） | `last-run` | **0** |
| 展开 | `daily-progress`（60s TTL，首次 7×8=56）+ `overview`（5×8=40）+ `status-all`（1×8=8） | 104（首次）/ 48（TTL 命中期） |
| 点「立即执行一轮」 | `auto` + 2s 轮询 `progress` | 同上 |

相比现状（进页面点开即 104），**收起态省 104 次**，且默认状态就是收起。

**「刷新」按钮的语义分级**（与 `ui-style-copy-review-2026-11-07.md:161` 的既定规范一致，现状 `GrowthPanel.tsx:153` 违反了它）：

| 按钮 | 行为 |
|---|---|
| 刷新 | 重读本地（`last-run`）|
| 强制刷新 | `daily-progress({force:true})`，跳过 TTL 真打上游，按钮上标注「会重新查询上游」 |
| 立即执行一轮 | `auto` + 轮询（现状已有） |

### 3.7 其余五个平台的占位

成长中心面板在筛选不命中 WorkBuddy 时，显示一行说明而非空白：

> 当前筛选没有 WorkBuddy 账号。成长任务（旅行 / 领奖 / 连登 / 抽奖）仅 WorkBuddy 提供，其余四个平台没有这项能力。

---

## 4. 落地清单

### 4.1 前端文件变更

| 文件 | 动作 | 说明 |
|---|---|---|
| `web/src/shared/lib/entitlement.ts` | **新增** | 四平台权益归一：`platformEntitlement(account): PlatformEntitlement`、`entitlementRows(accounts)`。**唯一**读 `packs/tokenBuckets/quota/raccoonPoints` 的地方 |
| `web/src/shared/ui/Menu.tsx` | **新增** | `MenuButton`：`aria-haspopup="menu"` + 方向键/Home/End/Esc + 点击外部关闭 + 焦点归还 |
| `web/src/features/accounts/ChannelRail.tsx` | **新增**（替换 `ChannelGrid.tsx`） | 单行 rail + ⋯ 菜单；`ChannelGrid.tsx` 删除 |
| `web/src/features/accounts/EntitlementOverview.tsx` | **新增** | 权益总览 + 按平台展开明细 |
| `web/src/features/accounts/GrowthPanel.tsx` | **重写** | 收起摘要行 + 单表；删 4 张表 |
| `web/src/features/accounts/CredentialsPage.tsx` | 改 | 页头统计条、工具栏、9 列表格、操作列、成长中心上移 |
| `web/src/features/accounts/accountPacks.tsx` | 改 | 保留 `packsOf/expirySummary/creditTotals/keepaliveOf`；`ExpiryChip` 改为 `ExpiryText`（输出「N 天后」文本 + 颜色，不再只有三档 Chip） |
| `web/src/features/accounts/KeepaliveBoard.tsx` | 改 | 删尾注里写死的三个平台名，改由 `channelById` 派生；修 P1-23 |
| `web/src/shared/api/credentials.ts` | 改 | 补 `resetAccountDevice(id, key)` → `POST /v1/credentials/:id/device/reset`（后端 `credentials.js:359` 已有，前端零接线） |
| `web/src/shared/api/types.ts` | 改 | 补 `raccoonPoints?: { available, packages, updatedAt }` |
| `web/src/styles/global.css` | 改 | `.col-*` 宽度表（§3.4）、`.rail`/`.rail-item`、`.td-actions{flex-wrap:nowrap}` |

### 4.2 后端变更（只有 1 行是必须的）

**必须**：`src/routes/credentials.js:56` 之后加一行，让 Raccoon 分池明细能到凭据池页：

```js
    quota: snap.quota && typeof snap.quota === 'object' ? snap.quota : undefined,
+   // Raccoon 的分池明细（奖励/每日/充值）与 `balance` 总额是两回事：
+   // balance 只给总数，分池在隔离键 raccoonPoints 里，不补这行前端只能显示一个总数。
+   // 与其他三个隔离键同原则：原样透出，不并入 packs/credits 汇总。
+   raccoonPoints: snap.raccoonPoints && typeof snap.raccoonPoints === 'object'
+     ? snap.raccoonPoints : undefined,
    entitlementSnapshotUpdatedAt: snap.updatedAt ? snap.updatedAt : null,
```

**可选（性能，非必须）**：`/v1/credentials` 与 `/v1/credentials/summary` 每 60 秒各下发 121 KB 的同一批账号（含 743 条权益包）。若要做，最小改动是给 `GET /v1/credentials` 加 `?slim=1`：去掉 `packs` 明细与 `devices`，只留聚合值。凭据池页的表格用不到包明细（只有展开权益时才需要），`SummaryProvider` 也不需要。**预计 121 KB → ≈18 KB，两处合计省 200 KB/分钟。** 这一项建议放到第二批，先做 UI。

### 4.3 ZCode `packs` 残留的防御

`entitlement.ts` 里对 ZCode 显式忽略 `packs`，并加一条注释指向 `src/test/unit.test.js:4435`：

```ts
case 'zcode':
  // 只用 tokenBuckets / tokenRemaining。快照里可能存在历史遗留的 packs
  // （实测有一条 meter:'model_usage'、limit:1e8 的桶），它是 token 计量，
  // 一旦被当积分读入会把总额抬高 4 个数量级 —— 见 src/test/unit.test.js:4435。
  return tokenEntitlement(account);
```

同时建议在 `channels.test.js` 补一条：`/v1/credentials` 的 ZCode 行，`platformEntitlement` 派生的主读数必须来自 `tokenBuckets`。

### 4.4 无障碍与交互细节

| 项 | 规格 |
|---|---|
| `⋯` 菜单 | `role="menu"`；`↑↓` 移动、`Home/End` 首尾、`Esc` 关闭并归还焦点到触发按钮、`Tab` 关闭 |
| 「启用/停用」 | 改为 `aria-pressed` 的开关，不再是每次改文案的按钮 |
| 「权益」列可点 | `aria-haspopup="dialog"`，打开该账号的权益明细弹窗（复用 `PackDialog`，扩展为 `EntitlementDialog` 支持四平台） |
| 折叠行 | `aria-expanded` + `aria-controls` |
| 表格 0 行 | 保留现有两个空态（无账号 / 筛选无命中），文案不动（`ui-style-copy-review` 已校过） |
| 危险操作 | 删除：`okText:'删除'`，`message` 保留「删除后该凭据不再参与调度，此操作不可撤销」 |
| 长文本 | 一律 `truncate` + `title`，不再 `break-all` 常驻铺开 |
| 单位 | `积分` / `Token` / `配额` 全部走 `.text-unit`（11px），与 2026-11-07 的术语统一规范一致 |

### 4.5 实施顺序（建议分 3 个批次）

| 批次 | 内容 | 可独立验证 |
|---|---|---|
| **B1** 布局与密度 | rail 替换 ChannelGrid、9 列表格、操作列主次分层、工具栏、页头统计条、文案精简 | `tsc --noEmit` + `check-css-tokens` + `eslint` + 目测 1440/1280 两档 |
| **B2** 多平台权益 | `entitlement.ts` + 权益总览 + 权益列/额度列跨平台 + 后端 1 行（`raccoonPoints`） | `npm test`（含 `channels.test.js`）+ 实测 5 平台各一行 |
| **B3** 成长中心 | 收起摘要行 + 单表 + 请求分级 | 收起态 Network 面板确认 0 次 `/growth/*` 上游调用 |

B1 与 B2 可以并行；B3 依赖 B1 的页面结构。

---

## 5. 验证清单

- [ ] `cd web && npx tsc --noEmit` → 0 错误
- [ ] `cd web && node scripts/check-css-tokens.mjs` → 0 未定义令牌
- [ ] `cd web && npx eslint .` → 0 问题
- [ ] `npm test` → 全绿（重点：`channels.test.js` 的前后端注册表一致性 + 向导落点）
- [ ] `npm run build:web` → 成功
- [ ] 1440×900：首屏可见「rail + 工具条 + 表格 ≥12 行」
- [ ] 1280×800：表格不横向滚动（列宽合计 ≤ 1232）
- [ ] 5 个平台各有一行，权益列与额度列都显示本平台口径
- [ ] ZCode 行的额度显示为 `0 Token`，**不**显示 1 亿
- [ ] Raccoon 行显示分池（奖励 / 每日），且快照陈旧账号带 ⚠
- [ ] 收起态打开凭据池：Network 面板无 `/v1/workbuddy/growth/*` 上游请求
- [ ] 键盘：`Tab` 到 `⋯` → `Enter` 打开 → `↓` 移动 → `Esc` 关闭焦点回到 `⋯`
- [ ] 危险操作只出现在菜单与确认框内，表格常驻区无删除按钮

---

## 6. 决策点与最终选择

用户确认：「全部按照最优推荐实施，6 个决策点按照首页展示最小化、跳转详情的逻辑。」

| # | 决策点 | 采用方案 | 与「首页最小化、跳转详情」的对应 |
|---|---|---|---|
| 1 | 渠道接入 | **A. 压成一条 rail**（每段：平台名 + 账号数 + 一个主按钮 + ⋯） | 探测全文、能力清单、定时任务快照 → `ChannelDetailDialog` |
| 2 | 权益总览位置 | **A. 独立面板，表格下方** | 列表只出摘要；单账号明细 → `EntitlementDialog`（按需拉完整 packs） |
| 3 | 成长中心 | **A. 本页折叠行**，默认收起 | 收起态只读 last-run 文件（零上游请求）；展开才拉 |
| 4 | 批量选择 | 不做 | 单行 2 个主按钮 + ⋯ 已覆盖高频操作 |
| 5 | Raccoon 后端 1 行 | 接受，并顺手把 §4.2 的 `?slim=1` 一起做了 | — |
| 6 | `/v1/credentials` 瘦身 | **本次就做**（原计划第二批） | 列表 129.2 KB → 24.5 KB |

「跳转详情」在三处落地成这三种形态，各自的数据来源不同：

```
渠道 rail  ──⋯──▶ ChannelDetailDialog      纯前端已有数据，0 请求
权益列     ──点──▶ EntitlementDialog       GET /v1/credentials/:id（单个账号 4.7~10.1 KB）
成长摘要   ──展开─▶ 单表 8 列             POST /growth/daily-progress|overview|status-all
```

---

## 7. 实施结果（2026-11-09）

### 7.1 量化对照

| 指标 | 改造前 | 改造后 | 验证方式 |
|---|---|---|---|
| 渠道区首屏占高 | ≈640–700px（卡片墙，最高卡 542px 通吃行高） | **≈100px**（44px 面板头 + 56px rail） | 结构推算 |
| 权益列有效行数 | 7 / 23（ZCode 1 + Qoder 4 + Raccoon 2 恒为「—」） | **23 / 23** | 真实数据跑 `entitlementOf` |
| 权益到期列有效行数 | 0 / 23（`worstExpiry` 只在 ≤7 天返回，实际 8–22 天） | **23 / 23**（并入权益列） | 同上 |
| `/v1/credentials` 体积 | 129.2 KB | **24.5 KB**（−81.1%） | 实测序列化 |
| 两端点每 60 秒合计 | 258.3 KB | **48.9 KB** | 同上 |
| 行内按钮 | 98 个，3–5 个/行，`flex-wrap` 导致 21/21 行折成两行 | 常驻 2 个 + ⋯；`nowrap` 后行高稳定 | 结构 |
| 操作列宽 | 200px | 248px（`nowrap`） | `global.css` |
| 成长中心收起态上游请求 | 0（因为默认不渲染，但一旦展开即 104） | **0**（收起态只读 `last-run` 文件） | 结构 |
| 成长中心表数量 | 4 张（账号名列重复 4 次） | **1 张 8 列** + 行内展开 | 结构 |
| 快照陈旧可见性 | 无（`entitlementSnapshotUpdatedAt` 后端透出、前端零引用） | 带 ⚠ 与「快照过期」Chip | 实测 1 个 Raccoon 账号快照停在 10-20 |
| ZCode token 混入积分 | 风险存在：快照残留 `packs`（limit 1e8），任何读 `packs` 的实现都会算错 | **双层排除**（后端 `isCreditCaliber` + 前端 `packCaliber`） | `entitlement-view.test.js` 2 条断言 |
| 浮点尾巴 | `12974.150000000001`（跨账号累加） | `12974.15`（`round2` 收口） | 实测 |

### 7.2 新增 / 删除的文件

**新增（前端）**

| 文件 | 行数 | 职责 |
|---|---|---|
| `web/src/shared/lib/entitlement.ts` | 491 | 四平台权益归一 + 按平台汇总。**唯一**读 `packDigest/packs/tokenBuckets/quota/raccoonPoints` 的地方 |
| `web/src/shared/ui/Menu.tsx` | 214 | 无障碍下拉菜单（`role=menu` + ↑↓/Home/End/Esc/Tab + 焦点归还） |
| `web/src/features/accounts/ChannelRail.tsx` | 210 | 56px 横向 rail；主按钮按 `onboarding` 顺序取第一条 `available` 的 |
| `web/src/features/accounts/ChannelDetailDialog.tsx` | 169 | 平台接入详情（探测全文 / 能力清单 / 任务快照），0 请求 |
| `web/src/features/accounts/EntitlementOverview.tsx` | 358 | 按平台一行 + 行内展开的账号明细（按口径渲染四套表） |
| `web/src/features/accounts/EntitlementDialog.tsx` | 413 | 单账号权益详情，按需拉 `GET /v1/credentials/:id` |

**新增（后端）**

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/credentials/entitlement-view.js` | 218 | 摘要投影 `digestOf / rollupOf / slimAccount` + 积分口径白名单 `CREDIT_PACK_PLATFORMS` |
| `src/test/entitlement-view.test.js` | 330 | 21 条契约断言（后端端点，见 §7.4） |
| `src/test/frontend-entitlement.test.js` | 300 | 23 条契约断言（前端归一逻辑，见 §7.4） |

**删除**

| 文件 | 原因 |
|---|---|
| `web/src/features/accounts/ChannelGrid.tsx` | 由 `ChannelRail` + `ChannelDetailDialog` 替代 |
| `web/src/features/accounts/PackDialog.tsx` | 由 `EntitlementDialog` 替代（后者支持四平台） |
| `accountPacks.tsx` 的 `worstExpiry / expirySummary / ExpiryChip / usablePacksOf / PackTable` | 引用归零；跨平台视图迁到 `entitlement.ts` |

**修改**

| 文件 | 改动 |
|---|---|
| `src/routes/credentials.js` | `withExpiry` 补 `raccoonPoints`；`GET /` 与 `GET /summary` 支持 `?slim=1` |
| `web/src/shared/api/credentials.ts` | `listAccounts(slim=true)` / `listAccountsWithRollup` / `getAccount`（详情）/ `resetOneDevice` |
| `web/src/shared/api/types.ts` | `PackDigest` / `RaccoonPoints` / `EntitlementRollup` / `packCaliber` |
| `web/src/shared/api/channels.ts` | 补 `dailyKeepalive` 能力位（后端 2026-10-15 起下发，前端类型一直没声明） |
| `web/src/features/accounts/CredentialsPage.tsx` | 全部重写：统计条 + rail + 工具条 + 9 列表 + 权益总览 + 成长 + 保活 |
| `web/src/features/accounts/GrowthPanel.tsx` | 全部重写：收起摘要行 + 单表 8 列 + 请求分级 |
| `web/src/features/accounts/accountPacks.tsx` | `creditTotals` 支持 `packDigest` 双形态；删死导出 |
| `web/src/features/accounts/KeepaliveBoard.tsx` | 尾注不再写死平台名（原来说 WorkBuddy 未纳入扫描，与实际相反） |
| `web/src/styles/global.css` | 列宽表重排；`.td-actions` 改 `nowrap`；新增 `.rail*` `.stat-strip` `.ent-*` `.growth-bar` |
| `package.json` | `test` 串入新测试；新增 `test:entitlement` |

### 7.3 关键实现的三个防错点

**① 摘要口径不与调度漂移**

后端的 `digestOf` 不自己算天数，而是调用 `credentials/credits.js` 的 `naturalDayDiff` ——
那正是 `summarizeExpiry`（临期金额）与 FEFO（先到期先用）用的同一套日历日判定。
测试里有一条逐账号交叉校验（`digest.expiring7d === summarizeExpiry().d7`），
写自己的毫秒除法会立刻失败。

**② ZCode 的 token 不得进积分口径**

实测该账号快照里躺着一条历史遗留的 `packs`：

```json
{"name":"GLM-5.3-Flash","limit":100000000,"used":100000000,
 "remaining":0,"meter":"model_usage"}
```

这是 `src/test/unit.test.js:4435` 明令禁止的状态。改造后前端只看 `packDigest`，
后端 `slimAccount` 对它返回全零摘要并标 `packCaliber:'zcode'`；`rollupOf` 用
**白名单** `CREDIT_PACK_PLATFORMS = {trae, workbuddy}` 过滤。将来新增平台若忘了登记，
它的 `packs` 会被忽略——宁可少显示一个数，也不要把别的计量单位当成积分。

**③ 不可加的额度不相加**

| 平台 | unit | 依据 |
|---|---|---|
| Trae / WorkBuddy | `credit` | 可累积积分（1e3 量级） |
| ZCode | `token` | Token 计量（1e8 量级） |
| Qoder | `quota` | 基础 + 赠送两段，不互相包含 |
| Raccoon | `points` | 分池 + **日清**（每日积分次日整额清零），与可累积积分语义不同 |

页头统计条只报 `credit` 的合计（Trae + WorkBuddy），并在 title 里写明
「仅统计积分口径；Token 与配额见下方权益总览」。权益总览的面板尾注进一步说明四类口径不可相加。

### 7.4 验证记录

```
后端 + 前端归一逻辑（npm test，24 个测试文件全部通过）
  unit.test.js              307 passed
  qoder.test.js              76 passed
  growth.test.js             16 passed
  growth-daily.test.js       16 passed
  security.test.js           53 passed
  protocol.test.js           36 passed
  toolcall-index.test.js      7 passed
  stream-gate.test.js        19 passed
  rtk.test.js                32 passed
  local-answer.test.js      111 passed
  qr.test.js                 38 passed
  channels.test.js           49 passed
  entitlement-view.test.js   21 passed   ← 新增
  frontend-entitlement.test.js 23 passed  ← 新增
  raccoon.test.js            44 passed
  ...（其余 9 个文件全部通过）

前端工程
  npx tsc --noEmit                         0 错误
  npx eslint .                             0 问题
  node scripts/check-css-tokens.mjs        33 引用全部有定义
  npm run build                            成功（CredentialsPage 123.08 kB / gzip 40.19 kB）

真实数据（隔离实例，23 账号 / 743 权益包，HTTP 实测）
  /v1/credentials?slim=1        25.0 KB   （完整 129.2 KB，降 80.7%）
  /v1/credentials/summary?slim=1 25.0 KB  （完整 129.2 KB，降 80.6%）
  两端点每轮合计                258.4 KB → 50.0 KB
  /v1/credentials/:id（WB 最大号）10.3 KB，含 57 条完整 packs、含 devices
  五平台 slim 行字段              均无 packs / devices，均有 packDigest + packCaliber
  权益列有效行数                7/23 → 23/23
  权益到期列有效行数            0/23 → 23/23（并入权益列）
  SPA 与三个 assets             index/html/js/css 全部 200，文件名与 dist 一致
```

`entitlement-view.test.js` 的 21 条断言覆盖：

1. `?slim=1` 返回 200 且标 `slim: true`
2. slim 行带 `packDigest`
3. slim 行**不含**完整 `packs`
4. slim 行不含 `devices` / `fingerprint`
5. 摘要 7 日金额与 `summarizeExpiry` 逐账号相等
6. slim 带 `rollup`
7. rollup 排除不限量包金额（Trae 780 + WB 200 = 980）
8. rollup 不含 ZCode token 与 Qoder 配额
9. 不限量包只计个数
10–13. 详情端点返回完整 `packs`、不带 `packDigest`
14–16. 三个隔离键（`tokenBuckets` / `quota` / `raccoonPoints`）都透出
17. slim 体积 < 完整 30%
18–19. `summary` 端点同语义
20–21. ZCode 残留 packs 不计入积分摘要与 rollup

`frontend-entitlement.test.js` 的 23 条断言覆盖：

1. 能打包 TS 并加载（否则后续断言无效——先钉住测试自身有效性）
2–3. Trae / WorkBuddy 从 `packDigest` 取积分
4–5. ZCode 从 `tokenBuckets` 取 token，且金额远小于残留 `packs` 的 1e8
6. Qoder 主读数取非零那一段（base=0 → 报 addOn 1926）
7–9. Raccoon 从 `raccoonPoints` 取数、单列 `points` 单位、到期文案是「日清」而非编造天数
10–12. 权益列文案非空、无并排破折号、额度耗尽是「额度已用尽」
13. 缺 `packCaliber` 时按 edition 兜底且仍不读 packs
14. 跨账号累加无浮点尾巴（`4920.41` 而非 `4920.410000000001`）
15–17. 快照陈旧识别（20 天前 stale / 刚刚不 stale / 无时间不算 stale）
18–21. 五平台汇总各自独立 unit，Trae 与 WB 同为 credit 但不合并成一行
22. 无数据时 `known=false` 且文案「未查询」
23. 源码级约束：`tokenSummary` 体内不得出现 `a.packs` 读取

### 7.5 未能自动验证的部分（需人工目测）

- 1440×900 首屏是否可见「rail + 工具条 + 表格 ≥12 行」
- 1280×800 下表格是否横向滚动（9 列固定宽合计 840 + 账号列自适应）
- `⋯` 菜单在表格最后几行是否被面板底边裁切（已改 portal 渲染，理论上不会）
- 收起态 Network 面板确认零 `/v1/workbuddy/growth/*` 请求
- 键盘链路：`Tab` → `⋯` → `Enter` → `↓` → `Esc` 焦点归还

以上四条需要浏览器实测，构建与类型层面无法覆盖。

---

## 8. 上线后缺陷修复（2026-11-09，用户实测反馈）

第一轮交付后用户实测报了三处问题。逐条定位到具体代码，不是样式微调。

### 8.1 「切换页面总是显示请求已取消，刷新才正常」——数据层缺陷

**症状**：从总览点进凭据池，页面稳定显示「请求已取消」，手动刷新后恢复正常。

**根因**：`web/src/shared/api/http.ts` 的 GET 去重。

```ts
// 修复前
const cacheKey = `${key}|${path}`;
const existing = inflight.get(cacheKey);
if (existing) return existing as Promise<T>;   // ← 共享的是「绑定第一个调用方 signal」的 Promise
```

`shared/hooks/useAsyncData.ts` 每次挂载都建一个 `AbortController`，卸载时 abort。
两个页面先后请求同一路径时，第二个调用方拿到的正是**已被前一个页面中止**的那个
Promise。而 `useAsyncData` 的 catch 里只检查 `controller.signal.aborted`——
那是**自己**的 controller，不是被中止的那个，所以判断不成立，错误被当作内容
渲染出来。刷新之所以有效，是因为刷新时没有并发的旧订阅者，缓存里已经空了。

**修复**（两层，缺一不可）：

```ts
// http.ts：带 AbortSignal 的请求不参与共享
function dedupeKey(path, key, opts) {
  if (opts.signal) return null;              // ← 关键
  if (opts.dedupe === false) return null;
  return `${key}|${path}|${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}`;
}
```

```ts
// useAsyncData.ts：取消不是错误，保持上一份数据
if (e instanceof ApiError && e.isTransport && /请求已取消|aborted/i.test(e.message)) {
  return;
}
```

去重本身保留（无 signal 的并发同一 GET 仍共享一次请求），测试里有专门一条断言
防止这次修复把去重顺手废掉。

**回归测试**：`src/test/request-cancel-isolation.test.js`，9 条断言。核心三条：

| 场景 | 期望 | 实测 |
|---|---|---|
| 两个带 signal 的同一 GET 并发 | 各发一次（hits=2） | ok |
| 两个无 signal 的同一 GET 并发 | 共享一次（hits=1） | ok |
| 一个 abort 后另一个 | 前者 AbortError、后者正常拿到数据 | ok |

### 8.2 「双滚动条」——overflow 传播

**症状**：页面右侧出现两条纵向滚动条；截图里表格区域还多一条横向条。

**根因**（两层）：

1. `global.css` 里 `.panel-body-flush:has(> table) { overflow-x: auto }`。
   CSS 规范规定：**一轴为 `auto` 时，另一轴的 `visible` 会被计算成 `auto`**。
   于是这个面板体同时成了纵向滚动容器，与外层 `main` 的 `overflow-y: auto`
   叠成两条纵向条。
2. 列宽合计 936px。1105px 窗口下内容区只有 841px，表格必然横向溢出——
   而第一轮把工具条、表格、表尾都塞进了同一个 `flush` 面板，滚动条因此横跨整块。

**修复**：

```css
/* 专用滚动容器，纵向显式 hidden，不抢外层滚动条 */
.table-wrap {
  overflow-x: auto;
  overflow-y: hidden;
}
```

- 删除 `.panel-body-flush:has(> table)` 的 overflow；
- 表格包进 `.table-wrap`，工具条与表尾留在它**外面**（表尾不该被横向滚动带走）；
- 固定列宽 936 → **840px**（启用 52 / 平台 84 / 状态 76 / 权益 156 / 额度 96 /
  有效期 104 / 冷却 60 / 操作 212），账号列吃剩余并设 `min-width: 150`。

窗口宽度对照：

| 窗口 | 内容区 | 账号列 | 结果 |
|---|---|---|---|
| 1440 | 1176 | 336 | 无滚动 |
| 1366 | 1102 | 262 | 无滚动 |
| 1280 | 1016 | 176 | 无滚动 |
| 1105 | 841 | 150（min） | 横向滚动，但纵向不会再出现第二条 |

### 8.3 「更多操作显示错误」——被 overflow 裁切

**症状**：点行内「⋯」后菜单只剩一个被切掉的方块。

**根因**：菜单是 `position: absolute` 的子元素，而它有两个裁剪祖先：
`.panel { overflow: hidden }`（圆角裁切需要）与 `.table-wrap { overflow-x: auto }`。
菜单被父级裁掉，看起来像渲染错误。

**修复**：`shared/ui/Menu.tsx` 改为 **portal 渲染到 `document.body`** +
`position: fixed` + 按触发按钮的 `getBoundingClientRect()` 定位。

配套细节：

| 项 | 处理 |
|---|---|
| 向下 / 向上展开 | 下方空间 < 160px 且比上方小时翻转到上方 |
| 左右对齐 | 右对齐贴按钮右边缘并夹到视口内（留 8px） |
| 高度受限 | `maxHeight` 取可用空间，内部 `overflow-y: auto` |
| 滚动跟随 | 监听 `scroll`（capture 覆盖所有可滚动祖先）+ `resize` 重算 |
| 点击外部 | 同时排除按钮与菜单本身（菜单已在 body 里，`contains` 判断要分开做） |
| 层级 | `z-[60]`，高于 Modal 的 `z-40` |

### 8.4 修复后的验证

```
node src/test/request-cancel-isolation.test.js    9 passed
npx tsc --noEmit                                  0 错误
npx eslint .                                      0 问题
node scripts/check-css-tokens.mjs                 33 引用全部有定义
npm run build                                     成功（CredentialsPage 124.00 kB / gzip 40.59 kB）

编译产物确认
  .table-wrap{overflow-x:auto;overflow-y:hidden}      ← 纵向不再传播
  .panel-body-flush{padding:0}                        ← 已无 overflow
  .col-toggle{width:52px} / .col-pack{width:156px} / .col-actions{width:212px}

隔离实例（真实库副本，23 账号）
  GET / 返回 index-7XId39gD.js（最新构建），assets 200
  GET /v1/credentials?slim=1 → accounts=23, rollup=45417.15
```

改动文件：`web/src/shared/api/http.ts`、`web/src/shared/hooks/useAsyncData.ts`、
`web/src/shared/ui/Menu.tsx`、`web/src/features/accounts/CredentialsPage.tsx`、
`web/src/styles/global.css`、`src/test/request-cancel-isolation.test.js`（新增）、`package.json`。

仍需浏览器确认的一项：门户菜单位置在真实滚动容器里是否始终贴合按钮
（已监听 capture 阶段 scroll，实测应跟随；键盘与点击路径不受影响）。

---

## 9. Trae OAuth 弹窗的「WorkBuddy 池」伪选项（2026-11-09，用户实测反馈）

**症状**：WorkBuddy 已经改用无感登录，Trae 的添加弹窗里却还留着一个
「默认池 / WorkBuddy 池」的二选一，标注「决定账号进入哪个转发池」。

### 9.1 它从来就不是一个真选项

查了三处，结论一致——这个开关是**纯空操作**：

| 检查点 | 事实 |
|---|---|
| `credentials/pool.js#editionOk` | 分池依据是 **edition**：WorkBuddy 账号靠 `edition='workbuddy'` 进 WB 池，Trae 系靠 `cn/sg/us/manual`。与 `group` 无关 |
| `credentials/pool.js#groupOk` | `POOL_GROUPS` 为空时 `if (!raw) return true` —— 默认不过滤。本机 `.env` 实测该变量为空 |
| 本机 23 个账号的 `group` | **全部为 null**，从未被这个选项写过 |
| 后端所有 `.group` 消费点 | 只有 `groupOk`（上述过滤）、`/groups` 统计、`transfer` 导出、`credit-history` 快照 —— 没有任何一处按 group 决定平台池 |

也就是说，选「WorkBuddy 池」的净效果是：给一个 **Trae 账号**打上
`group='workbuddy'` 的标签，池子不动、调度不变。它唯一的作用是让人以为自己
把 Trae 账号送进了 WorkBuddy 转发池。

### 9.2 修复

`web/src/features/accounts/OauthTraeDialog.tsx`：

| 改动 | 前 | 后 |
|---|---|---|
| 控件 | `Segmented`（默认池 / WorkBuddy 池） | `Field` 自由输入 + `datalist` 候选（来自 `/v1/credentials/groups`） |
| 值 | `'default' \| 'workbuddy'` 联合类型 | 任意字符串，空串 = 不分组 |
| 文案 | 「账号分组（决定账号进入哪个转发池）」 | 明确写清「分组只是标签；决定进哪个池的是平台本身；仅当启用分组筛选时才影响选号」 |

选 `datalist` 而不是纯文本框：已有分组名可直接点选，避免手打拼错导致分组对不上
（`groupOk` 是精确字符串匹配）。

### 9.3 顺带确认：WorkBuddy 的区域选择是**真**参数

同类控件容易一起被误删，所以单独核实了 `WbOauthDialog` 的「国内版 / 国际版」：
它经 `workbuddy/oauth.js#platformOfRegion` 与 `authBaseOfRegion` 改变
授权域（workbuddy / workbuddy-ai）与 billing base，并写入账号的 `userRegion`
——是真实生效的分支，保留。

### 9.4 回归测试

`src/test/oauth-group-semantics.test.js`，13 条断言，分三组：

**A. 前端不再有伪选项（4 条）**

1. 弹窗里不再出现写死的「WorkBuddy 池」选项
2. 不再把 group 当二选一（无 `'default' | 'workbuddy'` 联合类型）
3. 明确说明「平台决定进哪个池」
4. 分组输入接入已有分组候选（`datalist` + `listGroups`）

**B. groupOk 语义（5 条）**

5. `POOL_GROUPS` 为空时直接返回 true
6. `groupOk` 只读 `a.group`，不含 edition 判定
7–9. 行为验证：空配置下 `group=null` 与 `group='workbuddy'` 都通过；
      配置为 `workbuddy` 后前者被排除、后者通过

**C. 平台归属不由 group 决定（4 条）**

10. `group='workbuddy'` 的 Trae 账号仍在 Trae 候选池
11. 真 WorkBuddy 账号不会因缺 group 被排除
12. 把该 Trae 账号的 group 清空后仍可被选中
13. 空配置下分组不构成默认过滤

> 测试写法上的一个坑记录在此：`explainCandidates` 是**诊断**视图，
> 列全部账号 + 不可用原因，**不含** `groupOk`；`pick()` 又叠加了
> `lastPickedAt` 间隔、冷却、并发与策略排序，结果随机器状态漂移。
> 所以分组语义既不能用前者也不能用后者验证，最终用「正则截取 `groupOk`
> 函数体 + 对两种 group 值求值」的最窄方式，避免把无关状态卷进断言。

### 9.5 验证

```
node src/test/oauth-group-semantics.test.js   13 passed
npm test                                      25 个测试文件全部通过
npx tsc --noEmit                              0 错误
npx eslint .                                  0 问题
node scripts/check-css-tokens.mjs             33 引用全部有定义
npm run build                                 成功（CredentialsPage 124.43 kB / gzip 40.94 kB）
```

改动文件：`web/src/features/accounts/OauthTraeDialog.tsx`、
`src/test/oauth-group-semantics.test.js`（新增）、`package.json`。

---

## 10. 总览页三个额度指标可展开看构成（2026-11-09 需求）

**需求**：可用额度点击展开显示各平台各自的总额度；今日消耗点击展开显示各平台消耗；
到期积分点击展示哪些账号将要到期多少积分。

### 10.1 三个数字各自能拆到什么粒度

拆分的上限由**后端有没有这个口径**决定，不是由界面想不想画决定：

| 指标 | 可拆到 | 依据 | 限制 |
|---|---|---|---|
| 可用额度 | 按平台 | 四套隔离键（`packs` / `tokenBuckets` / `quota` / `raccoonPoints`）全部在列表响应里 | 不可跨平台相加 |
| 今日消耗 | 按平台 → 按账号 | `credit_history` 逐账号差分（`/v1/admin/credit-history`） | **只有积分口径写这张表** |
| 即将到期 | 按账号（含平台） | `packs` / `tokenBuckets` 的 `expireTime` | 需完整 packs，列表是 slim |

第二条是关键约束。实测 23 个账号的 `credit_history` 覆盖：

```
cn(Trae)   8 个账号  有快照  今日消耗   0
workbuddy  8 个账号  有快照  今日消耗 416
zcode      1 个账号  无记录
qoder      4 个账号  无记录
raccoon    2 个账号  无记录
```

ZCode/Qoder/Raccoon 不是「今天没消耗」，是这三类平台**根本不写这张表**
（`upstream/balance.js` 里明确注释：token 混进积分曾把今日消耗抬高 4 个数量级）。
所以界面给它们标 **「未纳入统计」**，而不是 0 —— 0 会让人以为今天没用过。

### 10.2 实现

新增两个文件：

| 文件 | 行数 | 职责 |
|---|---|---|
| `web/src/shared/lib/overview-detail.ts` | 300 | 三个指标的派生计算：`amountByPlatform` / `usageByPlatform` / `expiringAccounts` / `expiringTotals` |
| `web/src/features/overview/MetricCard.tsx` | 130 | 可展开指标卡 + 展开区三态（加载/错误/空）统一出口 |

**① 可用额度**（点开）

```
Trae        12,974.15 积分   8/8 账号
WorkBuddy      32,315 积分   8/8 账号
ZCode               0 Token  1/1 账号   Token 计量，不计入积分
Qoder           6,040 配额   4/4 账号   赠送 6,040
Raccoon         7,787 积分   2/2 账号   奖励积分 / 每日积分
─────────────────────────────────────────
积分口径合计（Trae + WorkBuddy）  45,289.15 积分
```

合计只含积分口径且**排除 Raccoon**（它也是「积分」字样，但分池 + 日清，
与可累积积分语义不同）。非积分行右侧标「不计入上方合计」。

**② 今日消耗**（点开，再点「按账号查看」展开第二层）

```
Trae              0 积分   8/8 个账号有快照
WorkBuddy       416 积分   8/8 个账号有快照
ZCode        未纳入统计    —         ← 不是 0
Qoder        未纳入统计    —
Raccoon      未纳入统计    —
─────────────────────────────
积分口径合计    416 积分
```

账号级明细按金额降序；本轮无快照的账号标「本轮无快照」（区分于真实 0 消耗）。

**③ 即将到期**（点开，可切 3 / 7 / 30 天）

```
9 天后   18232808772   WorkBuddy   3,968 积分   60 项   [CodeBuddy个人版国内运营裂变包]
9 天后   17395025927   WorkBuddy   3,854 积分   59 项   [CodeBuddy个人版国内运营裂变包]
...
─────────────────────────────
合计（积分）  39,890.15 积分
```

统计口径与后端 `summarizeExpiry` 一致：只算 `remaining > 0` 且未过期的条目，
自然日差（本地零点对齐，不是毫秒除法），`unlimited` 不计金额。
Raccoon 的每日积分次日清零，**永不出现**在到期列表（硬算一个到期日是编数据）。

### 10.3 数据加载策略（「按需」的落点）

到期明细需要完整 `packs`，而列表端点是 slim（只有聚合值）。所以：

```
打开总览页        → summary + credit-history，共 2 个请求（与改造前一致）
展开「可用额度」  → 0 请求（数据已在 summary 里）
展开「今日消耗」  → 0 请求（数据已在 credit-history 里）
展开「即将到期」  → 按账号拉 GET /v1/credentials/:id，并发上限 4
```

实测 23 个账号的详情合计约 150 KB，一次性在首屏付这个成本没有道理，
因此只有真正点开「即将到期」才拉。单账号失败不影响其余（该账号不出现，
而不是整块报错）。

### 10.4 无障碍与交互一致性

三处展开区共用同一套行为，避免用户每次重新学：

- 整块卡头可点，`aria-expanded` + `aria-controls`
- 展开区在卡内、卡下方，不跳页不弹窗
- 右侧 `＋ / －` 角标常显，提示可展开
- 展开区加载 / 错误 / 空都有明确文案
- `Raccoon` 与 `points` 单位在合计里按单位分组，跨单位不相加（`expiringTotals` 按 unit 聚合）

### 10.5 回归测试

`src/test/overview-detail.test.js`，24 条断言，四组：

**① 可用额度（9 条）** — 五平台各出一行；Trae 780 / WB 200 为「积分」；
ZCode 单列 Token（1500 万）；Qoder 单列配额（1926）；Raccoon 单独成行；
积分合计 = 980（不含 Token / 配额 / Raccoon）；断言合计 < 100 万以排除 token 混入。

**② 今日消耗（7 条）** — 五平台都出现（含无消耗的）；Trae 120 / WB 80；
ZCode/Qoder/Raccoon 的 `notTracked===true`（不是 0）；积分平台 `notTracked===false`；
账号明细只含有记录的账号；明细按金额降序。

**③ 即将到期（7 条）** — 3 天窗口只含 A=80，排除已用尽 D 与 unlimited F；
7 天窗口 280；30 天窗口含 WB 的 200、仍排除 40 天后的 C；Raccoon 永不出现；
按天数升序；合计按单位分组不跨单位相加。

**④ 源码约束（1 条）** — 到期统计用自然日差（`setHours(0,0,0,0)`）而非毫秒除法。

### 10.6 验证

```
node src/test/overview-detail.test.js   24 passed
npm test                                26 个测试文件全部通过
npx tsc --noEmit                        0 错误
npx eslint .                            0 问题
node scripts/check-css-tokens.mjs       33 引用全部有定义
npm run build                           成功（OverviewPage 13.30 kB / gzip 见构建输出）

隔离实例（真实库副本，23 账号）
  summary?slim=1           23 账号，expiring7d=0
  credit-history?days=1    totalUsed=416，23 行
  credentials/:id          200，4.7 KB（按需拉详情这条路径通）
  三个展开区用真实数据渲染结果见 §10.2 的样例
```

改动文件：`web/src/shared/lib/overview-detail.ts`（新增）、
`web/src/features/overview/MetricCard.tsx`（新增）、
`web/src/features/overview/OverviewPage.tsx`（重写指标区）、
`web/src/styles/global.css`（新增 `.metric-cards` / `.metric-card` / `.metric-kv`）、
`src/test/overview-detail.test.js`（新增）、`package.json`。

需浏览器确认：三张卡在 1440 / 1280 两档宽度下的换行与展开后高度
（`grid-template-columns: repeat(auto-fit, minmax(240px, 1fr))` + `align-items: start`，
展开只撑高那一张卡）。




