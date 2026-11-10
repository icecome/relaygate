# 事故记录：多工具调用的 wire index 全 0，客户端聚合出拼接 JSON（2026-11-06）

> 本文记录一次**网关出口协议缺陷**引发的用户侧故障：DSH 经虚拟模型并行调用两个工具时，
> 收到的 arguments 是两个 JSON 对象背靠背拼在一起，整轮以 `MALFORMED_RESPONSE` 失败。
> 留档原因：缺陷不在某次上游异常，而在我们自己的流式出口少传一个参数——单工具轮次
> 完全正常，**只有多工具轮次必炸**，这种「平时好的」缺陷最难从上游日志里看出来。

## 1. 事故经过

用户会话（DSH，`session-6ee1fa1a`，工作目录 `project/script`，dsh-markdown-polish 插件
收尾阶段）在 `vm/long-context` 虚拟模型上连续两轮失败，错误原文：

```text
Tool call "read": Unexpected non-whitespace character after JSON at position 99 (line 1 column 100)

Received arguments:
{"file_path":"C:\\opt\\...\\compose-check.mjs"}{"command":"Get-ChildItem ...","description":"List desktop profile files"}
```

```text
Tool call "pwsh": Unexpected non-whitespace character after JSON at position 263 (line 1 column 264)

Received arguments:
{...pwsh 参数...}{...grep 参数（path + pattern）...}
```

两轮形态完全同构：**工具 A 的参数对象后面紧贴工具 B 的参数对象**（`}{` 边界），
字节位置与报错的 position 逐一吻合（turn 3: `}` 在 idx 98、`{` 在 idx 99；turn 4:
`}` 在 idx 262、`{` 在 idx 263）。模型本意是并行发起两个调用（read+pwsh / pwsh+grep）。

## 2. 根因

调用链：DSH → RelayGate `/v1/chat/completions` → `model-router/dispatch.js`
`dispatchOpenAIStream()`（虚拟模型走这条）→ `transform/sse.js` 归一化 →
`transform/emitters.js` `toolCall()` 渲染 OpenAI SSE。

三层各有一份事实，拼起来才是完整根因：

1. **`transform/sse.js`** 把上游工具调用归一化为「一次性完整参数」的
   `tool_call` 事件——每个事件自带完整 arguments，不做分片续传。
2. **`emitters.js` `toolCall(id, model, call, index)`** 的 `index` 形参在
   **不传时默认补 0**（`typeof index === 'number' ? index : 0`）。
3. **`dispatch.js` 的 `tool_call` 出口调用时漏传了 index**（写于该出口落地时，
   直连出口 `routes/openai.js` 后续修过这个问题并加了递增计数器，dispatch 出口漏掉了）。

客户端（DSH 的 pi-ai 适配层）按 `tool_calls[].index` 分桶聚合 arguments——
两个调用的 delta 都带 `index: 0`，于是**两个参数流被拼进同一个桶**：
name 取首片、arguments 无缝累加成 `}{...}`，`JSON.parse` 在第二个对象开头炸掉，
整个 turn 以 `MALFORMED_RESPONSE` 失败，两个调用一个都没执行。

同族缺陷：`routes/anthropic.js` 的出口同样没传块序号，`exportAnthropic` 的
`text()`/`toolCall()` 把所有 `content_block` 的 `index` 硬编码为 0——文本块与每个
工具块共用序号 0，Anthropic 协议下多工具调用同样会被客户端拼坏。

## 3. 为什么「平时看起来正常」

- **单工具轮次不受影响**：只有一个调用时 index 是什么都对，绝大多数请求
  （一次一个工具）从未暴露。
- **只有虚拟模型受影响**：直连模型（`/v1/chat/completions` 的直连路径）走
  `routes/openai.js` 的出口，那里有 `toolCallIndex` 计数器并显式传参；
  虚拟模型（`vm/*`）走 `model-router/dispatch.js` 的流式出口，漏传。
  这与 2026-10-12 的历史结论对上了：「这是项目级的系统性缺陷，不是 Hy3 特例」
  ——space-bunny 在同一个 `vm/long-context` 上症状相同，因为锅在出口不在上游模型。
- **非流式出口没这个问题**：`writeCompletionChunks` 用 `forEach((tc, i) => ...)` 传了 `i`。

## 4. 影响面

| 路径 | 缺陷 | 触发条件 |
|---|---|---|
| `dispatch.js` `dispatchOpenAIStream` | tool_calls index 恒 0 | 虚拟模型 + 流式 + 一轮 ≥2 个工具调用 → 必失败 |
| `anthropic.js` `/v1/messages` 流式 | content_block index 恒 0 | Anthropic 协议 + 流式 + 文本与工具共存或多工具 |
| 直连 `openai.js` 出口 | 无（有计数器） | — |
| 非流式 `writeCompletionChunks` | 无（传了 `i`） | — |

## 5. 修复

1. **`src/model-router/dispatch.js`**：`dispatchOpenAIStream` 增加 `toolCallIndex`
   计数器，`out.toolCall(...)` 显式传参并递增（与 `routes/openai.js` 直连出口同型）。
2. **`src/routes/anthropic.js`**：增加 `anthropicNextBlock` / `anthropicTextBlock`
   块序号分配——文本块占一个序号（首个 text 事件分配、连续 delta 共用），每个工具
   调用各占一个，互不冲突。
3. **`src/transform/emitters.js`**：`exportAnthropic` 的 `text()`/`toolCall()` 增加
   可选 `blockIndex` 形参（缺省 0，向后兼容）；`exportOpenAI.toolCall` 的 index
   语义不变（缺省 0 保留，但生产出口必须显式传）。

## 6. 验证

- 新增回归套件 `src/test/toolcall-index.test.js`（7 项，已挂进 `npm test`）：
  - OpenAI 出口显式传 0/1 → 帧内 index 正确；
  - dispatch 修复后的发射模式（计数器递增）→ 按 DSH 的聚合方式分桶独立、各自可解析；
  - **反向锚**：旧形态（index 全 0）聚合必得 `}{` 拼接流，`JSON.parse` 必报
    `Unexpected non-whitespace character after JSON` —— 把事故认知锁进测试；
  - `createStreamHandler` + 计数器端到端（TRAE 分片形态入 → 出口两帧不同 index）；
  - Anthropic 出口 text=0 / tool1=1 / tool2=2 互不冲突，start/stop 同号。
- 既有套件回归：`protocol.test.js` 36 项、`unit.test.js` 303 项、全量 `npm test` 通过。
- 线上确认：修复文件 14:48:45 落盘，服务 14:55:48 重启加载（pid 6292），
  时间戳晚于落盘时间，运行中的即修复后代码。

## 7. 防复发

- 回归测试挂进 `npm test` 主链，任何出口改动退回「不传 index」会直接红。
- 出口约定显式化：emitters 的 index 形参是「调用方必须维护」的协议字段，
  不靠缺省值兜正确性——缺省 0 只为兼容旧测试，生产路径一律显式传。
