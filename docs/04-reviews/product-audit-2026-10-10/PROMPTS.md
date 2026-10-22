# PROMPTS — 接下来运行什么

**Project Professor · 2026-10-10 · commit `2a2ec43`**

按顺序执行。每一批都是**可独立验证**的，不要一口气全做完。

---

## 第 1 批：只改 UI，1 天，立刻提升信任感

### 修 P0（后端正确性）

```
/make-it-better p0-p1
```

第 1 批完成后再重新评分：

```
/score-product after
```

---

### 手动修 P1-001（删重复）· 15 分钟

```
删除 web/src/features/overview/OverviewPage.tsx 中的两个 Panel：
1) 「账号池」表格（第 175-248 行）—— 它是 CredentialsPage 账号表的只读子集，5/7 列重叠且无操作列，
   用户看到异常后仍必须跳转才能修复。改为一条异常摘要：
   - 有 N 个账号处于「需重新登录」→ 显示数量 + 一个「去凭据池处理」按钮（navigate('/credentials')）
   - 有 N 个账号冷却中 / 已停用 → 只显示数字，不列表
2) 「运行状态」KeyValue（第 250-278 行）—— 9 项字段与 /ops 第一屏 9/9 完全重复，
   删除，改为一行链接「查看运行状态 →」(navigate('/ops'))。
同时删除因此不再使用的 useAsyncData(getRuntime) 调用与 runtime 相关 import。
删除后必须确认：OverviewPage 仍能正确渲染，且 npx tsc -b 无未使用变量错误。
```

### 手动修 P1-003（空状态与错误）· 2 小时

```
为 web/src 全部 20 个空状态补充「下一步动作」。当前 19/20 是纯灰字「暂无X」，
用户停在任一空状态都不知道下一步。清单与改法：

必改（有明确下一步）：
1. OverviewPage.tsx:180「暂无账号数据」→ 「还没有接入任何账号。[接入第一个账号]」按钮 navigate('/credentials')
2. AccessKeysPage.tsx:227「暂无访问密钥」→ 「还没有访问密钥。[创建第一把]」按钮触发现有创建流程
3. CredentialsPage.tsx:316「没有符合条件的账号」→ 需要区分两种情况：
   - rows.length===0 且 list.data.length===0 → 首次使用态，给「接入新账号」按钮
   - list.data.length>0（说明有账号但被筛掉了）→ 「当前筛选条件下没有匹配账号。[清除筛选]」按钮
4. ModelRouterPage.tsx:243「尚未配置上游」/ :312「暂无虚拟模型」→ 给对应的创建入口
5. TokenStatsPage.tsx:364/459/560/620 四个「暂无X」→ 保留，但补一句原因
   （如「官方账单尚未入账，通常在请求后 1-2 天出现」）
6. NotifyBackupPanel.tsx:410「未配置任何渠道」/ :631「暂无备份文件」→ 给配置/立即备份按钮

另外修 B6 与 B7 两个真 bug：
B6: OpsPage.tsx:536-538 —— 账号池快照在数组为空时渲染 <LoadingBlock/>，导致「没有账号」永远显示「加载中…」。
    改为：loading 时显示 LoadingBlock；!loading 且为空时显示「当前没有账号。请先接入账号或点『生成种子』」。
B7: TokenStatsPage.tsx:263/285/313/333 —— 4 张口径卡全无 loading 分支，
    数据加载中直接显示「0 credits」/「0」。给每张卡加 loading 分支，加载中显示「—」而不是 0。
```

### 手动修 P1-005（文案）· 1 小时

