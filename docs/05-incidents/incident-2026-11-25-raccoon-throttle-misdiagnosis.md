# 事故记录：Raccoon「IP 出口限流」结论被推翻 —— 真因是账号风控 + 模型名过期 + 重试放大 + 60s 超时

- **日期**：2026-11-25
- **触发问题**：官方客户端（`商汤小浣熊` / Box-Agent）跑本项目代码审计对话，
  11:29 起持续 **40 分 42 秒 / 182 次 LLM 调用**，全程无中断、无 429；
  而外接 API（本网关 `sn-*` 通道）通常十几分钟即被限流。
- **影响面**：Raccoon 渠道全部对话转发（`/v1/chat/completions` 的 `sn-*` 分派、
  `/v1/raccoon/chat/completions`、`vm/raccoon`、`raccoon` 虚拟模型）。
- **状态**：已定位，四因叠加；修复清单见第 6 节。生产进程需重启后生效。

---

## 1. 结论先行

`src/raccoon/limiter.js` 头部那张表（「上游按**出站公网 IP** 计并发」）**结论是错的**，
它把 2026-11-09 那一次观测过度归纳成了架构前提，于是后续所有设计都建立在错误地基上。

本次实测给出相反证据：

| 判据 | 2026-11-09 记载 | 2026-11-25 实测 |
|---|---|---|
| 限流维度 | 出站 IP（换号换模型都没用） | **账号级**。两个网关账号**同时**探测：`7651371` 被限、`7651374` 正常 200 |
| 跨模型 | 同时 429（⇒ 判为 IP 墙） | **确实跨模型**（7 个模型全 429），但原因不同：`200108` 是**账号被风控处置**，一个号被处置当然全模型都拦 |
| 恢复窗口 | > 8~10 分钟 | **10800 秒（3 小时）**，由上游 `Retry-After` 明示 |
| 错误码 | `user_model_rate_limited` / `200103` | **`200108`**「系统检测到当前账号存在异常调用，模型调用功能已暂时受限」——这是**风控**码，不是并发码 |

「一个号被封、另一个号同机同 IP 却完全正常」这一条就足以证伪「出口 IP 限流」：
若是 IP 墙，同 IP 的第二个号不可能通。

**真正让外接 API 十几分钟就挂的，是四个叠加缺陷**，与 IP 无关：

1. **模型名过期**（`sn-deepseek-v4-1-flash` → `-1017`、`sn-kimi-k3` → `-1-pro`），
   请求直接被上游 `400 / 100004 param model unsupport` 拒掉；
2. **400 被误判成可重试**，每个用户请求放大成 3（dispatch）× 3（model-router）= **最多 9 次上游调用**；
   一次无效调用被放大成一场「无效调用风暴」，正好喂给风控；
3. **`200108` 未被识别**，只冷 300 秒，而真实处置是 3 小时 —— 冷却到点即撞，反复加深风控；
4. **60 秒硬超时**砍断长回合（官方客户端是 **1200 秒**），把 5.2% 的回合做成半截流。

---

## 2. 官方客户端为什么能跑 40 分钟

证据来自客户端自己的会话 trace：
`~/.box-agent/log/sessions/a67ec4af-….jsonl`（`box-agent-session-trace/v1`）。

| 维度 | 官方客户端（本次 40m42s） | 本网关历史会话 |
|---|---|---|
| 模型名 | `sn-deepseek-v4-1-flash-1017`（**现行有效**） | `sn-deepseek-v4-1-flash`（**已下线**） |
| 调用总数 / 时长 | 182 次 / 40.8 min ≈ **4.5 次/min** | 46~50 次 / 5~13 min ≈ **3.5~10 次/min** |
| 峰值密度 | **8 次/min**、并发峰值 **2** | 峰值 **22 次/min**（11-19）、并发 4~6 |
| 单次超时 | **1200 s**（`model-profiles.json.timeout`） | **60 s**（`RACCOON_TIMEOUT_MS`） |
| 失败重试 | 无候选切换，一次就是一次 | dispatch 3 × model-router 3 = 最多 9 次 |
| 输入 token 峰值 | 1,559,664 tok/min（04:08） | 单会话累计 2.0M~3.0M tok |

