# 更新日志

本文件面向使用者：只写「你关心的变化」，不写内部重构细节。
版本号见 `package.json`（面板左下角也显示当前版本）。

---

## Unreleased

### Linux 反代专用启动脚本 `start-relay.sh`：只跑转发面，不跑后台任务

- 新增 `start-relay.sh`：Linux/macOS 上以「纯转发模式」启动 —— 只提供 OpenAI /
  Anthropic / Codex 兼容转发与账号池选号，不注册任何后台定时任务。
- 实现方式：`src/index.js` 在 job 注册点新增总闸 `RELAY_ONLY=true`。原因：各 job 自带的
  `*_ENABLED` 开关优先级是「文件 > env > 默认」，`output/.trae-api/*-settings.json` 里
  写过 `enabled:true` 时 env 的 false 压不住（实测 balance-refresh / zcode-rewards /
  qoder-rewards 仍会启动），故在注册点一处截断。
- 不启动的后台任务：签到、token 临期扫描、保活、余额刷新、全量备份、成长中心、
  ZCode / Qoder / Raccoon 奖励与保活、账号轮换、客户端凭据同步。
- 仍保留：转发鉴权、账号池选号、转发链路里按请求触发的 token 续期（`ensureAuth`，
  这是转发成功的一部分，不属于后台任务）、日志保留清理。
- 用法：`./start-relay.sh`；端口/host 仍走 `.env`。

### WorkBuddy「7 个账号需重新登录」是误报：refreshToken 到期记录与凭据生命周期脱钩（2026-11-25）

- **现象**：面板凭据池与总览同时报「7 个账号需重新登录」；按提示重新登录其中一个账号后，
  该提示**没有消失**，那一行仍标红。
- **结论：误报**。8 个 WorkBuddy 账号全部有效 —— 逐个打计费面全部 200（余额 2658~3581），
  当日 1291 次转发 **0 个 401**。真正过期的是数据库里的 `refresh_expired_at` 这一列。
- **根因**：该列只在**导入那一刻**写一次，之后所有续期链路都不回写它
  （`ensureAuth` / `rotate-accounts` / `POST /refresh` / `auth-sync` 四处全部只写
  `token` 与 `expired_at`）。而 refreshToken 每次续期都会滚动换发一个新的 30 天值，
  于是导入满 30 天后这一列必然跨过 `now`，前端 `keepaliveOf()` 据此永久判
  「需重新登录」—— 一个只增不减、永不自愈的错误状态。
- **重登为何无效**：重登只更新 `token` / `expired_at`（这两列本来就对），
  那一列错的没人碰。实测该账号 `last_refresh_at` 已更新到 01:14，
  `refresh_expired_at` 仍是导入时的 `04:02:38`。
- **两处读侧放大器**：
  1. `readAuthFile()` 只读 `refreshExpiresIn`（相对秒数），忽略客户端文件里现成的
     绝对时间戳 `refreshExpiresAt` —— 拿 10 月 26 日文件里的「剩余 716 小时」加 `now`，
     会把已到期的凭据算到 2027 年；
  2. 上游续期响应只返回 `{accessToken, refreshToken, expiresAt}`，**不含**
     `refreshExpiresAt`，写侧即使想补也没有字段可取。
- **修复**（四层，缺一层都会复发）：
  - 写侧：`workbuddy/auth.js#refresh()` 从新 refreshToken 的 JWT `exp` 推出
    `refreshExpiresAt` 并返回；`auth/index.js`、`routes/workbuddy.js`（`/refresh` 与
    `/import`）、`jobs/rotate-accounts.js`（两处）、`jobs/auth-sync.js` 五个回写点全部补上。
  - 读侧：`readAuthFile()` 与 `auth-sync` 改认**绝对时间戳 → JWT exp → 相对秒数**三级优先。
  - 存量：新增 `credentials/refresh-expiry.js#repairWorkbuddyRefreshExpiry()`，启动时
    按 JWT exp 校正偏差超 1 小时的行，**两个方向都纠**（既修「已过期却还活着」，
    也修「记录比真值更晚」——后者会让到期告警被推迟，更危险）。幂等。
  - 判据：`keepaliveOf()` 与总览 `issues` 增加反证条件 ——
    `lastRefreshAt > refreshExpiredAt` 时判「到期记录陈旧」(warn) 而非「需重新登录」(danger)，
    界面上单独计数，文案指向「刷新 Token」而非「重新登录」。
- **效果**：`needRelogin` 7 → **0**；库内 8 行 `refreshExpiredAt` 与 JWT exp 偏差
  从 -700~-720h 收敛到 **0.0h**；新增契约测试 `src/test/wb-refresh-expiry.test.js`（16 项）。
- 完整取证：[SRC-01 WorkBuddy账号池需重新登录误报.md](审计报告/RelayGate/SRC-01%20WorkBuddy账号池需重新登录误报.md)

### Raccoon 限流误判修复：「IP 出口限流」结论被推翻，四因叠加才是真因（2026-11-25）

- **现象**：用官方客户端跑同一项目代码审计，11:29 起连续 40 分 42 秒 / 182 次调用
  全程无中断；而外接 API（本网关 `sn-*` 通道）通常十几分钟就被限流。
- **此前结论（已推翻）**：`raccoon/limiter.js` 头部曾论证「上游按**出站公网 IP**
  计并发」。决定性反证：同机同 IP 的两个账号，一个 429 一个 200 —— IP 假说当场证伪。
  真正的错误码是 **`200108`「系统检测到当前账号存在异常调用」**，即**账号级风控**。
- **四个叠加真因**：
  1. **模型名过期**：上游把 `sn-deepseek-v4-1-flash` 改成 `…-1017`、`sn-kimi-k3`
     改成 `…-1-pro`，而兜底表是硬编码的 ⇒ 每个请求 400 `param model unsupport`。
     （更隐蔽：旧名带 `X-Client-Name` 头时上游不报错，而是静默改写成默认模型
     `raccoon-090dd3` —— 计费与能力全变，日志里看起来一切正常。）
  2. **业务码正则只吃 3~5 位**，而小浣熊是 6 位码 ⇒ `200108` 被截成 `20010`、
     `100004` 被截成 `10000`，所有分类器失效，400 全落进 `'other'`，
     而 `'other'` 在默认 `switchOn` 里 ⇒ 每个请求放大成最多 **9 次**上游调用。
  3. **`200108` 未被识别**，只冷 300 秒，而上游 `Retry-After` 明示 **10800 秒（3 小时）**；
     且 `lib/upstream-error.js` 是 `cooldownMs || retryAfterMs`（本地优先），
     把上游真值覆盖成 5 分钟 ⇒ 冷却到点即撞 ⇒ 越撞越深。
  4. **60 秒硬超时砍断长回合**：`AbortSignal.timeout` 管的是**整条响应体读取**，
     不只是拿头。官方客户端自己的超时是 **1200 秒**。历史 324 条记录里
     **17 条（5.2%）** 回合是坏的（9 次 500 timeout 全落在 60020~60568ms；
     8 次 200 但 `finishReason=null` 的半截流）。且超时 abort 不带标记 ⇒
     被判成 `'other'` ⇒ **再触发一次换号重试**，成本翻倍再付一次。
