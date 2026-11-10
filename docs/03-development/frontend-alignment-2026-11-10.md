# 前端对齐参考实现（WorkBuddy-Switch）的对比分析与改造实施记录

> 参考对象：<https://github.com/koi128bit/WorkBuddy-Switch>（MIT 至 1.9.5，1.9.6 起为
> WorkBuddy Switch Attribution License 1.0）
> 审查对象：`web/src/`（74 个 `.ts/.tsx/.css`，21,011 行）
> 实施日期：2026-11-10
> 状态：**已实施并验证**（`tsc` / `eslint` / `check-css-tokens` / `vite build` 全绿；后端 309 + 89 条断言全绿）

---

## 0. 结论先行

参考仓库的**视觉层无法照搬**：它的 `src/` 是 Electron 渲染层，所有数据来自
`window.workbuddy` preload 桥（`desktop/preload.cjs` + `src/providers.ts`），
侧栏还有「客户端切换器」这类 RelayGate 没有对应概念的东西。
能借鉴的是**信息架构与交互契约**，不是代码。

七类问题里**三类是功能缺口、不是样式问题**，证据全部落在代码行上：

| 问题 | 根因（代码为证） | 修复性质 |
|---|---|---|
| 无法添加外部模型 API | 后端 `PUT /v1/admin/model-router/providers/:id` 早在 `src/routes/model-router.js:27`；前端 `shared/api/modelRouter.ts` **只有 deleteProvider**，面板只渲染删除按钮 | 纯前端 |
| 模型路由混乱 | `GET /v1/admin/model-router/route-check/:id`（`routes/model-router.js:145`）解释「这次会落到谁」，前端**零调用**；候选表嵌在单元格里且未加 `table-fixed` | 纯前端 |
| 账号保活不透明 | 后端 `scheduler.snapshot()` 一直在下发 `nextKeepaliveAt / nextProbeAt / checkinRoundRunning / dailyRuns`（`src/jobs/scheduler.js:59-60,730,964`），前端 `SchedulerSnapshot` **一个都没声明** | 纯前端（类型层丢字段） |

---

## 1. 逐问题：表现 · 证据 · 改进方向 · 实施结果

### 1.1 布局混乱

**表现**：全页同权重，看不出主任务；顶栏空转。

**证据**

- `AppLayout.tsx`（改造前）顶栏只有「页面名 + 秒级时钟」，两者都不承载操作。
- `CredentialsPage` 表格前堆三层（`stat-strip` → `rail` → `toolbar`）。
- `ModelRouterPage` 4 张表共 31 个 `<th>`，其中候选表是嵌在 `<td>` 里的第二张表，
  且**未加 `.table-fixed`**——列宽由内容反推，展开不同虚拟模型时整表横向位移。
- 全站无任何快捷键或命令入口（grep `Ctrl` / `⌘` / `CommandMenu` 为空）。

**实施**

| 改动 | 文件 | 依据 |
|---|---|---|
| 顶栏改「分组 › 页面」面包屑 + `Ctrl K` 命令框，时钟降级为次要 | `app/AppLayout.tsx:178-200` | 参考 `src/App.tsx:546-559` 的 `workspace-breadcrumb` + `command-trigger` |
| 新增全局命令面板：页面跳转 + 账号跳转，`↑↓ / Enter / Esc / Tab` 全套 | `app/CommandMenu.tsx`（新，约 260 行） | 参考 `src/CommandMenu.tsx`；本项目不引入 lucide，纯文本渲染 |
| 侧栏底部加版本号（`__APP_VERSION__` 早已在 `vite.config.ts` 注入，全仓零引用） | `app/AppLayout.tsx:191` | 参考 `src/App.tsx:538-541` |
| 候选表补 `table-fixed` + 8 列显式宽度（合计 704px） | `models/ModelRouterPage.tsx:601-618` | 本项目 `global.css` 的 `.table-fixed` 契约 |

命令面板**刻意只做只读跳转**：写操作需要上下文（哪个账号、哪把密钥、确认框），
塞进搜索框只会让误触代价上升。账号清单按需拉取（打开才拉，关闭即丢弃）。

### 1.2 账号管理困难

**表现**：找不到「改个名」「按额度排序」这两个日常动作。

**证据**

- `CredentialsPage` 的 `rows` useMemo 只有 filter、**没有 sort**（原注释「过滤与排序
  均为派生值」里排序是不存在的）；工具栏无排序控件。
- `AccountAttrsDialog` 提交的 patch 只有 `group / costTier / tags`，**没有 `label`**；
  而后端 `PATCH /v1/credentials/:id` 的 `ALLOWED` 白名单含 `label`
  （`src/routes/credentials.js:381-383`）。即：**账号导入后无法改名**，
  只能删了重导，而重导会换 id、丢「最近保活 / 签到」历史。

**实施**

| 改动 | 文件 |
|---|---|
| 工具栏加排序下拉：最近选用 / 额度低优先 / 到期近优先 / 按平台 | `accounts/CredentialsPage.tsx`（`SortKey` + `SORT_OPTIONS` + `rows` 内排序） |
| 弹窗加「显示名」字段并并入 PATCH | `accounts/AccountAttrsDialog.tsx` |
| 命令面板搜到账号后跳转带 `?q=`，凭据池首次挂载读取并预填搜索框 | `app/CommandMenu.tsx` + `CredentialsPage.tsx`（`useSearchParams`） |

排序的缺值处理统一用 `Infinity` 沉底，**不用 0**：0 会把「从未选用」排到
「刚刚用过」前面，正好把用户要找的那个藏起来。

### 1.3 积分统计混乱且缺乏直观参考性

**表现**：有数字没参照。46,347 是大是小、谁占大头、哪个平台压根没查过，都要点开才知道。

**证据**

- 总览「可用额度」卡面只有一个绝对值 + 一行 12px 灰字；按平台明细要展开才出现
  ——**判断「要不要点开」所需的信息恰好在点开之后**。