也就是说：官方客户端的**请求密度并不比网关低**（它 40 分钟跑了 182 次、单分钟输入
token 冲到 155 万），它之所以不断，是因为**每一次调用都是有效的、且没有放大**。
网关那边则是「大量 400 + 大量重试 + 长回合被 60s 砍断」，行为画像完全不同。

> 顺带一个反直觉数字：11-19 那次会话只有 **46 次调用**、**5 分钟**，却打出了
> **22 次/60s** 的峰值 —— 因为其中混着 `sn-kimi-k3`/`sn-glm-5-3` 的 400 重试。

---

## 3. 逐项取证

### 3.1 模型名过期（直接原因）

上游现行目录（`GET /api/web/llm/v2/model_catalog`，200，7810 B）：

```
raccoon-090dd3            (默认，visible=false)
raccoon-19b265 / raccoon-405a1c
sn-sensenova-6-8-flash          billing 0
sn-sensenova-6-8-flash-lite     billing 0
sn-qwen4-max                    billing 0.75
sn-glm-5-3                      billing 0.75
sn-kimi-k3-1-pro                billing 1
sn-glm-5-3-flash                billing 0.2
sn-deepseek-v4-1-flash-1017     billing 0.25     ← 现行名带 -1017
```

而本仓库两处仍写着旧名：

- `src/raccoon/product.js:213` `FALLBACK_MODELS` —— `sn-deepseek-v4-1-flash`、`sn-kimi-k3`
- `output/model-router.json` —— `raccoon` / `vm/raccoon` / `deepseekv4` 三个虚拟模型的候选全是旧名

对照实测（同一 token、同一套头）：

```
model=sn-deepseek-v4-1-flash        → 400 {"error":{"code":100004,"message":"param model unsupport"}}
model=sn-deepseek-v4-1-flash-1017   → 200 {"model":"sn-deepseek-v4-1-flash-1017", ...}
```

`traffic.jsonl` 佐证：历史上 176 次调用全部路由到 `raccoon/sn-deepseek-v4-1-flash`，
即**旧名曾经有效**，是上游近期改的名 —— 这是一个典型的「上游目录漂移」事故，
而网关的兜底表是硬编码的，没有任何漂移检测。

### 3.2 重试放大（把一次失败变成九次）

```
src/raccoon/dispatch.js:45      const MAX_ACCOUNT_SWITCHES = 3;
src/model-router/index.js:346   const maxAttempts = Math.max(1, vm.failover.maxAttempts || 3);
output/model-router.json        "switchOn": ["rate_limit","model","5xx","network","channel","other"]
```

400 `100004` 经 `classifyError` 落到 `'other'`（实测：`100004 -> other`），
而 `switchOn` 含 `'other'` ⇒ **每个 400 都要把 3 个候选全试一遍**，
每个候选内部又允许 3 次账号切换。`traffic.jsonl` 里的形状很直观：

```
同一秒内 14 行记录；17 个时间戳有 ≥2 行；durationMs 为 0/1/2 的行成串出现
2026-11-17T01:29:02.991Z 429 ... 01:29:24 429 ... 01:29:57 429 ... 01:30:18 429 ...
（撞墙后客户端按 20s 退避重发，网关再放大 3 次，如此循环）
```

`dispatch.js:270` 那段注释写着「撞墙后立刻停手，不换号」，那句在 **dispatch 内部**成立；
但 **model-router 层**仍会 `switchOn: rate_limit` 换下一个候选，
于是同一个账号在同一堵墙上被撞 3 次。两层各写一套「撞墙语义」，是这次放大的结构性原因。

### 3.3 `200108` 未识别，冷却严重不足

上游真实报文：