- **修复**：
  - `upstream/errors.js` 业务码正则 `(\d{3,5})` → `(\d{4,9})`；新增
    `account_risk`（200108）分类，先于泛化 429；`100004` 归入 `model`；
    本地超时归入 `timeout`（先于 5xx，不可重试）。
  - `raccoon/product.js` 兜底表改用现行模型名；新增 `detectCatalogDrift`
    —— 拉到远端目录后比对本地 id，不一致就告警（只告警不改写）。
  - `raccoon/limiter.js` 识别 `200108` 并**采用上游 `Retry-After` 真值**；
    `account_risk` 不参与指数退避（否则 3h 会被 30min 封顶砍短）；
    新增 `riskCoolingReason()` 供面板/脚本区分「风控 3 小时」与「并发 5 分钟」；
    删掉「IP 出口限流」那节错误结论。
  - `lib/upstream-error.js` `Retry-After` 改为取 `max(本地, 上游)`。
  - `raccoon/dispatch.js` `MAX_ACCOUNT_SWITCHES` 3 → 2，且只有 `auth` 还会换号；
    `200108` 走 `scope:'account'`（不连带冻出口 —— 同机健康号不该被拖下水）。
  - `model-router` 默认 `switchOn` 去掉 `other`；`shouldSwitch` 显式拒绝
    `account_risk` / `timeout`；`health.markFail` 为 `account_risk` 单开分支，
    冷却取 `Retry-After`（上限 6h）。
  - `RACCOON_TIMEOUT_MS` 默认 60000 → **1200000**（对齐官方客户端）。
  - traffic 日志新增 `upstreamCode` / `timedOut` 字段；超时记 504 而非 502。
- **注意**：网关账号与官方客户端**很可能共用同一个上游账号**（实测 JWT `sub`
  完全相同）—— 网关把号撞进 3 小时风控，官方客户端会一起挂。
- 完整取证：[incident-2026-11-25-raccoon-throttle-misdiagnosis.md](docs/05-incidents/incident-2026-11-25-raccoon-throttle-misdiagnosis.md)

### 上下文窗口与输入守门：区分「物理窗口」和「网关软阈值」（2026-11-27）

用户反馈「改了上下文输入为 340K 后对话频繁压缩」。复查发现两个概念被混为一谈：

| 概念 | 含义 | 上游真值 |
|---|---|---|
| `context_window` | 模型**物理上**能装多少 token | **1,000,000**（model_catalog 实测） |
| 单次输入守门 | 网关**主动拒绝**超过该值的请求 | 345,600（旧默认） |

- **根因一：网关从不把真实窗口告诉客户端**。
  `src/routes/models.js:217` 只在 `vm.contextWindow` 有值时才发 `context_length`，
  而所有 raccoon 虚拟模型的该字段都是 `null` —— 客户端拿不到窗口，
  只能用自己配置里的默认值（实测某 profile 写死 180,000），于是 18 万就开始压缩。
- **根因二：单次守门的取值依据不牢**。旧值 345,600 是按「官方客户端最大
  228,418 × 1.5」推的，那个 1.5 是拍的，不是上游规定。
- **修复**：
  1. `output/model-router.json`：`raccoon` / `deepseekv4` / `sn-v4` 三个虚拟模型的
     `contextWindow` 及全部 raccoon 候选的 `contextWindow` 设为 **1000000**
     （取自 `model_catalog` 的 `params.context_window`，是上游权威值）。
     这样 `/v1/models` 会输出 `context_length: 1000000`，客户端不再过早压缩。
  2. `DEFAULT_MAX_INPUT_TOKENS` 345,600 → **512,000**。依据改为实测分位
     （707 次成功请求 p90=492,484 / p95=537,470），覆盖到 p90 以上。
  3. `DEFAULT_HOURLY_UNCACHED_BUDGET` 3,000,000 → **8,000,000**。
     基准：官方客户端 40.6 分钟 182 次、命中 97.3%、未缓存 959,677/小时，
     8M = 8.3 倍余量，保证 1 小时长对话跑得完。
- 新增默认值区间断言测试，防止以后拍脑袋调参。

### 并发上限降到 1 反而制造了 52 个假 502（2026-11-27）

昨天把 `DEFAULT_MAX_CONCURRENT` 从 3 降到 1，本意是「每账号串行，别在同一时刻
堆多条长上下文」。今早实测暴露了新问题：

- **现场**（`logs/2026-11-27/traffic.jsonl`，131 条）：131 次请求里 **52 个 502**，
  错误文案全是「账号全部在冷却或并发已满」。
- **关键指纹**：这些 502 的 `durationMs` 只有 **2~3ms** —— 毫秒级直接返回，
  **一次上游请求都没发**。它们不是上游限流，是网关自己把请求扔了。
- **根因**：`raccoon/dispatch.js#pickAccount` 里有一条
  `inFlightOf(a.id) >= maxConcurrent → 排除该号`。并发上限降到 1 之后，
  只要某账号有一条在途，第二条请求到达时 `usable` 直接为空 →
  `pickAccount` 返回 null → `run()` 立刻抛 502，
  **根本走不到 `limiter.acquire` 的 FIFO 排队逻辑**。
- **修复**：
  1. `pickAccount` 去掉并发排除 —— 并发控制交给 `limiter.acquire`
     （满了是**排队等**，不是**拒绝**）；粘性分支同样去掉，粘性号忙时应排队等它，
     跳号 = 换缓存池 = 11-25 事故形态。
  2. `DEFAULT_MAX_CONCURRENT` 1 → **2**（对齐官方单会话峰值 2；
     11-27 实测客户端 1 秒窗口峰值 5 条，靠队列消化即可）。
- 新增回归用例 8 条，并对「并发排除」做了变异测试（加回去 → 测试必红）。

### 输入预算守门：单次超大 prompt 与累计实算 token 都会推账号进风控（2026-11-26）

粘性修好之后存活时间从 4 分钟提升到 **4 小时 47 分钟**，但下午 16:02 仍撞了一次风控。
把重启后的 100 次请求拉出来看，问题换了形态：

| 指标 | 网关（11-26 下午） | 官方客户端 |
|---|---|---|
| prompt 中位数 | **513,950** | 133,591 |
| prompt 最大 | **563,082** | 228,418 |
| >400K 的请求 | **78 / 100** | 0 |
| 56.5 分钟累计未缓存 token | **5,227,605** | 650,175 / 40 分钟 |

- **根因一：`sn-*` 直连路径完全没有窗口守门**。
  `model-router#checkContextLimit` 只作用于虚拟模型路径，而 `sn-*` 在
  `routes/openai.js` 是提前 return 的 —— 56 万 token 的请求被原样发给上游。
- **根因二：没有任何累计量控制**。单次守门挡不住「一堆中等请求在半小时里累计超标」。
- **修复**：
  1. 新增 `raccoon/input-budget.js`：
     - `checkInputSize()` 单次输入上限（默认 **345,600**，官方实测最大 × 1.5）；
     - `checkHourlyBudget()` 每账号每小时**未缓存 token** 预算（默认 **3,000,000**）；
     - 只计 `prompt - cacheRead` —— 缓存命中不消耗算力，也不推动风控。
  2. 两条 Raccoon 路径（统一端点 sn-* 分支、显式端点）在发上游前做单次守门，
     超限返回 **400 `raccoon_input_too_large`**，文案含估算值与上限与调整方式。
  3. `raccoon/dispatch#pickAccount` 排除已吃满小时预算的账号；
     `run()` 成功路径按统一口径记账（`normalizeUsageForBudget` 覆盖流式/非流式两种 usage 形状）。
- 新增回归用例 7 条，并对「预算检查」「路由守门」两处做过变异测试。
- 修复过程中踩到一个真实缺陷：`routes/raccoon.js` 里工具变量名是 `reqTools`，
  我误写成 `tools` 导致 ReferenceError 被 Express 吞成 unhandledRejection
  （表现是请求挂死而非报错），已订正并加注释。

### 账号粘性缺失：Raccoon 每请求换号，把 prompt cache 打穿（2026-11-26）

上一轮修完「模型名过期 / 6 位码截断 / 冷却时长 / 超时」之后，实测仍然在
**4 分钟内**撞上 3 小时风控。复盘的结论是：**那四个缺陷是必要的，但不充分**。

- **现场**（`logs/2026-11-25/traffic.jsonl`，124 条）：16:23:03 → 16:27:03
  纯 `sn-deepseek-v4-1-flash-1017` 单一模型，4.0 分钟 54 次请求后两个号同时 429。
  - 请求速率 **13.5 次/分**（官方 4.5 次/分，3.0×）
  - 未缓存 token **193,017/分**（官方 15,995/分，**12.1×**）
  - 最忙 60 秒：16 次 / 208,391 未缓存（官方 8 次 / 27,949，**7.5×**）