- `shared/lib/format.ts` 只有 `formatNumber`（千分位），无紧凑数字；全站 167 处调用，
  7 位数会撑爆 240px 的卡。
- `RingChart` / `BalanceBars` 等相对量图表零实现（grep 为空）。

**实施**

| 改动 | 文件 |
|---|---|
| `formatCompact`：≥1e9→B、≥1e6→M、≥1e3→K，三位有效数字 | `shared/lib/format.ts:75` |
| 新增 `ShareBar`：卡面混合占比条 + legend + 「N 个平台未计入」提示 | `features/overview/ShareBar.tsx`（新） |
| 新增 `creditShare()`：只统计 `unit==='credit'` 且非 raccoon 的行，`known===0` 的平台单列不进分母 | `shared/lib/overview-detail.ts` |
| 总览「可用额度」展开区把占比条放**最前**，逐平台绝对值在后 | `features/overview/OverviewPage.tsx` |
| 新增 `TokenMixRing`：非缓存输入 / 缓存读 / 输出三段环形图 | `features/stats/TokenMixRing.tsx`（新） |
| 用量页插到「每日趋势」之前；Token 总量卡改用 `formatCompact` | `features/stats/TokenStatsPage.tsx` |
| 新增 `.share-bar / .share-legend` 样式（复用既有令牌，不新增色值） | `styles/global.css` |

**三个必须遵守的口径**（写进了代码注释，防止后人改错）：

1. **缓存读是 prompt 的子集**。`promptTokens` 含缓存读（`log/stats.js:297` 直接累加），
   所以三段切法是 `prompt − cache` / `cache` / `completion`。把 `prompt` 与 `cache`
   并列画进去，总分会虚高一个缓存命中量——本项目实测缓存占 83%，那不是误差，是两倍。
2. **不可加的额度不相加**。Token / 配额 / 分池积分不参与积分占比条：量级差 4~5 个
   数量级，混进去会得到「WorkBuddy 占 99.9%」这种把量级差当比例的错误图。
3. **未查询 ≠ 0**。`known === 0` 的平台单独提示，不参与分母。

### 1.4 模型路由混乱

**表现**：配了虚拟模型，不知道一次请求会落到哪个上游、为什么。

**证据**

- `GET /v1/admin/model-router/route-check/:id` 返回 `wouldPick / usableCount /
  candidates[].reasons / failover`——「解释路由」的正解接口，前端零调用。
- 候选状态有 4 态 Chip，但「当前这次会选谁」看不出来。
- `rotateTopN` 的语义注释长达 20 行（事故复盘写进代码注释），用户读不到。

**实施**

- 每个虚拟模型行加「试算」→ `getVirtualRouteCheck` → 弹窗三块：
  **会选谁**（provider/model + 策略 + 可用数 + 倍率/窗口）、
  **逐候选判定**（可用 / 冷却 / 停用 / 不可用+原因，映射表 `REASON_TEXT` 复用）、
  **failover 配置**（maxAttempts / cooldownMs / switchOn）。
- 弹窗尾注明确「这是**此刻**的判定；找刚才那次失败要看请求日志的 `routedTo`，
  不要用本页反推」。

**实测**（隔离实例，19971）：

```json
GET /v1/admin/model-router/route-check/vm%2Fverify
→ wouldPick: { id:"verify-provider:m1", provider:"verify-provider", usable:true, reasons:[] }
   usableCount: 1
   failover: { maxAttempts:3, cooldownMs:20000, switchOn:[...] }
```

### 1.5 虚拟模型与上游模型管理不完善

**证据**：`VirtualModelDialog` 只支持 create；`failover` 三项后端完整支持但表单零暴露；
模型池「来源」筛选写死 3 档，Raccoon 模型筛不出来。

**实施**

- 模型池「来源」筛选改为**由数据派生**（`sourceOptions` 现算，带计数）：
  `type SourceFilter = string`，过滤条件只剩一条 `m.source !== source`。
  写死三档时新增平台必然漏改，且漏改表现是「筛不出来」而不是报错。
  → `models/ModelPoolPage.tsx:183-215`
- Provider 行加「编辑」（见 1.6）。

### 1.6 无法添加外部模型 API ← 最硬的缺口

**完整证据链**

```
后端：PUT    /v1/admin/model-router/providers/:id   src/routes/model-router.js:27   ✅
      DELETE /v1/admin/model-router/providers/:id   src/routes/model-router.js:43   ✅
前端：deleteProvider                              shared/api/modelRouter.ts:89     ✅
      upsertProvider                              grep 全仓 → 0 命中                ❌
面板：{p.type==='builtin' ? '内置，不可删除' : <Button>删除</Button>}   ModelRouterPage.tsx
空态文案：「第三方需在配置里新增 provider 条目后重载」← 等于让用户手改 JSON
```

**必须先说清的陷阱**：`src/model-router/dispatch.js:16-20` 的 `resolveApiKey`
**只读 `process.env[p.apiKeyEnv]`**，明文 `apiKey` 在 `normalizeProvider` 里被强制剥离
（`store.js:103-104`，M-S6 修复）。所以「添加外部 API」的正确形态是**填环境变量名**。

三种误用及确切症状（全部写进了弹窗常驻提示与列表措辞）：

| 用户做了什么 | 面板 | 请求 |
|---|---|---|
| 在 `apiKeyEnv` 里贴了 `sk-...` | 保存成功 | 401 `provider 缺少 API Key（apiKeyEnv=sk-...）` |
| 写了变量名但没写 .env | 保存成功，显示「已声明」 | 同上 401 |
| 写进 .env 但没重启进程 | 保存成功 | 同上 401（`process.env` 是启动快照） |

因此列表里 `hasApiKey` 的措辞从「已配置」改为 **「已声明 · 未验证」**——
后端 `listProviders` 的 `hasApiKey: !!p.apiKeyEnv` 只校验变量名存在
（`store.js:186-188`），不校验进程环境里有没有值。