```
HTTP 429
retry-after: 10800
{"error":{"code":200108,
          "message":"系统检测到当前账号存在异常调用，模型调用功能已暂时受限。…",
          "type":"rate_limit_error"}}
```

`src/raccoon/limiter.js` 只认两种码：

```
CONCURRENCY_CODES        = ['user_model_rate_limited', 'limiter_request_error']
CONCURRENCY_NUMERIC_CODES = [200103]
```

`200108` 两者都不匹配，落到第 151 行的兜底 `status === 429` 分支：

```
{"limited":true,"kind":"unknown","cooldownMs":300000}   ← 实测
```

**上游说 3 小时，网关只冷 5 分钟。** 5 分钟一到，`pruneGlobal()` 清掉全局冷却，
下一波请求立刻再撞 —— 而 `200108` 的文案是「检测到**异常调用**」，
反复撞墙本身就是最典型的异常调用特征。

### 3.4 `Retry-After` 真值被本地冷却覆盖

```
src/lib/upstream-error.js:123
  const retryMs = cooldownMs || (err && err.retryAfterMs) || (status === 429 ? 60_000 : 0);
```

`chat.js:169-177` 已经把上游 `Retry-After` 解析进 `err.retryAfterMs`（10800000 ms），
但 `cooldownMs`（本地 300000）**优先**，于是回给客户端的 `Retry-After` 是 300 秒：

```
cooldownMs || retryAfterMs = 300 s   （上游真值 10800 s）
```

客户端老老实实 5 分钟后重试 → 再撞 → 客户端把「重试」这个动作也做成了异常特征。

### 3.5 60 秒硬超时砍断长回合（本次新发现）

```
src/raccoon/product.js:62   const REQUEST_TIMEOUT_MS = Number(process.env.RACCOON_TIMEOUT_MS || 60_000);
src/raccoon/chat.js:126     const timeout = AbortSignal.timeout(product.REQUEST_TIMEOUT_MS);
                            const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
```

关键点：这个 signal 传给的是 `fetch()`，而 **`AbortSignal.timeout` 覆盖的不只是「拿到响应头」，
而是整条响应体的读取过程**。已用本地 mock 复现：

```
headers at 845 ms status 200
chunk at 846 ms / 1642 ms / 2447 ms
ABORTED at 2509 ms err= TimeoutError The operation was aborted due to timeout
```

也就是说：一个正常在流式输出的长回答，只要**总时长超过 60 秒就会被掐断**，
哪怕它一直在吐字。`traffic.jsonl` 里两处证据完全吻合：

- **9 次 `500 The operation was aborted due to timeout`，durationMs 全部落在 60020~60568 ms**
- **8 次 `200` 但 `finishReason` 为 null、durationMs 62~88 s**（半截流：有 token 计量，无收尾帧）

合计 **17 / 324 = 5.2% 的回合是坏的**。而官方客户端同口径下 p99 = 127 s、max = 150 s ——
**在 60 秒超时下，这些调用 100% 会被砍**。这就是「官方能跑 40 分钟、网关跑不动」最直接的一条。

> 注意 `dispatch.js` 与 `chat.js` 里 `aborted` 的语义只覆盖「**调用方**取消」
> （`opts.signal.aborted`），超时触发的 abort 走的是普通 catch 分支，
> 于是它既不算 `aborted` 也不算 `throttled`，被判成 `'other'` —— **又触发一次换号重试**。
> 一个已经跑了 60 秒的回合，因为超时被重试，等于把成本翻倍再付一次。

### 3.6 业务码正则截断 6 位码（隐蔽但影响面最大）

```
src/upstream/errors.js:81
  const m = msg.match(/"code"\s*:\s*(\d{3,5})/);
```

`{3,5}` 只吃 3~5 位。小浣熊的业务码是 **6 位**，实测：