- **根因：会话粘性在 Raccoon 直连路径上完全没接**。
  `routes/openai.js` 对 `sn-*` 是**提前 return** 的，而 `stickyKey` 的计算写在
  后面的「虚拟模型」段里 —— 那条路径根本走不到。于是
  `raccoon/dispatch#pickAccount` 退化成「最久未选优先」排序，**两个号严格轮流**：
  - 实测换号率 **36/53 = 68%**（几乎每个请求都在换）
  - 缓存按「账号 × 模型」隔离，换号等于换缓存池
  - 同号连续命中率 90.3%（平均 miss 8,356）vs 换号后 79.3%（平均 miss 15,856）
  - 单次最高 **107,415 token 全额重算**（16:26:37）
  - 而「异常调用」风控看的正是实算 token 量 —— 旧排序在**主动加速**风控触发
- **修复**：
  1. `routes/openai.js#handleRaccoonChat` 接收并透传 `stickyKey`/`stickyAccountId`；
     `sn-*` 分支在提前 return 前自己算一次；成功后 `sticky.bind()`（失败不绑，
     避免把会话钉死在风控中的坏号上）。
  2. `routes/raccoon.js` 显式端点 `/v1/raccoon/chat/completions` 同样补粘性
     （此前**完全没**有，与统一端点是同一个缺陷）。
  3. `raccoon/dispatch.js#pickAccount` 排序从「最久未选优先」改为
     **「最近用过优先」** —— 前者对无状态的 Trae 轮换是对的，对带 prompt cache
     的 Raccoon 是反的。额度分摊改由并发闸门与冷却机制保证。
  4. `DEFAULT_MAX_CONCURRENT` 3 → **1**（每账号串行，对齐官方客户端形态）。
  5. 候选 `maxRpm` 从 `null` 补到 **6**（官方峰值 7 次/分）；此前等于不限速。
  6. `raccoon` 虚拟模型：`weighted` → `priority`，非 deepseek 候选全部停用
     （保留条目可回滚）。此前它在 11-25 那次里混用了 4 个模型，
     缓存命中率只有 32.6%。
- 新增回归用例 6 条（`pickAccount` 排序口径、粘性优先级、两条路径的 sticky
  接线、并发默认值），并做过变异测试确认不是假绿。
- 文档：[raccoon-integration.md · 账号粘性](docs/02-technical/channels/raccoon-integration.md)

### 模型目录同步：「刷新」此前只刷了列表，没同步到派发候选池（2026-11-25）

- **根因追问**：上面那条「模型名过期」不是「本地忘了改名」，而是**架构上缺一条链路**：
  - **链路 A（列表）**：每次实时拉远端 `model_catalog` —— 永远新鲜；
  - **链路 B（派发）**：`model-router.json` 里的静态候选池 —— 可能是几个月前的；
  - A 与 B 之间**没有任何同步机制**，而真实请求走的是 B。
- **三处断点**：
  1. `POST /v1/models/refresh`（面板「刷新」按钮）只调 Trae 的
     `models/catalog.js`，函数体里连 `raccoon` 这个词都没有；
  2. `autotier.syncAutoTiers` 只拉 `trae` + `workbuddy`，且只写 `auto=true`
     的分层虚拟模型 —— `raccoon` / `vm/raccoon` 都是 `auto=false`，它根本不碰；
  3. `explainCandidates` 的不可用理由里**没有**「这个模型上游已不存在」，
     于是旧名候选在面板上一直显示「可用」。
- **修复**：
  - 新增 `raccoon/catalog-store.js`：远端目录**持久化快照**
    （`.trae-api/raccoon-catalog.json`）+ 漂移对账 + 候选重写。
    回退链从「远端 → 硬编码表」变成「**远端 → 快照 → 硬编码表**」。
  - 对账处置：可迁移的旧 id **改名**（只认显式迁移表，语义等价）；
    无法迁移的**禁用而非删除**（保留权重/置顶/优先级，可回滚）；
    上游新增的**只上报不自动入池**（加进去会改变用户的路由行为，那是产品决策）。
  - `POST /v1/models/refresh` 现在同时刷 Raccoon 并对账候选池，
    返回 `raccoon.totals = {renamed, disabled, available}`；前端 toast 会说出来。
  - 新增 `POST /v1/raccoon/models/refresh`（只刷 Raccoon，`?apply=0` 只看不写）。
  - `GET /v1/raccoon/models` 的 `source` 变三态 `remote` / `snapshot` / `fallback`，
    面板据此区分「数据是真的只是不是此刻的」与「这份名单可能已过期」。
  - `explainCandidates` 新增 `model_not_in_catalog` 不可用理由（有快照才判定，
    没快照=不知道=不阻断）。
- 文档：[raccoon-integration.md · 模型目录同步](docs/02-technical/channels/raccoon-integration.md)

### TraeWork 调自定义模型频繁报 4054：补心跳、改续写为流式、放宽 keep-alive（2026-11-25）

- **现象**：TraeWork CN 3.4.24 以自定义模型方式指向本网关，长回合对话经常弹
  「模型请求失败，请稍后重试。(4054)」，整轮作废需重发；同机 DSH 直连同一网关
  几乎不出现。
- **真实原因**：`4054` 是 Trae 客户端 `CUSTOM_MODEL_INTERNAL_ERROR` 的 catch-all，
  文案是「Custom model internal error occurred. Please check the proxy response for
  details.」。自定义模型走 `cloud_agent` 编排 + 本地 `custom-model-proxy` WebSocket
  隧道回传，**隧道中途断开**即触发。取证：6 次 4054 的当时网关都没有 Trae 请求在飞，
  当轮全部 200 —— 失败不在网关，在云端 ↔ 本地 harness 的隧道。DSH 是直连
  `localhost:19900`，不经隧道，所以从架构上产生不出该码。
- **但网关有三个放大器**（本次修复对象）：
  1. `AUTO_CONTINUE=true` 时 `emitDuringRound=false`，**整轮缓冲**到结束才发第一帧，
     首字节延迟 = 整轮耗时（实测 p50 4.9s / p90 19.1s / p99 45.5s / max 110s），
     而收益接近于零（6315 条 Trae 请求里 truncated 仅 1 条，0.02%）；
  2. 直连路径**完全没有 SSE 心跳**（心跳只在虚拟模型路径生效），于是「头已发 +
     零字节 + 最长 110 秒无流量」；
  3. `keepAliveTimeout` 走 Node 默认 **5000ms**，而客户端相邻请求间隔
     p50 11.5s / p90 35.3s，**57.6% 超过 5s** —— 一半以上的连接复用发生在
     服务端已 FIN 的 socket 上，写入落在竞态窗口就是「连接重置、无 HTTP 响应」。
- **修复**：
  - 续写改为「首轮边收边发 + 仅 `finish_reason=length` 时追加」，只把末帧 `done`
    挪到最后。续写是追加，与流式不冲突；`pool.run` 只在 auth/quota/rate_limit 上
    换号重试，那三类都在响应体被消费前抛出，故不会拼接两个候选的正文；
  - 新增 SSE 静默心跳（`SSE_HEARTBEAT_MS`，默认 15000，0=关闭），接入
    `/v1/chat/completions`、`/v1/messages`、`/v1/responses`。只在静默超期时补
    `: ping` 注释帧，**有字节流动时一帧都不发**；
  - `keepAliveTimeout` 默认 65000（`KEEPALIVE_TIMEOUT_MS` 可调），`headersTimeout`
    自动取 +5000（Node 要求前者严格更大，故不暴露第二个旋钮）；
  - **顺带修观测盲区**：401/403/429 此前完全不进 traffic 日志（实测：无效密钥 →
    401 → jsonl 行数 delta=0），现在落一行 `platform:'gateway'` +
    `rejectedBy:'gateway'` + `rejectCode`，与真实上游失败可区分。