**实施**

| 改动 | 文件 |
|---|---|
| `upsertProvider` + `VirtualRouteCheck` 类型 + `getVirtualRouteCheck` | `shared/api/modelRouter.ts` |
| 新增 `ProviderDialog`：新建/编辑、本地校验、内置 Provider 锁字段 | `features/models/ProviderDialog.tsx`（新，约 350 行） |
| Provider 面板加「新增 Provider」+ 行内「编辑」 | `models/ModelRouterPage.tsx:305-334` |
| 面板 footer 写清「密钥不落 model-router.json」 | 同上 |

内置 Provider 锁字段的理由：`normalizeProvider` 对 `builtin` 把 `baseUrl / models`
置 null，`builtin` 只认白名单 `trae|workbuddy|raccoon`——不在名单里会被**静默归一成
`trae`**（Raccoon 曾因此让 `sn-*` 模型打到 Trae 上游拿 4001）。改了不生效比不给改更糟。

**实测**（隔离实例 19971）：

```
PUT /v1/admin/model-router/providers/verify-provider
{ type:openai, label:"验证端点", baseUrl:"https://api.example.com/v1",
  apiKeyEnv:"VERIFY_KEY", models:["m1","m2"] }
→ 200 { id:"verify-provider", hasApiKey:true, models:["m1","m2"] }
GET /v1/admin/model-router/overview → providers 里出现该条 ✅
```

同时验证了一个**已知坑**：`PUT /v1/admin/model-router/virtual/vm/verify`（斜杠不编码）
会落到转发面鉴权返回 `401 Invalid access key`；`vm%2Fverify` 才 200。
前端 `upsertVirtual` 已用 `encodeURIComponent`，这条只是记录现象。

### 1.7 账号保活不透明

**表现**：不知道下一轮什么时候跑、上轮什么时候跑的、这轮是跳过还是真的都跑过了。

**证据**：后端 `scheduler.snapshot()` 下发 `nextKeepaliveAt / lastKeepaliveAt /
nextProbeAt / checkinRoundRunning / dailyRuns`（`src/jobs/scheduler.js:59-60,730,964`），
前端 `SchedulerSnapshot`（`shared/api/admin.ts`）**只声明了签到与轮换两组时刻**。

**实施**

| 改动 | 文件 |
|---|---|
| `SchedulerSnapshot` 补 12 个字段（含 `checkinRoundRunning`、`dailyRuns`、`lastError`） | `shared/api/admin.ts` |
| 新增 `KeepaliveSchedule` 排程条，置顶于保活看板 | `features/accounts/KeepaliveSchedule.tsx`（新） |
| 保活看板接入该条（保活看板外层去掉 `p-3`/`gap-4`，改由内层承载） | `accounts/KeepaliveBoard.tsx` |

**必须分流的第三种状态**：`SCHEDULER_ENABLED=false` 时 `nextKeepaliveAt` 恒为 null、
`dailyRuns` 恒空。若不区分，页面会对一个**故意关掉的调度器**报红字
「今日签到轮尚未执行」——把配置意图读成故障。实测隔离实例启动日志
`[scheduler] disabled`，`/runtime` 的 `scheduler.enabled = false`，此时走
「定时调度已停用」中性分支。

**两个实例的实测对照**

| 实例 | `scheduler.enabled` | `nextKeepaliveAt` | `nextCheckinAt` | 组件分支 |
|---|---|---|---|---|
| 19971（`SCHEDULER_ENABLED=false`） | `false` | null | null | 「定时调度已停用」 |
| 19972（`SCHEDULER_ENABLED=true`） | `true` | `2026-11-10 14:00` | `2026-11-11 01:00` | 「下次保活 …小时前/后」 |

第三行是**「本轮签到进行中」与「今日已签到」必须分开**：点「全部签到」得到
`claimed=0` 时，前者是 `checkin-lock` 里另一轮在跑（202 跳过、上游一次没请求），
后者是真的签完了。混成一句会把「没跑」读成「跑完了」。

### 1.8 密钥管理混乱

**表现**：一行 5 个同权重按钮；密钥的权限边界（scopes/resources/RPM/过期）页面上完全不可见。

**证据**

- `AccessKeysPage` 行内 `查看 / 轮换 / 重置 / 吊销 / 删除` 五个 `size="sm"` 平铺，
  只有「删除」是 danger——**「吊销」（不可恢复）与「查看」（只读）视觉权重完全相同**。
- 后端 `rowToKey` 下发 `scopes / resources / rpmLimit / expiresAt`，前端类型声明了，
  **页面一项都没渲染**（grep `rpmLimit` 只命中类型定义与注释）。
- `PATCH /v1/api-keys/:id` 后端一直有，前端没有客户端函数——
  「权限收窄」只剩「删了重建」，而那会打断已配好的 IDE。

**实施**

| 改动 | 文件 |
|---|---|
| `updateAccessKey` + `KEY_SCOPES`（6 项，与后端 `SCOPES` 逐字一致）+ `keyDaysLeft` | `shared/api/apiKeys.ts` |
| 新增 `KeyPolicyDialog`：scopes 勾选 + resources 多行 + rpm + expiresAt | `accounts/KeyPolicyDialog.tsx`（新） |
| 表格加「权限与配额」列（`N 项 · 资源 · rpm · 剩余天数`，超长截断 + title） | `accounts/AccessKeysPage.tsx` |
| 行操作改 2 主按钮 + `⋯`（权限与配额 / 重置 / 吊销 / 删除） | 同上 |

**三条写进 UI 的陷阱**

1. **platform 不可改**：不在 PATCH 白名单里。改平台等于悄悄扩大已分发密钥的适用范围
   → 弹窗里只读展示并写明「换平台请新建」。