```
200108 -> upstreamCode 20010   (截断)
100004 -> upstreamCode 10000   (截断)
200103 -> upstreamCode 20010   (截断)
11128  -> upstreamCode 11128   (OK，WorkBuddy 是 5 位，所以历史测试没暴露)
```

后果：**所有 6 位小浣熊业务码在 model-router 层都失去识别能力**，
`RATE_LIMIT_CODES` / `isModelConfigError` / `isChannelBlockedError` 一律匹配不上，
全部退化成 `'other'` → 触发换候选重试。这一条是 3.2 的放大器，
也是「为什么加了多少冷却都不管用」的底层原因。

### 3.7 「出口 IP 限流」这条结论是怎么来的，又为什么错

11-09 那天的观测是真实的：撞墙后换号、换模型都 429。但那次现场有**一个被忽略的共因** ——
三个「不同账号」当时都在**同一台机器、同一套请求形状**下高频调用，
如果其中**任何一个**账号被风控，另一个健康账号在**同一时刻**去撞，
看到的也会是「换号没用」，因为被拦的从来不是 IP，而是「这套行为」本身。

本次的直接反证（同机、同 IP、同 headers、间隔 400 ms）：

```
7651371  status 429  code 200108  retry-after 9320s  → 解禁约 15:39
7651374  status 429  code 200108  retry-after 8961s  → 解禁约 15:33
（更早一次对照：7651371=200 / 7651374=429，同一秒内）
```

`7651371` 通、`7651374` 不通，**同 IP**。IP 假说当场证伪。
（当前两个号都已被处置，是本次排查期间反复探测的代价 —— 见第 5 节红线。）

---

## 4. 5W2H 归因

| | 内容 | 证据 |
|---|---|---|
| **What** | 外接 API 十几分钟被限流，官方客户端 40 分钟不断 | 客户端 trace 182 调用 / 40.8 min；网关 429 全为 200108 |
| **Why** | 模型名过期 → 400 → 误判可重试 → 调用风暴 → 风控 200108 → 冷却 300s 远短于 10800s → 再撞 → 加深风控 | `product.js:213`、`errors.js:81`、`limiter.js:151`、`upstream-error.js:123` |
| **Where** | `src/raccoon/{product,chat,dispatch,limiter}.js`、`src/upstream/errors.js`、`src/lib/upstream-error.js`、`output/model-router.json` | 见第 3 节行号 |
| **When** | 上游改模型名之后（旧名曾 176 次成功）；60s 超时自始存在 | `traffic.jsonl` 路由分布 |
| **Who** | 本网关的 Raccoon 渠道；同机的官方客户端**不受影响**（用新名 + 1200s） | 两个账号 sub 对比：`7651374.sub == 官方.sub`，**同一个账号**！ |
| **How** | 行为画像差异（无效调用 + 重试 + 截断）触发账号级风控，而非配额 | 200108 文案「异常调用」；同号全模型 429 |
| **How much** | 5.2% 回合损坏；被处置后 **3 小时**不可用；且风控是账号级，会波及同账号的官方客户端 | 9×500 + 8×半截流 / 324 |

> ⚠️ **最要命的一条**：`7651374` 的 JWT `sub` 与官方客户端 `auth.json` 的 `sub`
> **完全相同**（`pu-01a13a3e-499d-7227-a190-1877f154e697`）。也就是说网关和官方客户端
> **在共用同一个账号**。网关把它撞进 3 小时风控，官方客户端**也会一起挂**。
> 这条链路不是「两个独立出口互相干扰」，而是「网关亲手把自己的上游账号打停」。

---

## 5. 排查过程红线（本次已越界一次，记录在案）

为了验证 IP 假说与账号假说，本次对上游做了约 120 次真实对话请求
（含 3 轮 20 次连发、6 并发压测、7 模型矩阵）。结果是**两个网关账号都被处置**
（`200108`，各 3 小时）。教训：