- **不做**：不改客户端；不保证云端不掐断隧道（外部依赖的固有边界）。
- **测试**：新增 `sse-heartbeat.test.js`（17 项，已进 `npm test`），覆盖「有流量时
  零额外帧」「静默才补帧」「end 后不写」「write 契约透传」「headers > keepAlive」
  与「默认值覆盖实测 p90」。端到端探针 `scripts/probes/verify-sse-heartbeat.js`
  与 `verify-continue-streaming.js` 走真实路由 + 真实 fetch 读 SSE 字节，全绿。
- **复盘**：[docs/05-incidents/incident-2026-11-25-traework-4054.md](docs/05-incidents/incident-2026-11-25-traework-4054.md)

### 本机请求体超限不再伪装成「上游暂时不可用」（2026-11-22）

- **现象**：客户端报 `500: {"message":"上游暂时不可用","type":"upstream_error"}`，
  且网关日志里查不到这次请求。用户据此怀疑 WorkBuddy 风控封号。
- **真实原因**：不是上游、不是账号、不是风控。cf-server 会话一轮贴了 5 张
  2550×1243 截图（base64 后约 8.9MB）+ 39 个工具定义，JSON 转义后约 10.0MiB，
  刚好越过网关 `express.json({limit:'10mb'})`。网关 **66ms 内**在本地拒收，
  上游一个字节都没收到；但全局错误处理器为「不泄露上游报文」把状态强制改成
  500，于是「本机拒收」被渲染成「上游故障」，DSH 按 SERVER 语义重试 5 次全撞同一堵墙。
  而 handler 在路由之前返回，traffic.jsonl 里连一行记录都没有——「日志无记录」
  又把排障方向进一步推向「上游异常」。
- **修复**：
  - 上限改为可配 `MAX_REQUEST_BODY_MB`（默认 **16**，范围 1–64）。
    默认上调的理由：一张 2550×1243 PNG base64 后约 1.8MB，10MiB 只够 5 张，
    而 agent 一轮贴 5–8 张截图是常态；
  - 超限回 `413 + code=REQUEST_BODY_TOO_LARGE`，文案带「本机网关上限 / 实收字节 /
    未发往任何上游 / 怎么调」，调用方不会再误判成风控；
  - 非法 JSON 回 `400 INVALID_JSON_BODY`、不支持的 charset 回 `415 UNSUPPORTED_CHARSET`
    （此前同样被渲染成 500）；
  - 本机拒收的请求也落一行 traffic（`platform:'gateway'`、`rejectedBy:'gateway'`），
    与真实上游失败在统计里可区分。
- **顺带修**：直连 WorkBuddy 路径的 traffic 一律记 `status:500`，把 429（模型频控）
  与 400（上下文超限）抹平成 500。现在记真实下发状态，事后复盘不会把限流读成故障。
- **不做**：图片缩放（需要独立的图像预算链路，见 `known-limitations.md` F16）。
- **测试**：`security.test.js` +5（413/400/415 三种本机拒收路径与文案断言）。

### WorkBuddy 11128 复发修复：developer role 同步迁位（2026-11-19）

- **复发根因**：11-13 / 11-19 各 2 条真实 11128（`wb/hy4free`、`wb/deepseek-v4.1-flash`），
  但 11-10 的 system 迁位已在生效。时间对齐（`scripts/probes/wb-incident-join2.js`）显示
  两条 11128 的 DSH 请求都带 `reasoningEffort=high`；全量相关性：effort=high 的
  WB 请求 2/2 全 11128，effort 未设置 0/12。取证 DSH 适配层
  （pi-ai `openai-completions.js#convertMessages`）确认：**reasoning 模型在通用
  OpenAI 兼容 provider 上会把指令消息发成 `role: "developer"`**
  （`instructionRole = model.reasoning && supportsDeveloperRole ? 'developer' : 'system'`，
  未知 provider 的 supportsDeveloperRole 默认 true），而 11-10 的迁位只认
  `role: "system"` —— developer 形状整条绕过迁位，被上游内容校验拦下。
  真实上游复现：同一份 9.5KB system + 49 tools，`system` → 200、
  `developer` → 11128（`wb-incident-replay.js` 形状 F）。
- **修复**：`system-relocate` 把 developer 视为指令类 role——先归一成 system
  （内容零改动，只换 role 字段），再走同一条迁位链路；`identity-scrub` 的句级
  中和同样覆盖 developer。归一数量单独打日志
  （`[wb-chat] developer role normalized: N message(s)`），迁位未触发时也不会漏观测。
  真实上游验证：developer 长指令 + 49 工具 → 200（`wb-developer-fix-verify.js`）。
- **运行实例生效方式**：网关服务需重启后加载新代码；当前实例内验证已由
  进程内直打（`wb-direct-chat` 同路径）完成。
- **顺手同步指纹衰减**：本机客户端已升 5.11.3 / CLI 2.176.0（11-13 安装），
  `variant.js` 声明还停在 5.9.3。已 `check-wb-fingerprint.js --update` 并手动
  同步 UA 模板（版本衰减是 10-22 那批 11128 的成因之一，不消除会叠加暴露面）。
- **测试**：`unit.test.js` 327 全绿（+3：developer 迁位回归、短指令归一、
  scrub 覆盖 developer）。

### 额度口径与保活结论统一（2026-11-17）

- **计量列不再给同一个数字起两个名字**：除 ZCode 按 Token 计量外，Trae /
  WorkBuddy / Qoder / Raccoon 的上游单位都是积分（Qoder 是 `userQuota` +
  `addOnQuota` 两段 Credits，Raccoon 是 `points/v1/balance` 的 credit），
  因此计量列统一显示「积分」。此前 Qoder 标「配额」、Raccoon 标「points」，
  而同一行的说明写「赠送 2,587」「奖励积分 / 每日积分」，一个数两个名字。
  口径差别改由悬停的限定语表达（可累积 / 分两段 / 分池日清 / Token）。
- **合计判据从展示名改为内部键**：「可累积积分合计」（原「积分口径合计」）
  现在按 `caliber === 'credit'` 筛，只含 Trae + WorkBuddy。展示名统一后，
  任何按「积分」字符串筛的旧写法都会把 Qoder 与 Raccoon 误并进来
  （实测数据下会得 5,030 而非 980），已由测试钉住。
- **保活结论三态化，界面不再自相矛盾**：新增渠道能力位 `keepaliveMode`
  （`scheduled` / `not-needed` / `not-implemented`）。池卡片与渠道详情同一措辞：
  Trae / WorkBuddy / Raccoon 显示「参与定时保活」；ZCode 显示「无需保活」
  （上游 JWT 无 exp、不发 refresh_token）；Qoder 显示「不保活 · 到期需手动更新」
  （凭据 30 天会过期，但网关未实现其续期链路）。尾注逐态陈述，删掉了
  「Token 仍会按需续期」这句对 Qoder / ZCode 都不成立的兜底话。
  判据见 `docs/01-architecture/entitlement-units.md`，边界见 F15。
- **按需续期现在也写「最近保活」**：此前只有每日保活轮写该列，15 分钟一轮的
  临期扫描与请求前兜底续期成功却不写，导致凭据明明活着、面板却显示「尚无记录」。
  三条链路统一写展示位（结果标「ok（按需续期）」），判据位 `lastRefreshAt`
  的分工不变。
- **到期列不再替缺记录的账号担保**：`expiredAt` 为空现在分两种说法——
  ZCode 报「无 Token 到期概念」（上游确实不返回到期时间），其余平台报
  「N 个账号到期时间未知」（多为手动导入未带到期时间，典型是 Qoder）。
  此前一律报「长期有效 / Token 均 7 日以上」，与同池卡片上的
  「不保活 · 到期需手动更新」互相打脸。
