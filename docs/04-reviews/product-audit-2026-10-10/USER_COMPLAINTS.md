# USER_COMPLAINTS — 5 个用户角色的真实负面评价
**Product Professor · 2026-10-10 · commit `2a2ec43`**

> 方法：为每个角色设定真实动机与场景，然后**只使用代码里存在的证据**构造抱怨。每条抱怨都附：原文、影响评分、严重度、证据、修复方向。
> 不是客套的"建议"，是用户真的会说的话。

---

## 角色 1 — 首次使用者（First-time user）

**画像**：从 GitHub 看到项目，clone 下来，跑 `start.bat`，打开浏览器。动机：想给自己省点 API 钱。

### 抱怨 1.1 ⭐ 核心

> **"我创建了密钥，点'进入面板'，然后就是一片空白，写着'暂无账号数据'。我该点什么？"**

- **影响评分**：从 4 星直接掉到 2 星（第一印象决定一切）
- **严重度**：🔴 CRITICAL
- **证据**：
  - [SetupGate.tsx:224-250](../../../web/src/features/setup/SetupGate.tsx#L224-L250) —— 创建密钥后只有"复制密钥"和"进入面板"两个按钮，**没有任何"下一步做什么"**
  - [OverviewPage.tsx:176-181](../../../web/src/features/overview/OverviewPage.tsx#L176-L181) —— `accounts.length === 0` 时渲染纯灰字"暂无账号数据"，**零引导、零按钮、零链接**
  - 真实路径需要：左侧「账号」→「凭据池」→「接入新账号」Panel → 三个按钮之一。**没有任何页面提示这条路**
- **修复方向**：onboarding 状态机 + 总览空状态给 CTA

### 抱怨 1.2

> **"我导入了 WorkBuddy 账号，提示'导入成功'，但列表里那个账号是灰的，什么都不能用。我以为是坏了。"**

- **影响评分**：-0.5 星
- **严重度**：🟠 MAJOR
- **证据**：
  - [ImportWbDialog.tsx:59](../../../web/src/features/accounts/ImportWbDialog.tsx#L59) toast「已导入 WorkBuddy 账号（默认停用）」
  - [ImportWbDialog.tsx:187](../../../web/src/features/accounts/ImportWbDialog.tsx#L187) Note「导入的账号默认处于停用状态，需在凭据池确认后手动启用。」
  - **弹窗此时已 close**（`:63`）。用户必须自己在 525 行的表里找到新行，点一个只写着「开」的按钮
  - **没有 toast 指向、没有行高亮、没有跳转**
- **修复方向**：导入成功后保持弹窗并给"立即启用"按钮，或 toast 带跳转链接

### 抱怨 1.3

> **"文档呢？README 呢？我想知道这玩意儿到底怎么配，结果根目录什么都没有，只有一堆 `.md` 全是审查报告。"**

- **影响评分**：-1 星（可信度）
- **严重度**：🟠 MAJOR
- **证据**：
  - 仓库根与 `web/` 下**均无 README**（仅 `docs/04-reviews/code-review-2026-10-05/README.md`，那是审查报告的索引）
  - `docs/` 下 13 篇文档全部是技术设计/审查/竞品对比报告，**零篇面向用户**
  - `docs/06-deliverables/comparisons/wb-ecosystem-comparison-2026-10-04.md` 与 `... (2).md` **内容完全相同**（均 37737 字节）
- **修复方向**：写 README + 快速开始

---

## 角色 2 — 移动端用户（Mobile user）

**画像**：出差在酒店，用手机连 VPN 到家里的机器，想看账号池是否还活着。

### 抱怨 2.1 ⭐ 核心

> **"手机上根本没法用。左边一条 216px 的侧栏把屏幕吃掉一半，剩下的表格挤成一列竖排的字，我看不出哪个账号死了。"**

- **影响评分**：直接 1 星（"不支持移动端"）
- **严重度**：🔴 CRITICAL
- **证据**：
  - [AppLayout.tsx:34-35](../../../web/src/app/AppLayout.tsx#L34-L35) —— `flex h-screen` + `<aside className="w-[216px] shrink-0">`
  - 390px 视口下主内容区仅剩约 **174px**
  - [CredentialsPage.tsx:319](../../../web/src/features/accounts/CredentialsPage.tsx#L319) —— `table-fixed w-full` 的 **10 列表格**（启用/账号/状态/平台/权益包/权益到期/账号到期/余额/冷却至/操作）
  - 全局无 `@media` 断点（`tailwind.config.ts` 无自定义 screens，`global.css` 无媒体查询调整布局）
- **修复方向**：<900px 侧栏折叠为抽屉；表格卡片化

### 抱怨 2.2

> **"我想点'签到'，结果按钮小得跟米粒一样，还挨着'删除'，差点点错。"**

- **影响评分**：-0.5 星
- **严重度**：🟠 MAJOR
- **证据**：[CredentialsPage.tsx:444-462](../../../web/src/features/accounts/CredentialsPage.tsx#L444-L462) —— 签到/查余额/删除三个 `size="sm"` 按钮以 `gap-1.5` 紧贴排列；删除是 `variant="danger"` 但与另两个**视觉重量接近**
- **修复方向**：移动端操作收进行菜单；删除单独分离

### 抱怨 2.3

> **"手机上那个顶部时钟每秒都在闪，滚表格的时候能感觉到卡。"**

- **影响评分**：-0.3 星
- **严重度**：🟡 MINOR
- **证据**：[AppLayout.tsx:10-23](../../../web/src/app/AppLayout.tsx#L10-L23) —— `Clock` 组件每秒 `setState`，即使拆成独立组件，在低端手机上仍是每秒一次 React 提交
- **修复方向**：时钟降到 1 分钟粒度，或 CSS-only

---

## 角色 3 — 回访用户 / 日常运维者（Returning user）

**画像**：已经用了两周，每天早上开面板看一眼，然后去写代码。动机：确认池子健康。

### 抱怨 3.1 ⭐ 核心

> **"面板上写着'可用 12'，但我发请求就是 429。到底哪个是真的？"**

- **影响评分**：2 星（信任崩塌）
- **严重度**：🔴 CRITICAL
- **证据**：
  - 侧栏徽章 [AppLayout.tsx:30-31, 80-86](../../../web/src/app/AppLayout.tsx#L30-L31) 显示 `data.enabled`（**已启用账号数**，不含冷却/余额/在途）
  - 总览 KPI [OverviewPage.tsx:74](../../../web/src/features/overview/OverviewPage.tsx#L74) 同样显示 `summary.enabled`
  - 但真实调度可用性取决于 [pool.js:422-433](../../../src/credentials/pool.js#L422-L433) 的 8 个条件（enabled + 非冷却 + 非模型冷却 + 余额达标 + 分组 + 版本 + 有容量 + 未排除）
  - **"可用"这个词在 UI 上指的是"enabled=true"，在调度器里指的是完全不同的东西**
- **修复方向**：把"可用"改成真实调度可用数，或改名为"已启用"

### 抱怨 3.2

> **"我看到一个账号红着写'需重新登录'，然后我不知道该干嘛。那行只有签到、查余额、删除三个按钮。"**

- **影响评分**：-1 星（最需要修的时候修不了）
- **严重度**：🔴 CRITICAL
- **证据**：
  - [accountPacks.tsx:234-236](../../../web/src/features/accounts/accountPacks.tsx#L234-L236) —— `refreshToken` 过期时 label = `'需重新登录'`，tone = `danger`
  - [CredentialsPage.tsx:390-426](../../../web/src/features/accounts/CredentialsPage.tsx#L390-L426) 渲染该列
  - [CredentialsPage.tsx:444-462](../../../web/src/features/accounts/CredentialsPage.tsx#L444-L462) —— **行内只有签到/查余额/删除**
  - 真正的修复入口（粘贴凭据导入 / Trae OAuth）在 [CredentialsPage.tsx:288-301](../../../web/src/features/accounts/CredentialsPage.tsx#L288-L301) 的**独立 Panel**，在表格上方
- **修复方向**：行内按状态给对应修复按钮（重新登录 / 重新导入）

### 抱怨 3.3

> **"我想知道今天花了多少。打开统计页，四张大卡片，底下六张表，每张表下面还有一段三行的说明……我就想知道一个数。"**

- **影响评分**：-0.5 星（认知过载）
- **严重度**：🟠 MAJOR
- **证据**：
  - [TokenStatsPage.tsx:259-346](../../../web/src/features/stats/TokenStatsPage.tsx#L259-L346) —— 4 张口径卡
  - 页面共 **7 个 `<table>`** 与 **6 处 footer/Note 口径声明**
  - "Trae 账单 1~2 天滞后"这条警告在文案里出现 **3 次**（`:354`、`:453`、`:788`）+ 代码 1 次（`:203`）
  - [TokenStatsPage.tsx:738](../../../web/src/features/stats/TokenStatsPage.tsx#L738) footer 是一整段 R² 回归方法论
- **修复方向**：一屏一数 + 详情折叠

### 抱怨 3.4

> **"总览页那个'运行状态'表，和运维页第一屏一模一样，我每次都怀疑自己点错了。"**

- **影响评分**：-0.3 星
- **严重度**：🟡 MINOR
- **证据**：[OverviewPage.tsx:250-278](../../../web/src/features/overview/OverviewPage.tsx#L250-L278) 与 [OpsPage.tsx:443-482](../../../web/src/features/ops/OpsPage.tsx#L443-L482) + `:405-418` —— **9 项字段 9/9 重复**（调度器/下次签到/粘性条目/不可用模型/运行时长/节点/池化策略/通知/管理密钥分离）
- **修复方向**：总览删掉这一块，改为异常摘要 + 链接

---

## 角色 4 — 管理员 / 运维者（Admin / staff）

**画像**：给自己的机器做长期维护，需要排障、需要知道系统到底在干什么。动机：出问题时能定位。

### 抱怨 4.1 ⭐ 核心

> **"我配了 `model-fallback.json`，写了 14 组降级映射，还开了 `autoFallback`。三个月后我才发现这文件从来没被读过。"**

- **影响评分**：1 星（配置欺骗）
- **严重度**：🔴 CRITICAL
- **证据**：
  - [config.js:27](../../../src/config.js#L27) `const fallbackConfig = readJson(...'model-fallback.json', {})`
  - [config.js:111](../../../src/config.js#L111) 挂到 `config.fallbackConfig`
  - **全库其余读取点**：`config.js:182`（reload 时重新读取）、`backup.js`（作为文件备份）、`admin-debug.js:259`（注释）
  - **无任何业务代码消费 `fallbackConfig`**（已独立 grep 复核）
  - 文件内容含 `autoFallback: true`、`queueThreshold: 300`、14 组 claude→glm/qwen 映射
- **修复方向**：实现或删除该文件并在启动时警告

### 抱怨 4.2

> **"我要知道这台机器上谁在什么时候 reveal 了一把密钥。后端明明写了审计，但面板里找不到。"**

- **影响评分**：-1 星（运维必需能力缺失）
- **严重度**：🟠 MAJOR
- **证据**：
  - [src/log/audit.js:30-60](../../../src/log/audit.js#L30-L60) —— `audit()` 双写 SQLite + JSONL
  - [src/routes/admin-security.js:59](../../../src/routes/admin-security.js#L59) —— `GET /v1/admin/audit` 已实现
  - **`web/src` 全库 grep `audit` → 0 命中**（无任何 UI 入口）
  - 写入点包括：密钥 reveal（`api-keys.js` ×5）、凭据导出（`admin-overview.js:46`）、catalog lifecycle（`admin-security.js:47`）
- **修复方向**：加只读审计页

### 抱怨 4.3

> **"服务停了之后，我客户端那边报'连接被重置'，日志最后一行什么都没有。像是被杀了。"**

- **影响评分**：-1 星
- **严重度**：🔴 CRITICAL（P0-002）
- **证据**：
  - [src/log/crash.js:78-83](../../../src/log/crash.js#L78-L83) —— `process.on('SIGTERM'|'SIGINT', () => { writeEvent(...); process.exit(0); })`
  - `src/index.js` **无 `server.close()`、无 flush、无 DB close**
  - 在途 SSE 被硬切；stats-cache / sticky / 池冷却全丢
- **修复方向**：优雅停机链

### 抱怨 4.4

> **"我改了轮换开关，保存了，但开关一直显示'已开启'。我以为是缓存，刷新了三次。"**

- **影响评分**：-0.5 星
- **严重度**：🟡 MINOR（**注：经复核此路径实际正确**，前端读的是 `rotate-settings.enabled`）
- **证据**：[OpsPage.tsx:225-233](../../../web/src/features/ops/OpsPage.tsx#L225-L233) 读 `rotateSettings.data.enabled`；[rotate-settings.js:22](../../../src/jobs/rotate-settings.js#L22) 该字段存在
- **修正说明**：架构审查员曾怀疑此处因 `scheduler-settings.js` 删除 `rotateEnabled` 而恒真，**我独立复核后确认前端读的是正确来源**。此条降级为观察项：**若后端双门控仍在**（`m-32`），面板显示"开"但调度器可能跳过
- **修复方向**：确认后端双门控已收敛

### 抱怨 4.5

> **"我在服务器上跑 `node scripts/login-key.js list`，结果服务日志里报了个 SQLITE_BUSY。两个进程抢一个库。"**

- **影响评分**：-0.5 星
- **严重度**：🟠 MAJOR（P0-001 的可见表现）
- **证据**：
  - [src/credentials/db.js:194-203](../../../src/credentials/db.js#L194-L203) —— 仅设 `PRAGMA busy_timeout = 5000`，**无 WAL**
  - [src/credentials/store.js:206-231](../../../src/credentials/store.js#L206-L231) —— `update()` 全列读-改-写，无版本保护
- **修复方向**：开 WAL + 加乐观锁

---

## 角色 5 — 怀疑型技术用户 / 潜在推荐者（Skeptical client / investor）

**画像**：技术很强，别人推荐他看这个项目。他会先看代码结构、再看 UI，然后判断"这值不值得用/推荐"。动机：判断这是不是个正经工具。

### 抱怨 5.1 ⭐ 核心

> **"一个叫'网关'的工具，界面上有个'抽奖'按钮，还有'Buddy 稀有度'和'补登卡'。这是个网关还是个游戏外挂？"**

- **影响评分**：直接关闭页面
- **严重度**：🔴 CRITICAL（产品定位）
- **证据**：
  - [GrowthPanel.tsx:347-349](../../../web/src/features/accounts/GrowthPanel.tsx#L347-L349) —— 「抽奖」按钮
  - [GrowthPanel.tsx:288](../../../web/src/features/accounts/GrowthPanel.tsx#L288) —— 「稀有度」列
  - [GrowthPanel.tsx:279](../../../web/src/features/accounts/GrowthPanel.tsx#L279) —— 「补登卡」列
  - [GrowthPanel.tsx:275](../../../web/src/features/accounts/GrowthPanel.tsx#L275) —— 「Buddy」列
  - 规模：`GrowthPanel.tsx` 372 行 + `cat-trip.js` 190 + `workbuddy/cat-trip.js` 430 + `growth-auto.js` 237 + `growth-progress.js` 169 + `growth.test.js` 286 ≈ **1860 行**
  - **不对称**：后端 15 个写端点（`cat-trip.js:181-188`）vs UI 只做 3 个按钮
  - **重复**：定时器已在跑同一 job（[scheduler.js:578-602](../../../src/jobs/scheduler.js#L578-L602)），UI 的「一键执行」是第二入口
  - **自承**：[GrowthPanel.tsx:367-369](../../../web/src/features/accounts/GrowthPanel.tsx#L367-L369)「建议按需手动执行」
- **修复方向**：删 UI 写操作，保留后台 job + 通知

### 抱怨 5.2

> **"我扫了一遍 CSS，发现有三个地方引用了根本不存在的东西。这说明写完没人打开过页面看一眼。"**

- **影响评分**：可信度 -2
- **严重度**：🟠 MAJOR
- **证据**（**已独立复核**）：
  - `--rg-bg-primary` 在 [shared/ui/index.tsx:126](../../../web/src/shared/ui/index.tsx#L126) 使用，token 层只有 `--rg-bg-base`。复核结果：DEFINED 48 个变量，USED 23 个，**`--rg-bg-primary` 与 `--rg-state-ok` 确未定义**
  - `.t-label` 类在 [ClientAccessPanel.tsx:59,142](../../../web/src/features/ops/ClientAccessPanel.tsx#L59) 使用，`global.css` 中 **0 命中**
  - [tailwind.config.ts:3](../../../web/tailwind.config.ts#L3) 注释指向 `styles/tokens.css` —— **该文件不存在**；且整套 palette **0 处使用**（全库 0 处 `bg-brand-*` / `text-ink-*`）
- **修复方向**：修三处 + 删 tailwind 化石配置

### 抱怨 5.3

> **"一个 1603 行的运维页，24 个面板，其中有个'调度预演'告诉我'如果现在发请求会选谁'。我直接看失败日志不行吗？"**

- **影响评分**：-1 星（噪音密度）
- **严重度**：🟠 MAJOR
- **证据**：
  - [OpsPage.tsx](../../../web/src/features/ops/OpsPage.tsx) 全文 1603 行，5 个分段，约 40 个控件
  - 「调度预演」[OpsPage.tsx:484-529](../../../web/src/features/ops/OpsPage.tsx#L484-L529) 5 个只读卡
  - 「网关配置」[OpsPage.tsx:1455-1586](../../../web/src/features/ops/OpsPage.tsx#L1455-L1586) **33 个只读字段，零个可编辑**
  - 「粘性会话」、「FEFO 到期信号」—— 内部算法术语直接作为面板标题
  - 人手写的工具会随使用**逐步删减**；AI 生成的工具**只增不减**
- **修复方向**：按真实使用频次裁剪运维页

### 抱怨 5.4

> **"面板 footer 里写着'DSH token-meter 分桶口径'。DSH 是什么？这是给我看的吗？"**

- **影响评分**：-0.5 星
- **严重度**：🟠 MAJOR（内部代号泄漏）
- **证据**：[TokenStatsPage.tsx:738](../../../web/src/features/stats/TokenStatsPage.tsx#L738) —— footer 原文含「（DSH token-meter 分桶口径）」
- **修复方向**：删除内部代号

### 抱怨 5.5

> **"我想知道这版本是哪个。界面上没有版本号，package.json 是 3.0.0，web 里是 1.0.0，也没有 changelog。"**

- **影响评分**：-0.5 星
- **严重度**：🟡 MINOR
- **证据**：
  - [AppLayout.tsx:36-38](../../../web/src/app/AppLayout.tsx#L36-L38) 只渲染 `RELAYGATE` 字样，**无版本、无 build 时间、无 commit**
  - 根 `package.json` version `3.0.0` vs [web/package.json](../../../web/package.json) version `1.0.0`（不一致）
  - `docs/` 下 13 篇文档，**零篇 changelog**
- **修复方向**：显示版本 + 写 changelog

---

## 抱怨汇总

| 角色 | 抱怨数 | 最严重 | 若给出评分 |
|---|---:|---|---|
| 首次使用者 | 3 | 🔴 首登后空页零引导 | ⭐⭐ |
| 移动端用户 | 3 | 🔴 移动端完全不可用 | ⭐ |
| 回访用户 | 4 | 🔴 "可用"含义与调度器不符 / 故障无修复入口 | ⭐⭐ |
| 管理员 | 5 | 🔴 配置欺骗（幽灵 fallback）/ 无优雅停机 | ⭐⭐ |
| 怀疑型技术用户 | 5 | 🔴 网关里有抽奖按钮 | ⭐⭐ |

**Expected User Complaint Severity: 7.5 / 10**

### 抱怨的根因分布

| 根因 | 关联抱怨 | 占比 |
|---|---|---|
| 缺少 onboarding 与状态引导 | 1.1, 1.2, 3.2 | 3 |
| 文案/术语面向开发者而非用户 | 3.3, 4.2, 5.4 | 3 |
| 功能冗余导致噪音 | 3.4, 5.3, 5.1 | 3 |
| 后端能力与 UI 不对齐 | 4.1, 4.2, 3.1 | 3 |
| 工程完成度缺口 | 4.3, 4.5, 5.2, 5.5 | 4 |
| 响应式缺失 | 2.1, 2.2 | 2 |

**结论：抱怨集中在"信息架构与引导"（9 条），而不是"功能不能用"（2 条）。** 这恰好解释了为什么功能分 82 而 UX 分 38——**东西是有的，但用户找不到、看不懂、不知道该信哪个。**