- 用「探测」去验证「限流」这件事本身就是自指的 —— 探测即消耗，消耗即证据。
- 正确姿势：先用**只读端点**（`model_catalog`，200 且不受限）判断账号存活，
  再用**单发**判断是否 429，绝不做并发/连发压测。
- 本次确认：`model_catalog` 在被处置期间**仍然 200**（7810 B），
  所以它是干净的存活探针；`chat/completions` 才是被拦的那个面。

---

## 6. 修复清单（**已全部落地**，见本节末的「落地状态」）

### P0（必须，直接决定能不能用）

| # | 位置 | 改动 |
|---|---|---|
| 1 | `src/upstream/errors.js:81` | `(\d{3,5})` → `(\d{4,6})`（或 `(\d+)` + 边界校验）。**这一条不改，后面所有分类都是空谈** |
| 2 | `src/raccoon/product.js:213` | 兜底表改名：`sn-deepseek-v4-1-flash-1017`、`sn-kimi-k3-1-pro`；**并加漂移检测** —— 启动时拉一次 `model_catalog`，本地 id 不在远端列表就告警 |
| 3 | `output/model-router.json` | 三个虚拟模型的候选全部换成现行名（`raccoon`、`vm/raccoon`、`deepseekv4`） |
| 4 | `src/raccoon/limiter.js:139` | 把 `200108` 加进「长冷却」码表，且**冷却时长取上游 `Retry-After`**（10800s），不要用本地 300s |
| 5 | `src/lib/upstream-error.js:123` | `cooldownMs \|\| retryAfterMs` → `Math.max(cooldownMs, retryAfterMs)`，让上游真值能透出去 |

### P1（结构，防复发）

| # | 位置 | 改动 |
|---|---|---|
| 6 | `src/raccoon/product.js:62` | `RACCOON_TIMEOUT_MS` 默认 60_000 → **1_200_000**（对齐官方客户端）；或拆成「首字节超时 60s + 整轮无进展超时 120s」，用 idle 判据代替 wall-clock |
| 7 | `src/raccoon/chat.js:126` | 超时 abort 要打标（`err.timeout = true`），dispatch 里**不得**把它当可重试 |
| 8 | `src/raccoon/dispatch.js:45` | `MAX_ACCOUNT_SWITCHES` 3 → **1**。账号级冷却已足够；撞墙换号在 200108 语义下纯属加深风控 |
| 9 | `output/model-router.json` | `switchOn` 去掉 `rate_limit` 与 `other`（或对 raccoon 单独一套）：**rate_limit 不该换候选**，`other` 里的 4xx 参数错更不该 |
| 10 | `src/raccoon/limiter.js` 头部注释 | 删掉「上游按出站公网 IP 计并发」整段结论与那张表，改为「账号级风控 + 跨模型」并附本次证据。**错误注释会持续生产错误代码** |

### P2（观测）

| # | 改动 |
|---|---|
| 11 | traffic 日志新增 `upstreamCode` 字段（现在只能从 `error` 字符串里正则抠） |
| 12 | 面板/Raccoon 卡片显示「账号处置状态 + 解禁时刻」，而不是笼统的「冷却中」 |
| 13 | 给 `200108` 单独一条告警：它意味着账号被风控，不是配额问题，**需要人去「问题反馈」申诉** |

---

### 落地状态（2026-11-25 当天完成）