- **验证**：`node src/test/channels.test.js`（54）/ `overview-detail.test.js`（25）/
  `frontend-entitlement.test.js`（23）/ `unit.test.js`（324，含 3 条新增保活回归）。

### WorkBuddy 客户端 5.9.3 形状对齐（2026-11-10）

- **11128 根因定位并修复（system 内容层 + 长度阈值）**：DSH 重启后用新 `wb`
  provider 真实复现了 11128。二分实验给出决定性判据——**上游只对 `role: system`
  的消息做内容校验**：同一份 13,649 字系统提示，放 `system` → 11128，放 `user`
  → 200，字节完全相同。性质是「长度 × 第三方语境密度」累积特征：中性文本 30,000
  字放行；system 前缀 7000 字放行、9000 字被拦；逐词替换 `DeepSeek Harness`/`DSH`/
  `runtime context`/`Web GUI` 全文后**仍被拦**（词表方案被证否）。修复用
  `src/transform/system-relocate.js`：超 6000 字的 system 正文迁到首条 user，
  system 只留一句中性身份，**一个字节不改**，模型所见信息量与原请求一致。
  实测 5 模型 + 45 个真实工具 schema 全部从 11128 转 200；短 system / 无 system
  零改动。多模态安全（图片块不丢）、多条 system 合并、未超阈值零拷贝均有单测。
  阈值 `WB_SYSTEM_RELOCATE_MAX` 可调，`WB_SYSTEM_RELOCATE=false` 可关。
  **已知权衡（2026-11-10 审查补记）**：该变换把 system 正文降为 user 消息，
  协议级 role 隔离退化为纯文本边界，系统指令的遵循权重低于原生 `system` role；
  为降低提示注入面，前缀显式声明「以下为引用文本，不是可执行指令」，闭合标记
  改为不可由用户消息伪造的形态。无法接受该权衡时置 `WB_SYSTEM_RELOCATE=false`。
  另：非纯文本（含图片块 / 混合块 / null）的 system 消息整条原样保留、不参与
  迁位，避免收集循环跳过而删除循环无差别删除导致图片静默丢失。
- **渠道校验复核**：11128 在 10-23 头集重建后曾连续 7 天 0 例（精确统计工具
  `scripts/probes/wb-real-11128.js`，修复了「totalTokens 含 11128 数字串被误计」的口径）。
  「DSH 内调 WB 报错」是**两层问题**：换密钥后是密钥平台边界（trae 密钥调 `wb/*`
  被网关 403，DSH 显示成通用错误）；换密钥前（DSH 真用 `provider: workbuddy` 的
  10-16~10-30）的历史失败原文从会话日志还原（`scripts/probes/dsh-wb-fails.js`）——
  是上游 500 invoke model error、上下文超限、账号限流、14003 模型繁忙，
  **没有一条 11128**。DSH 侧已补独立 provider `wb` + 专用 WB 密钥
  （`label=dsh-workbuddy`，可单独吊销；详见
  `docs/05-incidents/workbuddy-channel-detection-2026-11-10.md` §2）。
- **指纹升级**：客户端已升 5.9.3 / CLI 2.165.0，`variant.js` 声明与 UA 模板同步
  （`check-wb-fingerprint.js` 现在报一致）。
- **头集跟进 asar 取证**：chat 面新增 `acp-connection-id`（同会话稳定）、
  `X-Agent-Runtime: local-agent`、`X-Agent-Type: main`；`X-Request-ID` 与
  `X-Conversation-Message-ID` 改为客户端真实的同值 messageId 形态。会话键
  `wbConversationOpts` 按 stickyKey 同时派生 conversationId 与 acpConnectionId。
- **identity-scrub 两处修正**：① 官方身份跳过从「整条消息」改为「句级」——
  否则长系统提示里只要说明性提到 WorkBuddy 一词，整条提示免检；② 改写句保留
  首尾空白，修复改写后与相邻句粘连（`GUI.You are`）。
- **密钥修复**：`updateKey` 改 label/scope 时不再把 `platform` 列写丢（丢失后
  平台密钥会变成跨平台语义错乱）。
- 新探针：`dsh-wb-e2e`（DSH 形态端到端）、`dsh-key-matrix`（密钥×模型矩阵）、
  `wb-direct-chat`（绕过运行中服务、直打上游验证新头集）、`wb-fail-scan`、
  `wb-errorcodes`。全量测试 310+ 全绿。
- **审查根因修复（2026-11-10，首轮 SPEAR 66 → 全量回归）**：
  - `src/lib/upstream-error.js`（新增）：统一上游错误出口，客户端只回泛化文案 +
    结构化 code/Retry-After，上游原始报文全量进服务端日志；网关自产的「无账号
    怎么接 / 冷却怎么退避」指引通过 `err.gatewayError` 原样保留，不影响可行动性。
    接入 `openai` / `raccoon` / `workbuddy` 路由、`raccoon/stream` 错误帧与
    `index.js` 全局兜底。
  - `raccoon/limiter.js#release()` 唤醒排队者前复核 `blockedFor()`，冷却期间批量
    reject（不再把一次撞墙放大成 N 次）；abort 监听改为按 `waiter.onAbort` 精确移除。
  - `transform/system-relocate.js`：收集/删除循环统一用 `isTextOnlySystem()` 判据，
    非纯文本 system 原样保留；迁位前缀声明引用语义、闭合标记不可伪造。
  - `routes/models.js` 虚拟模型可见性与 `middleware/model-access.js` 判据同源
    （`router:read|router:invoke` + `providerAllowedForKey(getProvider())`）；
    Raccoon 目录改用 `pickCatalogAccount()`，不再被冷却/并发过滤误伤。
  - `routes/openai.js#handleRaccoonChat` 改为逐字透传 `req.body`
    （`reasoning_effort` / `thinking` / `seed` 等不再静默丢失），`max_tokens` 用原值。
  - 其余：`RaccoonChatError.headers` 与 `Retry-After` 归一、identity-scrub 句级
    判定顺序、OAuth 去重按 edition 收口、Anthropic 文本块补 `content_block_start`、
    `http.ts` abort 原因按请求局部持有、显式端点复用 `res.locals.clientSignal`、
    空 catch 补日志、死代码/重复注释清理、前端补 `raccoonStatus` / `raccoonLimiter`
    类型与消费、伪测试断言改为无条件真实断言。

### 新功能（对标 WorkDaddy 的五大功能点）

- **无感登录新账号（WorkBuddy 免退出 OAuth）**：凭据池新增第三条 WorkBuddy 接入路——
  不退出当前账号、不动本机客户端，点「接入 → 无感登录新账号」在系统浏览器完成授权后，
  新账号自动加入凭据池（默认停用，验证后启用）。国内版 / 国际版可选；授权链接 10 分钟有效，
  授权完成前面板每 2 秒自动查询结果，无需手动提交任何东西。
- **账号导入 / 导出（跨机迁移）**：凭据池页新增「导入 / 导出」。导出用你设置的密码 +
  随机盐做 AES-256-GCM 加密（gzip 先压缩后加密），生成 `RelayGate-账号导出-日期.json`；
  在另一台机器的 RelayGate 里选文件、输密码即可导入。按账号 uid 去重：已存在的号更新凭据，
  新号默认停用。导出文件含可恢复登录态的 token，请像密码一样保管；访问密钥不导出。
- **成长每日汇总（一张卡片看全）**：成长中心新增「成长每日汇总」表——成长任务进度（含
  「N 项需真实操作」提示）、当日签到、今日活跃（热力墙 is_active）、连续活跃天数、
  Buddy 解锁与旅行状态，全部账号一次出全。查询带 60 秒缓存，打开面板不会把上游打满；
  失败账号如实标「查询失败」，不会把没查到写成零分或未签到。
- **用量统计支持按账号筛选**：「用量与成本」页顶栏新增账号下拉——按天 Token/积分、
  模型排行、账号排行、官方账单四块全部联动过滤（热力图保持全账号视角）。