```
清理 web/src 的论文体文案。具体：

1) 删除内部代号泄漏：TokenStatsPage.tsx:738 footer 中的「（DSH token-meter 分桶口径）」整段删除。
2) 全局去重「Trae 账单 1~2 天入账滞后」：保留 TokenStatsPage.tsx:354 一处，
   删除 :453 与 :788 中的重复表述。
3) 删除 TokenStatsPage.tsx:436 footer（历史脱敏 bug 说明是开发笔记不是用户文案），
   因为 :406 的表格已经在数据点旁标了「数据缺失」。
4) 删除 OpsPage.tsx:1434 footer「轮换可能返回业务层失败（请求成功但结果未成功），此时会展示后端返回的原因。」
   与 ModelRouterPage.tsx:306 的同类 footer —— 「业务层失败」是后端概念，用户不知道是什么。
5) OpsPage.tsx:1598 的全局 Note 只在 rotate 与 config 两个分段显示，不要在 notify 分段显示
   （现在在配置通知渠道时也显示「轮换会重新分配账号」，完全不相关）。
6) OpsPage.tsx:423 页面描述「运行状态、定时任务、账号轮换、通知备份与网关配置」——
   这是把 5 个分段标签用顿号拼一遍。改写为一句真正的描述，例如
   「网关运行状态、定时任务与账号调度策略」。
7) 同类处理 OpsPage.tsx 与 TrafficPage.tsx 的其余「标签拼接式」description。
```

### 手动修 P1-006（CSS 幽灵）· 10 分钟

```
修三处 CSS 引用了不存在的东西——这三处证明页面生成后从未被人打开看过：

1) web/src/shared/ui/index.tsx:126  var(--rg-bg-primary)  →  var(--rg-bg-base)
   （已核实 token 层只定义了 --rg-bg-base）
2) web/src/shared/ui/index.tsx 中 var(--rg-state-ok)  →  var(--rg-state-success)
   （已核实只定义了 --rg-state-success）
3) web/src/features/ops/ClientAccessPanel.tsx:59 和 :142  使用 className="t-label"，
   但 global.css 从未定义 .t-label（已核实 0 命中），这两处标签当前没有任何样式。
   二选一：在 global.css 的组件层加 .t-label 定义（参照同文件其他类如 .t-value 的写法），
   或改成已存在的等价类。

4) 删除 web/tailwind.config.ts 的死配置：该文件定义了一整套 brand/ink/ok/warn/danger/line/surf
   palette，但 web/src 中 0 处使用这些语义色类（全部走 CSS 变量 + style={{}}）。
   它的第 3 行注释还指向不存在的 styles/tokens.css。
   → 删除整个 palette 定义块与该注释，只保留真正在用的内容（content 路径等）。

改完后运行 npx tsc -b && npm run lint 确认无回归。
```

---

## 第 2 批：接通已有后端能力，1 天

### 手动修 P1-002（首登引导）· 3 小时

```
建立 onboarding 状态机，修复首登后落入空白总览的死链。当前：
SetupGate 创建密钥 → 落进 OverviewPage:180「暂无账号数据」零下一步。

1) 新建 web/src/features/setup/onboarding.ts：
   导出一个 useOnboarding() hook，接收 SummaryProvider 的 summary 与访问密钥列表，
   返回 { steps: [{id,label,done}], next: {id,label,path} | null }
   步骤固定为：
   - 'account'  接入第一个账号   done: summary.accounts.length > 0
   - 'key'      创建访问密钥   done: listAccessKeys(kind='access').length > 0
   - 'verify'   验证链路可用   done: localStorage 标记 / 或 /status 探测成功

2) 在 AppLayout.tsx 的主内容区上方渲染一条进度条（仅当 next 存在时显示），
   文案形如「还差 2 步：创建访问密钥」，并给一个跳转按钮。
   完成全部步骤后自动消失。不要用弹窗打扰。

3) 修 ImportWbDialog.tsx:59：导入成功后不要直接关弹窗。
   改为在成功态显示「账号已导入（默认停用）」+ 一个「立即启用」按钮，
   点击后调 patchAccount(id,{enabled:true}) 并 onImported()。这解决
   「导入成功但账号是灰的、用户以为坏了」的死胡同。

4) CredentialsPage.tsx 的空状态按「首次使用」与「筛选无结果」两种情况区分文案与按钮（见 P1-003 第 3 条）。
```

### 手动修 B2（客户端接入三页互链）· 1 小时

```
修复「mint 密钥 → 配置 IDE → 验证」这条核心流程的断裂。当前：
AccessKeysPage 创建密钥后，本页 0 行提及 base URL；
ClientAccessPanel 藏在 /ops/config 第 5 个分段；TrafficPage 的连通性测试 0 行提及客户端接入。

1) AccessKeysPage.tsx：在「最近生成的明文」Panel 下方增加一块「下一步：配置你的客户端」，
   直接展示 baseUrl + curl 示例（从 /v1/admin/client-config 获取）+ 「验证连通性」按钮
   （跳转到 /traffic 并自动打开连通性测试表单）。
2) ClientAccessPanel.tsx：在 footer 增加一句「这些密钥在「访问密钥」页创建」+ 跳转链接。
3) TrafficPage.tsx 的连通性测试区标题旁增加一句「用于验证从「客户端接入」页复制的配置是否可用」+ 反向链接。
```

