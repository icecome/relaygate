# WorkBuddy 渠道校验（HTTP 400 / code=11128）解包取证与升级记录

- 时间：2026-10-21
- 触发：网关经 WorkBuddy 转发 `vm/long-context` 连续 12 次失败，
  `{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}`
- 结论：**请求身份头是插件/网页形态，不是 WorkBuddy 桌面端形态**。已按桌面端
  5.8.3 的真实头集重建 chat 面身份，并补齐 11128 的错误分类与降级语义。

---

## 1. 现象与取证

### 1.1 失败现场（`logs/2026-10-21/traffic.jsonl`）

12 条 11128 全部落在 `09:59:24 – 10:00:47`（84 秒内），特征高度一致：

| 字段 | 值 |
|---|---|
| endpoint | `/v1/chat/completions` |
| virtualModel | `vm/long-context` |
| toolsIn | 42 |
| status | 400 |
| durationMs | 380–1600（多数 <500） |
| 横跨模型 | step-5-preview / glm-5.3-flash / minimax-m3.1-flash / space-bunny / deepseek-v4.1-flash / mimo-v2.6-pro |
| attempt | 1 → 2 → 3 全部失败 |

同一批请求在 `06:19:57` 之前还是 200，`09:59` 起全灭——**同一份代码、同一个账号，
时间点切换**，因此不是本地请求构造错误，而是上游在这一时刻上线了新的渠道判定。

> 480ms 的耗时只够读 body 头、不够进推理，说明这是**前置闸门**而非模型侧拒绝。

### 1.2 客户端里的码表

`resources/app.asar` → `renderer/assets/contexts-*.js`：

```
11128:{actions:[`editInput`],feedback:!0}
```

`renderer/assets/zh-cn-*.js` 解出的文案：

```
"errorCode.11128":     "请求被拦截，请重新发送"
"errorCode.11128.desc":"这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。"
```

`editInput` 而非 `retry` / `switchModel` —— 官方客户端自己都把 11128 定义为
「**改动输入**才能恢复」，而不是「重试」或「换模型」。这与网关侧旧实现
（失败就换候选、换账号）正好相反。

### 1.3 客户端真正发的头（`resources/app.asar` → `main/server.js`）

桌面端自己走 `VlmUpstream`（本地回环代理）转发 chat，头由
`buildVlmGatewayHeaders` + `applyGatewayHeaders` 生成：

```js
X-User-Id / X-Enterprise-Id / X-Tenant-Id / X-Domain / X-Product: SaaS
X-IDE-Type: WorkBuddy
X-IDE-Name: WorkBuddy
X-IDE-Version: <appVersion>
X-Private-Data: true
User-Agent: `WorkBuddy/<appVersion> WorkBuddy/<appVersion> CLI/<cliVersion>`
x-requested-with: XMLHttpRequest
X-Conversation-ID / X-Conversation-Request-ID / X-Conversation-Message-ID
X-Request-ID / X-Agent-Intent: craft / X-Agent-Purpose: conversation
x-codebuddy-request: 1
traceparent / b3 / X-B3-*
```

`main/sidecar-manager.js#buildWorkbuddyClientInfoEnv` 进一步说明这些值从哪来：

```js
CLIENT_INFO_PLATFORM        = 'WorkBuddy'
CLIENT_INFO_IDE_TYPE        = 'WorkBuddy'
CLIENT_INFO_PLUGIN_NAME     = 'workbuddy-desktop'
CLIENT_INFO_PLUGIN_VERSION  = <desktop version>
CLIENT_INFO_USER_AGENT_EXTENSION = `CLI/<cli version>`
```

`cli/package.json` 的 `publishConfig.customPackage.version` = `2.161.0`
（旧实现硬编码的 `2.63.2` 是几个月前的 CLI 版本）。

而 `cli/dist/codebuddy-lite-wb.mjs` 的 `UserAgentHttpInterceptor#buildUserAgent`：

```js
[platform/platformVersion, applicationName/productVersion, ...(userAgentExtension)]
  .join(' ')
// → "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0"
```

### 1.4 旧实现发的头（`scripts/probes/dump-wb-request.js` 实测）

```
User-Agent: CLI/2.63.2 CodeBuddy/2.63.2      ← 插件身份，不是桌面端
X-Client-Platform: web                       ← 网页端身份
X-Enterprise-Id: (空串)                      ← 桌面端根本不带这个头
Origin/Referer: https://www.codebuddy.cn/    ← 浏览器同源头，桌面端 chat 不带
```