- **账号切换说明**：WorkDaddy 的「点一下切账号」在本项目里由两套机制覆盖——转发调度
  （每请求按 FEFO/优先级自动选号）与「运维 → 账号轮换」（客户端轮换，带登录态终态校验），
  无需新增入口。详见 `docs/06-deliverables/comparisons/workdaddy-adoption-2026-11-06.md`。

### 修掉的问题

- **「不可用」的模型状态混了三件事：媒体模型被误判、账号套餐被记成模型下线（2026-11-08）**：
  面板上有一批 WorkBuddy 模型长期挂红，实际是三种不同情况被同一个 `unavailable` 混在一起：
  1. **图片/视频生成模型被 chat 探活误判**（`hunyuan-image-alpha` / `kling-video-v3` /
     `minimax-video-h3` / `hunyuan-image-alpha-edit`）：它们在目录里，但推理后端是
     `hunyuan-stream` / `maas`，**没有 chat 端点**，拿 chat 探必然回 11103
     「Backend is not supported」。这不是模型不可用，是探活方式错。现在按
     `tags` / `videoGeneration` 分类（`isChatModel`），探活与转发都跳过，
     面板单独显示为「媒体模型」。
  2. **套餐额度不足被记成模型下线**（`kimi-k3.1-pro`）：PlanLimit 1005 是账号/套餐
     维度结论，换号或升级立刻可用。TTL 从 7 天改为 6 小时，原因前缀标 `[套餐层]`。
  3. **目录已下架的僵尸条目一直留着**（`wb/hy4-preview` 等）：新增按目录对账
     （`availability.reconcile`），带「目录条目过少则跳过」的截断保护。
  真正「目录有、chat 服务没有」的 11102（`glm-5.0` / `glm-4.6` / `glm-4.7` /
  `minimax-m2.5` 等 8 个）判定本来就是对的，未改。
  同时 `/v1/models` 改用 WorkBuddy 动态目录（此前只映射静态名单，与面板口径分叉：
  多出 7 个已下架 id、少了 14 个新增 id）。系统梳理见
  `docs/02-technical/model-subsystem.md`。
- **模型相关面板页对齐后端能力（2026-11-09）**：后端引入「媒体模型」档、套餐层结论与
  动态目录后，前端有三处没跟上，已修：
  1. 状态筛选缺「未探测」，且三档各写一条 `if` 判断——新增一档必漏一行。改为单条比对。
  2. 媒体模型仍显示「探测」按钮，点了必然 11103。改为显示「无 chat 端点」。
  3. `[套餐层] PlanLimit: 套餐额度不足 (1005)` 原样裸露方括号。改为前缀渲染成标签，
     正文保留后端原文（错误码是排查依据，翻译掉就搜不到了）。
  另修：指标卡口径不闭合（总数 − 可用 = 13，但不可用只有 9，差的正是 4 个媒体模型，
  现在总数卡显式列出）；`least_balance` / `chat_v3` / `model-router` 等机器标识改为中文名
  并保留原值；空态指向了不存在的「同步目录」按钮；清理确认框说「所有模型」但媒体模型
  根本不写可用性表。审查报告见 `docs/04-reviews/ui-review-2026-11-09-model-pages.md`。
- **单个后端模型提示「API 密钥失效」、只剩聚合虚拟模型可用（2026-11-07）**：
  直接调单个模型（如 `glm-5.3` / `doubao-1-6` / `wb/glm-5.3`）返回 403
  `auth_error`，客户端把它显示成「API 密钥失效」；虚拟模型（`vm/long-context`
  等）一切正常——因为虚拟模型分支不做平台与 scope 判定。两个叠加根因均已修复：
  1. **密钥 scope 被迁移脚本写坏**：`ensureModelsReadScope` 此前把「scopes 为空」
     的历史密钥写成只剩 `models:read`，单模型调用要求的 `models:invoke` 缺失。
     现在空值按平台默认物化（含 invoke），已写坏的行由新增的
     `ensureInvokeScope` 在启动时自动修复。
  2. **「WB 独有」判定只看静态名单**：`glm-5.3` / `glm-5.2` / `kimi-k2.6` /
     `minimax-m2.5` 等名字 WorkBuddy 名单里有、Trae 上游**同样服务**（实测
     可调），却被判成平台不匹配而 403。新增平台归属事实源
     （`models/platform-ownership`）：Trae 上游目录（含隐藏项）+ 实测记录 +
     可用性表三路证据，任何一路命中即不再判独占；真 WB 独有（`hy3` /
     `hunyuan-chat` 等，Trae 实测明确不可用）仍被正确拒绝。
  通用密钥的同名模型分派同步修正：`glm-5.3` 现在按 Trae 走（不再白占
  WorkBuddy 配额），`hy3` 仍走 WorkBuddy。修复脚本：
  `node scripts/repair-model-key-access.js`（幂等，可反复跑）。
- **虚拟模型一轮调用多个工具时整轮失败（`Unexpected non-whitespace character after JSON`）**：
  虚拟模型的流式出口给每个工具调用的 `tool_calls[].index` 都发了 0，客户端
  （DSH 等）按 index 聚合参数，把两个调用的参数拼成 `}{...}` 一条流，
  JSON 解析在第二个对象处报错，两个调用一个都没执行。单工具轮次不受影响，
  所以平时看着正常；修复后每个调用的 index 递增，各自独立。
  Anthropic 出口（`/v1/messages`）的同族问题（文本块与工具块共用
  content_block 序号 0）一并修复。详见
  `docs/05-incidents/incident-2026-11-06-toolcall-index-collision.md`。
- **关机跨过签到时刻，开机后当天会补跑**：定时签到此前只算「今天/明天 HH:mm」，
  已过点就顺延到明天，而「今天跑没跑过」记在进程内存里，重启即失忆。
  于是「夜里关机 → 次日上午开机」这条路径上，当天**永远不会**签到
  （实测 10-31、11-01 两天全部账号漏领）。现在把执行事实写进
  `.trae-api/daily-runs.json`，开机后发现已过点且今日未跑，60 秒后补跑一轮；
  成长中心（派猫旅行、任务奖励）同样纳入补跑。
- **签到通知不再把「今日已签满」报成失败**：定时轮按 30 分钟窗口分散签到，
  这期间你点「全部签到」会同时起第二轮，两批各领一半，通知于是显示
  「Trae 签到 3 · 已签 5」——看着像 5 个号失败，实际 8 个号全签完了。
  现在三条批量签到入口共用一把互斥锁，后到的那次直接跳过并说明原因；
  文案改为「本轮领取 N · 今日已签 M（Trae 今日 8/8）」，按今日口径给结论。
- **余额刷新不再每 30 分钟静默失败一次**：小浣熊账号的余额接口返回的数据
  少了一个字段，导致后续「解冻账号」拿到空值去查库，SQLite 直接报错，
  整轮刷新的解冻与低额度告警全部中断（自接入起累计 549 次，面板上看不到）。
  现在补齐字段并加了空值防御，即使将来新增平台再漏字段也不会带崩整轮。
- **账号轮换不再和签到抢同一分钟**：两者都排在 08:45，轮换要在开机后逐个
  登录客户端（会短暂占住主线程），把签到窗口内的动作往后推。轮换时刻已改到 10:30。

- **凭据不再从管理接口漏出去**：新增的「小浣熊密码登录」把手机号与密码存进了
  账号表，但两处出口没跟上——`GET /v1/credentials/:id` 只剥了 token，于是
  **上游登录密码与手机号**随响应原样出网；`PATCH /v1/credentials/:id` 与
  `POST /v1/raccoon/accounts/:id/balance` 也带出了手机号（store 的统一脱敏
  只剥了 `raccoonPassword`，漏了 `raccoonPhone`）。现在密码与手机号在
  store 层与路由层双重剥离，面板只拿到一个 `hasPasswordLogin` 布尔值。
