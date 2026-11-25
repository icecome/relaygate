# 事故记录：TraeWork 调自定义模型频繁报 `4054`（2026-11-25）

- **日期**：2026-11-25
- **影响面**：TraeWork CN 3.4.24 以「自定义模型（Custom OpenAI Compatible）」方式指向
  本网关（`http://localhost:19900/v1/chat/completions`）时的长回合对话。
- **表现**：客户端弹「模型请求失败，请稍后重试。(4054)」，该轮对话作废
  （`revertible:true`，需重发），已消耗的 token 不退。
- **对照**：同一台机器上 DSH 直连同一网关**几乎不出现**该错误。
- **状态**：已修复（网关侧两个放大器）+ 已补观测盲区。生产进程需重启后生效。

---

## 1. 结论先行

`4054` **不是网关返回的 HTTP 错误**，是 Trae 客户端自定义模型链路的业务错误码：

```
o[o.CUSTOM_MODEL_INTERNAL_ERROR=4054]="CUSTOM_MODEL_INTERNAL_ERROR"
   （客户端 bundle：node_modules/@byted-icube/solo-lite/dist/9968.f56c1dc0.mjs）
```

对应文案 `Custom model internal error occurred. Please check the proxy response for details.`
是一个 catch-all，语义是「自定义模型的代理回传出了问题」，不是鉴权/限流/额度码。

**网关侧取证：6 次 4054 的当时，网关没有任何 Trae 请求在飞；当轮全部 200。**

| 4054 时刻（本地） | 上一个 Trae 请求结束 | 间隔 | 当轮网关状态 |
|---|---|---|---|
| 11-20 10:27:52.523 | 02:27:49.994Z | 2.53s | 全 200 |
| 11-24 14:09:54.503 | 06:09:02.965Z | 51.5s | 全 200 |
| 11-24 14:17:42.669 | 06:13:16.443Z | 266s | 全 200 |
| 11-24 17:05:40.751 | 08:59:19.111Z | 381s | 全 200 |
| 11-25 09:59:44.895 | 01:59:40.384Z | 4.51s | 全 200 |
| 11-25 10:04:46.668 | 02:04:41.575Z | 5.09s | 全 200 |

（`logs/<date>/traffic.jsonl`，`platform='trae'`，`status=200`、`finishReason=tool_calls`、`error=null`）

---

## 2. 真实链路：为什么会有「proxy response」

Trae 的自定义模型**不是客户端直连 endpoint**。从客户端 `harness.dll` 的字符串可还原：

```
harness\custom-model-proxy\module\src\tunnel_manager.rs
preparing custom model proxy tunnel / custom model proxy tunnel prepared
custom model proxy request preparation failed / custom model proxy preparation timed out
custom model proxy WebSocket host is not configured
custom model proxy TurnStart is missing session id
failed to close replaced custom model proxy tunnel
```

```
云端 agent 服务（cloud_agent 编排）
   │  WebSocket 隧道（TurnStart / 结果回传）
   ▼
本地 harness 的 custom-model-proxy
   │  普通 HTTP
   ▼
http://localhost:19900/v1/chat/completions   ← 本网关
```

日志里这一轮确实走云端编排（`window1/renderer.log` 的 metadata）：

```json
{"agent_task_service_strategy":"cloud_agent",
 "provider":"custom_openai_compatible",
 "base_url":"http://localhost:19900/v1/chat/completions"}
```

**隧道中途断开 = 4054。** 与 Trae 官方 FAQ 的表述一致：