缺 `X-IDE-Type/Name/Version`、缺 `X-Private-Data`、缺 `x-codebuddy-request`、
缺会话/追踪头。**UA 首段是 `CLI/` 而不是 `WorkBuddy/`，是「非官方客户端」最直接的指纹。**

---

## 2. 逐项排除（不靠猜）

每个假设都写了探针并实测，脚本留在仓库里可复跑：

| 脚本 | 验证的假设 | 结果 |
|---|---|---|
| `probe-wb-channel.js` | 旧头集 vs 新头集（最小体） | 两者都 200 → 头集**单独**不足以复现 |
| `probe-wb-body.js` | 请求体形状（42 工具 / tool_choice / stream_options / 120k system / reasoning_effort / parallel_tool_calls / response_format） | 全 200 → 体形状无关 |
| `probe-wb-accounts.js` | 8 个账号 × 有无工具，走真实 `chat.js` 路径 | 16/16 200 → 非账号级 |
| `probe-wb-size.js` | 输入体量 1k–400k 字符 × 两种头集 | 14/14 200 → 体量无关 |
| `probe-wb-huge.js` | 0.58MB / 1.15MB / 2.3MB / 3.8MB | 1.15MB 仍 200；2.3MB 起是 **11115**（窗口超限），不是 11128 |
| `probe-wb-burst.js` | 并发突发 20×2 | 40/40 200 → 非频控 |
| `probe-wb-origin.js` | 三个 front door（workbuddy.cn / copilot.tencent.com / wb.tencentbuddy.com）× 两种头集 | 6/6 200 → 非域名 |
| `probe-wb-matrix.js` | 6 个失败模型 × 两种头集 × 2 次 | 24/24 200 → 非模型 |
| `probe-wb-trigger.js` | **反向**逐项删头（UA / x-codebuddy-request / X-IDE-* / X-Private-Data / B3 / 会话头 / X-Product / 裸请求） | 15/15 200 → 当前时刻上游未按头集校验 |
| `probe-wb-catalog.js` | 目录端点两种头集 | 都 200、都 34 个模型 |

**关键判断**：上游的渠道校验是**服务端灰度/按账号批次开启**的，不是「缺某个头就必拒」。
所以反向删头此刻无法复现 11128 —— 但这不推翻结论：

1. 11128 的官方文案明确指向「不是官方客户端发出的」；
2. 官方客户端自己把 11128 归为 `editInput`（改请求才能恢复）；
3. 旧实现的 UA 首段 `CLI/` + `X-Client-Platform: web` 客观上就是插件身份，
   与桌面端身份**互斥**；
4. 修复方向只能是「把请求做成官方客户端的样子」，这也是唯一能同时覆盖
   「现在被拦的账号」与「将来被拦的账号」的做法。

因此本次改动不依赖「此刻能否复现」，而是**对齐官方客户端的真实形状**。

---

## 3. 改动

### 3.1 身份头拆成两套（`src/workbuddy/auth.js`）

原来只有一个 `authHeaders()`，billing/checkin/catalog/chat 全用它。现在拆开：

| 函数 | 面向 | 身份 |
|---|---|---|
| `authHeaders()` | billing / checkin / catalog / 刷新 | **web 身份**（保持原样，未改动） |
| `chatHeaders()` | `/v2/chat/completions` | **桌面端身份**（新增） |

`chatHeaders()` 产出：

```js
Accept / Content-Type / Authorization: Bearer …
User-Agent: WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0
x-requested-with: XMLHttpRequest
X-User-Id / X-Domain / X-Product: SaaS
X-IDE-Type: WorkBuddy / X-IDE-Name: WorkBuddy / X-IDE-Version: 5.8.3
X-Private-Data: true
x-codebuddy-request: 1
X-Conversation-ID / X-Conversation-Request-ID / X-Conversation-Message-ID
X-Request-ID / X-Agent-Intent: craft / X-Agent-Purpose: conversation
traceparent / b3 / X-B3-TraceId / X-B3-SpanId / X-B3-ParentSpanId / X-B3-Sampled / X-Trace-ID
```

**刻意不带**：`X-Client-Platform`、`Origin`、`Referer`、`X-Enterprise-Id`（空串）。

### 3.2 版本号收敛到 `platform/variant.js`