- **「配置密码登录」从「永远失败」变成真的可用**：该路由引用了一个不存在的
  标识符（`raccoonAuth`），每次调用都在第一行抛 `ReferenceError`，却被
  catch 包装成「密码登录验证失败，凭据未保存」——用户会以为是密码错了，
  反复重试、反复改密码。已改回正确的模块引用，并把错误按
  「内部缺陷（500）/ 上游失败（502）/ 参数凭据（400）」分级，不再把内部
  异常伪装成用户输入问题。
- **配密码时填错手机号不再删掉你的另一个账号**：账号不一致分支原本会
  `store.remove()` 掉命中的那条账号，而命中既可能是「刚新建的多余记录」，
  也可能是**库里已存在的另一个真实账号**（实测可复现删除）。现在只中止并
  提示，不做任何删除。
- **WorkBuddy 的「7 天周期续期」从形同虚设变为真正生效**：该判据此前读
  `lastKeepaliveAt`，而每日保活轮每天都会无条件把这一列写成当天，于是
  「距上次刷新已超 7 天」永远不成立；反过来，续期**失败**也写同一列，
  又让一次网络抖动把重试压满 7 天。现在拆成两列：`lastRefreshAt`（最近一次
  成功续期，判据位）与 `lastKeepaliveAt`（最近一次保活尝试，面板展示位）。
  `lastRefreshAt` 为空的存量账号会在下次用到时自动补一次刷新。
- **密码登录不再每天新增一条重复账号**：账号去重原本只认 `userId`，而
  `user_info` 取失败会被吞成空对象 → `userId` 变空 → 每次都新建一条。
  现在加了手机号作为二级幂等键，并且「没查到 userId」不再把既有账号的
  userId 抹成空（那会让一级键同时失效）。实测连跑 3 次账号数稳定不变。
- **保活写回的令牌不再写错账号**：密码登录命中的可能是同身份的另一条账号，
  原实现把新令牌写到调用方传入的 id 上，导致同一份凭据被写进两条账号、
  而真正被上游刷新的那条没更新。现在写回 `persistLogin` 实际命中的那条。
- **WorkBuddy 转发恢复：上游新增的「渠道校验」不再把网关整片拦死**。
  2026-10-21 上午起，网关经 WorkBuddy 的对话请求被上游以
  `HTTP 400 / code=11128`（`Illegal API invocation from an unapproved channel`，
  中文「这次调用没通过渠道校验，可能不是官方客户端发出的」）拒绝，
  表现为 `vm/long-context` 连续 12 次失败、换模型换账号都无效。
  原因是我们一直以「CodeBuddy 插件」的身份发请求（UA `CLI/2.63.2 CodeBuddy/2.63.2`
  + `X-Client-Platform: web` + 指向 codebuddy.cn 的 Origin），而 chat 上游认的是
  **WorkBuddy 桌面端**身份。现已按桌面端 5.8.3 的真实头集重建 chat 面身份：
  UA 改为 `WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0`，补齐
  `X-IDE-Type/Name/Version`、`X-Private-Data`、`x-codebuddy-request`、
  会话与追踪头（`X-Conversation-*` / `X-Request-ID` / `traceparent` / B3），
  并去掉与之互斥的网页身份头。计费/签到接口仍走原 web 身份，未受影响。
  桌面端升级后只需改 `platform/variant.js` 的 `appVersion` / `cliVersion`
  （或设 `WB_APP_VERSION` / `WB_CLI_VERSION`），不必再翻全库找硬编码。
- **被渠道校验拦住时不再做无用功**：11128 此前被判成 `other`，于是「换候选、换账号、
  冷却、重试」全套都走一遍，客户端要等 3 次尝试全灭才看到错误。现在它单独成类
  `channel`：不重试同账号、不冷却账号（账号本身健康，冷却只会让面板一片红并跳过
  可用候选）、同平台不再换候选（同一堵墙），但**允许跨平台降级**
  （WorkBuddy 被拦会自动落到 Trae 候选，客户端无感）。全部候选都失败时，
  错误信息会直接指出「核对桌面端版本」或「保留一个非 WorkBuddy 候选」，
  而不是把上游那句 `Illegal API invocation` 原样丢给使用者。
- **`11102` / `11103` 不再被当成账号问题**：模型不存在（`model [x] service info not
  found`）与模型后端不支持（`Backend [x] is not supported`）此前被判成 `other`，
  换候选时冷却的是**健康账号**。现在归入模型问题，只换候选不冷却账号。
- **WorkBuddy 派猫旅行不再半夜打扰你**：成长中心自动化（派猫出发 / 领旅行奖励 / 补登 /
  兑换 / 抽奖）此前是「按网关启动时刻每 4 小时轮询一次」，间隔锚定在启动时间，前台只有
  开关和间隔、**没有任何可配的执行时刻**——网关若在夜里启动或被拉起，全天所有轮询都落在
  半夜，派猫与领奖通知连续不断。现在它和签到、保活、轮换一样按**墙钟每天执行一次**，
  默认**早晨 08:00**，可在「运维 → 定时任务 → 成长中心（WorkBuddy 派猫旅行）」直接改时刻，
  「下次执行」区也会显示「下次成长」。环境变量：`GROWTH_POLL_INTERVAL_HOURS` 已废弃，
  改用 `GROWTH_HOUR` / `GROWTH_MINUTE`（`GROWTH_POLL_ENABLED=false` 仍可整体关闭）。
  改为每天只跑一次后，自动化会在领完旅行奖励的同一轮里补派一次，当天剩余次数不会空转。
- **成长中心补登不再「有卡却永远补不到」**：自动编排的补登段有三个叠加的坑
  （2026-10-30 全量 8 账号实测复盘发现）：
  1) 候选日只信上游 `/streak` 的 `makeup_dates`——该列表会**残留已补过的日期**、
     又漏掉真正断登的日子，八个账号一轮跑下来全部记成「候选日本就已签，无需补登」，
     卡一张没动。现在改以 `/heatmap` 热力墙的 0 分日为准（当天除外，当天还能靠
     真实活跃点亮），`makeup_dates` 只在热力墙查询失败时兜底。
  2) 补登的幂等键与其余动作共用「账号+当天」种子——同一天用第二张卡时 key 完全相同，
     被上游按幂等去重**静默吞掉**。现在每张卡按「账号+目标日期」独立派生：
     重跑同一天仍去重（不会重复消耗），不同日期互不吞掉。
  3) 每轮上限 1 张卡，追不上按**连续**天数判定的 28 天档位（连登段起点前往往连着
     缺好几天）。现在一轮最多 8 张，从最近的断登日补起、补到解锁线即停；
     三个档位都已领取时不再耗卡。
  同时修复领取口径：档位解锁看的是连登天数（`streak.days`），补一个孤立断登日只加
  本月累计、不延长连登，等于浪费卡——补登顺序因此必须从新到旧。
- **面板重置登录密钥不再把人锁在门外**：此前点「重置登录密钥」后只提示一句「已重置」，
  新密钥没有显示，且当前会话被直接退出——因为页面紧接着用**旧密钥**刷新了一次列表，
  拿到 401 就判定登录失效，连同刚生成的明文一起卸载，只能回服务器重跑
  `node scripts/login-key.js reset` 才能登录。
  现在重置成功后：新明文在专用面板显示（带复制按钮），当前会话自动切换到新密钥，
  **不会退出登录**；列表与接入配置随后用新密钥重拉。
- **登录密钥新增「查看明文」**：已配置但手头没有明文时，可按后端密文备份直接取回，
  不必为了拿回明文再做一次重置（重置会让旧密钥立即失效，连带其他已登录的标签页）。
- **重置按钮加了防重复点击**：连点两次时第二次会用旧密钥发请求，正是上面那次事故的入口。
- **「上游 Provider」里那个一直删不掉的示例终于没了**：`model-router.json` 的仓库模板里
  早期内置过一个演示用的第三方端点（`DeepSeek（示例）`，指向 api.deepseek.com，默认停用），
  用来示范「第三方 OpenAI 兼容接口」长什么样。该条目虽已从模板删除，但你机器上**真正被
  面板读取**的那份工作区配置不会随代码更新，于是它一直显示在「上游 Provider」表里，
  看着像真实配置。现在启动时会自动清掉这条**没人动过的**种子记录；
  若你已把它改成自己的端点或手动启用过，则视为有效配置原样保留。
  同时该表新增「删除」按钮，第三方端点可以自己删（内置 Trae / WorkBuddy 仍不可删）。
