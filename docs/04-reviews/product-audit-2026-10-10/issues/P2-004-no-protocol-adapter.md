# P2-004 — 四份手写协议骨架，已产生行为分叉

| 字段 | 值 |
|---|---|
| **Priority** | P2 |
| **Category** | 架构 |
| **Labels** | `architecture`, `p2`, `backend`, `refactor`, `protocol` |
| **Difficulty** | 高（约 2-3 天，含测试） |
| **Risk** | 高（动的是转发面核心路径；**必须在 P0/P1 修复稳定后单独进行**） |
| **来源** | product-professor full audit 2026-10-10 |

---

## ⚠️ 执行时机警告

这是本审计中**唯一不建议立即执行**的修复。理由：

1. 它动的是三条转发路由的核心 —— 恰好是**测试覆盖为零**的区域（见 P3-003）
2. P2-003（流错误当内容）必须先修 —— 否则重构会把 bug 一并搬进新抽象
3. 收益是长期的（可维护性），不是即时的

**推荐顺序：先做 P2-003 + 补齐协议层测试 → 再做本重构。**

---

## Evidence

### 四份手写骨架

以下 8 项职责在 **4 个文件中各自独立实现**：

| 职责 | openai.js | anthropic.js | responses.js | model-router/dispatch.js |
|---|---|---|---|---|
| ACL 检查（canUseModel） | ✅ 手写 | ✅ 手写 | ✅ 手写 | ✅ 手写 |
| pool.run 包裹 + 重试 | ✅ | ✅ | ✅ | ✅ |
| SSE 响应头 | ✅ | ✅ | ✅ | ✅ |
| createStreamHandler + createLineFeeder + consumeStream | ✅ | ✅ | ✅ | ✅ |
| 流内 error → 异常 → 回灌 pool | ✅ | ✅（有 bug，见 P2-003） | ✅ | ✅ |
| 已发头错误帧 | ✅ | ✅ | ✅ | ✅ |
| logRequest 调用 | ✅ | ✅ | ✅ | ✅ |
| finish_reason 改写 | ✅ | ✅ | ✅ | ✅ |

### 已产生的行为分叉（不是假设，是现实）