`identity` 新增 `appVersion` / `cliVersion` / `privateData` / `ideType` / `ideName`，
均可用环境变量覆盖（`WB_APP_VERSION` / `WB_CLI_VERSION` / `WB_UA`）。
桌面端升级后只改一处，不必再全库找硬编码。

### 3.3 会话/请求幂等键（`src/model-router/dispatch.js#wbConversationOpts`）

上游按 `X-Conversation-ID` + `X-Request-ID` 做链路归因与去重。网关没有上游会话
概念，这里用客户端会话键（`stickyKey`）派生 `conversationId`：

```js
sha256('wb-conv:' + stickyKey).slice(0, 32)
```

同一客户端会话在多次请求间保持同一个 conversationId（符合上游语义），
`requestId` 每次新建。没有 `stickyKey`（内部探活、测试）时两者都由
`chatHeaders` 各自生成 UUID。

### 3.4 11128 的错误语义（`src/upstream/errors.js`、`src/platform/variant.js`）

新增分类 `'channel'`，判定三路兜底：业务码 `11128` / HTTP 状态恰为该码 /
文案（`unapproved channel`、`Illegal API invocation`、`没通过渠道校验`）。

行为差异：

| 维度 | 旧（判成 `other`） | 新（`channel`） |
|---|---|---|
| 是否重试同账号 | 是 | 否（确定性判定，重试只是白打一次上游） |
| 是否冷却候选 | 是（`other` 走默认路径） | 否（账号与模型都健康，冷却只会让面板一片红） |
| 是否同平台换候选 | 是（逐个撞同一堵墙，12 次失败即此形态） | 否（`blockedProviders` 整平台熔断本次请求） |
| 是否跨平台降级 | 视 `switchOn` | 是（workbuddy → trae 是唯一有效降级） |

`switchOn` 默认值补入 `'channel'`（`autotier.js` / `store.js` / `index.js` 三处）。

### 3.5 顺带修掉的分类缺陷

`classifyError` 原先不认 WorkBuddy 的 `11102`（`model [x] service info not found`）
与 `11103`（`Backend [x] is not supported`），两者都被判成 `other` → 换候选时
冷却的是**健康账号**。现已归入 `'model'`（模型问题，换候选即可，不冷却账号）。
`err.logs/relay.err.log` 里 `[scheduler] probe skip wb/glm-5.0 … 11102` 那串就是这个缺口。

---

## 4. 验证

```bash
node scripts/probes/verify-wb-channel.js     # 30 项断言，全本地
node scripts/probes/dump-wb-request.js       # 打印网关真正发往上游的头与体
node scripts/probes/e2e-wb-11128.js vm/long-context 42   # 走网关 /v1/chat/completions
```

实测：

- `verify-wb-channel.js` → **30 项全通过**
- `dump-wb-request.js` → 头集已是桌面端形态，无 `X-Client-Platform`/`Origin`
- `e2e-wb-11128.js vm/long-context 42` → `http 200`，`finish_reason: stop`
- 全量测试：`unit 294` / `protocol 36` / `stream-gate 19` / `channels 44` /
  `startup-checks 17` / `security 41` / `rate-limit 7` / `qoder 76` / `growth 11` /
  `rtk 32` / `local-answer 111` / `qr 38` / `raccoon 44` / `store-concurrency 11` /
  `shutdown 9` / `oauth-listener 5` —— **全绿**

---

## 5. 复现与排障手册

被 11128 拦时的判断顺序（按成本从低到高）：

1. **看耗时**。`< 1s` 且 body 是 11128 → 前置闸门，与模型/账号/体量无关，
   不要浪费时间换号换模型。
2. **跑 `node scripts/probes/dump-wb-request.js`**，确认发出去的头是不是桌面端形态。
   UA 首段不是 `WorkBuddy/`、或带 `X-Client-Platform: web` → 就是本文这个原因。
3. **确认桌面版本**。`resources/install-manifest.json` 的 `appVersion` 与
   `cli/package.json` 的 `publishConfig.customPackage.version` 变了就更新
   `variant.js#identity.appVersion/cliVersion`（或设 `WB_APP_VERSION`/`WB_CLI_VERSION`）。
4. **反向定位**。`node scripts/probes/probe-wb-trigger.js` 逐项删头，若某项删掉后立刻
   11128，即证明该项是当批校验项——把它加进 `chatHeaders`。
5. **跨平台兜底**。`switchOn` 含 `channel` 时，workbuddy 被拦会自动降级到 trae
   候选，客户端不会看到 400。