### 手动修 P3-002（接通审计与手动任务）· 2 小时

```
后端已实现但 UI 完全不可达的两个真实能力：

1) 新增只读审计页：
   - 后端已有 GET /v1/admin/audit（src/routes/admin-security.js:59），web/src 全库零调用。
   - 在 shared/api/admin.ts 加 getAudit(params) 封装。
   - 新建 web/src/features/security/AuditPage.tsx：表格列出
     时间/事件/结果/ip，路由 /audit，nav.ts 的「运维」分组下加一项「审计日志」。
   - 这是「谁在什么时候 reveal 了一把密钥」的唯一可见途径。

2) 手动触发定时任务：
   - 后端已有 POST /v1/admin/scheduler/:action（checkin/keepalive/probe），web/src 零调用。
   - 在 OpsPage 的「定时任务」分段顶部加一行三个按钮「立即签到」「立即保活」「立即探测」，
     点击后显示执行结果并刷新任务日志。
```

---

## 第 3 批：后端正确性，2 天

### 手动修 P0-001（丢失更新）· 3 小时

```
修复 src/credentials/store.js:206-231 的 update() 丢失更新问题。
当前实现是「get(id) 全列读 → merge → UPDATE 全部 34 列」，无版本保护、无事务、无 CAS。
任何并发的另一写入方（面板改 priority / scripts/login-key.js / 另一个 pick）刚写入的字段
会被本次 update 用陈旧快照覆盖回去。

要求：
1) 给 accounts 表加一个 version INTEGER NOT NULL DEFAULT 0 列（写进 db.js 的 ensureSchema，
   注意：现有项目用的是幂等 ALTER 模式，参考 db.js:19-192 已有写法）。
2) update() 改为条件更新：UPDATE ... SET <仅 patch 涉及的列>, version = version + 1
   WHERE id = ? AND version = ?；若 affected rows === 0，说明期间被改过，
   重新读取并重试（最多 3 次），仍失败则抛出可识别的错误。
   注意：acctToRow 目前是全列映射，需要新增一个「按 patch 键生成 SET 子句」的函数。
3) 修复 pool.js:725 与 pool.js:750：在 explainCandidates / snapshot 这两个只读函数里
   不要调 store.update 去裁剪 modelCooldowns。把裁剪结果返回给调用方，
   或者把裁剪下沉到 balance-refresh 定时任务里做。
   理由：GET /v1/admin/runtime 与 GET /status 都会触发这两个函数，
   而 /status 在 STATUS_PUBLIC=true 时是免鉴权的 —— 一个 GET 请求不应该产生 N 次数据库写。
4) 补测试：新增 src/test/store-concurrency.test.js，
   覆盖「A 改 enabled、B 改 priority，最终两个字段都生效」这个场景。

注意：node:sqlite 的 DatabaseSync 是同步的，单进程内 pick() 没有 await 窗口，
所以问题表现为「跨进程」和「多客户端同时写」两种场景，测试要按这个来构造。
```

### 手动修 P0-002（优雅停机）· 2 小时

```
当前：src/log/crash.js:78-83 的信号处理器在 writeEvent 之后立刻 process.exit(0)，
src/index.js 全文无 server.close()、无 flush。后果是在途 SSE 被硬切、SQLite 连接从不 close、
stats-cache/sticky/池冷却全丢，客户端看到的是「连接重置」。

要求：
1) src/log/crash.js：把 process.exit(0) 改为调用一个导出的 async shutdown(signal)，
   并给 5 秒超时兜底（超时则强制退出）。
2) src/index.js 实现 shutdown 链，顺序：
   a) 停止接受新连接（server.close()）
   b) 停止所有定时器：scheduler.stop()、balance-refresh.stop()、backup.stop()、zcode-rewards.stop()
      （若这些模块没有 stop()，需要补上）
   c) flush 日志：写一条 lifecycle 事件
   d) 关闭 SQLite：db.js 补一个 close() 并调用
   e) process.exit(0)
3) 补跨进程防重：新增 output/.trae-api/scheduler.lock 文件锁（进程启动时写 PID，
   启动时检查 PID 是否存活；或用 lock 文件 + mtime 心跳）。
   理由：start.bat 自己的注释承认可能出现「two schedulers run side by side」，
   而备份与轮换是非幂等的，重复执行有副作用。
4) 补测试：新增 src/test/shutdown.test.js，覆盖「收到 SIGTERM 后定时器被停、
   DB 被 close、在途任务不再新建」。
```