2. **清空 ≠ 取消权限**：`scopes: []` 会被 `normalizeScopes` 回落成平台默认值。
   → 弹窗禁止提交空集合，并常驻说明「想彻底切断请用停用/吊销」。
3. **scopes 与 resources 是 AND**：scope 放行 + 资源不匹配仍是 403。

**实测**（隔离实例 19971）：

```
POST /v1/api-keys { label:'verify-key', platform:'trae' }
→ scopes:["models:read","models:invoke"] resources:["model:trae/*"]
PATCH /v1/api-keys/key_xxx { scopes:[...3项], resources:["model:trae/glm-*"], rpmLimit:30, expiresAt:+30d }
→ scopes 3 项 / resources 1 条 / rpmLimit 30 / expiresAt 生效 ✅
```

---

## 2. 借鉴来源 ↔ 落地对应总表

| # | 借鉴项 | 参考仓库位置 | 本项目落点 | 性质 |
|---|---|---|---|---|
| 1 | 顶栏面包屑 + 命令框 | `src/App.tsx:546-559`、`src/CommandMenu.tsx` | `app/AppLayout.tsx`、`app/CommandMenu.tsx` | 结构照搬，实现重写 |
| 2 | 侧栏底部「当前状态 + 版本」 | `src/App.tsx:510-542` | `AppLayout.tsx` 侧栏底 | 结构照搬 |
| 3 | 紧凑数字 `shortNumber` | `src/components.tsx:17-22` | `shared/lib/format.ts#formatCompact` | 移植 + 补 1e9 档 |
| 4 | 环形图（Token 构成） | `src/Charts.tsx:159-243` | `features/stats/TokenMixRing.tsx` | 重写（无图表库） |
| 5 | 条形对比（账号积分分布） | `src/Charts.tsx:245-287` | `features/overview/ShareBar.tsx`（混合条，更省高度） | 思路借鉴 |
| 6 | 指标卡三段式 | `src/components.tsx:196-217` | 本项目 `MetricGrid` + `MetricCard` 已有 | 已具备 |
| 7 | 账号行「主按钮 + ⋯」 | `src/Accounts.tsx:292-366` | `AccessKeysPage` 行操作（凭据池早已是此形态） | 推广既有范式 |
| 8 | 账号页排序 + filter | `src/Accounts.tsx:144-186` | `CredentialsPage` 排序下拉 | 部分移植（不做收藏，后端无该字段） |
| 9 | 配额占比小条 | `src/workspace.css:560-575` | —— | **未做**，见 §5 |
| 10 | 右侧详情栏（替代嵌套表） | `src/Accounts.tsx:390-423` | 模型路由改用弹窗（比侧栏更轻） | 变体 |
| 11 | 活动流 | `src/Dashboard.tsx:325-351` | —— | **未做**，见 §5 |
| 12 | **不借鉴**：客户端切换器 | `src/App.tsx:468-489` | RelayGate 是多平台网关，无「当前客户端」概念 | 丢弃 |
| 13 | **不借鉴**：毛玻璃 / 深色主题 | `src/tokens.css` | 本项目是浅色工程纸面体系，`global.css:1-140` 有完整 WCAG 对比度推导 | 丢弃（理由见 §6） |

---

## 3. 改动文件清单

**新增（7 个）**

| 文件 | 行数 | 职责 |
|---|---|---|
| `web/src/app/CommandMenu.tsx` | 258 | 全局命令面板（页面 + 账号跳转） |
| `web/src/features/models/ProviderDialog.tsx` | 348 | 上游 Provider 新增/编辑 |
| `web/src/features/accounts/KeyPolicyDialog.tsx` | 307 | 密钥权限与配额 |
| `web/src/features/accounts/KeepaliveSchedule.tsx` | 143 | 保活排程条 |
| `web/src/features/overview/ShareBar.tsx` | 89 | 额度占比混合条 |
| `web/src/features/stats/TokenMixRing.tsx` | 158 | Token 构成环形图 |
| `docs/03-development/frontend-alignment-2026-11-10.md` | 本文 | — |

**修改（10 个）**

`app/AppLayout.tsx`（重写顶栏与侧栏底）、`shared/api/modelRouter.ts`（+upsertProvider
+routeCheck）、`shared/api/apiKeys.ts`（+updateAccessKey +KEY_SCOPES +keyDaysLeft）、
`shared/api/admin.ts`（SchedulerSnapshot +12 字段）、`shared/lib/format.ts`（+formatCompact）、
`shared/lib/overview-detail.ts`（+creditShare）、`features/models/ModelRouterPage.tsx`、
`features/models/ModelPoolPage.tsx`、`features/accounts/AccessKeysPage.tsx`、
`features/accounts/AccountAttrsDialog.tsx`、`features/accounts/CredentialsPage.tsx`、
`features/accounts/KeepaliveBoard.tsx`、`features/overview/OverviewPage.tsx`、
`features/stats/TokenStatsPage.tsx`、`styles/global.css`（+share-bar）

**后端（唯一一处，修回归）**：`src/raccoon/index.js` 的注释——
原文注释里写了 `require('../raccoon')` 字面量，被 `unit.test.js` 的「全库无双向依赖」
正则匹配成 `raccoon/index.js <-> raccoon/index.js` 自环。改为不含该字面量的说明，
**零行为变更**。

---

## 4. 验证记录

### 4.1 前端工程门

```
cd web
npx tsc --noEmit -p tsconfig.json   → 0 错误
npx eslint src                      → 0 问题
node scripts/check-css-tokens.mjs   → 33 个引用全部有定义（令牌层 48 个）
npm run build                       → 成功
  index-*.css            35.94 kB │ gzip:  7.44 kB
  ModelRouterPage-*.js   29.26 kB │ gzip: 10.60 kB
  TokenStatsPage-*.js    30.48 kB │ gzip: 10.48 kB
  AccessKeysPage-*.js    17.40 kB │ gzip:  7.21 kB
  OverviewPage-*.js      14.48 kB │ gzip:  5.63 kB
  CredentialsPage-*.js  120.27 kB │ gzip: 39.19 kB
```