| # | 位置 | 状态 |
|---|---|---|
| 1 | `upstream/errors.js` 正则 `(\d{3,5})`→`(\d{4,9})` + `account_risk`/`model`/`timeout` 分类 | ✅ 已改，含回归单测 |
| 2 | `raccoon/product.js` 兜底表改名 + `detectCatalogDrift` 漂移检测 | ✅ 已改，含漂移单测 |
| 3 | `output/model-router.json` 三个虚拟模型候选换现行名 | ✅ 已改（5 处候选） |
| 4 | `raccoon/limiter.js` 识别 `200108` + 采用上游 `Retry-After` + 不参与指数退避 | ✅ 已改，含 5 条新单测 |
| 5 | `lib/upstream-error.js` `Retry-After` 取 `max(本地, 上游)` | ✅ 已改 |
| 6 | `RACCOON_TIMEOUT_MS` 60000 → **1200000** | ✅ 已改，含默认值单测 |
| 7 | 超时 abort 打标 `err.timedOut`，dispatch/model-router 均不得重试 | ✅ 已改 |
| 8 | `MAX_ACCOUNT_SWITCHES` 3 → **2**（且只有 `auth` 分支还会换号） | ✅ 已改 |
| 9 | 默认 `switchOn` 去掉 `other`（store / autotier / 两份 json 全改） | ✅ 已改 |
| 10 | 重写 `limiter.js` 头部「IP 出口限流」错误结论 | ✅ 已改（含历史保留说明） |
| 11 | traffic 日志补 `upstreamCode` / `timedOut`；超时记 504 | ✅ 已改（两条入口） |
| 12 | `/v1/raccoon/limiter` 增加 `riskControl` / `blockedReason` | ✅ 已改 |
| 13 | 面板显示「风控 + 解禁时刻」 | ⏳ 后端已就绪（`snapshot().riskControl`），前端待接 |

验证：`npm test` **全绿**（0 失败）；`npm run lint` 退出码 0。
新增回归用例覆盖：6 位码不截断、`200108`→`account_risk`、`100004`→`model`、
`timedOut`→`timeout`（先于 5xx）、`account_risk` 不参与指数退避且不连带冻出口、
`riskCoolingReason`、超时默认 1200s、兜底表不含旧名、`detectCatalogDrift` 双向。

---

## 7. 复现与验证

```bash
# 1) 账号是否被处置（只读、不消耗、不受限）
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  https://xiaohuanxiong.com/api/web/llm/v2/model_catalog
# 200 = 账号活着；429/200108 = 被处置

# 2) 单发判断模型名是否还有效
curl -s -X POST https://xiaohuanxiong.com/api/web/llm/v2/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"sn-deepseek-v4-1-flash-1017","messages":[{"role":"user","content":"ok"}],"max_tokens":4}'
# 200 → 有效；400 code=100004 → 名字过期

# 3) 确认超时语义（不再有 60s 砍流；超时记为 timeout 而非可重试）
node -e "const p=require('./src/raccoon/product');
console.log('RACCOON_TIMEOUT_MS =', p.REQUEST_TIMEOUT_MS, '(应为 1200000)')"

# 4) 确认 6 位码不再被截断
node -e "const {classifyError}=require('./src/upstream/errors');
const e=new Error('x: {\"error\":{\"code\":200108}}'); e.status=429;
classifyError(e); console.log(e.upstreamCode===200108?'OK':'STILL TRUNCATED');"
```

---

## 8. 未验证的假设（留待后续，不要当结论用）

- **`User-Agent: node` 是否被风控纳入画像**。网关走 `undici`，UA 字面是 `node`；
  官方是 `Mozilla/5.0 … Raccoon/1.0.38`。已做 A/B：同一账号、20 次 @1200ms，
  两套头**都是 200**，所以 UA 单独不足以触发 `200108`。但它是否作为**加权项**
  参与风控打分，无法在不制造风控的前提下验证 —— 建议直接对齐官方 UA，成本为零。
- **`X-Client-Name: Raccoon` 的作用**。实测它是「旧模型名能否被接受」的开关：
  `sn-deepseek-v4-1-flash` + 无该头 = 400/100004；加该头 = 200 但**被改写成
  `raccoon-090dd3`**（上游把它当别名转到默认模型）。也就是说旧名即使能过，
  实际跑的也不是你以为的那个模型 —— 计费与能力全变。这条比 400 更危险，值得单独跟。
- **`200108` 的触发阈值**。已知：单账号、跨模型、`Retry-After` 固定 3 小时；
  未知：是按「无效调用占比」还是「单位时间 token 量」判定。**不要为了测这个再去撞。**