### 手动修 P1-008（默认限流）· 10 分钟

```
在 .env.example 的转发面章节加入：
# 访问密钥的默认每分钟请求上限（0 = 不限）。不设则任何持钥者可无限消耗真实额度。
KEY_DEFAULT_RPM=60
并在 src/middleware/rate-limit.js 的文件头注释里说明为什么默认值不再是 0。
如果希望代码层强制而非依赖 .env，则把 rate-limit.js:14 的 fallback 从 0 改为 60。
```

### 手动修 P1-004（OAuth 注入面）· 2 小时

```
src/credentials/oauth.js 的本地回调监听器（127.0.0.1:17388）存在凭据注入面：
- 第 152-155 行的 GET 分支调用 handleCallbackParams → completeLogin
- 第 245-260 行 completeLogin 在 state 不匹配时只打 console 警告（「仅告警不拒绝」）
- GET 分支没有 Origin 校验（POST 分支在 137-151 行有）

对比：POST /v1/credentials/oauth/complete 是有 state 校验的。

要求：
1) GET /authorize 分支同样强制 state 校验：state 不匹配时返回 400 并拒绝，不调用 completeLogin。
   删除「仅告警不拒绝」的逻辑。
2) GET 分支加 Referer/Origin 白名单（与 POST 分支同一份白名单）。
3) 考虑把回调参数改为仅接受 POST —— 如果上游 Trae 的 OAuth 流程允许，
   在 handleCallbackParams 里改成只处理 POST。
4) 补测试到 src/test/security.test.js：
   - 携带错误 state 的 GET /authorize 应返回 4xx 且不创建账号
   - 不带 Origin 的 GET /authorize 应被拒绝
```

---

## 第 4 批：产品取舍 + 文档，2 天

### 手动修 P2-001（成长中心）· 2 小时

```
先确认：这个功能对你来说是真需求还是 AI 加的？
如果是真需求（你确实想自动领 WorkBuddy 奖励）→ 只做下面的 (2)。
如果不是 → 删掉整个 GrowthPanel UI，保留后台 job 与通知。

无论如何都要做的 (2)：
删除 GrowthPanel.tsx 中的「抽奖」按钮（347-349 行）与「补登卡」列（279 行）、
「稀有度」列（276 行）、「Buddy」列（275 行）。
理由：一个叫 RelayGate 的网关界面里出现抽奖与盲盒元素，会让任何技术用户
对整个产品的定位产生怀疑。且 scheduler.js:578-602 已经在后台自动跑同一 job，
UI 上的「一键执行」是第二入口，自己还维护了一套 4 state/4 ref 的轮询状态机。
```

### 手动修 P2-002（幽灵配置）· 1 小时

```
model-fallback.json 当前完全没有消费者（已核实：config.js:27 读入、config.js:111 挂到
config.fallbackConfig、config.js:182 reload 时重读，除此之外全库无任何读取点）。
但这个文件声明了 autoFallback: true、queueThreshold: 300 和 14 组 claude→glm/qwen 降级映射，
用户会花时间配一个从不生效的策略。

二选一：
A) 实现它：在 dispatch 的选号/选模型逻辑里真正使用 fallbackConfig，并在 /ops/config 面板
   展示「当前降级链」与「命中次数」。
B) 删除它：删掉 model-fallback.json、config.js 中 fallbackConfig 的三处引用、
   .env.example 里相关注释，并在启动时如果检测到该文件存在就打一条警告日志。

同时删除幽灵 env（已核实全库零引用）：PROJECTION_ENABLED、PROJECTION_MAX_SYSTEM、
STATS_CACHE_OFF（真正生效的是 STATS_CACHE）。从 .env.example 移除这三项。

注意：TASK_LOG_MAX_ENTRIES 与 SCHEDULER_ENABLED 经核实是真实消费的，不要删。
```