| # | 分叉 | 证据 | 影响 |
|---|---|---|---|
| 1 | `markIncompleteToolArgs`：openai 传 `config.markIncompleteToolArgs`，dispatch 硬编码 `false` | [openai.js:431](../../../../src/routes/openai.js#L431) vs [dispatch.js:407](../../../../src/model-router/dispatch.js#L407) | 同一入参走 `/v1/chat/completions` 与虚拟模型路由，残缺工具参数的处理不同 |
| 2 | `AUTO_CONTINUE`（截断自动续写）只在 openai 生效 | [openai.js:447,537](../../../../src/routes/openai.js#L447) | `/v1/messages` 与 `/v1/responses` **完全没有续写**——同一上游截断，一个协议自动续，两个协议如实截断 |
| 3 | `responses.js:149-152` 无条件写 `status:'completed'`，不区分截断 | [responses.js:149-152](../../../../src/routes/responses.js#L149-L152) | 同一上游截断，`/v1/chat/completions` 返回 `finish_reason:'length'`，`/v1/responses` 返回 `completed` |
| 4 | 流内错误出口质量不一 | [emitters.js:48-50 vs :77-79](../../../../src/transform/emitters.js#L48-L79) | OpenAI 把错误当内容（P2-003）；Anthropic/Responses 用标准错误事件 |

### 加重因素

- 这 4 个文件**零测试覆盖**（`routes/openai.js`、`anthropic.js`、`responses.js` 在测试中一个 require 都没有）
- 每次修一个协议面的 bug，都要人工检查其他三个是否同样存在——历史上已经漏了（anthropic 的时序 bug）

---

## Why it matters

这不是审美问题。分叉 1-4 意味着：**同一个用户请求，走不同的协议面会得到不同的行为**——而用户无从知晓。

对于"OpenAI/Anthropic/Codex 兼容"这个核心卖点，协议面行为不一致是**产品级缺陷**，不只是代码异味。

---

## Expected behavior

存在一个 `src/protocol/`（或等效）适配层，4 个路由文件退化为薄壳：

```js
// routes/openai.js（重构后）
router.post('/v1/chat/completions', authenticate, keyRateLimit(), (req, res) =>
  protocol.handle('openai', req, res));
```

适配层统一负责：ACL → pool → SSE → 流处理 → 错误回灌 → logRequest → finish 改写。协议差异（事件形状、字段名）由每协议的 `emitters` + `parsers` 承担——这两层**已经存在**（[transform/emitters.js](../../../../src/transform/emitters.js)、[transform/request.js](../../../../src/transform/request.js)），缺的只是把"编排"从路由中抽出来。

---

## Acceptance criteria

1. `src/routes/openai.js`、`anthropic.js`、`responses.js` 每个文件 ≤ 150 行（当前 584/约 300/约 200）。
2. 分叉 1-4 全部消除：四个出口对同一入参产生**协议正确但语义一致**的行为（markIncomplete / autoContinue / 截断状态 / 错误事件）。
3. **新增协议层集成测试**（这是本重构的前置条件，不是附带产物）：
   - 每协议至少 3 个用例：正常流、中途错误、截断
   - 用 mock 上游（不消耗真实额度）
4. 现有 288 断言全部通过。
5. 真实上游冒烟：三个协议各发一次真实请求验证（人工）。

---

## Implementation notes

### 分阶段（每步可独立合并）

1. **第一步（不动行为）**：抽出 `src/protocol/pipeline.js` —— 把 4 处相同的"ACL → pool.run → SSE 头 → streamHandler 装配"提为一个函数，参数化协议差异。4 个路由改调它。**此步结束行为应完全等价**（用现有 288 断言 + 新增的协议测试守门）。
2. **第二步**：把分叉 1-4 的行为统一到一个 config 驱动点（`markIncompleteToolArgs`、`autoContinue`、截断状态改写）。每统一一个分叉，跑一次协议测试。
3. **第三步**：`model-router/dispatch.js` 的虚拟模型路径并入同一 pipeline（它当前是第 4 份手写）。

### 前置条件（必须先完成）

- [ ] P2-003 已修复（流错误出口）
- [ ] 协议层测试已建立（否则重构无守门）
- [ ] P0-001、P0-002 已修复（不要在数据层/停机层不稳时动转发面）

---

## 可直接执行的修复提示词

```
【这是一个分阶段重构，请严格按顺序执行，每阶段独立验证后再进入下一阶段】

背景：src/routes/openai.js(584行)/anthropic.js/responses.js 与
src/model-router/dispatch.js 四份文件手写了同一套转发骨架：
ACL 检查 → pool.run 包裹 → SSE 头 → createStreamHandler+createLineFeeder+consumeStream
→ 流内 error 回灌 → 已发头错误帧 → logRequest → finish_reason 改写。
已经产生 4 处行为分叉：
  1) markIncompleteToolArgs：openai 传 config 值，dispatch.js:407 硬编码 false
  2) AUTO_CONTINUE 只在 openai.js:447,537 生效，/v1/messages 与 /v1/responses 没有续写
  3) responses.js:149-152 无条件写 status:'completed'，不区分截断
     （openai 是 finish_reason:'length'）
  4) 流内错误出口：OpenAI 把错误当内容（emitters.js:48-50，另一个 issue 已修），
     Anthropic/Responses 用标准错误事件

前置条件（必须先完成，否则拒绝执行本重构）：
  □ 流内错误出口已修复（P2-003）
  □ 已建立协议层测试（见下方第 0 步）

—— 第 0 步：先建测试（没有它不要动任何路由代码）——
新建 src/test/protocol.test.js，用 mock 上游（不消耗真实额度）覆盖每协议 3 个用例：
  - 正常流：完整 delta 序列 + 正确收尾
  - 中途错误：上游中途抛错 → 断言协议正确的错误事件 + 收尾
  - 截断：finish_reason=length → 断言各协议的截断语义
mock 方式：参照 src/test/unit.test.js 已有的 WORKSPACE_DIR 隔离与模块注入模式，
对 upstream/client.js 的 llmUtilsChat 打桩。
先让这些测试在当前代码上通过（记录现状行为），再开始重构。

—— 第 1 步：抽 pipeline（行为完全等价）——
新建 src/protocol/pipeline.js：
  导出 handleForward({ protocol, req, res, key, model, messages, opts })
  内部统一：ACL → pool.run → SSE 头 → streamHandler 装配 → 错误回灌 → logRequest。
协议差异通过参数注入：emitters（已有 transform/emitters.js）、
解析器（已有 transform/request.js）、协议名（用于 logRequest.endpoint）。
4 个路由文件改为薄壳调用 pipeline，每个文件目标 ≤150 行。
完成后：npm test 必须 288+新增 全绿；第 0 步的测试必须与重构前行为一致。

—— 第 2 步：统一 4 处分叉（每处一个 commit）——
分叉 1：markIncompleteToolArgs 统一读 config.markIncompleteToolArgs
分叉 2：AUTO_CONTINUE 在三个协议面生效（若上游行为不同需在 emitters 层适配）
分叉 3：responses 的截断状态改为与 openai 一致的语义（completed 仅在真正完成时）
分叉 4：流内错误事件统一走 emitters 的 error()（已在 P2-003 修过 OpenAI 侧）
每统一一处：跑 protocol.test.js + 全量 npm test。

—— 第 3 步：dispatch.js 并入 ——
model-router/dispatch.js 的虚拟模型路径改用同一 pipeline。
完成后删除 dispatch 中与 pipeline 重复的手写骨架。

验收：
  - openai.js / anthropic.js / responses.js 各 ≤150 行
  - 4 处分叉全部消除（protocol.test.js 有对应用例）
  - npm test 全绿，exit 0
  - 人工冒烟：三个协议各发一次真实请求验证

如果任何一步发现行为等价性无法保证，停下来报告差异，不要强行继续。
```