> 自定义模型的 LLM 调用请求由客户端发起，客户端需通过长连接将 LLM 执行结果回传给
> 服务端，**若此长连接中途断开，将触发该错误**。
> —— [有问必答｜热门问题答疑 Vol.2（火山引擎）](https://developer.volcengine.com/articles/7622875964665495595)

时间线也支持这个判断：每次 4054 的前 100–300ms 都是同一组工具收尾
（`captureThumbnail` ×4 → `refreshLocalArtifactShareIfExists` ×N → `browserUseTool`
unlock cleanup → `getRulesDetails` → `mark_session_read`），随后云端推
`session_updated {"status":6,"task_status":6}`（6 = failed），本地判定
`Status conflict detected while streaming`（本地仍在 status 3 = streaming），
**最后**才吐 4054。顺序是「云端先判失败 → 本地清理 → 报错」，判决来自云端。

---

## 3. 为什么 DSH 不出现

DSH 是**直连**：`profiles/desktop/cordis.patch.yml` 里 `baseURL: http://localhost:19900/v1`，
本地进程直接发 HTTP，不经云端编排、没有那条隧道，**从架构上产生不出 4054**。

这是「同一网关、两个客户端、只有一个出问题」的完整解释，不是网关不稳定。

---

## 4. 网关侧的两个放大器（本次修复对象）

根因不在网关，但网关有两个实现细节会**显著拉长隧道静默**，直接提高被云端掐断的概率。

### 放大器 A —— `AUTO_CONTINUE` 让每个请求都「整轮缓冲」

`routes/openai.js` 原实现：

```js
const emitDuringRound = !continueEnabled;   // continueEnabled = autoContinue && maxContinues>0
```

`AUTO_CONTINUE=true` 时 `emitDuringRound=false`，于是**整轮一个字节都不下发**，
直到聚合完成才在 `ensureStart()` 处写第一帧。首字节延迟 = 整轮耗时。

该路径耗时分布（近 6 天 3146 条 Trae 请求）：

| p50 | p75 | p90 | p95 | p99 | max |
|---|---|---|---|---|---|
| 4.9s | 10.6s | **19.1s** | 26.8s | **45.5s** | 110s |

26.8% 超过 10s，15% 超过 15s，1% 超过 45s。**头已发、零字节、静默 20 秒是常态。**

而它换来的收益接近于零：全库 Trae 通道 **6315 条请求里 `truncated` 只有 1 条（0.02%）**。

语义缺陷在于：续写逻辑本应只在 `finish_reason=length` 时触发，但实现是
「先全缓冲、再判断要不要续写」，等于给所有请求（包括 100% 正常的 `tool_calls`）都套上缓冲代价。

### 放大器 B —— 直连路径完全没有 SSE 心跳

仓库里已有心跳（`model-router/stream-gate.js` 的 `DEFAULT_KEEPALIVE_MS = 15_000`），
但它只在**虚拟模型**路径生效（`model-router/index.js:361`）。TraeWork 打的是
`deepseek-v4.1-flash` 这类直连模型，走 `routes/openai.js` 那条路，**一个 ping 都不发**。

A + B 叠加 = 「头已发 + 零字节 + 最长 110 秒无任何流量」。

### 放大器 C —— keep-alive 空闲 5s vs 客户端请求间隔 p50 11.5s

网关从未调过任何超时（`grep keepAliveTimeout` 全库零命中），走 Node 默认值。
对本机运行实例实测：

```
keepAliveTimeout 5000  headersTimeout 60000  keepAliveTimeoutBuffer 1000
空闲 6015ms 后服务端发 FIN；6.0s 内复用正常；6.5s 后写 → 失败
```

而 Trae 通道的相邻请求间隔：

```
p50 = 11.5s   p75 = 19.6s   p90 = 35.3s
间隔 > 5s：57.6%     间隔 > 6s：51.1%
```

**一半以上的请求间隔超过 6 秒。** 客户端连接池里的 socket 早已被服务端单方面 FIN，
写入落在竞态窗口就得到「连接重置、无 HTTP 响应」——正是错误文案里
*"Please check the proxy response"* 所指的那种失败。6 次 4054 里 4 次间隔 > 5s，
其中 11-25 10:04:46 那次是 **5.09s**，正压在默认边界上。

---

## 5. 顺带发现的观测盲区

实测验证：**中间件层的拒绝完全不进 traffic 日志**。

```
bogus key → HTTP 401 → logs/<date>/traffic.jsonl 行数 delta = 0
```

`middleware/auth.js` 的 401/403、`middleware/rate-limit.js` 的 429 都没有 `logRequest`。
于是出现「客户端报错、网关日志里查不到这次请求」的困境——与 2026-11-22 那次请求体
超限被渲染成上游故障是同一类问题，只是拒收点更早。

本次 4054 已用「无在飞请求」排除了该原因，但盲区本身必须补。

---

## 6. 修复

| # | 改动 | 位置 | 说明 |
|---|---|---|---|
| 1 | 续写改为「首轮边收边发 + 仅 length 时追加」 | `routes/openai.js` | 首字节延迟从「整轮耗时」降到「首 token」；只把末帧 `done` 挪到最后。续写是**追加**，与流式不冲突 |
| 2 | 新增 SSE 静默心跳（默认 15s） | `lib/sse-heartbeat.js`，接入 `openai.js` / `anthropic.js` / `responses.js` | 只在静默超期时补 `: ping` 注释帧，有字节流动时一帧都不发；客户端解析器一律忽略注释行 |
| 3 | `keepAliveTimeout` 5s → 65s（`headersTimeout` 自动 +5s） | `lib/server-timeouts.js`，在 `index.js#listen` 生效 | 覆盖 p90（35.3s）两倍以上；Node 要求 headers > keepAlive，故不暴露第二个旋钮 |
| 4 | 401/403/429 补 traffic 日志 | `log/traffic.js#logRejected`，接入 `auth.js` / `rate-limit.js` | 记 `platform:'gateway'` + `rejectedBy:'gateway'` + `rejectCode`，与真实上游失败可区分；不记任何密钥材料 |

配置项（都有注释，见 `.env.example`）：

```
SSE_HEARTBEAT_MS=15000        # 0 = 关闭
KEEPALIVE_TIMEOUT_MS=65000
AUTO_CONTINUE=true            # 保持开启：续写已不再付缓冲代价
```

### 为什么 #1 不新增「已发字节不可撤回」的风险

`pool.run` 只在 `auth` / `quota` / `rate_limit` 三类错误上换号重试，而这三类都在
`llmUtilsChat` 返回 HTTP 状态时抛出——那时响应体还没被消费，一个字节都没下发。
流中途的错误被标成 `UPSTREAM_STREAM_ERROR`，`classifyError` 落到 `other`，
不重试、直接补错误帧。故不会出现「候选 A 的半截 + 候选 B 的正文」拼接。

---

## 7. 验证

新增 `src/test/sse-heartbeat.test.js`（17 项，已进 `npm test`）：

- 有字节流动时**零额外帧**（不得给正常路径加任何帧）；
- 静默超期才补帧，且补的是 SSE 注释行；
- `end()` 之后不再写（避免 `ERR_STREAM_WRITE_AFTER_END`）；
- `write` 的返回值与回调原样透传（包装不改契约）；
- `headersTimeout` 严格大于 `keepAliveTimeout`；
- 默认 `keepAliveTimeoutMs` ≥ 实测 p90（35300ms）。

端到端探针（走真实路由 + 真实 fetch 读 SSE 字节）：

```
node scripts/probes/verify-sse-heartbeat.js
  心跳到达时刻(ms): [438,844,1252]      上游静默 1500ms、心跳 400ms
  全部通过（含「正文帧完整」「心跳不与 data 帧粘连」）

node scripts/probes/verify-continue-streaming.js
  +335ms text="ROUND1"   ← 首轮正文在两轮结束前就已到达
  +943ms text="ROUND2"
  +943ms finish=stop / done
  全部通过（含「只有一个 finish_reason」「只有一个 [DONE]」）
```

全量 `npm test` 通过；`biome check` 对改动文件无新增告警。

---

## 8. 落地步骤

1. 重启网关服务（Windows 服务名 `RelayGate`，或 `start.bat`）；
2. 启动日志应出现：
   `[relay-gate] keep-alive: idle=65000ms headers=70000ms (Node 默认 5000ms，…)`
3. 用一把无效密钥打一次转发面，`logs/<date>/traffic.jsonl` 应出现一行
   `platform:'gateway'`、`rejectedBy:'gateway'`、`rejectCode:'INVALID_ACCESS_KEY'`；
4. TraeWork 侧继续观察：同一会话连续长回合不再出现 4054；若仍出现，先按
   Trae 官方口径退出该会话重发（同 session 反复重试会反复撞同一隧道状态）。

---

## 9. 遗留与边界

- **根因不在网关**：隧道断开发生在 Trae 云端 ↔ 本地 harness 之间，网关只能缩小
  自己被牵连的窗口（静默、连接复用），不能保证云端不掐断。这是外部依赖的固有边界。
- **心跳不是万能**：若对端的「无进展」判据不看字节而看业务事件（例如必须收到
  `TurnStart` 回执），`: ping` 不解决。目前没有证据支持这一点（同链路下 WB 与
  DSH 都稳定），若后续复现需抓隧道侧报文再定。
- **不改客户端**：本次全部改动在网关侧，客户端零配置变更。