### 4.2 后端与契约测试

```
src/test/unit.test.js                 309 passed
src/test/security.test.js              53 passed
src/test/channels.test.js              49 passed
src/test/overview-detail.test.js       24 passed
src/test/frontend-entitlement.test.js  23 passed
src/test/entitlement-view.test.js      21 passed
src/test/wiring.test.js                20 passed
src/test/virtual-model-pool.test.js     9 passed
```

### 4.3 隔离实例真实 HTTP 验证

两个隔离工作区（`%TEMP%\rg-verify*`），`WORKSPACE_DIR` / `LOGS_DIR` / `PORT` 全部隔离，
验证后已删除；仓库 `model-router.json` 确认未被污染。

| 验证项 | 结果 |
|---|---|
| `PUT /v1/admin/model-router/providers/:id` | 200，overview 里可见 |
| `PUT /v1/admin/model-router/virtual/vm%2Fverify` | 200（未编码斜杠 → 401，已知坑） |
| `GET /v1/admin/model-router/route-check/:id` | 200，`wouldPick` 命中新建 Provider |
| `PATCH /v1/api-keys/:id`（scopes/resources/rpm/expiresAt） | 四项全部生效 |
| `/v1/admin/runtime` 调度启用/停用两态 | 字段齐全，分支正确 |

---

## 5. 未做的项（附理由，不是遗漏）

| 项 | 为什么不本轮做 |
|---|---|
| 账号表「额度」列的配额占比小条 | 需要 `packDigest.usableAmount` 与「包上限」两个值同屏。包的 `limit` 在 slim 投影里被丢弃（`entitlement-view.js#slimAccount` 只留聚合值），要做得先给后端摘要补一个 `capAmount` 字段。纯前端算不出来，硬算会得到一个和调度口径不一致的数 |
| 总览页「最近动态」活动流 | 数据源要合并 `task-log.jsonl` 与 `audit_log` 两张表并统一排序，是新的后端聚合端点（`GET /v1/admin/activity`）。前端拼两份异构日志会在分页与时间口径上出问题 |
| 模型生命周期列（`available/degraded/deprecated/...`） | `PATCH /v1/admin/security/catalog/models/:providerId/:modelId` 已实现，但 `catalog_models` 表的语义是「目录同步快照」，不是「用户手工状态」。加在模型池页会让人以为改的是上游真实状态。需要先在后端区分这两个来源 |
| OpsPage 拆成 5 条独立路由 | 影响面最大（1693 行、11 个 Panel、6 个 `useAsyncData` 共享状态）。改动会牵扯调度草稿、日志分页、轮换向导的全部状态提升，应当独立一批做并有单独回归 |
| 虚拟模型「编辑」（failover 三项） | 需要给 `VirtualModelDialog` 加 create/edit 双模式并回填候选列表。本轮先把入口最缺的 Provider 建/改补上；虚拟模型的编辑可以复用同一套表单骨架，下一批做 |

---

## 5A. 追补：权益总览上移到首屏（2026-11-10 追加）

### 5A.1 位置变更

| | 变更前 | 变更后 |
|---|---|---|
| 顺序 | 统计条 → 平台接入 → **凭据表** → 权益总览 → 成长 → 保活 | 统计条 → **权益总览** → 平台接入 → 凭据表 → 成长 → 保活 |
| 权益总览位次 | 第 4 块，需滚过整张凭据表 | 第 2 块，首屏可见 |

理由：进页面的第一问题是「各平台还剩多少、哪些快到期」，不是「怎么接入新平台」。
上移后 1440×900 首屏同时可见：统计条 + 权益总览（含汇总行与平台行）+ 平台接入 rail
+ 凭据表首行。

### 5A.2 顺带解决的重复

统计条原本就报「可用积分 / 可用权益包 / 7 日内到期」，而这三项正是权益总览的下钻
视图。上移后两者紧邻会变成同一屏两处相同数字。处置：

- 三项**移入权益总览的汇总行**（`RollupStrip`，新样式 `.ent-rollup`）；
- 统计条回归纯账号健康维度（账号 / 启用 / 停用 / 冷却 / 登录态）；
- 数字只留一处，口径仍用后端 `rollup`（`/v1/credentials?slim=1`），不在前端重算。

面板加了「收起 / 展开」，收起态保留一行摘要（积分合计 / 可用包 / 7 日内到期 / 平台数），
零额外请求（数据已在 `list.data` 里）。默认展开。

`Panel` 组件新增可选 `id`，让面板外的控件能用 `aria-controls` 指向它
（原先 `aria-controls` 指向不存在的 id，Chrome 会整条忽略）。

### 5A.3 浏览器实测中发现并修掉的三个真缺陷

这三条都是**上移之后才会在首屏撞见**的既有问题，此前藏在滚动线以下。

**① 权益总览行头与展开明细自相矛盾**

行头按 `packDigest` 显示「1/1 个账号有数据 · 47 个可用包」，展开却显示
「该平台没有可用的权益包」。根因：列表端点带 `?slim=1` 时 `packs` 被整体移除
（`entitlement-view.js#slimAccount` 解构丢弃），而 `CreditDetail` 只读 `packs`。
实测确认：

```
GET /v1/credentials?slim=1
  packs       : null
  packDigest  : { total:47, usable:47, usableAmount:3598, soonestDays:15, ... }
  packCaliber : credit
```

修复：`CreditDetail` 分两层兜底 —— 有 `packDigest` 无 `packs` 时用摘要出聚合表
（含合计行），并说明「列表端点带 `?slim=1`，为省带宽不下发逐包明细；逐包请点账号的
权益明细」；两者都没有才走原空态。修复后行头与明细数字一致（均 47 包 / 3,598 积分 / 15 天后）。