### 手动修 P1-007（移动端）· 3 小时

```
当前 web/src 完全无响应式断点。AppLayout.tsx:34-35 是
`flex h-screen` + `<aside className="w-[216px] shrink-0">`，
390px 视口下主内容区只剩约 174px，而 CredentialsPage 是 10 列表格 —— 移动端完全不可用。

要求：
1) AppLayout.tsx：< 900px 时侧栏收为抽屉（汉堡按钮唤起），主区全宽。
2) CredentialsPage / OpsPage / TrafficPage / TokenStatsPage 的 table：
   < 768px 时改为卡片列表（每行一张卡，字段用 label: value 竖排）。
   可参考 design/relaygate-console/pages/*.html 里已有的表格卡片化原型。
3) OperationsPage 的移动端触控目标最小 44px（当前 Button size="sm" 是 h-6，太小）。
4) 验证：Chrome devtools 390×844 下走通全部 8 条路由。
```

### 补齐发布基线 · 2 小时

```
当前缺失：README、版本显示、changelog。这三项是「发布」的第一道门。

1) 写 README.md（根目录）：一句话定位、快速开始（clone → npm install → start.bat）、
   首次登录怎么拿密钥、常用操作路径、配置项说明（指向 .env.example）、
   常见问题（端口占用 / encrypt.key 丢失 / 上游限流）。
2) 版本显示：在 AppLayout 的侧栏底部（现在显示「可用 N」的那块）上方加一行
   `v{version} · {buildTime}`。version 从 package.json 读（注意根是 3.0.0、web 是 1.0.0，
   先统一成一个来源）。
3) 写 CHANGELOG.md：从 git log 提取最近 10 个 commit（2a2ec43 / 3df0b83 / 63d354d …），
   整理成用户能读懂的形式（不要用 commit message 原文）。
4) 清理 docs/：wb-ecosystem-comparison-2026-10-04.md 与 '...(2).md' 内容完全相同，删一份。
5) 删调试产物：web/dev.err.log、web/dev.out.log、web/_dev_v4.out、web/tsconfig.tsbuildinfo、
   web/.playwright-cli/。把它们加进 web/.gitignore。
```

---

## 其他

### 设计彻底重做（可选）

```
如果想在视觉层做一次真实的设计介入（而不只是修漏）：
/design-teardown
```

当前 `design/relaygate-console/` 里有 8 个静态 HTML 原型，与 React 实现并存但未对齐。
建议先决定：是按原型改 React，还是删掉原型。两者并存本身就是 AI 工作流残留的信号。

### 生成 GitHub issue

```
/github-issues from latest audit
```

本目录 `issues/` 下已生成 16 个 issue 文件（P0×2、P1×8、P2×4、P3×2），
可直接导入。需要先在仓库创建 `.github/workflows/ci.yml`：

```
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm test
      - run: npm --prefix web ci && npm --prefix web run lint && npm --prefix web run build
      - run: npm audit --audit-level=high
```

⚠️ CI 必须检查 exit code —— `unit.test.js` 失败时 stdout 仍会打印 `N passed`，
只看日志会把失败读成成功。

### 发布前检查

```
/ship-it-check full
```

**当前不建议发布**（Launch Readiness 42/100）。
建议在完成第 1-3 批后再跑一次本审计，届时预期 Overall ≈ 74。

---

## 分数追踪

```
product-professor record-score --auto "After initial audit"
product-professor compare
```

| 批次 | 预期 Overall | 关键变化 |
|---|---|---|
| 初始（基线） | 54 | — |
| 第 1 批（只改 UI） | 62 | UX 38 → 52；True Score 45 → 58 |
| 第 2 批（接通已有能力） | 68 | Product clarity 55 → 70 |
| 第 3 批（后端正确性） | 74 | 2 个 P0 清零；Security 55 → 68 |
| 第 4 批（取舍 + 文档） | 80 | Launch 42 → 75；AI 感 6.5 → 4.0 |