# WorkDaddy 对标报告 —— 五大功能点的借鉴与复刻（2026-11-06）

> **对比对象**：[babygoton/WorkDaddy](https://github.com/babygoton/WorkDaddy)（CDP 注入型 WorkBuddy/CodeBuddy 桌面端增强助手，AGPL-3.0）。
> 已克隆至本地 `_refs/WorkDaddy`（仓库外，不入库），核心文件：`scripts/daemon.js`（13240 行，本地 HTTP API）+ `scripts/lib.js`（账号备份/切换）+ `scripts/secure-transfer.js`（加密导出）+ `scripts/growth-daily.js` / `growth-active.js`（成长只读汇总）+ `scripts/token-stats.js`（用量统计）。
>
> **本项目**：RelayGate —— 多平台账号池**网关**（无桌面端注入面，账号作为调度资源），React 管理面板。
>
> 两者的定位差异决定了复刻边界：WorkDaddy 的不少能力依赖「它跑在 WorkBuddy 旁边」（CDP 注入、监听 auth 文件、切换登录文件后刷新 renderer）。RelayGate 没有客户端进程可控，凡是**依赖客户端在场**的能力只复刻其「可独立成立」的那一半；凡是**纯上游 API + 本地数据**的能力全部复刻。

---

## 一、差距矩阵（WorkDaddy 五功能 → RelayGate 现状 → 本次动作）

| # | WorkDaddy 功能 | WorkDaddy 实现要点（文件:行为） | RelayGate 原状 | 差距定性 | 本次动作 |
|---|---|---|---|---|---|
| 1 | 方便切换账号（每客户端账号独立备份，点一下就切） | `lib.js:1886 switchTo()` 写登录文件；`daemon.js:12724 /api/switch` 切换后 CDP 刷新窗口 | ✅ 已有且更强：账号在 SQLite 池内按 FEFO/优先级自动调度（`pool.js:522`），另有「运维→账号轮换」的客户端轮换（`rotate-accounts.js:412`，逐账号验证 refreshToken→播种→切换→waitForIdentity 终态校验） | **无需复刻**：网关形态天然「点一下就切」由调度器完成；手动切换已有比 WorkDaddy 更严的终态校验（WorkDaddy 靠 CDP reload 确认，本项目靠 observation.json identity 轮询） | 无 |
| 2 | 无感登录新账号（免退出 OAuth） | `daemon.js:10584 /api/oauth/start`（POST auth/state）→ 浏览器授权 → `oauthPollOnce`（daemon.js:1442，轮询 auth/token + login/account）→ `saveSeamlessAccount`（daemon.js:1421，写 accounts/&lt;uid&gt;.info） | ❌ 缺失。WorkBuddy 只有「抓本机登录态 / 粘贴 .info」两条路，且 2026-09-24 后本机凭据加密、粘贴路实际不可用 | **核心缺口**：这是 WorkBuddy 当前唯一不需要客户端在场、也不需要解密的接入路径 | ✅ 复刻：`src/workbuddy/oauth.js` + 路由 `/v1/workbuddy/oauth/start|poll|cancel` + 前端 `WbOauthDialog.tsx` + 渠道注册表加 `oauth` 向导 |
| 3 | 账号导入导出（加密导出，跨机一键导入） | `secure-transfer.js`（v3 信封：gzip→AES-256-GCM，scrypt 密钥派生，随机 salt）+ `daemon.js:11248 export / 11285 import`（v1 兼容、uid 形态闸） | ⚠️ 只有**本机**全量备份（`jobs/backup.js`，密文绑定本机 `TRAE_API_ENCRYPT_KEY`，跨机解不开）；无「带走的账号导出」 | **结构性缺口**：备份密钥不出机器 ⇒ 备份文件换机无用 | ✅ 复刻：`src/credentials/transfer.js`（v3 同构信封，导出时解密→信封由用户密码保护；导入按 userId 去重、新号默认停用）+ 路由 `/v1/credentials/transfer/export|import` + 前端 `TransferDialog.tsx` |
| 4 | 成长计划与活跃状态（任务进度/签到/活跃/连登/Buddy/旅行） | `growth-daily.js fetchDailyProgress`（六端点并发）+ `normalizeDailyProgress`（任务四态/奖励 claimed+pending/manualTasks）+ `growth-active.js fetchGrowthStreak/fetchGrowthTodayActive` + `daemon.js:11147 /api/growth/daily-progress`（TTL 缓存 + 并发合并） | ⚠️ 部分：旅行 status-all、连登/抽奖 overview（`routes/cat-trip.js`），但**没有任务进度、当日签到、今日活跃的合并视图** | **半缺口**：上游端点本项目全都有（`cat-trip.js` 的 fetchTasks/fetchHeatmap、`wb-checkin.js`），缺的是 WorkDaddy 那张「一张卡片看全」的归一化与缓存 | ✅ 复刻：`src/workbuddy/growth-daily.js`（normalizeDailyProgress 口径与 WorkDaddy 对齐 + 缓存）+ 路由 `/growth/daily-progress` + overview 补 todayActive/todayScore + `GrowthPanel.tsx` 加每日汇总表 |
| 5 | Token 和积分用量统计（按天、按账号筛选、模型/账号排行） | `token-stats.js` 扫 `.workbuddy/projects` jsonl（按账号=会话 owner 归因）+ `credit-usage-store.js`（SQLite 按天）+ `daemon.js:11078 /api/token-stats?account=…` | ✅ 大部分已有且更细：`log/stats.js` 三维聚合（日/模型/账号）+ 官方账单对照 + 标定系数；**缺「按账号筛选」查询参数**（账单缓存文件名带 accountId 但聚合层没接） | **小缺口**：只差筛选入口 | ✅ 补齐：`/stats/daily|models|accounts` 加 `account` 参数（带筛选时绕过增量缓存）+ `official-daily.js dailyCredits(days, accountId)` + 前端 `TokenStatsPage` 加账号下拉（热力图刻意保持全账号） |

---

## 二、逐项实现说明（含与 WorkDaddy 的口径差异）

### 2.1 无感登录（新增 `src/workbuddy/oauth.js`，218 行）

**上游链路**（与 WorkDaddy `daemon.js:10589-10611 / 1452-1480` 逐行核对）：

```
POST {billing}/v2/plugin/auth/state?platform=workbuddy|workbuddy-ai
  → { code:0, data:{ state, authUrl? } }
浏览器打开 authUrl || {billing}/login/started?platform=…&state=…   ← 桌面端全程不动
GET  {billing}/v2/plugin/auth/token?state=…                        （轮询；code 0/200 且有 accessToken 才算完成）
GET  {billing}/v2/plugin/login/account?state=…  （Bearer + 可选 X-Domain）
  → { code:0, data:{ uid, nickname, phoneNumber, … } }
```

**与 WorkDaddy 的实现差异**（都有明确理由）：

| 维度 | WorkDaddy | RelayGate（本次） | 理由 |
|---|---|---|---|
| 落库形态 | 写 `accounts/<uid>.info` 备份文件（daemon.js:1421） | 写 `credentials` SQLite 库（`store.add/update`，AES-256-GCM 列级加密） | 网关没有「登录文件」概念；账号是调度资源 |
| 完成后状态 | 直接可切换 | `enabled=false`（与粘贴导入口径一致，verify 后启用） | 无感登录的 token 未做在线余额验证，直接进池会污染调度 |
| platform 参数 | `PROFILE.oauthPlatform`（workbuddy / workbuddy-ai / ide） | region 枚举映射：cn→`workbuddy`、global→`workbuddy-ai` | 本项目只有这两个区域；CodeBuddy IDE 的 `ide` 平台不在账号池范围 |
| 超时 | 600s + 结果保留 300s | 同（600/300，env `WB_OAUTH_TIMEOUT_SECONDS` 可覆盖，**调用时读**而非模块加载时读，测试可单测超时分支） | 同口径，可测性增强 |
| 网络抖动 | `httpJson` 抛错→ poll 500 | `poll` 返回 `{done:false, transient:true}`，前端计数提示但流程不中止 | WorkDaddy 的 poll 失败会打断轮询循环；这里对齐 RelayGate 的「瞬态失败≠终态」原则 |

**安全边界**：上游 URL 全部由 region 枚举→常量映射生成（复用 `wbAuth.billingBase`，与 SSRF 白名单原则一致）；token 只经内存传递，落库即密文；授权链接与 state 不写日志；会话过期后 `poll` 不再打上游（测试断言）。

### 2.2 账号加密导出/导入（新增 `src/credentials/transfer.js`，254 行）

**信封格式**（v3，与 WorkDaddy `secure-transfer.js:67-108` 同构，字段名区分品牌）：

```json
{ "rgExport":"RelayGate", "version":3, "exportType":"relaygate-accounts",
  "createdAt":"…", "kdf":"aes-256-gcm+scrypt", "compression":"gzip",
  "salt":"<base64 16B>", "data":"<base64: iv12 | tag16 | gzip(JSON)>" }
```

**关键设计差异**——WorkDaddy 导出的是**客户端备份文件原文**（本来就含 token 明文字段），RelayGate 库里是**列级密文**，所以多了一层「导出时解密」：

```
导出：store.get() 解密明文 → 组 payload → gzip → AES-256-GCM（密码+随机 salt 派生）
导入：解信封 → 明文凭据 → 用目标机自己的 TRAE_API_ENCRYPT_KEY 重新加密落库
```

这一点是**必须的**：WorkDaddy 的信封密码保护的是「客户端备份 JSON」；若本项目直接导出 `token_enc` 密文列，换一台机器（密钥不同）必然解不开——导出文件就成了废纸。因此明文凭据只存在于内存与加密信封内，绝不落任何磁盘明文文件。

**逐条对齐 WorkDaddy 的防御**：
- 密码必填、≤1024 字符（`requiredPassword`，secure-transfer.js:12 同语义）；
- uid 形态闸 `/^[A-Za-z0-9_-]{1,128}$/`（daemon.js:11342 的「uid 只能是账号文件名的一段」原则，本项目 uid 是 `user_id`，同闸）；
- 错误分层：`密码错误或导出文件已损坏`（GCM 认证失败不泄露细节）/ `不是 RelayGate 的账号导出文件` / `版本不受支持`；
- **访问密钥不导出**（WorkDaddy 只导账号备份，本项目 api_keys 表整体排除——密钥绑定本机审计与加密密钥，跨机搬等于搬门禁）；
- 导入按 `userId` 去重（WorkDaddy 按 uid 文件名去重），同 uid 更新凭据与元数据、新号默认 `enabled=false`。

### 2.3 成长每日汇总（新增 `src/workbuddy/growth-daily.js`，232 行）

**归一化口径逐字段对齐 WorkDaddy `normalizeDailyProgress`（growth-daily.js:28-112）**：
- 任务四态：`claimed / completed / in_progress / not_accepted`（completed 判据 = status 三态之一或 current≥target）；
- 奖励三计数：`claimed`（已领）/ `pending`（completed 未领）/ `total`（有 credit/energy 奖励的任务数）；
- `manualTasks`：名单外未完成任务 ≤8 条（`AUTOMATABLE_TASK_CODES` 14 个任务码与 WorkDaddy 同源）；
- 旅行进度：traveling=1、arrived=0.72、dailyLimitReached=1、locked/needs_selection 两特判态；
- Buddy 未解锁时只展示 `first_buddy`/`RichMeow_Chat` 两个任务（`LOCKED_BUDDY_TASK_CODES`）。

**本项目补充的三个口径**（WorkDaddy 分散在别的端点，这里并进同一响应）：
- `checkin.checkedIn`：来自 `wbAuth.checkinStatus`（`/v2/billing/meter/checkin-activity-status`，只读不消耗）；
- `active.todayActive/todayScore`：来自 `cat-trip.fetchHeatmap` 的 `data.today`（与 WorkDaddy `fetchGrowthTodayActive` 同一数据源，本项目零新增上游调用）；
- `active.streakDays`：连登天数（heatmap 的 streak 与 checkin-status 的 streak_days 取其一）。

**三条工程纪律**（WorkDaddy 注释明文，本项目照抄进实现）：
1. 只读，不调写接口（写动作仍归 `jobs/growth-auto.js`）；
2. 单账号 60s TTL 缓存 + 在途合并（`createDailyProgressCache` 与 WorkDaddy 同构，另加 `size()` 诊断）；
3. 失败账号标 `unavailable` + reason，不把「没查到」写成 0 分或「未签到」——测试专门断言 `todayActive=null ≠ false`。

### 2.4 用量统计按账号筛选（改 `routes/admin-traffic.js` + `models/official-daily.js`）

- `/v1/admin/stats/daily|models|accounts` 新增 `account` 查询参数：网关侧按 `traffic.jsonl` 的 `r.account` 过滤后走原聚合函数；**带筛选时绕过增量缓存**（`stats-cache` 的桶没有「账号→模型」二次维度，硬套会得到错误的模型分布——这是本项目自己的坑，不是 WorkDaddy 的）；
- 官方账单侧：`dailyCredits(days, accountId)` 按缓存文件名前缀 `<accountId>-<date>.json` 过滤（账单缓存本来就把账号编进文件名，等于白捡一个维度）；
- 前端：`TokenStatsPage` 顶栏加账号下拉（`全账号` + 逐账号），daily/models/accounts/official-usage 四个请求联动；**热力图刻意不带筛选**（单账号 17 周多为空白，全账号视图才有比较意义，页面描述里写明）。

**不复刻的部分**：WorkDaddy 的 token-stats 扫的是「客户端自己的会话日志」并按会话 owner 归因到账号；本项目对应的等价物是 `/stats/client`（WorkBuddy 本机会话日志，无账号归因——客户端日志本身没有账号字段，硬造归因就是伪造数据，已在响应里显式标 `scope:'local-device'`）。网关侧的账号归因（`r.account`）本项目反而更准，因为它是选号时刻写下的。

### 2.5 切换账号（不复刻，理由如上）

WorkDaddy 的价值在「客户端多账号」；RelayGate 的账号是池内资源，调度器每请求都在做「选号」，`/ops/rotate` 已有比 WorkDaddy 更严格的手动切换（切换前 refreshToken 终验 → 换种 → 切换 → observation.json identity 轮询终态校验，超时显式报 `unverified`）。WorkDaddy 的「假退出」（daemon.js:10537，退出客户端+删登录文件+重启）在本项目没有意义——网关从不持有「当前登录」状态。

---

## 三、验证

| 验证 | 结果 |
|---|---|
| `npm test`（19 套件，含新增 2 套） | ✅ 全绿（303+76+45+44+41+38+36+32+19+17+16+13+12+11+11+9+7+5+5 passed, 0 failed） |
| 新增 `src/test/wb-oauth-transfer.test.js` | 13 passed：信封往返/错密码/篡改/GCM/uid 闸/选择性导出 + 无感登录状态机（未授权→授权→落库→重复授权 updated→抖动 transient→超时不打上游） |
| 新增 `src/test/growth-daily.test.js` | 12 passed：任务四态/奖励口径/manualTasks/旅行三态/locked/needs_selection/null≠0/arriveAt 换算/缓存 TTL+force+并发合并 |
| `npm run build:web`（tsc -b + vite） | ✅ 95 modules，无类型错误 |
| `npm run lint`（eslint + biome） | ✅ exit 0（存量 warning 154 条均为既有文件，本次新增文件未引入新 error） |
| `channels.test.js` 回归 | WorkBuddy onboarding 断言更新为三路 `["local","oauth","paste"]`（oauth = 无感登录） |

**新增/修改文件清单**：

```
新增  src/workbuddy/oauth.js            无感登录状态机 + 落库
新增  src/credentials/transfer.js       v3 加密导出/导入
新增  src/workbuddy/growth-daily.js     成长每日汇总归一化 + 缓存
新增  web/src/features/accounts/WbOauthDialog.tsx
新增  web/src/features/accounts/TransferDialog.tsx
新增  src/test/wb-oauth-transfer.test.js（13 用例）
新增  src/test/growth-daily.test.js（12 用例）
改    src/routes/workbuddy.js           +/oauth/start|poll|cancel
改    src/routes/credentials.js         +/transfer/export|import
改    src/routes/cat-trip.js            +/daily-progress（+缓存诊断）；overview 补 todayActive
改    src/routes/admin-traffic.js       stats 三端点 + account 参数
改    src/routes/admin-channels.js      oauth onboarding 文案（WB 无感登录 vs Trae 回调）
改    src/models/official-daily.js      dailyCredits(days, accountId)
改    src/platform/variant.js           WB onboarding 加 'oauth'
改    web/src/shared/api/{stats,credentials,workbuddy,growth}.ts
改    web/src/shared/lib/channels.ts    WB 加 wb-oauth 向导
改    web/src/features/accounts/{CredentialsPage,GrowthPanel}.tsx
改    web/src/features/stats/TokenStatsPage.tsx   账号筛选下拉
改    src/test/channels.test.js         WB onboarding 断言三路
改    package.json                      test 链加 2 套件
```

---

## 四、未复刻清单与理由（WorkDaddy 其余能力）

| WorkDaddy 能力 | 不复刻理由 |
|---|---|
| CDP 注入面板 / 主题 / 免打扰 / 会话分支 | 依赖客户端进程在场；网关没有渲染进程可注入 |
| 会话迁移/复制（`session-sync.js` 55KB） | 操作对象是客户端会话库（workbuddy.db）；网关不持有会话 |
| 模型管理（备份/复制客户端 models.json） | 网关有自己的 model-router + 虚拟模型，语义更强 |
| 积分不足切换建议（`credit-rotation.js`） | 网关调度天然按余额/FEFO 选号，建议环节不需要——直接切了 |
| 模型限流解封时间展示 | 已有：模型级冷却（accounts.model_cooldowns）+ `upstream/errors.js` 解析 6004 恢复时刻 |
| 自动化任务（发现/导入/执行） | 网关等价物是 jobs/*（签到/保活/成长/轮换），无需再引一层 DSL |
| 防休眠 / 快捷短语 / 暂存提示词 | 客户端输入框增强，与网关无关 |