**② 保活排程条把「进行中」读成「0 新签 / 0 失败」**

`daily-run-state.mark()` 是**起跑即标记**（该文件头部明确写「写入时机：起跑即标记，
不是成功后才标」）。所以本轮进行中时 `ok`/`failed` 都还是 null，而文案一律渲染
「（0 新签 / 0 失败）」，与同一行上的「签到轮进行中」Chip 直接矛盾。
实测后端真值：`checkinRoundRunning: true`、`dailyRuns.checkin.at` 存在、`ok/failed` 为 null。
修复：进行中显示「本轮始于 HH:MM:SS（进行中，结果未出）」，结束后才显示计数。

**③ 排程条尾注抢行被视口裁掉**

尾注用 `ml-auto` 推到最右，1440 宽度下与左侧三项挤在同一基线，把行高撑高、
在 900 高的窗口里被裁掉。去掉 `ml-auto` 让它自然换行。

### 5A.4 实测方式

用 CDP 驱动 headless Edge（`Emulation.setDeviceMetricsOverride` 1440×900）真实渲染，
先写入 `sessionStorage.trae_key` 越过 SetupGate，再导航到 `/credentials` 截图；
交互用 `Runtime.evaluate` 点 `.ent-head` 验证展开、点「收起」验证收起态。
隔离实例（`WORKSPACE_DIR` / `LOGS_DIR` / `PORT` 全隔离）验证后已删除，
仓库 `model-router.json` 与 `.trae-api` 确认未被写入。

### 5A.5 改动文件

`web/src/features/accounts/CredentialsPage.tsx`（位置上移、统计条精简、`entOpen` 状态）、
`web/src/features/accounts/EntitlementOverview.tsx`（`rollup` prop、`RollupStrip`、
`CreditDetail` 双层兜底）、`web/src/features/accounts/KeepaliveSchedule.tsx`（进行中文案、
尾注换行）、`web/src/shared/ui/index.tsx`（`Panel` 加 `id`）、
`web/src/styles/global.css`（`.ent-rollup`）

---

## 6. 关于「不借鉴深色主题」的量化依据

参考仓库 `src/tokens.css` 是整套 Raycast Dark（`--bg:#19191c` / `--accent:#ff6b6b`）。
本项目 `global.css` 是浅色工程纸面，且每个语义色都带 WCAG 对比度推导：

```
success #0f7d59  白底 5.12 / 淡底 4.59 / 灰底 4.70
warning #a85800  白底 5.17 / 淡底 4.57 / 灰底 4.74
error   #c23a30  白底 5.33 / 淡底 4.55 / 灰底 4.89
```

换深色不是改一组变量：`--rg-*` 有 48 个定义、33 处引用，全部按「浅底 + 深字」
调过对比度；反向后每个值都要重算，且 `Menu.tsx:217` 的
`rgba(23,23,23,0.16)` 阴影、`Modal.tsx:136` 的遮罩、`SetupGate` 的 `#fff`
图标都要跟着改。这件事的收益（观感）与风险（可见性回归）不成比例，
应当作为独立主题工程，而不是搭在本次对齐里。

若确实要做，已算好的深色候选值（对照 `#17171a / #1f1f23 / #26262b` 三档底色）：

```
text-primary   #eeeef1   15.45 / 14.18 / 13.00
text-secondary #c9c9d1   10.87 /  9.98 /  9.15
text-tertiary  #9a9aa4    6.42 /  5.89 /  5.40
success        #46c39a    8.12 /  7.46 /  6.84
warning        #e0a44a    8.16 /  7.49 /  6.87
error          #f08a84    7.39 /  6.78 /  6.22
info           #8fb0ff    8.37 /  7.68 /  7.04
brand          #8894ff    6.58 /  6.04 /  5.54
```

全部 ≥ 5.4（12px 辅助文字要求 4.5），可直接落成 `[data-theme="dark"]` 块。

---

## 7. 上传前检查清单

- [x] `tsc --noEmit` 0 错误
- [x] `eslint src` 0 问题
- [x] `check-css-tokens` 33/33 有定义
- [x] `vite build` 成功
- [x] 后端 8 个测试文件全绿（509 条断言）
- [x] 新增端点逐个打过真实 HTTP
- [x] 隔离实例验证后清理，仓库配置文件未污染
- [ ] 真机目测：1440×900 下顶栏命令框不挤压面包屑
- [ ] 真机目测：凭据池工具栏加排序下拉后是否仍在 1366 一行内
- [ ] 真机目测：Token 构成环形图在 1280 宽度下不与 legend 挤成两行
- [ ] 真机目测：密钥表加「权限与配额」列后，1366 是否出现横向滚动

---

## 8. 缺陷修复：轮换通知缺失 + 虚拟模型可见性（2026-11-10 追加）

两个独立的缺陷，均由用户实测反馈触发。都不是配置问题。

### 8.1 轮换完毕后没有通知

**根因**：`runRotateAccounts`（`src/jobs/scheduler.js`）只有两条通知路径，
且**都以「有异常」为前提**：

| 位置 | 事件 | 触发条件 |
|---|---|---|
| `:440` | `rotate_fail` | 仅 `r.failed > 0` |
| `:458` | `rotate_inactive` | 仅存在今日活跃度为 0 的账号，且 `checkStatus()` 成功 |

于是「全部成功 + 所有账号活跃」这一最理想的情况**一条通知都不发**，
用户无法区分「跑完且一切正常」与「根本没跑」。

**修复**：

1. 新增事件 `rotate_done`（`notify/settings.js` 的 `EVENTS` + `notify/index.js` 的
   `EVENT_TITLES`），与 `rotate_fail` **互斥**：失败发 fail，全成功发 done。