- **请求日志的「估算成本」列已移除**：该列长期没有数据（费率标定未覆盖时恒为空），
  留着只会让人误以为消耗是 0。成本口径仍在「用量与成本」页，那里有标定系数与官方账单对照。

### 管理面板

- 重置登录密钥不再附带「客户端接入配置 / 去验证连通性」面板——那是访问密钥（IDE 用）
  的指引，登录密钥只用于打开面板，配到 IDE 里调不通。
- **请求明细的「序号」不再看起来是乱的**：`#` 列此前直接显示日志里的自增计数器，
  而该计数器在网关每次重启后都从 1 重新开始（同一天内可回退几十次），表格又是按时间
  新→旧排列的，于是出现「894、893、…、2、1、1、888…」这种读起来毫无顺序的编号。
  现在 `#` 改为按当前展示顺序连续编号（跨页接续），需要原始计数器时按时间与其他列定位即可。
- **请求明细新增「上游模型」列**（位于「模型」列之后）：显示这一行**实际命中**的上游模型名。
  「模型」列是客户端请求的名字，走虚拟模型时它是 `vm/unified-chat` 这类对外 ID，
  看不出真正调的是哪个上游；新列直接给出物理模型名（如 `glm-5.3`、`step-5-preview`）。

### 运维工具

- **成长中心补登不再只能照上游的候选列表走**：上游 `/activity/growth/streak` 的
  `makeup_dates` 与热力墙 `/heatmap` 会互相打架——2026-10-29 实测 8 个账号里，
  候选里列出的 `10-24`／`10-01` 当天**热力分不为 0**（提交即被 400 `date is not broken`
  打回，不扣卡），而真正断登的 `10-28` 反而多数没被列出来。后台编排
  （`jobs/growth-auto.js` 补登段）只遍历候选列表，因此这类「真缺口不在候选里」的
  情况永远补不到。新增两个脚本把这件事变成可操作、可复核：
  - `scripts/probes/wb-growth-status.js`：连登 / 补登卡 / 热力近 N 天 / 旅行三态 /
    签到日历一次拉齐，并交叉核对「上游候选 vs 热力口径的真实缺口」，标出假候选。
  - `scripts/ops/wb-growth-makeup.js`：按**显式日期**用补登卡（`--date`／`--each`／
    `--dry`），假候选不扣卡自动往更早退，写后回读连登与卡余额。
- **派猫旅行有了手动补跑**：成长中心是墙钟排程（默认 08:00，`scheduler.js#nextAt`
  过了时刻就直接排明天），进程在那一刻没在跑或刚好重启，当天的派猫/领奖整天跳过，
  而旅行次数按日重置、`arrived` 的奖励不会自己进账——2026-10-28、10-29 两天实测
  8 个账号全部卡在 10-27 那趟的「已到达未领取」，当日派猫额度 0/1 空转。
  新增 `scripts/ops/wb-travel-run.js`（领奖 → 当日未派则派一次，`--dry`／
  `--location`／`--hours`／`--account`）与只读明细 `scripts/probes/wb-travel-status.js`
  （三态 + 出发/到达/服务器时刻 + 今日已派标记 + 可领奖励）。手动补跑一次即把
  10-27 的 52 分领回并重新派出 8 趟。

---

## 3.1.0 — 可用性与安全性整改

### 你需要知道的变更

- **转发面默认限流 60 次/分钟**：此前未单独设置限额的访问密钥等于「无限流」，
  任何持钥者都能把账号池里的真实积分烧光。现在默认每秒 1 次（IDE 场景绰绰有余）。
  需要放开可设 `KEY_DEFAULT_RPM=0`。
- **删除 `model-fallback.json`**：该文件声明了模型降级策略，但**从未被任何代码读取**。
  若你曾配置过，请知悉它没有生效过，可以安全删除。启动时若检测到该文件会给出警告。
- **成长中心不再提供手动操作**：旅行 / 领奖 / 兑换 / 抽奖改由后台定时任务自动执行
  （默认每 4 小时），结果经通知渠道播报。原先的抽奖/稀有度/补登卡界面已移除。
- **密钥「轮换」现在真的有 24 小时宽限期**（此前实际是立即失效，与文案不符）。
- **创建访问密钥需要指定平台**：面板创建的密钥统一为 `all`（三平台通用）。

### 修掉的问题

- **流中途失败不再伪装成模型输出**：此前上游报错时，`/v1/chat/completions` 会把
  `[Error 3004: …]` 当作模型回复内容发给客户端，且 HTTP 状态仍是 200。
  agent 客户端会把这段文字并入对话上下文污染后续轮次。现在改为标准的
  `error` 事件 + `[DONE]` 收尾。
- **账号并发写入不再互相覆盖**：跨进程/多客户端同时改同一个账号时，先写的字段会被
  后写的陈旧快照覆盖（静默丢数据）。现在用乐观锁（version CAS）避免。
- **停机不再硬切**：收到 SIGTERM/SIGINT 后会依次停止接收新连接、停定时器、
  落盘状态、关闭数据库再退出，而不是立刻 `process.exit`。在途流式请求能正常收尾。
- **调度器跨进程单实例**：此前同时跑两个进程会各跑一份定时任务（备份、账号轮换
  这类非幂等任务会重复执行）。现在用文件锁保证只有一个实例在调度。
- **OAuth 本地回调增加闸门**：此前任何本地程序或网页都能往凭据池注入账号。
  现在没有进行中的登录会话时，回调请求一律拒绝（403）。
- **`/health` 变成真正的健康检查**：之前固定返回 `ok`，数据库坏了也照样报 ok。
  现在返回真实的检查结果，异常时状态码 503。
- **凭据加密密钥丢失会明确报错**：之前静默生成新密钥，导致所有已存账号 token
  永久无法解密（不可逆），且没有任何提示。现在启动时检测到这种情况会**拒绝启动**
  并给出恢复指引。

### 管理面板

- **WorkBuddy 导入后可就地启用**，不必回到长列表里找那个灰色行。
- **凭据列表出现「需重新登录」时，该行直接给出修复入口**（按平台分发到 OAuth
  或本机重新抓取）。
- **访问密钥创建成功后，页面就地展示接入配置**（base URL / 环境变量 / curl），
  并给出「去验证连通性」入口——不必再去运维页翻。
- **空状态全部补上下一步动作**，并区分「还没配置」与「筛选没匹配」。
- **新增审计日志页**：谁在何时查看过密钥明文、导出过凭据，现在可查（此前后端一直
  在记，面板上看不到）。
- **运维页新增「立即签到 / 立即保活 / 立即探测」**：不必等定时器。
- **移动端可用**：侧栏可收起为抽屉，宽表格自动转为卡片列表，触控目标放大到 44px。
- 面板左下角显示当前版本号与构建时间。
- 新增 README（快速开始、密钥区分、常见问题）。

---

## 3.0.0 — 首次发布

- 多平台账号池（Trae / WorkBuddy / ZCode）与三协议转发（OpenAI / Anthropic / Codex）
- 账号调度：优先级 → FEFO → 成本分层 → 余额 → 闲置时间
- 自动保活：每日签到、token 续期、余额定时刷新、积分临期告警
- Web 管理面板（凭据池 / 访问密钥 / 模型路由 / 模型池 / 用量成本 / 请求日志 / 运维）
- 通知（Webhook / Server酱 / PushPlus / Telegram）与加密全量备份
- 上游稳定、安全加固与首轮架构重构（含此前列出的资源 ACL 越权、明文密钥落盘问题）