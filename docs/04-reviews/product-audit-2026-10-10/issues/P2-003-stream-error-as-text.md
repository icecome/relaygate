# P2-003 — 流中途失败被渲染成模型输出文本

| 字段 | 值 |
|---|---|
| **Priority** | P2 |
| **Category** | 协议正确性 |
| **Labels** | `bug`, `p2`, `backend`, `sse`, `protocol` |
| **Difficulty** | 低-中（约 2 小时，含测试） |
| **Risk** | 中（改的是 SSE 出口，需验证三个协议面一致） |
| **来源** | product-professor full audit 2026-10-10（**evidence-verifier 独立复核确认**） |

---

## Evidence（已独立复核）

### OpenAI 出口：错误变成 delta.content

[src/transform/emitters.js:48-50](../../../../src/transform/emitters.js#L48-L50)（已实读复核）：

```js
error(id, model, code, message) {
  return [sse(openaiChunk(id, model, { content: `\n[Error ${code || ''}: ${message || 'unknown'}]` }, null))];
},
```

调用点 [src/routes/openai.js:510-513](../../../../src/routes/openai.js#L510-L513)（已实读复核）：

```js
if (!res.writableEnded) {
  // SSE 头已下发，无法改状态码：code 传 429 让客户端识别为「过载可重试」
  write(out.error(completionId, model, err.upstreamCode ?? (err.status === 429 ? 429 : null), err.message));
  res.end();
}
```

**问题链条**：

1. 流已经开始（SSE 200 已下发）
2. 上游中途失败
3. 网关把错误文本塞进 `delta.content` —— **HTTP 仍是 200**
4. **没有 `finish_reason`、没有 `data: [DONE]`、没有标准 error 对象**

对 agent 类客户端（继续消费 delta 拼接内容）来说，`[Error 3004: ...]` 就是模型说的话的一部分。

### 对比：另外两个出口是对的

[src/transform/emitters.js:77-79](../../../../src/transform/emitters.js#L77-L79)（Anthropic，已实读复核）：

```js
error(id, model, code, message) {
  return [sse({ type: 'error', error: { type: 'api_error', message: ... } })];
},
```

[responses.js:165](../../../../src/routes/responses.js#L165) 用 `response.failed` 事件。

**三个出口中 OpenAI 是唯一把错误当内容的。** 而 OpenAI 协议恰恰是使用最广的出口。

### 连带问题（同一修复面）

1. **`consumeStream` 无 `finally { reader.cancel() }`**（[upstream/client.js:405-427](../../../../src/upstream/client.js#L405-L427)）—— 上游 body 泄漏，连接与 pool 的 inFlight 租约不释放。
2. **`anthropic.js:145` 的 `streamAccountId` 时序错误**（已实读复核行号）：赋值在 `pool.run` **返回后**（[:145](../../../../src/routes/anthropic.js#L145)），使用在 `pool.run` **内部回调**（[:134](../../../../src/routes/anthropic.js#L134)）→ 此时恒为 `null` → **`/v1/messages` 的流内限流错误永不回灌账号池**。对比：`openai.js` 用闭包参数（正确），`responses.js` 在 pool.run 之后使用（正确）——**只有 anthropic 错**。
3. **流式读取阶段无超时**（[upstream/client.js:224,243](../../../../src/upstream/client.js#L224-L243)）：600s 超时定时器在拿到响应头后就 `clearTimeout`，`reader.read()` 可永久挂起。

---

## Why it matters

对 OpenAI 协议的 agent 客户端（IDE 插件、自动化脚本），这是**静默数据污染**：

- 客户端收到 HTTP 200 + 一段以 `[Error 3004: ...]` 结尾的"模型输出"
- 若客户端把内容存入对话历史，**错误文本从此成为上下文的一部分**，污染后续所有轮次
- 没有任何信号（状态码/finish_reason/error 事件）告诉客户端"这段不是模型说的"

一个每 50 次请求出现一次上游限流的网关，会以每周几次的频率污染用户上下文——而用户只会觉得"模型变笨了"。

---

## Expected behavior

流中途失败时，OpenAI 出口应：

1. 发送一个**标准错误 chunk** 或至少一个**带 `finish_reason: 'error'`（或 `'stop'` + error 字段）的终止 chunk**
2. 发送 `data: [DONE]\n\n` 正确收尾
3. 不把错误文本放进 `delta.content`
4. `err.upstreamCode`（如 429）应能被客户端从某个字段读出

同时修复：`consumeStream` 的 reader 清理、`anthropic.js` 的 `streamAccountId` 时序。

---

## Acceptance criteria

1. 新增测试：模拟流中途抛错，断言 OpenAI 出口**不产生**包含 `[Error` 的 `delta.content` chunk，且以 `[DONE]` 收尾。
2. Anthropic 出口错误事件保持现状（已是正确的 `{type:'error'}`）。
3. `anthropic.js` 的流内 `pool.record(accountId, ...)` 能拿到非 null 的 accountId（可用注入 spy 验证）。
4. `consumeStream` 在异常退出时调用 `reader.cancel()`（测试可用 mock reader 断言）。
5. 现有 288 断言全部通过。
6. 手动验证：真实上游限流场景下，IDE 客户端显示错误而非"模型输出了一段错误信息"。

---

## Implementation notes

### OpenAI error chunk 的正确形状

OpenAI 协议没有标准的流内错误事件（错误都在 HTTP 层）。社区通行做法有两种：

**方案 A（推荐，兼容性最好）**：
```js
error(id, model, code, message) {
  return [
    sse(openaiChunk(id, model, {}, 'stop')),           // finish_reason: 'stop' 正常收尾
    sse({ error: { message, type: 'upstream_error', code } }),  // 顶层 error 对象（OpenAI SDK 会抛出）
    'data: [DONE]\n\n',
  ];
}
```
OpenAI 官方 SDK 遇到 chunk 内的顶层 `error` 字段会抛出 APIError——客户端能感知失败。同时 `finish_reason:'stop'` 保证不等待的客户端正常结束。

**方案 B**：`finish_reason: 'error'`（非标准但自解释）+ `[DONE]`。

**无论哪种，都不要把错误文本放进 `delta.content`。**

### `anthropic.js` 时序修复

把 `:134` 的回调改为使用 `pool.run` 返回值里的 `accountId`（与 `responses.js` 同模式），或在 `pool.run` 的 options 里传入回调。**不要**依赖外层 let 变量在异步回调里的赋值时序。

### `consumeStream` 清理

```js
try { ... while ((chunk = await reader.read()) ...) } 
finally { try { await reader.cancel(); } catch {} }
```

---

## 可直接执行的修复提示词

```
修复流中途失败的三个问题（OpenAI 出口错误当内容、anthropic 时序 bug、reader 泄漏）。

已核实的事实：
1) src/transform/emitters.js:48-50 —— OpenAI 的 error() 把错误文本放进 delta.content：
   `[Error ${code}: ${message}]`。调用点 openai.js:510-513 在 SSE 头已下发后调用它，
   然后直接 res.end() —— 没有 finish_reason、没有 [DONE]、没有标准 error 对象。
   HTTP 仍是 200。agent 客户端会把这段错误文本当模型输出存进上下文。
   对比：同文件 77-79 行 Anthropic 出口用的是正确的 {type:'error'} 事件；
   responses.js:165 用 response.failed。三个出口只有 OpenAI 是错的。
2) src/routes/anthropic.js —— streamAccountId 在 145 行（pool.run 返回后）赋值，
   但 134 行在 pool.run 内部的流回调里使用它，此时恒为 null
   → /v1/messages 的流内限流错误永不回灌账号池。
   openai.js 用闭包参数（正确），responses.js 在 pool.run 之后使用（正确）。
3) src/upstream/client.js:405-427 的 consumeStream 没有 finally { reader.cancel() }
   → 异常退出时上游 body 泄漏、连接与 pool inFlight 租约不释放。
   另外 224/243 行的 600s 超时定时器在拿到响应头后就被 clearTimeout，
   流式读取阶段没有超时保护。

请执行：

【修复 1：OpenAI 出口的 error()】
emitters.js 的 exportOpenAI().error 改为：
  - 一个 finish_reason:'stop' 的空 delta chunk（让不检查错误的客户端正常结束）
  - 一个顶层 error 对象 chunk：sse({ error: { message, type: 'upstream_error', code } })
    （OpenAI SDK 遇到 chunk 内顶层 error 会抛 APIError，客户端能感知失败）
  - 'data: [DONE]\n\n' 收尾
绝不把错误文本放进 delta.content。
同时检查 openai.js:510-513 的调用点：res.end() 前确保 [DONE] 已写出
（如果 out.error 的返回数组里已含 [DONE] 就不要重复）。

【修复 2：anthropic.js 的 streamAccountId 时序】
把 134 行回调里对 streamAccountId 的依赖改为与 responses.js 相同的模式：
在 pool.run 的 resolve 值（{ result, accountId }）拿到后再做需要 accountId 的收尾，
或把 record 调用移到 pool.run 之外的 catch 分支（此时 accountId 已可用）。
修复后 145 行的外层 let 变量可以删除。
注意：不要改变现有正常路径的行为——只影响错误回灌。

【修复 3：consumeStream 的资源清理】
upstream/client.js 的 consumeStream 加 finally { try { await reader.cancel(); } catch {} }。
可选（若改动风险可控）：给流式读取阶段加一个软超时（如 120s 无新 chunk 则 abort），
默认值走 env（STREAM_IDLE_TIMEOUT_MS，0=关闭），避免改变现有长输出场景的行为。

【测试】
在 src/test/unit.test.js 新增（或新建 stream-error.test.js）：
- 用例 A：mock 一个中途抛错的 stream，走 exportOpenAI 渲染，
  断言输出中不存在含 '[Error' 的 delta.content chunk，且最后一行是 data: [DONE]
- 用例 B：mock reader，断言异常路径下 cancel() 被调用
- 用例 C：anthropic 流内限流场景，断言 pool.record 收到的 accountId 非 null
  （可用注入 spy 或记录参数）

运行 npm test 确认 288 个既有断言 + 新用例全部通过，exit 0。
```