2. `busy`（互斥锁占用）单列一个分支：它不是「完成」，不能推「轮换完成：0 个账号」。
3. 文案只用 `rotateAll()` 真实返回的字段 `{ ok, failed, results, skippedUids }`
   （见 `rotate-accounts.js#rotateAllInner` 末尾）。刻意**不**渲染「是否切回起始账号」
   —— 该状态没有作为返回值透出，凭猜写 `r.restored` 会永远显示错误结论。
4. **把活跃度核对从 `runRotateAccounts` 里拆出去**（`runRotateHeatmapCheck`）：
   `checkStatus()` 对每个 WorkBuddy 账号打一次上游（15s 超时），8 个账号最坏 120s。
   此前它 `await` 在主流程里，导致「轮换完成」这个结论要等两分钟才返回。
   现在不 await，后台跑，失败只 warn。

**实测**（隔离实例 + 本地 webhook 接收器）：

```
真实成功路径载荷：
{"event":"rotate_done",
 "text":"[relay-gate] 账号轮换完成：1 个账号\n详情: 账号轮换完成：1 个账号已切换，7 个按排除规则跳过\n成功: 1\n失败: 0",
 "payload":{"ok":1,"failed":0,"message":"账号轮换完成：1 个账号已切换，7 个按排除规则跳过"}}
```

三条分支用 stub 直接断言（比等真实轮换可靠，每轮要 8 账号 × 60s）：

```
ok   全部成功   → 期望 rotate_done，实际 [rotate_done]   message: 账号轮换完成：5 个账号已切换
ok   部分失败   → 期望 rotate_fail，实际 [rotate_fail]   message: 账号轮换 3 个成功 / 2 个失败；a：x
ok   互斥占用   → 期望 rotate_done，实际 [rotate_done]   message: 本次触发被跳过：另一轮账号轮换正在进行中。
```

### 8.2 密钥加了 router:read / router:invoke 仍看不到虚拟模型

**根因**：这两个 scope 在整个仓库里**只存在于定义处，没有任何一处消费**。

```
src/credentials/api-keys.js:25  'router:read',      ← 枚举定义
src/credentials/api-keys.js:26  'router:invoke',    ← 枚举定义
src/credentials/api-keys.js:34  all: [...'router:read','router:invoke']  ← 平台默认值
src/credentials/api-keys.js:395 INVOKE_SCOPES = ['models:invoke','router:invoke']  ← 仅「有其一即放行」
```

而 `/v1/models` 的虚拟模型可见性（`src/routes/models.js`）只看 platform：

```js
const allowVirtual = !req.platform || req.platform === 'all' || req.keyKind === 'login';
```

**实测复现**：

| 密钥 | scopes | 可见 / 虚拟 |
|---|---|---|
| `platform=all` | 默认 4 项 | 49 / **2** |
| `platform=trae` | +`router:read` `router:invoke` | 18 / **0** |

**修复**（两处，读与调分别生效）：

1. **可见性**（`routes/models.js`）：判据改为「platform **或** scope」——
   `isAdminView || isUniversal || hasRouterRead`。平台密钥额外做**候选层过滤**：
   只列出「至少有一个本平台候选」的虚拟模型，否则客户端会选到一个必然失败的模型。
2. **调用**（`middleware/model-access.js`）：采用**显式授予才收紧**的渐进语义——
   平台密钥默认 scopes 不含 `router:invoke`（`DEFAULT_SCOPES.trae = ['models:read','models:invoke']`），
   若硬性要求会导致所有存量平台密钥调虚拟模型立刻 403（行为回归）。
   所以：scopes 里**出现** router 系 scope 才要求 `router:invoke`；两个都没出现则沿用旧行为。

**修复后四态实测**：

| 密钥 | 列表可见虚拟 | 调用虚拟模型 |
|---|---|---|
| trae，无 router scope | 0（保持原行为） | 放行（旧行为） |
| trae + `router:read` | **2** | 403 `scope_missing:router:invoke` |
| workbuddy + `router:read` | 2（含 wb 候选的） | 同上 |
| all（默认 4 项） | 3（全部） | 放行 |

平台候选过滤实测：`vm/fix-test`（仅 trae 候选）对 workbuddy 密钥不可见，
`vm/wb-only`（仅 wb 候选）对 trae 密钥不可见，`vm/unified-chat`（两平台候选）双方都可见。

### 8.3 账号列表增加连登天数（位置修正）

> ⚠️ **本节经历过一次位置误判，记录在此以免重犯。**
> 第一版把连登加到了**凭据池列表**（`CredentialsPage`），那是错的：
> 连登是「成长计划 / 活跃度」维度的事实，与凭据（token、额度、到期）无关。
> 用户指出正确位置是 **运维 → 账号轮换 → 账号列表**（该页 `OpsPage.tsx`
> 的 `title="账号列表"` 面板，6 列：账号 / uid / 状态 / 当日活跃 / 说明 / 操作），
> 也就是「活跃地图的活跃度」那张表。第一版改动已全部回退。

**根因**：`RotateStatus.heatmap`（`GET /v1/admin/rotate/status` 的返回）里
每行只有 `score / isActive / level / statusText`——**没有连登天数**。
前端 `RotateHeatmapRow` 类型也没有该字段，因此账号列表只能显示「当日活跃」，
无法回答「这个号连续活跃多少天」。

**数据源的两个上游接口，不能混**：

| 接口 | 提供 | 用途 |
|---|---|---|
| `/activity/growth/heatmap` | 今日分数、`is_active`、档位文案 | 账号列表「当日活跃」列（原有） |
| `/activity/growth/streak` | `days`（连登）、`next_tier`、`next_tier_remaining` | 本次新增的「连登」列 |

heatmap **不返回** streak，必须单独调用 `fetchStreak`
（`workbuddy/cat-trip.js:385` 已封装好解析）。

**实现**：

| 层 | 改动 |
|---|---|
| `jobs/rotate-accounts.js#checkStatus` | 每个账号在 heatmap 成功后再调一次 `fetchStreak`，产出 `streakDays / streakNextTier / streakNextTierRemaining / checkedAt` |
| `jobs/rotate-accounts.js` 错误分支 | **错误行也带同一组字段（值为 null）**，保证行形状一致 |
| `shared/api/admin.ts` | `RotateHeatmapRow` 补上述四个字段 |
| `OpsPage.tsx#rotateRows` | 左连 heatmap 时把 streak 一并透传（此前只透了 score/level/statusText） |
| `OpsPage.tsx` 账号列表表头 | 「连登」列插在「当日活跃」与「说明」之间 |
| `credentials/db.js` | `checkin_streak_days` 列**保留但不再作为面板数据源**，注释标明正确落点 |

**三条失败边界（都实测过）**：

1. `streakDays: null` = 本次没取到（上游 `/streak` 报错或无权限），**不是 0**。
   渲染成「—」。0 的含义是「今天断了」，两者处置动作完全不同。
2. streak 失败**不影响** heatmap 行：两件事独立，一个挂了另一个照常显示。
3. 只在 heatmap 成功的账号上取 streak——连 heatmap 都失败的号再打一次
   streak 只会把失败时间翻倍（两次 15s 超时）。

**一个被实测抓到的形状缺陷**：第一版错误分支只 push
`{accountId, label, uid, error}`，没有 streak 字段；而前端用
`'streakDays' in row` 判断「后端是否支持连登」，于是**上游网络故障时
面板会误报「当前后端版本未下发连登字段」**——把一个网络问题说成了版本问题。
已改为错误行也带全字段（值为 null）。

**实测**（stub 上游 + 真实 `checkStatus`，两账号各自取值）：

```
成长号A: streakDays=14  nextTier=28d  remaining=14  score=25  isActive=true
成长号B: streakDays=3   nextTier=28d  remaining=25  score=25  isActive=true
判定 A=14: PASS    判定 B=3: PASS
```

上游失败时（stub 停止）：

```
{ score: null, isActive: null, streakDays: null, error: "fetch failed" }
→ 面板显示整行「—」+ 错误原因，不误报版本问题
```

**浏览器实测**（CDP + headless Edge，1440×900，`/ops/rotate`）：
账号列表出现「连登」列，值为数字时按分级着色（≥14 绿、≤0 警告色），
`title` 给出「连续活跃 N 天 · 距下一档还差 M 天 · 数据时刻」。

### 8.3.1 全列短横线的排查记录（2026-11-10 追加）

上线后用户反馈「连登列全是短横线」。**不是代码缺陷，是进程跑着旧代码**，
但排查过程暴露了一个真实的次生缺陷，一并修掉。

**排查顺序与结论**（都留有实测输出，不是推测）：

| 步骤 | 做法 | 结果 |
|---|---|---|
| 1 | 用生产库真实账号直接调 `fetchStreak` | **成功**，`days: 10`、`nextTier: 14d`、`remaining: 4` |
| 2 | 跑 `checkStatus()` 全量 | 8 个账号全部 `streakDays=10`，`streakReason=null` |
| 3 | 模拟前端 `rotateRows` 合并 | 8/8 命中，`streak=10` |
| 4 | 查进程启动时间 | **11:31:19**，而 `streakDays` 代码落地在 **11:31:47** → 跑的是旧代码 |
| 5 | 重启验证 | `heatmap` 全部返回 `streakDays=10` |
| 6 | CDP 提取渲染 DOM | 表头 `… / 当日活跃 / 连登 / 说明 / …`，每行连登 `10` |

**结论**：`RelayGate` 服务需重启才能加载新代码。生产实例由 Windows 服务
`RelayGate`（Automatic）托管，重启命令：

```
Restart-Service RelayGate        # PowerShell（管理员）
```

或 `services.msc` 里右键「重新启动」。重启会中断当前 GUI 会话，需重新打开面板。

**排查中修掉的次生缺陷：失败原因被吞**

第一版 `checkStatus` 里是：

```js
let streakDays = null;
try {
  const s = await growth.fetchStreak(info);
  if (s && s.ok) { /* 赋值 */ }
} catch { /* 保留 null */ }
```

问题：`fetchStreak` 本来会返回 `{ ok:false, reason, code }`（401 无权限／
`code≠0`／响应里没有 `days` 字段，三种情况区分得清清楚楚），但这段代码
**只判 `s.ok`、失败什么都不记**，`catch` 也是空的。于是界面上只有一整列「—」，
完全无法判断该去补权限、重新登录、还是改字段解析。

修复：`streakReason` / `streakCode` 一并透出，前端两处消费——

1. 单元格 `title` 展开「可能原因 / 上游业务码 / 检查时刻」；
2. 面板右上角汇总「N/M 个账号未取到连登：<原因前 40 字>」，
   整列空白时一眼能看见根因，不必逐行悬停。

**实测失败路径**（stub 上游返回 `code:40003`）：

```
streakDays = null
streakReason = 成长中心未开通
streakCode = 40003
PASS: 失败带原因
```

**另一个测试环境陷阱**（记下来避免重犯）：用复制出来的库起验证实例时，
若显式设置 `TRAE_API_ENCRYPT_KEY`，必须与 `output/.trae-api/encrypt.key`
一致；不一致会解出垃圾 token，上游返回 `401 openresty/APISIX` 的 **HTML**
（表现为 `Unexpected token '<'`）。正确做法是**不设该环境变量**，
让实例自己读库目录下的 `encrypt.key`。

### 8.4 验证汇总

```
后端：unit 316 / security 53 / channels 49 / growth 16 / growth-daily 16
      entitlement-view 21 / frontend-entitlement 23 / wiring 20  全绿
前端：tsc 0 / eslint 0 / CSS 令牌 33/33 / vite build 成功
隔离实例：所有验证用 %TEMP% 独立工作区，验证后删除，仓库 model-router.json 与 .trae-api 未写入
```
