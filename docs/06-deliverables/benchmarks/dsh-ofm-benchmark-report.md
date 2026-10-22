# dsh-our-free-model × RelayGate 深入对标与择优优化报告

> **本文定位**：针对 13 项候选优化点做**代码级逐项分析**，每项给出「对方实现（算法级）→ 我方现状（带行号）→ 择优结论 → 落地方案 → 代价与风险」。
>
> **配套文件**（同目录）：
> - `our-free-model-对比分析.md` — 48 项功能总矩阵与分维度概览（**先读那份看全貌**）
> - `dsh-ofm-四组功能代码级对标.md` — 省 Token / 可视化 / 本地应答 / 请求日志四组逐行详解（877 行）
>
> **代码根**：A = `C:\opt\workstations\project\web\dsh-our-free-model`；B = 本仓库。行号均为实测。
>
> **四项前提纠正**（分析中发现，与原假设相反，先看这里避免误判）：
> 1. **哈希错峰是 B 的能力，不是 A 的**。A 全仓无 spread/stableHash，只有启动延迟 30s + 串行 + captcha serial-queue（`auto-checkin.ts:184`）。B 的 `util.js:32-57,121-135` 才是确定性哈希错峰。
> 2. **A 的签到路径没有 busy 码指数退避**。`trae-credits.ts:265-276` 对 9074 明确不重试，`classifyTraeCheckinError` 算出的 `cooldownSecs` 全仓无消费方。**B 的 Trae 签到退避反而更完整**（`checkin.js:196-213` 三次 5/10/20s + 批后 busy 补跑 `:319-334`）。
> 3. **B 的 `client_token` 是每次随机 UUID**（`cat-trip.js:53`），重试/重启即换键 ⇒ 服务端去重失效。`growth-auto.js:12` 注释声称的幂等与实现不符，**这是一处真实缺陷**。
> 4. **A 的本地应答完全不写 usage 记录**（`forward.js` 全无 `recordUsage`），在 A 自己的看板里不可见；B 相反——转发路径是唯一数据源，因此**记账口径必须与 A 分歧**。

---

## 零、总览：13 项定位与 ROI

| # | 项 | 类型 | A 的实现强度 | B 的现状 | ROI | 人日 |
|---|---|---|---|:---:|:---:|:---:|
| 1 | 账号渠道（6 条） | 扩展 | 强（13 渠道体系） | 缺 Raccoon 等 | 中 | 视渠道 |
| 2 | `/v1/messages/count_tokens` | 补缺 | 有（近似公式） | **无端点**（但估算器更准） | **高** | 0.5 |
| 3 | SSE 形状嗅探 | 补缺 | 有（首块嗅探+回灌） | **仅非流式部分有** | 中 | 1-1.5 |
| 4 | 命名降级链 | 语义增强 | 有（提交语义最优） | failover 被 headersSent 卡死 | **高** | 2-3 |
| 5 | 容量取交集 | 语义增强 | 有（声明取交集） | **窗口有、模态无** | 中 | 1 |
| 6 | 思考强度档位 | 新增 | 有（硬预算） | 机制已有、缺阶梯 | 中 | 1.5-2 |
| 7 | 本地应答（5 个） | 新增 | 有（Claude Code 专用） | 无 | 中 | 1.5-2 |
| 8 | 节省统计面板 | 新增 | 有 | 无 | 中 | 1（依赖 RTK） |
| 9 | Token 热力图 | 新增 | 有（17 周） | 无 | **最高** | 1-1.5 |
| 10 | 总量曲线 | 增强 | 有（两维切换） | 单图双序列 | 高 | 1-2 |
| 11 | 请求日志 | 增强 | 有（物理/逻辑分离） | jsonl 分页 + 三态 | 中 | 1 |
| 12 | 热重载 | **不建议** | 有（插件形态专用） | 配置级已有 | 低 | 0.5 |
| 13 | 成长任务/积分领取 | 增强 | 有（coversToday 语义） | 六段编排、缺日闸 | **高** | 2-3 |
| — | **RTK 工具输出压缩** | 新增 | 有（实测省 90%） | 无 | **高** | 3-5 |

> **注**：第 8 项与 RTK 强绑定，RTK 是 B 全表中最对口的省钱项（B 上游输入 token 直接烧账号积分）；第 9-10 项是纯前端增量、风险最低，建议先做以建立节奏。

---

## 一、协议与网关层（第 2-6 项）

### 1.1 `/v1/messages/count_tokens` 本地估算

**A 的实现**（`src/anthropic.js:793-828`，常量 `:51-56`）

```js
const CHARS_PER_TOKEN = 4, IMAGE_TOKENS = 1024, TOOL_FRAME_TOKENS = 8, BASE_TOKENS = 16
input_tokens = 16 + ceil(textChars/4) + images*1024 + toolTokens
toolTokens   = toolCount === 0 ? 0 : ceil(toolChars/4) + toolCount*8
```
- `textChars` 逐个 block 累计：`text` / `tool_use`（name + `JSON.stringify(input)`）/ `tool_result`（字符串或内层 text/image）/ `thinking` / `redacted_thinking`；system 亦计入（`flattenSystem`）。
- 设计要点：**图片固定 1024**（base64 无尺寸信息可定价）、**工具帧 8 token/条**、**BASE 16 保证空 body 不为 0**（"客户端拿它做除数，读到 0 会炸"，`:54-56` 注释）。

**B 的现状**：**无此端点**。但估算基础设施比 A 更精确：
- `src/lib/token-estimate.js`：启发式 `CJK 0.7 token/字 + 其它 4 字符/token + 每消息 8 + 图片 1000`，且 `estimateRequestTokens` **计入 tools schema**（`:116-127`，有实测依据：27 个工具声明使上游报 100001 tokens 超限）。
- `src/lib/token-precise.js` + `token-estimate.js:60-71`：**js-tiktoken `cl100k_base` 真实分词**，超 60K 字符自动回退启发式（避免同步 BPE 阻塞事件循环，`:24-28` 注释）。

**择优结论**：**用 B 的分词器 + A 的结构完整性**。B 的 tiktoken 比 A 的 `chars/4` 准得多（尤其中文，A 的 4 字符/token 对中文低估约 40%），但 A 的分项口径（图片固定值、工具帧开销、BASE 防 0）是 B 缺的。两者互补。
**注意一个既有缺陷**：B 的 `/v1/messages` **恒流式**——`routes/anthropic.js:82` 解构了 `stream = true` 但 `:112-115` 无条件设 SSE 头并 `flushHeaders()`，此后再未使用 `stream`。count_tokens 是独立端点不受影响，但同一缺陷会阻塞第 7 项（本地应答需要非流式返回）。

**落地**：`src/routes/anthropic.js` 加 `router.post('/v1/messages/count_tokens', auth, ...)`；body 投影可写一个轻量 walker（不必走 `anthropicToOpenAI`，避免引入 tool 配对修复的副作用），文本累计后调 `estimatePromptTokensPrecise`，图片/工具按 A 的分项补。约 50 行。
**代价**：0.5 人日。**风险**：低。**验收**：与上游真实 `input_tokens` 对比偏差 <10%（当前 B 的 `tokenEstimateDelta` 日志字段已具备这个对照能力，`log/traffic.js` 有 `tokenEstimate/tokenEstimateDelta`）。

---

### 1.2 按响应体形状嗅探 SSE（防 Content-Type 欺骗）

**A 的实现**（`src/http.js`）
- `readHead` 只读**首个块（≤4KB）**即判定形状：`:` 或 `data|event|id|retry:` → SSE；`{` / `[` → JSON。
- **已嗅探的字节经 `replayStream` 回灌**——不用 `response.text()` 缓冲整条流，也不丢一个 token。
- **首帧识别为流立即放行**：短回答若在嗅探窗口等到 deadline 会被 `cancel` 丢掉整轮、报可重试 TIMEOUT 再花一次额度（v1.2.2 复审记录的真实教训）。
- 「按形状而非 header」的动机：该车道高负载下会以 `200 + application/json` 返回**完整 SSE 帧序列**，旧实现依赖 header 导致 `JSON.parse` 失败、整轮报废，且错误对象携带 `status:200` 使探测把可用模型误判为不可路由。

**B 的现状**：**已有部分实现，但位置不同**
- `src/upstream/client.js:306-309` 的 `looksLikeSse(text)`：取前 64 字符判 `event:` / `data:` / `:`。**判定思路与 A 的 `sniffBody` 同源，B 独立得出**。
- **但只用在一个地方**：`client.js:264` 的**非流式路径**，且是 `await resp.text()` **全量缓冲之后**再判。
- **流式路径没有判定**：`client.js:259` `if (stream !== false) return { body: resp.body }` 直接返回，完全不看形状。
- `model-router/dispatch.js:96-101` 对上游响应头到达即 `flushHeaders()`，随后 `:118-124` 逐块 `res.write(chunk)` 原样写出。

**风险场景**：上游忽略 `stream:true` 返回**完整 JSON** 时——
- WorkBuddy 路径（OpenAI passthrough）：非 SSE 字节带着 SSE 响应头写给客户端 → 客户端解析失败；
- Trae 路径：`createStreamHandler` 按行找 `data:` 前缀，找不到 → 产出空回复。
这是 A 记录过的同类事故（"整轮报废 + 可重试 TIMEOUT 再花一次额度"）。

**择优结论**：**采用 A 的"首块嗅探 + 字节回灌"用于流式路径**；B 已有 `looksLikeSse` 可复用其判定逻辑，但必须改掉"全量缓冲"与"只判非流式"两个限制。

**落地**：
1. 新建 `src/lib/sse-sniff.js`：导出 `sniffHead(buffer)`（返回 `'sse' | 'json' | 'unknown'`）与一个把已读字节回灌到流的辅助（Node 侧可用 `Readable.from([...]) ` 或直接返回 `{body: 拼接流}`）。
2. `src/upstream/client.js:259` 改为先窥探首块 → 判定 → 回灌；非流式路径 `:264` 复用同一函数（去掉 64 字符魔数，改为 4KB 窗口 + 首帧即放行）。
3. `src/model-router/dispatch.js` 与 `src/routes/openai.js` 的流式入口接入，确保 WB passthrough 与 Trae 解析两条路都经过判定。
**代价**：1-1.5 人日（~120 行 + 3 处调用点）。**风险**：**必须保证首块判定不引入 TTFT 延迟**——A 的解法是"首帧识别为流立即放行"，B 需照做（不要凑满 4KB 才判）。

#### 实施记录（2026-10-14）——证据不支持建管线，改为精准打掉静默失败

**先查证据**：报告的动机是 A 车道的实测事故（「该车道高负载下会以 200 + application/json 返回完整 SSE 帧序列」）。
在 B 这边查了 30 天全量流量，**没有任何该形态的证据**；报告引用的 4 条 `llm response empty stream`
经查也不成立——**该字符串在整仓源码与 git 历史里都不存在**（`git grep` + `git log -S` 均为空），
它是**上游自己报的错误**（Trae 的错误信封被原样带出）。

**但反过来有个更值得处理的问题**：B 请求 `stream: true`，上游若回完整 JSON，SSE 解析器按行找不到
`data:` 前缀 → **一个事件都不产出**，而三条出口都会照样收尾成「正常结束、内容为空」：
`routes/openai.js` 发 `finish_reason: 'stop'` + `[DONE]`、`routes/anthropic.js` 发
`stop_reason: 'end_turn'` + 空 content、`model-router/dispatch.js` 发末帧 + `[DONE]`。
**不报错、额度已花、客户端拿到空答案**——最坏的一类失败。
WorkBuddy 透传路径更糟：它把非 `data:` 行**原样写进 SSE 流**，客户端会收到夹在流里的裸 JSON。

**采用的形态**（不做形状转换，只把静默失败变成可降级、可诊断的错误）：
1. 新建 `src/lib/sse-sniff.js`：纯函数 `sniffHead(text)` → `'sse'|'json'|'html'|'empty'|'unknown'`
   （注释帧 `:` / 字段名 `data|event|id|retry` / `{`、`[` / `<`；前导空白与 BOM 不干扰）+ `describeShape()`。
2. 四条出口各自记录**是否解析出过事件**，并顺手留下前 200 字符原始文本（**零额外插桩**——
   调用方本来就在 `consumeStream` 回调里拿到字节）；流结束时若零事件 → 抛
   `status: 502 / code: UPSTREAM_NOT_STREAM`，错误文案带上形状（`shape=json：上游忽略了 stream=true`）。
   - `model-router/dispatch.js#dispatchTraeStream`：未提交答案 → 仍可换候选；即使全失败，
     闸门未 flush 头 → 走 JSON 错误体（而不是错误帧）。
   - `routes/openai.js#runRound`：抛错交还 `pool.run`，未开始时整体轮换账号。
   - `routes/anthropic.js`：`message_start` 已下发，故走流内错误帧路径（客户端至少能看到错误）。
   - `routes/responses.js`：原本会照样发 `response.completed`（假成功），一并兜住。
3. WorkBuddy 透传：确认是 SSE 之前**不写非 data 行**（`sawDataLine` 闸门），零 data 帧则抛错。
   合法流不受影响（`data: [DONE]` 也是 data 行；首个 `: keepalive` 被丢弃，无副作用）。
4. `upstream/client.js#looksLikeSse` 收口到同一函数（原实现只看 64 字符、只认三种前缀，
   且与流式侧各写一套判定）。

**未做**：形状转换（把 JSON 补成 SSE 帧）。JSON 与 Trae 的 SSE 帧形状不同，转换需要按 provider 分别实现，
而**转为明确错误已经消除了静默失败**这一真正的危害；若将来实测到该形态频繁出现，再考虑转换。
**残留**：`dispatchOpenAIStream`（通用 openai provider 逐字节透传）未接此闸门——那是用户自配的第三方端点，
且没有证据；已在 `docs/01-architecture/known-limitations.md` 记为残留项。

测试：unit.test.js 新增 7 项（`sniffHead` 各形态 + BOM/空白、`describeShape`、
Trae 回 JSON 抛错且抛前零写出、空流抛错、正常 SSE 不误触发、WB 回 JSON 抛错且零写出）。


---

### 1.3 命名降级链（fallback/round-robin + 粘滞）—— 本次分析的核心项

**A 的实现**（`src/combos.js` 174 行 + `src/adapter.js` `runCombo`）

```js
// A 的提交判定 —— 整个设计的核心（adapter.js:758-766）
function commitsAnswer(chunk) {
  if (chunk.type === 'text-delta')      return chunk.text.trim() !== ''
  if (chunk.type === 'tool-call-delta') return true
  if (chunk.type !== 'block-end')       return false
  if (chunk.block?.type === 'reasoning') return false          // ← 思考刻意不算提交
  if (chunk.block?.type === 'text')      return chunk.block.text.trim() !== ''
  return true
}
```
```js
// runCombo（:223-284）：held 缓冲 → 首个答案增量才 flush
while (true) {
  const row = await iterator.next()
  if (row.done === true) { result = row.value; break }
  if (committed) { yield row.value; continue }
  held.push(row.value)
  if (commitsAnswer(row.value)) { committed = true; for (const c of held) yield c; held.length = 0 }
}
if (committed) { recordTurn(...); return }              // 已交付答案 → 绝不换
if (result?.advance !== true) { for (const c of held) yield c; return }  // 非候选故障 → 如实收尾
// 否则推进到下一个候选
```
```js
// advanceVerdict（:494-498）三重否决
if (plan.allowAdvance !== true || options.signal?.aborted === true || sawAnswer) return { advance: false }
// sawAnswer 只在 text-delta 非空白时置真（:511）—— 而 delivered 含 reasoning，
// 故用 sawAnswer 而非 delivered（:484-493 注释：思考被 held 扣住并整段丢弃，用户从没见过）
```
补充设计：
- 策略 `fallback`（固定链首）/ `round-robin`（轮换起点 + `stickyLimit` 连续粘滞）；游标**只在内存**（重启丢失只等于换个起点），`pruneRotation` 防 map 泄漏（`:148-169`）。
- `normalizeCombos`（`:64-87`）把存储值当**不可信输入**：非数组 models 清空 → 该链丢弃；未知 strategy 回退 `fallback`；非正 stickyLimit → 1。
- 链中当前不存在的模型**从链剔除而非留占位**（否则"试了 2 个候选"实为 1 个）；链接**按输入原样保存**（今天取不到的链接在某天车道开放时仍正确）。

**B 的现状**（`src/model-router/index.js`）
- failover 循环机制**已具备**：`maxAttempts`（`:329`）、`tried` 集合（`:330`）、`switchOn` 分类（`shouldSwitch :242-243`）、`health.markFail` 冷却（`:464`）、`context_length` 永不切换（`:241`，终端错误）。
- **窗口守门比 A 强**：虚拟模型声明窗口超 75% 直接 400（`:283-294`）；候选级窗口过滤路由到大窗口候选（`:324-337`）。
- **阻塞点**（`:479-480`）：
```js
const canSwitch = shouldSwitch(kind, vm) && i < maxAttempts - 1
  && !(ctx.stream !== false && res.headersSent);
```
  配合 `dispatch.js:96-101` 「上游响应头到达即 `flushHeaders()`」，**流一旦建立（哪怕 0 token 未吐）就不能再换候选**。

**逐点差异**

| 维度 | A（combo） | B（model-router failover） | 谁优 |
|---|---|---|---|
| 可切换窗口 | 首个**答案增量**之前（思考不算） | 上游响应头之前（≈0 token） | **A** |
| 长思考后撞配额墙 | 可无缝降级（最典型案例） | 无法降级，整轮失败 | **A** |
| 候选表达能力 | 跨车道任意真实模型 id | provider/model 对 | A 更宽 |
| 策略 | fallback + round-robin 粘滞 | priority/weighted + rotateTopN 加权随机 | 各有适用 |
| 上下文守门 | 声明值取交集 | **实测校准 + 候选级过滤** | **B** |
| 健康度/冷却 | 规则表 classify | **二维冷却 + 精确恢复时刻** | **B** |
| 与调用方解耦 | 适配器内解析，两调用方免费获得 | 转发层实现 | 等同 |

**择优结论**：**保留 B 的守门与冷却，移植 A 的"内容增量前可切换"语义**。这不是替换，而是把 `canSwitch` 的判据从"响应头是否已发"改成"是否已写出答案内容"，并相应推迟 `flushHeaders`。

**落地方案**
1. **`src/model-router/dispatch.js`**：延迟 `flushHeaders()` 到**首个答案承载帧**（而非上游响应头到达）。若上游在首帧前报错，可干净地换候选。
2. **帧分类复用既有资产**：`src/transform/sse.js:242-252` **已经**把 `reasoning_content` / `reasoning` 与 `content` 分开（`out.reasoning` vs `out.content`）——这正是判定所需的信息，无需新写解析器。定义 `commitsAnswer(evt)`：`evt.content` 非空白 或 `evt.type === 'tool_call'` → 提交；仅 `reasoning` → 不提交。
3. **`src/model-router/index.js:479-480`**：`canSwitch` 条件由 `res.headersSent` 改为 `!answerCommitted`（一个新的会话态标志）。
4. **缓冲有界**：为 held 缓冲设字节/时长上限（建议 256KB 或首帧后 60s），超限即提交并停止降级——防止"上游卡住不出内容"导致无限等待。
5. **思考帧的 keepalive 交互**：B 目前无 SSE 注释帧心跳（A 有 `:` 帧 + 15s 心跳，`forward.js`）。降级窗口内若不发心跳，客户端 idle 超时可能先触发；建议同时补 15s `: ping`（这也是 A 的既有设计）。

**代价**：2-3 人日（流式核心路径改造）。**风险**：
- **TTFT**：缓冲会推迟首字可见时间。缓解：只在**上游已确认但在首帧前失败**时才真正受益，正常路径的首帧到达即 flush，延迟可忽略；上限机制兜底。
- **回归面**：涉及 openai/anthropic/responses 三个入口 + 虚拟模型 + 直连模型两条路径，需补流式测试用例（B 现有 10 套件里 protocol.test.js 是落点）。
- **不要照抄 A 的一点**：A 的 combo 是"虚拟清单行"，B 的虚拟模型已是独立模块，语义已对齐，无需引入 combo 概念本身。

#### 实施记录（2026-10-14）——实测推翻了本节的价值假设，实现形态随之收敛

**先量化再实现**。查了近 30 天真实流量（33,519 行）：

| 观测 | 结果 |
|---|---|
| 「已产出 token 却报错」的行数 | **0 行** |
| 近 7 天错误率 / 错误耗时 p50 | 1.8% / **1 ms**（95% 的失败在准入阶段：ACL、上下文、参数） |
| 错误中耗时 ≥3s / ≥10s / ≥30s | 10 / 5 / 2 条（共 223 条） |
| 唯一真正的流中途失败样本 | `llm response empty stream`（4 条，17-37s）——**空流今天本来就能降级**（无帧则未 flush 头） |

也就是说，「思考一分钟后撞配额墙」在 B 的真实流量里**观测不到**。因此**没有**采用 A 的「把 reasoning 整段扣留、换候选时丢弃」——那会用**每一个** reasoning 模型请求的思考显示延迟，去换一个实测观测不到的收益。

**采用的形态**（`src/model-router/stream-gate.js`）：只扣「未成行的残片」。
- 完整帧（emitter 每次 write 都是 `...\n\n`）**原样立即下发**：正常路径的字节流、帧顺序、TTFT 与改动前**逐字节相同**（有测试钉住）；
- 只扣住最后一个换行之后的残片，换候选时丢弃——这才是真会把客户端流拼成坏 JSON 的字节（上游在帧中间断掉时那半行绝不能接到下一个候选后面）；
- 提交语义 = `commitsAnswerEvent` / `commitsAnswerLine`：content 非空白或 tool_call 才提交，**只有 reasoning 不提交**（与 A 的 `commitsAnswer` 同义）；
- 另补「静默超过 15s 才发 `: ping`」的心跳（正常有字节流动时一帧都不加）。

`canSwitch` 由 `res.headersSent` 改为 `gate.answerCommitted`；换候选前 `discardHeld()`；终局错误出口也走同一 sink（否则错误帧会被拼到半行后面，客户端连错误都看不到）；成功日志新增 `failoverSwitches` 供长期观测。

**唯一可观测的取舍**：若 A 只输出过思考就失败，客户端会先看到 A 的思考、再接上 B 的答案（改动前这种情况客户端只会收到一个错误帧）。已写成测试断言，不隐瞒。

**本节其余建议的处置**：
- 「缓冲上限 256KB / 60s」→ **不需要**：只扣残片后缓冲天然有界（≤1 行），无限等待的风险不存在。
- 「15s `:` 心跳」→ 已实现，但只在真的静默时发。
- 测试：新增 `src/test/stream-gate.test.js`（19 项）+ `unit.test.js` 3 项（只思考过→窗口仍开；交付答案→立即提交；带闸门与不带闸门**字节完全一致**）。

---

### 1.4 容量取交集（窗口/视觉/思考）

**A 的实现**（`src/combos.js:101-129` 的 `buildComboCatalog`）

| 字段 | 取法 | 理由 |
|---|---|---|
| `vision` | `members.every(e => e.vision === true)` | 视觉是**要求**：发图时每个成员都必须能读 |
| `reasoning` | `members.some(e => e.reasoning === true)` | 思考是**能力**：任一成员能思考，链就能产出思考 |
| `contextWindow` | `Math.min(...)` | 链不能声称比最弱成员更大的窗口 |
| `maxOutput` | `Math.min(...)` | 同上 |
| `canDisableThinking` | `every(e => e.canDisableThinking !== false)` | 全员可关才算可关 |
| `lanes` | `[...new Set(members.map(e => e.channel))]` | 详情行展示可及车道 |

设计注释（`:25-28`）："链声称支持视觉是因为链头支持，就会把一张它读不了的图交给兜底；链声称 1M 窗口是因为链头有，就会让 128K 的兜底溢出。诚实的数字是每个候选都能兑现的那个。"（**注意 vision 用 every、reasoning 用 some 的不对称是刻意且有论证的**。）

**B 的现状**
- `src/model-router/autotier.js:41-45` 三层静态窗口（116K / 200K / 1M），层窗口即对外声明；
- `effectiveCandidateWindow`（`:34-38`）：**实测校准值 > 配置声明值 > 平台安全地板 100000**，动态计算；
- `filterCandidatesByInput`（`:324-337`）：请求时**按候选窗口过滤**，路由到装得下的更大窗口候选；全装不下才 400；
- `clampMaxTokens`（`:304-309`）：max_tokens 按候选 `maxOutputTokens` 钳制；
- **B 没有任何模态过滤**（全仓 grep `vision|multimodal|image` 在 `model-router/` 只命中一处无关的模型名排除）。

**择优结论**：**采用 B 的机制、补 A 的维度**——这与"抄 A"相反，是"择优"的典型：
- **窗口维度：B 更优**。A 取交集会把 1M 链头的能力砍到最弱成员的水平；B 的"请求时按候选实测窗口过滤 + 路由到能装下的候选"保留了能力上限，更合理。**不要改成 A 的 min 语义**。
- **模态维度：B 缺失**。当前若虚拟模型同时含 `multimodal` 与纯文本候选，发图请求可能被路由到纯文本模型 → 上游报错。**这是真实缺口**，应采用与窗口同构的机制（**请求时按模态过滤**），而不是 A 的"声明时取交集"——因为请求时过滤能保留"纯文本请求仍可用全部候选"的能力。
- **思考维度**：B 的 `reasoning` 目前只是目录上的能力标签（`catalog.js:117`、`catalog-meta.js:13`），未参与任何路由决策。是否需要"s思考不可关的候选"过滤，取决于是否要做第 6 项（effort）。A 的 `canDisableThinking` 交集语义可在做 effort 时一并引入。

**落地**：
1. `src/models/catalog.js` 与 `catalog-meta.js` 确认已暴露 `multimodal`（`catalog-meta.js:67` 的 fingerprint 含 `multimodal`，说明字段存在）；
2. `src/model-router/autotier.js` 的 `filterCandidatesByInput` 扩展为 `filterCandidatesByInput(vm, messages, tools)` → 增加模态判定（请求 messages 含 `image` 类块 → 只留 `multimodal === true` 的候选）；
3. `src/model-router/index.js:324-337` 的过滤链同步；
4. 全候选被模态过滤掉时，返回明确错误（照 `:341-347` 的窗口阻塞文案样式，code 用 `MODALITY_UNSUPPORTED`），**不要静默降级到纯文本候选**。
**代价**：1 人日。**风险**：低（纯过滤链增量）。**验收**：构造"虚拟模型含 1 个多模态 + 1 个纯文本候选 + 发图请求"的用例，断言命中多模态候选。

#### 实施记录（2026-10-14，提交 `9826610`）

按「采用 B 的机制、补 A 的维度」落地，但**加了一条报告没写、实测逼出来的约束**：

模态能力必须保留**三态** `true / false / null`，且发图时**只排除明确 `false` 的候选，`null` 一律放行**。
理由是实测的：Trae 目录（`fetchAllModels()` 实测）38 个描述符里 30 个 `true`、8 个 `false`、**0 个 null**；
而 **WorkBuddy 目录根本不返回该字段**，29 个描述符全是 `null`。若把「未知」当「不支持」，
发图请求会把 `wb/glm-5v-turbo`、`wb/glm-4.6v` 这些视觉模型全部排掉——**比现状（交给上游判错）更差**。
因此 `models/catalog.js:116` 原来的 `multimodal: !!dc.multimodal` 也一并改成保留 null（否则「上游没给」
会被压成 `false`）。指纹不受影响：`catalog-meta.js:12` 在哈希前 `!!meta.multimodal` 强制布尔。

实现：`autotier.requestsImages()`（识别 OpenAI `image_url` / Anthropic `image` / Responses `input_image` /
`source.media_type`）+ `filterCandidatesByModality(vm, messages)` → `{image, list, blocked}`，
`blocked` 仅在「**有启用候选**但没一个能接图」时为真（池里本就无可用候选不能报成模态问题）；
`index.js` 过滤链加入该维度，**模态阻塞优先于窗口阻塞**报告（用户看到「没有能读图的候选」才能对症处理），
错误码 `MODALITY_UNSUPPORTED`；顺带把 `err.code` 原样带出到 JSON 错误体（原先只给 message）。

生效时机：候选的 `multimodal` 由定时同步（`jobs/scheduler.js:465` → `syncAutoTiers`）或面板手动同步写入，
**现有配置里的候选该字段为 `null`（放行，行为完全不变），下次同步后才实际生效**——即安全上线。

验收：unit.test.js 新增 6 项（三协议识别与不误判、混合候选过滤、纯文本不受影响、
全 false 时 `blocked`、无启用候选时 `blocked=false`、归一化保留三态）。

---

### 1.5 思考强度档位（硬预算实现）

**A 的实现**（`src/effort.js` 268 行）
```js
LEVELS = [ light:2048, balanced:8192(默认), deep:undefined(模型上限) ]   // :33-37
ALWAYS_THINKING_FACTOR = 2                                              // :42
支持菜单 = model.reasoning === true                                      // :45-47
实际上限 = min(档位上限, 模型 maxOutput, 会话 maxTokens, 插件 defaultMaxTokens 32768)
下限 MIN_BUDGET = 512；非正数视为「未设置」回落
```
- **核心动机（有实测依据）**：`reasoning_effort` / `thinking.budget_tokens` / `enable_thinking` / `thinking_budget` 四个拼写**全部被网关接受后忽略**——每档三次采样，`low` 产出的思考 token 反而多于 `xhigh`；未知字段偶发 503。**唯一真正生效的控制是 `max_tokens`**（`effort.js:4-10` 注释；实测 64 token 上限把思考从 ~397 压到 ~63）。
- **思考不可关的模型整体翻倍**：MiMo V2.6 实测 92 次调用中 82% 输出 token 是思考，与正文共享额度；未翻倍的 8192 只剩约 1500 给正文，约每三次请求一次 `length`（`:21-27`）。
- 声明式菜单模型（EAC/Kilo）走另一套：上游 effort 字段 + JSON merge patch，ceiling 恒为模型容量，**不再叠加预算阶梯**（否则砍掉菜单从未承诺的东西）。

**B 的现状**
- `src/config.js:43-81`：`model-config.json` 的模型映射里有 `reasoning` 布尔（**仅能力标签**，无预算语义）；
- `src/model-router/dispatch.js:265,:352`：只透传 `body.max_tokens`；
- `src/model-router/autotier.js:304-309`：`clampMaxTokens` **已实现**"按候选 maxOutputTokens 钳制"；
- `src/transform/sse.js:242-252`：**已分离** reasoning 与 content；`transform/emitters.js:30` 已输出 `delta.reasoning_content`；
- **无 effort 阶梯、无预算推导、无设置入口**。

**择优结论**：**B 的机制已完成 ~90%，只缺阶梯与默认应用**。关键洞察：A 的结论"只有 max_tokens 生效"意味着 B 无需触碰上游参数——**B 已经在发 `max_tokens`，只需在客户端未指定时按档位填充一个默认上限**。这比 A 的实现路径还短（A 还要处理预算与容量的多层取 min）。

**落地**：
1. 新建 `src/lib/effort.js`：`LEVELS`（建议 4K / 16K / 模型上限，按 B 的真实输出上限调整——A 的 2048/8192 是为免费车道调的，B 的 Trae dev 档 max 32K、max 档 64K，可直接用文档 `model-parameters-report-2026-10-06.md` 的实测值）、`budgetFor(level, candidate, requested)` 返回 `min(档位, 候选 maxOutputTokens)`、`ALWAYS_THINKING_FACTOR`（B 的豆包/GLM/Kimi 均为思考与正文共享额度，应默认翻倍）。
2. 应用点：`src/routes/openai.js:117`、`src/routes/anthropic.js:82`、`src/routes/responses.js` 的请求构造处——**当客户端未传 `max_tokens` 时按档位填充**；已传则尊重客户端（A 也是"上限为强制下发"，但 B 的客户端多是 IDE，尊重客户端更安全，可作为开关）。
3. 持久化：`src/config.js` 加 `defaultEffort`；面板「模型池状态」页的模型卡标注该档实际下发值（照 A 的 `budgetLadder` 文案）。
4. 需要先验证：B 的上游是否真的忽略 reasoning 类参数（A 的结论来自另一条车道）。**先做一次实测**（B 有 `POST /v1/admin/test-chat` 与 `docs/model-parameters-report` 的探测脚本族可复用），若 Trae/WB 支持 `thinking_budget`，则可直接传参而不必走预算。

**代价**：1.5-2 人日（含一次实测）。**风险**：低-中。**注意**：不要照抄 A 的 2048/8192（那是免费车道的调参），必须用 B 的实测上限重算。

#### 实施记录（2026-10-14，提交 `faf3dbd`）——按实测收敛为「只翻译客户端显式意图」

**先查了两件事，都改变了实现形态**：

1. **本仓库此前完全没读这些字段**：`grep reasoning_effort|thinking|budget_tokens` 在 `src/`
   下**零命中**。即客户端明确表达的「少想一点」被静默丢弃——这本身就是一个缺陷，而不是
   「缺一个新功能」。
2. **不加服务端默认档**：A 有 light/balanced/deep 并默认 balanced，但那是在它的免费车道上
   调出来的。本项目实测**输出仅占 token 总量的 0.3%**（输出 690 万 / 输入 24.5 亿），
   压输出的收益几近于零；而给客户端没要求的请求加一个默认上限，只会带来
   「长回答被截断」的风险。所以只在**客户端明确表达意图**时出手，不提就一个字节都不改
   ——**默认零行为变化**。

**`docs/06-deliverables/analysis/model-parameters-report-2026-10-06.md` 里并没有 effort/thinking 的实测**（只覆盖
`max_tokens`/窗口），所以「上游是否真的忽略 reasoning 参数」这条**仍未实测**。但本实现
不依赖它：既然唯一确认生效的是 `max_tokens`，就只用它——这也正是 A 的核心结论。

**规则**（`src/lib/effort.js`）：
1. 客户端**显式传了** `max_tokens` → 原样尊重，本模块完全不介入（IDE 客户端更清楚要多长）；
2. 否则有 `reasoning_effort` → 按档位表（`none 1024 / minimal 2048 / low 8192 /
   medium 16384 / high·xhigh 32000`，取本项目实测的 Trae dev 32K 档，不照抄 A 的数值）；
3. 否则有 `thinking.budget_tokens` → 折算成 `预算 + ANSWER_RESERVE(2048)`（Anthropic 要求
   `max_tokens > budget_tokens`：预算是「想多久」，`max_tokens` 是「想 + 答」的总量）；
   `thinking.type === 'disabled'` → 给极小预算；
4. 结果按候选 `maxOutputTokens` 钳制；都没给 → 不设上限（与改动前一致）。

档位名归一化收 `x-high`/`extra_high`/大小写等写法；无效档位**不得**当作 `low`
（否则拼错一个单词就悄悄压短输出）。

**日志**：介入时记 `effortLevel` 与 `maxTokensApplied`，便于长期观察客户端都在要什么档。

**测试**：unit 5 项（显式优先/无意图不介入/档位归一化/budget 折算与候选钳制/档位表命中）
+ protocol 2 项（`thinking.budget_tokens` 真的变成下发的 `max_tokens`；显式 `max_tokens`
优先，两者都无时限。为 undefined——即**钉住「默认零行为变化」**）。

---

## 二、省 Token 与可观测性（第 7-11 项）

> 本组四节的**逐行详解见 `dsh-ofm-四组功能代码级对标.md`**（877 行，含触发条件原文、SVG 结构、CSS、测试矩阵）。此处只给决策结论。

### 2.1 五个本地应答（额度探测/命令前缀/标题/建议/文件路径）

**A 的实现**（`src/local-optimize.js` 446 行，零依赖纯函数）

| 检测器 | 完整触发条件 | 返回 | 我方可搬 |
|---|---|---|:---:|
| quota | `singleUserTurn` 存在 ＋ `max_tokens === 1 \|\| '1'` ＋ 该轮小写含 `quota` | `Quota check passed.` | ✅ 通用 |
| prefix | `singleUserTurn` ＋ 含 `<policy_spec>` 与 `Command:` ＋ 取 **`lastIndexOf('Command:')`** | 命令前缀 | 仅 `/v1/messages` |
| title | **无 tools** ＋ system 含 `title` ＋（`sentence-case title` 或 `return json`+`field`+`coding session`） | `Conversation` | 仅 `/v1/messages` |
| suggestion | **任意** user 轮含 `[SUGGESTION MODE:` | 空串 | 仅 `/v1/messages` |
| filepath | `singleUserTurn` ＋ **无 tools** ＋ 含 `Command:` 与 `Output:` ＋（user 提 filepaths 或 system 要求提取） | `<filepaths>` 块 | 仅 `/v1/messages` |

**最易抄错的一行**：prefix 用 `lastIndexOf('Command:')`（`:324`）而 filepath 用 `indexOf('Command:')`（`:364`）——**刻意不同**，同源 Python 实现如此。`shellWords`（`:122-169`）的关键行为：引号外 `\` 只在空白/引号前转义，故 **Windows 路径 `type C:\notes\todo.md` 存活**。

**B 的现状**：**无任何本地短路**（已逐条核对：`routes/openai.js` 全部提前返回是 400/403 失败分支；`model-router/index.js` 只有超窗 400 与无候选 400/429；`routes/anthropic.js:74-97` 全是权限校验，`:152-153` 必调上游）。

**择优结论**：**这 5 个是 Claude Code 专用内部请求**，与第 2 项（count_tokens）、`/v1/messages` 构成一个完整的"Claude Code 直连支持"工作流——建议作为**一个包**评估，而不是零散接入。
- 对 B 的真实价值：**quota 与 title 有普适价值**（额度探测可作连通性自检，标题生成对任何 IDE 都有意义）；prefix/filepath 只在接 Claude Code 时有意义；suggestion 对通用 IDE 永不命中（无害但不划算）。
- **真正的成本不在检测器**（纯函数可整文件搬），而在两件 B 没有的东西：
  1. **流式帧渲染**：B 的 `/v1/messages` 恒流式（见 1.1），本地应答要么手工补 `content_block_start/delta/stop + message_delta + message_stop`，要么**补非流式分支**（后者顺手修掉一个既有缺陷，推荐）。
  2. **记账决策**：A 命中后**完全不写 usage**，在 A 自己的看板里不可见；B 相反——`traffic.jsonl` 是唯一数据源。若照抄 A，这些请求会从热力图/趋势/计量覆盖率里**消失**。必须显式记 `{localAnswer: kind, promptTokens: 0, completionTokens: 0, tokensEstimated: true}`，并在 `stats.js` 与 `stats-cache.js` 各加一个 `local` 计数、前端单列——否则污染 `tokenSource: 'none'` 的语义与覆盖率分母。

**必须拒绝照抄的两点**：
- **绝不写 A 的假 usage**（`{input:10, output:5}` 等，`:314/325/337/345/369`）。B 的 `pricing-calib` 回归样本直接来自 traffic，写假 token 会污染标定与账单对照。
- 不要把 A 的 `enabled[kind] !== false` 语义直接搬——B 的配置项惯例是显式 `true` 才启用（`config.js` 各开关），需统一。

**代价**：1.5-2 人日，其中 ~60% 花在配套（帧渲染 + 记账口径）。**风险**：低。

#### 实施记录（2026-10-14，提交 `c6dd224`）

**移植**（`src/lib/local-answer.js`，458 行，零依赖）：5 类检测器全部到位，求值顺序、判定式、
常量表、命令解析规则（含源实现的各种 quirk：`FOO=1 ls` 保留前缀而 `FOO=1 git status` 丢前缀的
非对称、不闭合引号回退、`head -n 5 a.md` 把 `5` 当路径的 naive filter 等）**一字未改**。
差分验证：**8987 项比对仅 1 项不一致**，那一项是刻意补的「不抛错」
（源对 `{messages:123}` 会抛 `number 123 is not iterable`）。

**两点按报告明确要求拒绝照抄**：
1. **绝不写假 usage**：源在各检测器里塞 `{input:10,output:5}` 常量并带进响应体——假 token 会污染
   本项目的账单标定回归（`pricing-calib` 样本直接来自 traffic）。本移植返回值无任何 usage 字段。
2. **每个检测器各自 try/catch** → 算「没命中」并继续试下一个，最外层再兜一层 → `null`。
   本地应答是优化，绝不能因为它让请求失败。

**接线**（`routes/anthropic.js`）：命中即返回、**不调上游**；非流式走 JSON，流式补完整 6 帧序列
（`message_start → content_block_start → content_block_delta → content_block_stop →
message_delta → message_stop`，沿用本文件既有的 data-only 风格）。两道闸：
`LOCAL_ANSWER_ENABLED`（默认开）+ `LOCAL_ANSWER_DISABLE=title,suggestion` 按类禁用。

**记账：新增第四类 `local`**。为什么三种写法只有一种可行——报告预判了这一坑，实测确认：
- 写 `0/0/0` → `isMetered(0)` 为真 → 被判成 **exact（上游真值）**，虚高计量覆盖率；
- 写 `tokensEstimated: true` → 归入 estimated，同样是谎报；
- 只写 `localAnswer` 标记 → `tokenSource` 归入 `local` ✓。

`metered` 改为只统计 exact+estimated（`local` 没调上游）；`unmetered` 仍是 `none`；于是前端
`meteredRate = metered / (metered + unmetered)` 的**分母天然排除本地应答**，正是报告要的效果。
`BUCKET_VERSION 11 → 12`；覆盖率卡加一行「本地应答（未调上游）」。

**另修掉一处潜伏缺陷（D14）**：`emitLog` 在没有 usage 时也写 `0/0/0` → 失败请求与本地应答都会
被记成 exact、虚高覆盖率。实测当前**零行受影响**（33,077 行全是 `/v1/chat/completions`，
`/v1/messages` 一行都没有，虚拟模型路径本来就不写零值），故是潜伏缺陷——但本地应答一上线
就会每次都写 0。现改为无 usage 时不写这三个字段。

**端到端验证**：隔离工作区真实 app；非流式返回
`content=[{"type":"text","text":"Quota check passed."}]`；流式返回完整 6 帧；两条记账行
`localAnswer=quota / account=null / 无任何 token 字段`；对照组（普通对话）照常走上游。

---

### 2.2 节省统计面板

**A 的实现**（四段链）
1. **管道返回**（`src/token-saver/index.js:69-102`）：`{prompt, rtk, saved, bytesBefore, bytesAfter, notes}`；**prompt 先 → RTK 后**（报出的字节数才是真正上路的）；**fail-open**（throw → `notes.push(...)`，请求绝不因压缩而失败）。
2. **RTK stats 不变量**（`rtk/index.js:258-278`）：`bytesBefore - bytesAfter === saved === Σ hits[].saved`；尺寸闸门 `MIN_COMPRESS_SIZE=500` / `RAW_CAP=10MiB`；**替换必须非空且严格更小**；**错误结果跳过**（`is_error === true` → 不压，理由："错误轨迹是模型唯一的失败证据，藏起来会让它重试同一调用，用户为这个循环付钱"）。
3. **生命周期聚合**（`token-saver/index.js:105-151`）：`{bytesBefore,bytesAfter,saved,blocks,calls,promptCalls}`；**`calls` 每次 +1 含未命中的**（否则"压缩有效率"分母失真）；`savingsPercent` 在服务端算。
4. **持久化 + 面板**（`store.js:377-395`、`core/stats.js:71,86`、`client.js:5040-5156`）。

**B 的现状**
- `src/log/traffic.js:57-105`：`logRequest(entry)` 接受任意 entry 展开，**新增字段零成本**；但 `sanitize`（`:32-51`）**数字/布尔原样保留**，**键名含 `token` 的字符串值会被掩码** → 新字段必须用**数字值**且**避开 `token` 键名**。
- `src/log/stats.js`：三态口径（`exact`/`estimated`/`none`）+ `costOf` 费率重算 + `cacheReadTokens` 缺失标 `costUpper` 上界。
- `src/log/stats-cache.js`：`BUCKET_VERSION = 8`（`:39`，`:32-38` 有 v3→v8 变更登记惯例）。
- 前端：`TokenStatsPage.tsx` 的四张 `CaliberCard`（exact/metered/estimate 三态配色）。

**择优结论**：**落在 `traffic.jsonl` 每请求行 + stats-cache 桶聚合，不要另开独立文件**。三条理由：① B 已有"每请求一行 + 每日桶缓存"，且 `stats-cache.js:11-13` 注释明确"结构统一到 stats.js"；② `invalidateDay()` 已挂在写入路径（`traffic.js:91`），新字段自动获得正确失效语义；③ 与 A 的 `adapter → store` 累加是 1:1 映射。

**落地**（可直接实施）：
1. **writer**（RTK 调用点）：`rtkBytesBefore / rtkBytesAfter / rtkSavedBytes / rtkBlocks`（**number**）、`rtkFilters`（字符串，不含 `token`）、`promptInjected`（boolean）。
2. **聚合**（`stats.js:156-182`）：桶加同组键；累加条件 `numTok(r.rtkBytesBefore) != null`（= 跑过压缩的调用）；输出加同名字段 + `rtkPercent`（服务端算，照 A 口径）。
3. **缓存**（`stats-cache.js`）：`BUCKET_VERSION 8 → 9` 并在 `:32-38` 登记。**兼容性免费**：`readCache` 版本不符即返回 `null` → 旧桶自动丢弃重建，零迁移代码。**不要**对缺失字段用 `?? 0` 兜底——"历史没测量"与"历史省了 0 字节"是两件事。
4. **API**（`admin-traffic.js:120-156`）：`/stats/daily` 加 `savings` 汇总；`stats.ts` 加类型；`TokenStatsPage` 加第 5 张 `CaliberCard`，caliber 用 `'metered'`（这是**测量值不是账单值**），`grid-cols-2 xl:grid-cols-4` 改 `xl:grid-cols-5`。
5. **Meter**：直接用 B 现成的 `ProgressBar`（`shared/ui/index.tsx:418-433`），不必搬 A 的 60ms setTimeout 动画（B 有 `prefers-reduced-motion` 处理）。

**步骤 0（真正的阻塞项）**：**B 没有 RTK**。好消息是 B 的消息形态与 A 的 chat walker **完全兼容**——`transform/request.js:37-41` 把工具结果写成 `{role:'tool', tool_call_id, content:[{type:'text',text}]}`，正是 `rtk/index.js:289-298` 处理的形状；`/v1/messages` 的 `tool_result` 也在 `routes/anthropic.js:57` 先转成 `role:'tool'` → **一套 walker 覆盖 B 全部三入口**。

#### 实施记录：D5 已修（2026-10-14），RTK 本体仍待办

**D5 的修法带一个报告没写的关键约束**：`buildBody` 把 `messages` **原样**放进上行 body，
而参照项目实测过「未知字段偶发 503」。所以 `is_error` 只能作为**内部信号**保留，
**绝不能上行**。故分三步：

1. `routes/anthropic.js#anthropicToOpenAI`：`tool_result.is_error === true` 时在归一化消息上
   带 `is_error: true`（原先直接丢弃）。
2. `transform/request.js#normalizeTraeMessages`：`role:'tool'` 消息保留 `is_error`。
3. `upstream/client.js#buildBody`：新增 `INTERNAL_MESSAGE_FIELDS = ['is_error']`，
   序列化前**逐个剥掉**（无内部字段时不做拷贝，避免无谓开销）。注释写明
   「新增内部字段必须加进这里，否则会静默泄漏到上游」。

**给它一个当下就有消费者的用途**：新增 `countToolErrors(messages)`，
`routes/anthropic.js` 的流量日志记 `toolErrors`（工具失败率是可观测的模型能力信号，
也是将来工具输出压缩「跳过错误轨迹」的判据来源）。

**只有 Anthropic 入口能表达它**：OpenAI 协议的 tool 消息**没有** `is_error` 字段，
客户端无法表达「工具失败」。故**没有**在 `openai.js` 与虚拟模型路径也记一份
「恒为 0」的同名字段——那只会制造两个口径不同的 `toolErrors`。
（这也是把改动限制在 `/v1/messages` 的原因。）

**测试**：unit 3 项（归一化保留、计数兼容两种形态且不重复、buildBody 剥除且不误伤其他字段）
+ protocol 1 项（真实 HTTP 请求带 `tool_result.is_error` → 日志确有 `toolErrors: 1`；
无失败工具结果时不写该字段，避免把「没测量」写成 0）。

**RTK 本体仍待办**：13 个过滤器约 36KB（A 侧），属批 3 的大块工作，
且需要在 D5 之上实现「输入侧压缩 + 每请求字节数落 traffic + 节省面板」。

**移植前必须先修的两处**（否则会引入新 bug）：
1. **`is_error` 在转换中丢失**（`routes/anthropic.js:57`、`transform/request.js:37-41`）→ RTK 会压缩错误轨迹。**必须先透传 `is_error`**，否则模型会把错误输出当成正常工具结果，诱发重试循环。
2. **`compressText` 用 `text.length`（UTF-16 码元）而非 UTF-8 字节**（`rtk/index.js:191`）→ 中文工具输出下与字节差 2-3 倍，"省了 1.2 MB"是假的。要么改 `Buffer.byteLength(text, 'utf8')`，要么把展示单位从"字节"改成"字符"（**改字节需同步重算 `MIN_COMPRESS_SIZE=500` / `RAW_CAP=10MiB` 两个闸门**）。

**代价**：RTK 本体 3-5 人日（13 个过滤器约 36KB，纯函数，ESM→CJS 改写；B 只需 OpenAI `messages` 一种形态，可省掉 Anthropic blocks / Responses / Kiro 三个 walker），节省面板 1 人日。**风险**：中（字符 vs 字节口径 + is_error 透传 + 回归测试覆盖工具输出压缩后的模型可用性）。

#### 实施记录（2026-10-14，提交 `faf3dbd`）——先量化，结论是「很值得做」

**先量化收益基础**：近 30 天输入 **24.5 亿** token / 输出 **690 万**（**337:1**），
单请求输入 p50 **149,254** token、89.9% 的请求 ≥50K、缓存读占输入 67%；
工具调用结束的行平均输入 99.6K（其它行 38.4K）。输入侧确实是成本绝对主体。

**移植**（`src/lib/rtk/`，19 个文件）：源目录里其实是 **12** 个过滤器（不是 13），已全部到位。
三处刻意差异：
1. **只保留一条 walker**：本项目工具结果统一是 `{role:'tool', content:[{type:'text'}]}`
   （由 `transform/request.js` 与 `routes/anthropic.js` 产出），源的 Anthropic/Responses/Kiro
   三套 walker 生产路径不可达，未搬。副作用：源形态 `content` 为**字符串**的 tool 消息不再压缩 ——
   本项目不产出该形态。
2. **字节口径一律 UTF-8**（源用 UTF-16 `text.length`）：闸门与所有计数改用
   `Buffer.byteLength(text,'utf8')`，不变量 `bytesBefore - bytesAfter === saved === Σ hits[].saved`
   恒成立。方向实测：一份中文 grep（427 码元 / 927 字节）源 `saved=0`（被 MIN 闸门放过），
   移植版 `saved=176` 字节——「该压的能压到」；`RAW_CAP` 对 CJK 相应更严（反向保护）。
3. **错误轨迹整条跳过**（`msg.is_error === true`，即 §2.2 步骤 0 的 D5 前置）：不仅不压，
   也**不计入** `calls`/`bytesBefore`，不污染压缩有效率的分母。

**移植保真度证据**（子代理实跑，脚本在 `%TEMP%`，不在仓库内）：与源 ESM 实现
**384 组（12 过滤器 × 32 输入）输出逐字节一致**、`autoDetectFilter` 选择零差异；
**600 组随机模糊用例**验证账本恒等式、Σhits 一致、确定性、入参不被修改、非 text 块不变、
错误轨迹不变，0 失败。

**接线：每次客户端请求只压一次**（这是硬要求——降级换候选会为同一客户端请求写多行 traffic，
若每次尝试都压都记，日聚合按行相加会把节省量按尝试次数放大）：
- `routes/anthropic.js` 派发前压一次，流式/非流式两条分支共用；
- `model-router/index.js#handleChat` 顶部压一次，循环里的降级与账号重试共用；
  **窗口守门与模态判定也改按压缩后的 messages 算**——那才是真正上路的字节；
- RTK 字段只记在**代表本回合结局**的那一行（虚拟机路径里失败尝试不记，只在 `!canSwitch` 时记）；
- 总闸 `RTK_ENABLED`（默认开）。

**面板**：字段拼装收口到 `log/traffic.js#rtkLogFields`（两条硬约束：单位是字节不是 token；
键名必须避开 `token`，否则 `sanitize` 会把字符串值掩码成 `***`）。
`log/stats.js` 逐日聚合六项且**只在真跑过压缩时输出**（不写会被读成「压缩没效果」的 0），
缺字段或**不满足不变量**的行把该日标 `rtkPartial`（节省是下界）；
`stats-cache.js` 桶里只存聚合对象（逐回合明细会让桶膨胀十倍），`BUCKET_VERSION 10 → 11`；
`/stats/daily` 输出窗口级 `savings`（**窗口内一行都没压过时返回 null**，与「压了但省 0」区分）；
前端新增第 5 张 CaliberCard（caliber=`metered`，测量值不是账单值）+ `ProgressBar` 比例条，
并新增 `formatBytes()`（注释写明单位是 UTF-8 字节、**不可与 Token 并读**）。

**端到端验证**：隔离工作区启动真实 app + 造转发密钥 + 发真实 `/v1/messages` 请求，
落盘行 `rtkCalls=1 before=12602 after=2298 saved=10304 blocks=1 filters=git-diff`，
不变量成立（该请求因隔离库无账号而 429，仍照常记账，证明压缩发生在派发前）。

**未接线**：`routes/openai.js` 的直连模型路径与 `routes/responses.js`（虚拟模型路径与
Anthropic 入口已覆盖，这两条是剩余入口）。

---

### 2.3 Token 热力图（17 周）—— ROI 最高项

**A 的实现**（`client.js:2545-2579` + CSS `:1336-1344`）
```js
function buildHeatCells(days, span = 119) {          // 14 行核心
  if (days.length === 0) return []                   // 空态可达（issue-30 修复点）
  const byDay = new Map(days.map(row => [row.day, row]))
  const end = new Date(); end.setHours(12, 0, 0, 0)  // 本地正午锚点：避免午夜 DST 把日期推到 01:00
  const start = new Date(end)
  start.setDate(start.getDate() - end.getDay() - (Math.ceil(span / 7) - 1) * 7)  // 先定本周周日，再回退 16 周
  for (let c = new Date(start); c <= end; c.setDate(c.getDate() + 1)) { ... }     // 不生成未来日期
  return cells  // 数量 ∈ [113, 119]，ceil(len/7) === 17 恒成立
}
// 色阶（:2550）：0→''、peak===0→''、>0.66→l4、>0.4→l3、>0.16→l2、其余 l1
```
- CSS：`grid` + `grid-auto-flow: column` + `grid-template-rows: repeat(7, 12px)` + `justify-content: start` + `gap: 2px` + `overflow-x: auto`；格子 12px、`outline` 描边、`hover: scale(1.25)`。
- 布局决策（`docs/issue-30-heatmap.md`）：隐式 `auto` 列宽会吃掉剩余宽度（560px 面板每列多约 19px 空白）→ `justify-content: start` + 固定 12px 行列 + 窄容器横向滚动。**这正是"等比缩放会拉伸格子"的坑**。
- 测试（`scripts/heatmap-test.mjs` 99 行）：3 时区 × 12 结束日（含跨年、闰年、美国/巴西 DST）× 40 项断言。

**B 的现状与三个缺口**
1. **`days` 被夹在 `[1, 90]`**（`admin-traffic.js:122`）→ 17 周需 119 天，**当前取不到**。改 180 即可（1 行）。
2. **日期口径冲突（既有隐患）**：日志目录与 `readTrafficLines`/`recentDays` 用 **UTC**（`traffic.js:22`、`stats.js:18`、`stats-cache.js:50`），而 `stats-cache.todayKey` 用**本地**（`:41-44`）；A 的热力图用**本地**日历。→ **中国区本地 00:00-08:00 的请求会记到前一天的文件**，按本地日历画会系统性错位一格。
3. **前端无图表/色阶基础件**（`shared/ui` 16 个组件里最接近的是 `ProgressBar`）；`global.css` 有完整色板 token，但有**硬门槛** `web/scripts/check-css-tokens.mjs`（新增任何 `var(--rg-*)` 引用前必须先定义）。

**择优结论**：**做，且先做**。后端 1 行 + 前端约 150 行，复用现有 `/stats/daily`，风险最低。

**落地**：
1. **后端 1 行**：`admin-traffic.js:122` 的 `90 → 180`。`readTrafficLines(180)` / `recentDays(180)` 都是逐日 `existsSync`，可忽略开销。
2. **日期口径决策（先定）**：
   - **方案 A（推荐，0 行后端）**：前端按 **UTC 日键**生成网格（与 `stats.js:18` 一致），把 A 的 `setHours/getDay/setDate/getFullYear` 全换成 `setUTCHours/getUTCDay/setUTCDate/getUTCFullYear`，锚点 `setUTCHours(12,0,0,0)`；页面加一行 `Note` 说明"按 UTC 日切分"。
   - 方案 B（语义最正确但要单独立项）：后端统一本地日键；**风险**：切换当天同时存在 UTC 名旧文件与本地名新文件，`recentDays` 只按本地键找会漏读 → 需同时返回本地键与前一日 UTC 键、读两处去重。约 20 行 + 数据核对，**建议记入 `known-limitations.md` 后做**。
3. **组件**：新建 `web/src/features/stats/TokenHeatmap.tsx`，导出纯函数 `buildHeatCells(rows, span=119)` + 组件。**必须新增 `unmetered` 态**：B 的 WorkBuddy 平台全部不回传 usage（`stats.js:38-42`），若这些日子只画最低档，用户会读成"这天没消耗"而实际是"计量缺失"——与 B 既有的口径纪律（`TokenStatsPage.tsx:297-301`）一致。tooltip 三种文案：有用量 / 未计量（明确写"非零消耗"）/ 无记录。
4. **CSS**：新增 `.heat` / `.heat-cell` / `.heat-l1..l4` / `.heat-unmetered` / `.heat-scale`，全部只用已定义 token → `check:tokens` 必过。色阶用 `color-mix(in srgb, var(--rg-brand-600) 22%/44%/66%, transparent)`。
5. **不要**给 `<svg>` 套 `.chart` 类（`global.css:541-544` 的 `w-full h-auto` 会等比缩放拉伸格子）；用 CSS Grid（与 A 一致，`title` 属性即 tooltip，零 JS）。
6. **测试**：B 无前端测试运行器。三选项：① 在 `src/test/heatmap.test.js` 用 node:test 复刻断言矩阵（~30 行，最省但测的不是前端那份代码）；② **上 vitest**（~0.5 天，第 10 项也受益，推荐）；③ 手工核对 + lint + check:tokens。

**代价**：1-1.5 人日（有 vitest 则 0.5-1）。**风险**：最低。

---

### 2.4 总量曲线（总计/单模型切换）

**A 的实现**（`client.js:2581-2611` `TrendChart`）
- **多序列渲染方式 = 单序列重绘**（不叠加多线，只切换画哪一条 + 什么色）；
- `valueOf`（`:2587-2589`）：`requests` → Σ calls；`tokens` + `total` → `row.total`；`tokens` + 模型 → 该模型 `output`；
- `peak` 只按选中序列 → 单轴自适应；刻度 `[0, 0.5, 1] × peak`；x 轴只画首/中/末三个标签。
- 数据组织（`:3016-3060`）：`mode` state + `metric` state；**累计模式做前缀和 → 总量是累计曲线**。
- **A 的三个缺陷（B 不要照抄）**：① `requests` 模式**完全忽略 `metric`**（切到单模型曲线毫无变化）；② 总量用累计、单模型用每日值 → **同图两种口径，y 轴含义静默改变**；③ `id="ofmFill"` 硬编码（B 已用 `useId()` 修好，保持）。

**B 的现状**
- `DailyTrendChart.tsx` 双序列（requests 面积+实线、tokens 虚线、errors 柱），但**Y 轴刻度只有一套（按 `maxReq`）→ tokens 虚线的纵向位置读不出数值**，这是现图的口径缺陷，顺带修。
- **`/stats/daily` 已经返回 `byModel`**（`stats.js:196-199` / `stats-cache.js:170-180`），**但 TS 未声明**（`stats.ts:11-41` 的 `DailyStat` 没有该字段）。
- `/stats/models`（`stats.ts:43-58`）**没有 date 维度**（`stats.js:208-246` 是纯窗口聚合）→ **不能支撑单模型曲线**；且默认路径下不可信（见下"既有缺陷"）。

**择优结论**：**数据已经在手，只需补类型 + 改前端**。

**落地**（分级）
| 级别 | 内容 | 位置 | 代价 |
|---|---|---|---|
| **P0 必需** | `byModel` 进 TS 类型（零后端改动） | `stats.ts:11-41` | 10 行 |
| **P0 必需** | `days` 上限 `90 → 180`（与热力图共用） | `admin-traffic.js:122` | 1 行 |
| P1 要 output 口径 | `byModel` 补 `promptTokens/completionTokens` | `stats.js:176-181,196-199`；`stats-cache.js:114-115,170-180` | ~30 行 |
| P1 配套 | `BUCKET_VERSION 8 → 9` + 登记 | `stats-cache.js:39` | 2 行 |
| P2 顺手修 | `cachedModelStats` 的 prompt/completion/errors 恒 0 | `stats-cache.js:189,210-211` | ~15 行 |

- **是否要做 P1**：A 画的是输出 token；B 的 `byModel.tokens` 是 `totalTokens`（含输入），长上下文调用会极高抬曲线。**要数值可信必做 P1**；只做形状对比则够用，但必须在副标题写明"含输入 Token"。
- **前端**：`DailyTrendChart` 改成受控组件（props `mode` / `metric` / `scale`），删双 Y 轴，`peak` 取选中序列；累计在前端做前缀和（**不要**像 A 那样只累加 `row.total` 而漏掉单模型分支）；控件用现成的 `Segmented` + `Chip`；色板用 `--rg-chart-1..5` 循环，>5 模型时在 token 层补 `--rg-chart-6..8`。
- **附带资产**：A 的 `Sparkline`（`client.js:2613-2624`，150×30，min/max 双端归一化 + `1e-6` 防除零）可直接用——B 目前没有，给口径卡片加迷你趋势线很值。

**代价**：P0 0.5h；P1 2h；前端 0.5-1 天；测试 0.5 天 → 合计 1.5-2 人日（只做 P0 则 1 人日）。

---

### 2.5 请求日志（逐请求明细）

**双方各有独有能力，不是单向借鉴**：

| 维度 | A | B | 择优 |
|---|---|---|---|
| 存储 | `stats.json` 的 `samples[]` 环形（最近 200）+ 4 个 JSON 文件 | `logs/<date>/traffic.jsonl` 逐请求追加 + 每日桶物化缓存 | **B**（可检索、无上限、有分页） |
| 明细字段 | 结果/耗时/首字/速度/Token 细分/失败原因 | 30+ 字段含 `pricedModel`/`routedTo`/`tokenEstimateDelta`/`truncated`/`continues` | B 更全 |
| **计量口径** | 三态 `exact`/`estimated`/`none` 分离 + 费用**一律按当前标定系数重算**（不信任历史固化值——曾差 97 倍量纲）+ `cacheRead` 缺失标上界 | **物理请求 vs 逻辑回合分离**：上游请求数按实际发出计，对话回合数/失败数/已恢复数按一次调用的最终结果计 | **双方都要** |
| UI | 逐请求列表 + 失败原因悬停 | 服务端分页检索 + SSE 调试记录（如实标注非实时） | 各有侧重 |

**择优结论**：
- **B 的"三态计量 + 费率重算"更严谨，保留**（A 只有 exact/estimated 二分）。
- **B 缺"逻辑回合"聚合**：B 的 failover（`maxAttempts` 多次尝试）与截断续写（`AUTO_CONTINUE` 多轮）都会在一个客户端请求下产生多个上游请求。B 的 traffic.jsonl **只记上游请求行**，因此一次"降级 3 次后成功"的客户端请求在 B 的统计里是 **3 次失败 + 1 次成功**，成功率被系统性低估。**这是做第 4 项（降级链）时必须一并补的配套**——否则降级上线后看板的成功率会立刻变难看且无法解释。
- **落地**：traffic 行加 `turnId`（一次客户端请求一个，failover/续写各轮共享）+ `attempt` 序号；`stats.js` 与 `stats-cache.js` 加 `turns` / `turnsFailed` / `recoveredTurns` 三个计数；`TokenStatsPage` 的成功率卡片改为按回合计算并加口径说明。约 1 人日。

#### 实施记录（2026-10-14）——先量化，再实现，并顺手发现一处&nbsp;AUTO_CONTINUE 不生效

**量化**（30 天全量流量）：总行 33,519；虚拟模型 **成功 22,890 / 失败 1,936** → 只按行算成功率，
被低估的**上界是 7.80%**（92.2% 实际可能是 100%）。值得做。

顺带实测出两件与本节假设不同的事：
1. **截断续写几乎不发生**：`finishReason=length`/`truncated` 仅 21 行（0.06%），
   全量日志里 `continues > 0` 的行数为 **0**。所以逻辑回合问题**纯粹来自降级**，不是续写。
2. **虚拟模型路径根本没有续写**：`model-router/index.js:30` 的
   `const { runWithContinuation } = require('../transform/continue')` 是**死导入**，
   该函数从未被调用。即 `AUTO_CONTINUE=true` 只对直连模型（`routes/openai.js`）生效，
   对虚拟模型**静默不生效**。已记入 `docs/01-architecture/known-limitations.md` F9。
   （本次一并删除了该死导入。）

**实现**（与报告原方案有一处改动：`turnId` 不逐个调用点传，改用 `AsyncLocalStorage`）：

一次客户端请求会产出多行 traffic，而这些行散落在 openai / anthropic / responses /
model-router 的**十余处** `logRequest`。逐个补 `turnId` 的问题不是工作量大，而是
**容易漏、且将来新增的调用点会绕过它**——这类「漏一处就静默失真」的口径最怕靠自觉。
改用 `src/lib/request-context.js`（AsyncLocalStorage）承载请求上下文，`logRequest`
自动继承，新调用点零成本；调用方显式给的 `entry.turnId` 仍优先（可覆盖）。

- `src/index.js`：`express.json()` 之后立刻挂中间件，`requestContext.run({turnId}, next)`。
- `src/log/traffic.js#logRequest`：`...(ctx?.turnId ? {turnId} : {})` 置于 `...entry` 之前。
- `src/model-router/index.js`：成功/失败两行都加 `attempt: attempts.length`。
- `log/stats.js` 新增 `turnBuckets/addTurn/turnCounters`（`stats-cache` 复用同一实现，
  避免两处口径漂移）；**桶里只存三个计数**，不把每回合明细留下——桶要覆盖历史每一天，
  逐回合存会让体积膨胀十倍以上。
- `log/stats-cache.js`：`BUCKET_VERSION 9 → 10`；旧桶按版本号自动丢弃重建（零迁移）。
- 历史行没有 `turnId` → **每行各自算一个回合**（等价于「无降级的单次尝试」），
  与旧口径一致，也不需要 `?? 0` 兜底。
- `admin-traffic.js /stats/daily` 加窗口级 `turns` 汇总；`stats.ts` 加类型；
  `TokenStatsPage` 的「计量覆盖率」卡加两行：`逻辑回合（客户端请求）· 成功率` 与
  `其中降级后成功`（口径写明，避免与「上游请求行」混淆）。

**验证**：
- 单元测试 4 项：混合回合聚合（含「失败两次后成功」与「全败」）、无 `turnId` 的历史口径、
  桶内三计数与逐日口径一致、请求上下文**跨 await 不丢 / 并发请求不串号 / 无请求时不写**。
- **端到端**：隔离工作区启动真实 app，造转发密钥后发一次真实 HTTP 请求，
  确认落盘的 traffic 行带上 `turnId=tmv7pky9qblbeq`（1/1 行）。


---

## 三、账号渠道层（第 1 项）

> A 的渠道实现在 `vendor/channel-pack/src/`（整包 vendored 上游 `dsh-codearts-auth`），共 13 条；B 有 4 个平台（Trae / WorkBuddy / ZCode / Qoder）。

### 3.1 四个重叠平台的逐项对比

**先肯定 B 的一项架构优势**：B 的 `src/platform/variant.js`（533 行）是**平台差异的单一事实源**——每个平台集中声明 `capability`（chat/checkin/balance/growth/billing/oauthLogin/deviceFingerprint 七个能力位）、`hosts`（cn/global 双域 + 域名字段 + regionPattern）、`identity`（UA/productCode/product/clientPlatform）、`paths`（各端点路径）、`errors`（已签到码/限流码/超长码）、`clientAuth`（本机凭据文件位置）。A 的对应物是每渠道一个 `*-product.ts`，**B 的集中表对固定平台集更清晰、且新平台接入只改一处**。这个设计应保留并在接入新渠道（如 Raccoon）时沿用。

| 渠道 | A 的独有机制 | B 的独有机制 | 择优结论 |
|---|---|---|---|
| **WorkBuddy / CodeBuddy** | 双额度**按 `DeductionEndTime` 15 天分档**选号（`buddy-balance-rank.ts:59`）+ **永久积分锁**（独立文档 `permanent-lock-store.ts:43`）+ 锁定时"只剩永久=不可用"可拒绝服务；`checkin-activity-status` 权威状态源（`credits.ts:11-13`，明确指出 `checkin-status` 返回占位数据会误判"活动未开启"） | 双域（国内/国际）统一解析；设备指纹重置 `deviceGen`；`get-user-resource-summary` 余额；**已正确使用 `checkin-activity-status`**（`platform/variant.js:136`）✓ | **互有胜负**：A 的余额分档 + 永久锁是 B 缺的（见 3.3）；B 的多域统一与指纹管理更工程化 |
| **Qoder 国际版** | 设备授权 + PKCE + **WASM 签名**（`qoder-auth-wasm.wasm`，推理端点需签名） | **已打通对话转发**（`POST /v1/qoder/chat/completions`，8 个可调用模型）；COSY 老协议签名可复用 | **B 领先**（对话面已通，A 只做账号+积分）；A 的 WASM 签名方案值得存档 |
| **Qoder 中国版** | 同一 product 分支 | realm 分叉（cn/intl）已落地；**国内版对话未启用**（实测 503，需 COSY 协议） | 持平（都未启用对话） |
| **TRAE** | ExchangeToken + GetUserInfo；**machine_id/device_id 必须持久化且签到不能共用 device_id**（否则"该设备已签到"）；`traeStreamToOpenAI` 转换自定义 SSE | **私有协议转换层**（`__dev`/`__max` 档位、function/scene 语义、**三形态工具调用归一化**、参数残缺从 userText 启发式补偿）；OAuth 完整闭环 + SSRF 白名单 | **B 领先**（转换层是 B 的核心资产，A 只是消费同一个上游） |
| **ZCode** | 浏览器登录（bigmodel/zai 双渠道）；验证码体系（`zcode-captcha.ts` 95KB + 预取池 + 退避）；**刻意删除"读取官方客户端本机凭据"能力**（安全考虑：公开可复现的派生密钥等于任何本地进程都能解密） | **DPAPI 解密导入**（`qoder/crypto.js`，Windows）；验证码求解器（happy-dom 模拟浏览器，`ZCODE_CAPTCHA_SOLVER_DIR`）；指纹档案轮换 | **B 领先**（本机凭据导入 + 求解器更完整）；A 删除本机导入的安全论证值得记入文档 |

### 3.2 RelayGate 没有的渠道：Raccoon（商汤小浣熊）可行性

**A 的实现**（8 文件约 3345 行）：`raccoon.ts` / `-adapter.ts`(477) / `-auth.ts`(609) / `-credits.ts`(249) / `-login-page.ts`(525) / `-oauth.ts`(340) / `-product.ts`(366) / `-qr.ts`(507)。

**三个必须记住的坑**（`raccoon.ts:12-23` 原文）：
1. **官方桌面端登录链路不可复用**：靠 `office-raccoon://auth/callback` 自定义协议回调，Node 宿主进程收不到；且 `/code/authorize` 的回调地址是**写死的**，改不成 localhost → 改为「客户端本地生成 code + 自行轮询」（实测任意自造 code 都被接受）；
2. **手机号必须 AES-128-CFB 加密**（公开常量密钥，非安全边界，只为避免明文进日志），否则 `send_sms` 回 `100003 params_encryted_error`；
3. **每日 300 积分没有端点**：服务端按日自动发放（`daily_grant`）——**不要实现成签到按钮**。

**评估**：接入成本高（本地 HTTP 登录页承载二维码+短信表单 + OAuth + 适配器，约 3300 行 TS 需改写），且与 B 现有 4 平台的登录形态（OAuth / 本机抓取 / DPAPI）不同，需新增"本地页承载登录"这一类基础设施。**建议：暂不接入，除非确有 Raccoon 账号与使用需求**。若做，`raccoon-login-page.ts` 的"宿主侧持敏感状态 + 本地页只渲染"模式是必须照搬的（B 的 Qoder 本地导入是另一条路）。

### 3.3 渠道层最高价值的两项借鉴（与渠道数量无关）

**① `CycleEndTime` vs `DeductionEndTime` —— B 的一处待验证字段语义**

A 的实测（`buddy-balance-rank.ts:18-31`，2026-09-29）：

| 资源包 | `DeductionEndTime` | `CycleEndTime` | A 的归类 |
|---|---|---|---|
| WorkBuddy Bonus Pack | 9 天 | 9 天 | 临时 |
| WorkBuddy Free Plan Subscription | **3008 天** | **2 天** | 永久 |
| CodeBuddy 个人体验版 | 3008 天 | 已过期 | 永久 |
| CodeBuddy 拉新权益包 | 17~208 天 | 同左 | ≥15 天永久 |

A 的结论："套餐包的**计量周期**虽短（月度），但**扣费截止在 8 年后** —— 取 `CycleEndTime` 会把每月刷新的套餐判成'马上作废'，锁定永久积分就形同虚设。"

**B 的现状**：`src/workbuddy/auth.js:298` 注释"与网页端 plans-usage 一致：summary 取 PackageCodes，free/paid 取包容量与 **CycleEndTime**"，`:352` `parseCycleTime(a.CycleEndTime || a.cycleEndTime)` 作为 `expireTime` 写入权益快照；`src/credentials/pool.js:418-419` 与 `:741-742` 用该 `expireTime` 做 FEFO 排序与跨池抢占。

**需要判断的问题**：B 的 FEFO 语义是"优先消耗即将作废的额度"。这里的"作废"究竟指**周期重置**（额度在本周期末清零、下周期重新发放）还是**扣费截止永久失效**？
- 若指周期重置（use-it-or-lose-it）→ `CycleEndTime` 正确；
- 若指永久失效 → 应为 `DeductionEndTime`。
**当前 B 的选择由"与网页端一致"决定，而非由 FEFO 的需求推导**。建议：**先做一次实测**（用 B 现有的 `src/workbuddy/auth.js` 请求 `get-user-resource-free-packages` / `-paid-packages`，对比两个字段的真实值），确认后再决定是否切换字段。这是**低代价、可能修正排序质量**的验证项。

**① 结论（已实测，2026-10-14）**

**字段确实取错了，已修。** 新增只读探针 `scripts/probes/probe-wb-pack-fields.js`（`npm run probe:wb-packs`），
对真实账号实测 70 条包：`CycleEndTime` / `DeductionEndTime` **69 条完全相等**，唯一不同的是

```
CodeBuddy个人体验版  Status=0  CycleCapacityRemain=500
  CycleEndTime      = 2026-10-31 23:59:59   （17 天后）
  DeductionEndTime  = 2034-12-12            （8.1 年后）
```

即 ① 的猜测成立，且这一条包**真有 500 可用积分**：取 `CycleEndTime` 会让 FEFO 把这
500 个「2034 年才作废」的积分当成「17 天后作废」，排到别的账号真正临期的积分前面被
优先烧掉，临期提醒也会误报。修法见 §六 D11。

**② 永久积分保护 + 15 天分档 —— 实测后判定「不做」**

原判断（三处证据链）在**字段取错的前提下**成立，修正字段后逐条复核：

- 420 个真实额度包**全部**是 `{remaining, expireTime}` 形态，`unlimited` / 无到期时间的
  分支**一次都没出现过**，`CycleEndTime` 最远也只有 30.8 天。也就是说
  `credits.js:103` 的 `never` **恒为 false**，数据里不存在「永久积分」概念。
- 修正 D11 后，「长期积分」已被正确表示为**较远的 `expireTime`**（2034-12-12），
  于是它天然被 FEFO 排到最后——**A 想要的保护已经由正确的字段选择自动实现**，
  不需要额外的闸门。
- `pool.js:579` 的「余额降序」只是**同一到期档位之内**的 tiebreak（前面还有
  prio / FEFO / d3 / d7 / costTier 五级），不构成「优先烧长期积分」。

因此**取消 P0-4**：加这个闸门会是「无数据可作用的死开关」，而它想解决的问题
已经被 D11 的字段修正解决。**不要照抄 A 的 15 天阈值**这一条仍然有效——
若将来上游真的出现无到期时间的包，再按 B 自己的 `POOL_ACCOUNT_PRIORITY_WINDOW_DAYS`
窗口讨论，且要作为**过滤项**而非排序项。

### 3.4 渠道接入入口（m-40，前端缺口）

**发现**：ZCode 的后端接口（`/v1/zcode/local/preview`、`/local/import`、
`/rewards/*`、`/accounts/:id/balance`、`/accounts/:id/fingerprint/rotate`）**全部就绪并已上线**，
前端却连一个按钮都没有——账号接不进来，只能翻 `docs/02-technical/channels/zcode-integration.md` 打 curl。
Qoder 的活动领取（`/campaigns`、`/claim`、`/quota`）同样只有 API。

**根因不是「忘了」**：`CredentialsPage.tsx` 原先是
「每加一个平台手写一个弹窗 + 手写一个按钮」，且没有任何地方能发现漏了一个。
平台能力位本来就在 `platform/variant.js`（单一事实源），前端却另有一套平台名单。

**实证影响（本机可复现）**：这台机器上 ZCode 桌面客户端**已安装且已登录**
（`C:\Users\bing\.zcode\v2\credentials.json`）、Qoder 双区域也已登录，
但这些账号此前完全无法从面板接入。

**择优结论**：借参考项目的**信息结构**（provider 卡片网格 + 已接入/待接入徽标 +
「管理渠道」入口），不搬它的**数据来源**（A 的 provider 清单是前端静态导入，
本仓库的 `variant.js` 已是正源，再维护一份必然漂移）。形态为
「后端声明能力位 + 本机实测可用性，前端按渠道 id 注册向导」。

**实施记录（2026-10-14）**

- 新增 `GET /v1/admin/channels`（`src/routes/admin-channels.js`）：能力位 + 真实账号计数 +
  逐条接入方式的本机实测可用性，全部从 `variant.js` 派生；单平台探测异常降级为
  「不可用 + 原因」而不 500（否则一个平台的异常会挡住另外三个）。
- `variant.js` 补 `note` 与 `onboarding`（**声明**有哪些接入方式，运行时可用性由端点实测）；
  新增 `allVariants()` 保证展示顺序与定义顺序一致。
- 前端新增渠道注册表（`shared/lib/channelIds.ts` + `channels.ts`）、
  渠道卡片网格（`ChannelGrid.tsx`）、ChannelOpsDialog + `ZcodeOps.tsx` / `QoderOps.tsx`。
- **`connected` 口径用 `total > 0` 而非 `enabled > 0`**：WorkBuddy 导入后显式
  `enabled=false`，按 `enabled` 判定会把刚导入完的渠道显示成「待接入」。
- **修掉两个同源的错路由**：行内「重新登录」此前只特判 WorkBuddy，ZCode/Qoder
  账号会掉进 **Trae 的 OAuth 弹窗**（对一个 Qoder 账号打开 Trae 授权页）；
  行内按钮此前按平台名硬编码 `!== 'zcode' && !== 'qoder'`，改为读能力位。
- **修掉 Qoder 弹窗的一处错误文案**：写着「导入的账号默认停用」，实际
  `qoder/local.js#buildAccountFromLocal` 不带 `enabled`，`store.add` 默认
  `cred.enabled !== false` → **导入即启用**（只有 WorkBuddy 是显式停用）。
- **修掉一处跨接口字段不一致**：`/v1/zcode/accounts` 的 `redact` 没有像
  `/v1/credentials#withExpiry` 那样把 token 额度摊平到顶层，运营面表格若各读一套
  `entitlementSnapshot.tokenRemaining` 必然会漂移；现在两个接口同名同值（有断言钉住）。
- 测试：新增 `src/test/channels.test.js`（39 项），把「每个渠道必须声明至少一条接入方式」
  「前端向导注册表与后端渠道集合**双向一致**」「每条接入方式都有向导落点」
  钉成会失败的断言——下次「加了平台忘了加入口」会直接让测试红。
  溯源与扩展步骤见 `docs/02-technical/channel-onboarding.md`。

### 3.5 Raccoon（商汤小浣熊）渠道接入

§3.2 原判「**暂不接入，除非确有 Raccoon 账号与使用需求**」。用户确认有账号后实施，
本节记录**实际成本与原估的偏差**——那正是「不建议」结论需要被修正的地方。

**原估 vs 实际**：原估「约 3300 行 TS 需改写 + 需新增『本地页承载登录』基础设施」。
实际成本低得多，原因有三：

1. **不做本地 HTTP 登录页**。参考项目的 525+562 行（登录页 + 二维码）是因为它的宿主
   是 Cordis 插件、需要自己起一个 `127.0.0.1` 的临时页面。RelayGate 已经有 React 面板——
   后端只出「会话 + 二维码 path」，面板负责渲染，**省掉约 1100 行**。
2. **二维码编码器是机械转译 + 逐位对拍**，不是重写。参考项目的 `raccoon-qr.ts` 零依赖
   纯函数，用 tsc 转译后规范化导出与错误文案即可；保真由 315 组输入对拍 + 29 组黄金哈希
   钉住（`src/test/qr.test.js`，38 项）。
3. **对话面是标准 OpenAI 兼容 + 标准 SSE**（`chat.completion.chunk` + `data: [DONE]`，
   无加密、无信封、无格式转换）——**逐字透传即可**，是五个渠道里最便宜的一条转发链路。
   对比 ZCode 那条 Anthropic Messages 通道（还要过请求体身份块准入）。

**实施记录（2026-10-14）**

- `src/platform/variant.js` 新增 `[RACCOON]` 变体（域名/路径/身份/业务码/能力位/`onboarding`）。
  新增两个能力位：`tokenRefresh`（可静默续期）与 `loginReward`（一次性登录奖励）。
- 新增 `src/raccoon/{product,client,auth,credits,chat}.js` 与 `src/lib/qr.js`；
  路由 `src/routes/raccoon.js` 挂 `/v1/raccoon`（运营面 admin 鉴权；`/chat/completions`
  转发面鉴权 + 限流）。
- 前端：面板承载扫码登录（`ImportRaccoonDialog.tsx`），二维码渲染为
  `<svg><path d={…}/></svg>`——**不经第三方图片服务、不用 dangerouslySetInnerHTML**。
  渠道卡片因 m-40 的注册表设计**自动出现**，只需登记向导。
- store 新增 `raccoon_org` 列（`office_identity`，`X-Org-Code` 每次请求都要用）；
  **刻意不加设备标识列**：参考实现全链路只读不写 `device_id`，没有生成规则就不发明。

**顺手修掉的三处（都是「照抄会错」的地方）**

1. **`pool.editionOk` 的默认分支**：原文是「`canChat` 为真且非 workbuddy」+ 逐个排除
   qoder。Raccoon 的 `chat=true` ⇒ 它会被**静默放进 Trae 默认池**，Trae 请求就会拿着
   Raccoon 的 token 打别家上游。改为「归一化后属于 Trae 平台」。
   ⚠️ 修法有坑：不能用 `isTrae(edition)`——它是显式白名单，对**空/未知 edition 返回
   false**，而默认池历来把这类历史账号视为 Trae 系放行；改用 `isTrae` 会让它们静默
   出池，表现为整池 `No account available in pool`（实测踩到，4 个 pool 用例变红）。
2. **`scheduler.refreshExpiringTokens` 的平台判据**：它复用 `oauthLogin` 兼作「可续期」，
   对 Trae 恰好成立；Raccoon 既不是 OAuth 换票又**必须**续期。改用新的 `tokenRefresh`
   能力位。顺带查清：`workbuddy` 的两位都是 false ⇒ 循环体里那个
   `edition === 'workbuddy'` 分支**不可达**（现状如此，**不顺手打开**——那会让 WB 账号
   开始产生新的上游请求，属未经证实的行为变更）。
3. **模型密钥边界**：Raccoon 模型（`sn-` 命名空间）**只有通用密钥可调**，
   否则 Trae 分支的「非 WorkBuddy 独有模型就放行」会让平台密钥越界消耗 Raccoon 积分
   （与 Qoder 同一类问题）。另在路由层加一道闸：非 `sn-` 模型返回 **400**
   （而不是走到「没有账号」的 503 —— 那会把「调错端点」说成「缺账号」）。

**保真证据**

- `encryptPhone` 与参考实现**逐字节一致**：12 组固定 IV 的黄金值
  （错一字节 `send_sms` 就回 `100003 params_encryted_error`，而错误信息完全不指向
  「密钥长度写成了 aes-256」这种根因，故必须有黄金值钉住）。
- `displayName` 7 个分支与参考实现一致（含「**1 倍也要显示倍率**」这条用户报障结论）。
- 二维码：315 组输入逐位对拍 + 29 组黄金哈希。
- 请求头**逐调用点照抄**：参考实现里 `send_sms`/`refresh` 只发 `Content-Type`、
  `user_info` 不发 platform/version、积分端点发两者、`model_catalog` 手写四头且
  **无 Content-Type**、`chat/completions` 发 platform 但**不发 version**；
  且**全程不发 `User-Agent`**（该字段注释写明「仅记录用；实测不校验」）。
  我最初把 UA 加进公共头并发明了设备标识 —— 两者都按证据回退了。

**未验证的**（如实记录）：远端模型目录的响应解析照抄参考实现，本机无已登录账号，
故未经真实请求验证；失败时回退 6 条实测兜底表并把 `source` 标成 `fallback`。
见 `docs/01-architecture/known-limitations.md` 的 F12–F14。

---

## 四、运维自动化（第 12-13 项）
### 4.1 成长任务 / 每日签到 / 积分领取

**六维逐项裁决**（证据见 `30179cf7` 报告，60 余处 `file:line`）：

| 维度 | 裁决 | 关键证据 |
|---|---|---|
| **幂等（防重复）** | **A 优** | A 有跨重启日闸（`auto-checkin.ts:601-606`）+ `shouldMarkToday` 只认 `coversToday>0`（`:392-394`）；B **无日闸**，`lastCheckinResult` **只写不读**（`checkin.js:95,205,254`，全仓无读取点） |
| **防假成功** | **A 略优** | A 全部渠道 claim 后回读 + 业务码判据（明确拒用 HTTP 码，`qoder-credits.ts:598-600`）；B 仅 Trae 有回读（`checkin.js:241-250`），**`wb-checkin.js:117` 无回读直接标 claimed** |
| **重试退避** | **B 优** | B 的 Trae 签到三次指数 5/10/20s + 批后 busy 补跑（`checkin.js:196-213,319-334`）；A 的 `trae-credits.ts:265-276` **对 9074 明确不重试**，`classifyTraeCheckinError` 的 `cooldownSecs` 无消费方。**缺口**：B 的 `wb-checkin.js` 与 growth 六段零重试 |
| **错峰** | **B 优** | B 有确定性哈希错峰（`util.js:32-57`，4 处调用）；A 只有启动延迟 + 串行 |
| **跨重启恢复** | **A 优** | A："未证明今日即不记账 ⇒ 下次启动补跑"（`auto-checkin.ts:575-582`）+ inflight 去重 + 独立文档防多 profile 互抹；B：scheduler 是"下一次 HH:mm"（`scheduler.js:56-62`），**重启晚于该时刻即整天跳过、无补跑**；`growth-progress.js:25` 的 `readDisk` **从未被调用**，进度只在内存 Map，重启 `running` 复位（`:70,123`），中断轮不续跑、不记账 |
| **编排隔离** | **B 优** | B 六段独立 try（`growth-auto.js:67,95,132,158,178,195`）+ 账号级隔离（`:216-221`）；A 的 `serial-queue.ts` 只解决 captcha 并发 |
| **可观测性** | 各有侧重 | A 长于"每笔请求的账且落盘"（`token-ledger.ts` 渠道×provider×账号×模型日聚合）；B 长于"钱被消耗多少"（`credit-history.js`），但**签到/成长日志无金额明细**（`checkin-log.js:27-37` 只 4 个计数），接不上钱账 |

**择优落地方案（按优先级）**

| 编号 | 内容 | 落点 | 代价 |
|---|---|---|---|
| **P0-1** | **补持久化日账 + `coversToday` 语义**：新增 `src/jobs/daily-task-log.js`；判据照 `auto-checkin.ts:176-178,575-582`（UTC+8 日键 + "至少一个账号能证明今日已处理"才记账） | `scheduler.js:135-243`、`growth-auto.js` | 小（需定义各平台刷新时刻，qoder 10:00 UTC+8 已知）。**同时修掉 known-limitations R3（重启边界重复触发）与 F6（非 UTC+8 时区需手动对齐）** |
| **P0-2** | **`client_token` 改稳定键**：`cat-trip.js:53` 现用 `randomUUID()`，改为 `${localDateKey}:${accountId}:${action}:${主键}`，重试复用 | `src/routes/cat-trip.js:53` | 小。**这是一处真实缺陷**（注释声称幂等但实现不是） |
| **P0-3** | **`wb-checkin` 补 claim 回读**：照 `checkin.js:241-250` 在 `wb-checkin.js:117` 前加回读 | `src/upstream/wb-checkin.js` | 小（每账号 +1 请求） |
| **P0-4** | ~~加永久积分闸门（见 3.3②）~~ **实测后取消** | 420 个真实额度包全是 `remaining/expireTime`，`never` 恒 false，无「永久积分」概念可作用 | — |
| **P1-1** | growth 写操作外包 retry 白名单 | `growth-auto.js`（复用 `upstream/errors.js:153-181`） | 小 |
| **P1-2** | 用起 `readDisk`，启动补跑中断轮未完成账号 | `growth-progress.js:25` | 小 |
| **P1-3** | 签到/成长日志带金额明细，挂 `credit-history` | `checkin-log.js`、`growth-progress.js` | 中 |

**注意**：`alreadyToday`（B，`qoder/rewards.js:293`）与 `coversToday`（A）**是同一个设计的两种命名**——双方独立收敛到同一结论，说明方向正确。但 **B 的是"任务排在刷新后"的时序依赖**（`qoder-rewards.js:34-35` 默认 10:15 对齐 UTC+8 10:00），A 的是**产出方声明、与时序解耦**。P0-1 的价值正是去掉这个时序依赖。

---

### 4.2 热重载 —— 判断为**不适用**，但发现一处配置缺陷

**A 的实现**（`src/reload.js` 277 行）：镜像内核 `partialReload` 的 5 步——① 快照 fibers/config → ② 从 ESM `loadCache`（含 Node 24 LoadCache 不是真 Map 的怪癖，用 `Map.prototype.*.call`）与 CJS `require.cache` 剔除本包条目 → ③ 经 loader 重新 import（`?ofm=<ts>` 强制新求值、`loader.unwrapExports`）→ ④ 删旧注册 + await 旧 fibers 结束 + 按同名 config 重新 `registry.plugin` → ⑤ 任一步失败恢复两个缓存 + 重新注册旧代码，并如实报告是否恢复成功。

**判断：不建议引入**。理由：A 是 **Cordis 插件**（有 fibers / loader entry / plugin registry 这些接缝），B 是**长驻 CJS 主进程**（Express 路由已绑定、scheduler 定时器在跑、SQLite 连接已开、可能有在途流式请求）。"热重载自身代码"对 B 的收益仅为省一次 `npm start`，而风险是路由/定时器/DB 句柄的三重不一致。B 已有的**优雅停机链**（`src/log/crash.js` 的 `onShutdown`）才是这个形态的正解。

**但分析中发现 B 的一处配置缺陷**（这才是这一项的实际收获）：
`src/config.js:213-244` 的 `config.reload()` 声称"重新加载 .env（不覆盖已存在的环境变量，仅刷新可热更项）"，然而 `:9` 的 `require('dotenv').config()` 与 `:217` 的再次调用**都没有 `override: true`**。dotenv 默认不覆盖已有 `process.env` 键 → **第二次调用是 no-op，.env 的改动不会被热加载**（`config.reload()` 实际只重载了 `model-config.json`）。
**落地**：`:217` 改为 `require('dotenv').config({ override: true })`，或改用 `dotenv.parse(fs.readFileSync('.env'))` 手动合并到指定字段（更可控，避免覆盖进程启动时外部注入的变量）。同时借鉴 A 的 **generation 守卫**（`auto-checkin.ts` 与 `reload.js` 的多处代次校验）加强 `scheduler.js` 的重排安全性。
**代价**：0.5 人日。**风险**：低（注意 override 的边界：只应覆盖 .env 中明确出现的键）。

---

## 五、共有功能的择优分析（双方都有时谁更优）

### 5.1 逐项裁决

| 能力 | A | B | 裁决与融合 |
|---|---|---|---|
| **失败分类与冷却** | `route/classify.js` 542 行：统一 `FAILURE_KIND` 11 类 + `retryable` + `scope` 四值（request/account/provider/transient，**request 类故障不冷却账号**）；规则表驱动（文本规则优先于状态规则）；429 指数退避 2s×2ⁿ 封顶 5min；provider 报告 reset 硬封顶 30min；**纯函数无时钟** | 冷却能力**更丰富**：二维冷却（账号×模型 分离）、rate_limit 退避带**上游精确恢复时刻解析**（"将在 UTC+8 某时刻重置"）、quota 硬冷到次日 04:00、5xx 计 5 次熔断；但分类函数**散落三处**（`upstream/errors.js`、`model-router/health.js`、`credentials/pool.js`），无统一词汇 | **保留 B 的冷却策略，移植 A 的"统一词汇 + scope 维度"**。B 缺的正是"request 类故障不该冷却健康账号"这条原则的显式表达。~1 人日 |
| **账号池调度** | 渠道内基础池（`account-pool.ts` 64KB）：按模型限流标记 + 永久锁 + 余额分档 + 跨账号防覆盖 | **五层比较器**（priority→FEFO→临期金额→d3/d7→costTier→余额→闲置，Schwartzian 预计算）+ **跨池权益抢占**（Trae 池 vs WB 池 tier 信号，5s 缓存）+ 粘性会话 1h + 乐观锁 CAS | **B 明显领先**。仅需补 A 的**"阳性证据剔除下架模型"**（`dead-model-store.ts`：只在真实请求回 "模型不存在" 时落盘，TTL 30 天，不从残缺远端目录反推）——B 的 `availability.js` 有 7 天 TTL，但无此"阳性证据"原则。~0.5 人日 |
| **计量口径** | 三态 `exact`/`estimated`/`none` + 费用按当前标定重算 + `cacheRead` 缺失标上界；**物理请求 vs 逻辑回合分离** | 同有三态 + 费率重算 + `cacheRead` 上界；**无逻辑回合概念** | **各取所长**：B 保留自己的三态；补 A 的逻辑回合聚合（见 2.5） |
| **流式健壮性** | 首块嗅探 + 字节回灌 + 15s SSE 注释帧心跳 + 流内 error 帧统一分类 | WB passthrough / Trae 状态机；**无心跳帧** | 借 A 的嗅探（1.2）与**心跳帧**（降级窗口内必需，见 1.3） |
| **工具调用归一化** | 三协议共用配对修复（`repairToolPairing`）+ 工具指纹闸门（四件套提升） | **三上游形态归一化**（原生分片 / `<tool_use>` 文本块花括号平衡扫描 / 裸 JSON）+ 参数残缺启发式补偿 + B2 规则 | **B 更精细**（三种上游形态是 B 独有）；A 的"发送前统一修配对"值得借（B 已有类似逻辑但可对照） |
| **提示词注入与撤销** | 三线幂等注入（chat system / Anthropic system 块插在最后一个 `cache_control` 前 / Responses instructions）+ 可撤销 | 无 | 借 A 的**幂等注入与撤销**机制，但**不建议**引入 caveman/ponytail 文案（改变模型说话方式对编码助手是负资产；A 自己默认全关） |

### 5.2 B 领先、A 较弱或没有的能力（**不要被借鉴动作覆盖掉**）

用户要求"对于我方拥有而对方有雏形或较弱的功能，也可参考分析"。以下 12 项经逐条核实是 **B 的资产**：A 要么没有，要么只是雏形。**融合时必须作为保留基线**，其中最容易被"借鉴大动作"顺手改坏的已标注 ⚠️。

| # | B 的能力 | A 的状态 | 证据（B） | 风险 |
|---|---|---|---|---|
| B1 | **五层选号比较器 + 跨池权益抢占** | 渠道内基础池，无跨池概念 | `pool.js:564-581`；跨池 tier 信号 5s 缓存 | ⚠️ 引入永久积分闸门时**不要改动既有比较器顺序**（新闸门应是过滤项，不是排序项） |
| B2 | **二维冷却（账号×模型）+ 上游精确恢复时刻解析 + quota 硬冷到次日 04:00 + 5xx 熔断** | 规则表驱动，无账号×模型二维 | `pool.js:224-234,646-680`；`health.js` | ⚠️ 引入 A 的 `classify.js` 统一词汇时，**必须保留 B 的 `cooldownMs` 具体数值与解析逻辑**，只换词汇层 |
| B3 | **上下文窗口实测校准**（校准值 > 声明值 > 平台地板 100K） | 声明值取交集（更保守） | `window-calibration.js`；`autotier.js:34-38` | ⚠️ 见 1.4——**不要改成 A 的 min 语义**，会砍掉大窗口能力 |
| B4 | **三上游形态工具调用归一化**（原生分片 / `<tool_use>` 文本块花括号平衡扫描 / 裸 JSON）+ 参数残缺启发式补偿 + B2 规则 | 三协议共用配对修复（不同维度） | `transform/sse.js` 全文；`transform/finish.js` | ⚠️ 引入 RTK 时**不要触碰工具解析层** |
| B5 | **Trae 私有协议转换层**（`__dev`/`__max` 档位、function/scene 语义、SSE 工具块归一化） | 仅消费同一上游，无转换层 | `upstream/client.js`、`transform/` | ⚠️ 引入 SSE 嗅探（1.2）时**只加形状判定，不要改写解析器** |
| B6 | **官方账单积分口径 + 费率标定（pricing-calib 三系数拟合）+ 费用按当前标定重算** | 仅 token 计数，无账单口径 | `models/pricing-calib.js`、`log/stats.js:117-126` | ⚠️ 见 2.1——**本地应答绝不能写假 usage**，会污染标定样本 |
| B7 | **三态计量（exact/estimated/none）+ `cacheRead` 缺失标 `costUpper` 上界** | 两态（exact/estimated） | `log/stats.js:60-141` | 无 |
| B8 | **通知告警四渠道 + 事件级开关 + 去重 + 合并窗口** | **无进程外通知**（仅应用内 toast/SSE） | `notify/index.js` | 无 |
| B9 | **加密备份/恢复**（AES-256-GCM + 校验和 + 恢复前安全快照 + 路径限定） | **无** | `jobs/backup.js` | 无 |
| B10 | **审计日志**（append-only，谁看了密钥明文/导出凭据） | **无** | `log/audit.js`；`routes/admin-security.js` | 无 |
| B11 | **访问密钥体系**（sk-admin/sk- 分离 + RPM 滑窗 + `scopes` + `resources` 前缀 ACL + 轮换 24h 宽限期） | 单转发 Key + 中继 Key | `credentials/api-keys.js`、`auth/scope.js` | 无 |
| B12 | **生产加固全家桶**（优雅停机链、调度锁、启动健康检查拒启动、crash 落盘、OAuth 回调闸门、CSP/SSRF 白名单、乐观锁 CAS） | 以热重载/自更新为重心 | `log/crash.js`、`lib/startup-checks.js`、`middleware/` | ⚠️ 见 4.2——**不要为"热重载"改动停机链与启动检查** |
| B13 | **`platform/variant.js` 平台差异单一事实源** | 每渠道一个 `*-product.ts` | `platform/variant.js` | 接入新渠道时应沿用此表 |
| B14 | **确定性哈希错峰** | 无（只有启动延迟 + 串行） | `util.js:32-57,121-135` | 无 |
| B15 | **Trae 签到 busy 码指数退避 + 批后补跑** | 签到路径对 9074 明确不重试 | `checkin.js:196-213,319-334` | ⚠️ 见 4.1——**不要照搬 A 的签到退避"改进"**，A 这块比 B 弱 |
| B16 | **成长任务六段段级隔离**（六段独立 try + 账号级隔离） | `serial-queue` 只解决 captcha 并发 | `jobs/growth-auto.js:67,95,132,158,178,195` | 无 |

**一句话**：B 在"账号经营"（调度/冷却/计费/通知/备份/审计/加固）上整体领先 A；A 在"模型获取与协议兼配"（免费车道/聚合注册表/降级链语义/省 Token/多客户端配方）上领先 B。**借鉴应严格限定在后者，前者是已建成的护城河。**

---

## 六、分析中发现的既有缺陷（顺手修，与借鉴无关）

| # | 缺陷 | 证据 | 影响 | 代价 |
|---|---|---|---|---|
| D1 | **`cachedModelStats` 的 `promptTokens`/`completionTokens` 恒为 0**，`errors` 恒 0，`avgDurationMs` 按请求数比例摊 | `stats-cache.js:189,210-211`（桶里没这两字段）；而 `STATS_CACHE` **默认开**（`admin-traffic.js:23`） | `/stats/models` 默认路径下数值不可信 | ~15 行（与 P1 同批修） |
| D2 | **`byModel` 未进 TS 类型** | `stats.ts:11-41` 的 `DailyStat` 缺该字段，而后端 `stats.js:196-199` 已返回 | 热力图 tooltip 与单模型曲线**被这一个类型挡在门外** | 10 行 |
| D3 | **`days` 上限 90** | `admin-traffic.js:122` | 17 周热力图取不到 119 天 | 1 行 |
| D4 | **日期口径冲突：UTC vs 本地** | 日志目录/`readTrafficLines`/`recentDays` 用 UTC（`traffic.js:22`、`stats.js:18`、`stats-cache.js:50`），`todayKey` 用本地（`:41-44`） | 中国区本地 00:00-08:00 的请求记到前一天 → 按本地日历画热力图**系统性错位一格** | 见 2.3 方案 |
| D5 | **工具结果转换丢失 `is_error`** | `routes/anthropic.js:57`、`transform/request.js:37-41` | RTK 会压缩错误轨迹，诱发模型重试同一调用 | **已修**（见下） |
| D6 | **`client_token` 每次随机 UUID** | `cat-trip.js:53` vs `growth-auto.js:12` 注释 | 重试/重启即换键，服务端去重失效 | 小 |
| D7 | **`wb-checkin` 无 claim 后回读** | `wb-checkin.js:117`（对比 `checkin.js:241-250`） | 假成功无法识别 | 小（+1 请求/账号） |
| D8 | **`config.reload()` 的 .env 热加载是 no-op** | `config.js:9,217` 均无 `override: true` | .env 改动不生效，用户以为生效了 | 1 行 |
| D9 | **`DailyTrendChart` 单 Y 轴** | `DailyTrendChart.tsx:37-40` 只用 `maxReq` | tokens 虚线的纵向位置读不出数值 | 随第 10 项一并修 |
| D10 | **`growth-progress.js` 的 `readDisk` 从未被调用** | `:25` | 重启后进度丢失、中断轮不续跑 | 小 |
| D11 | **`CycleEndTime` 取错字段（长期积分被当临期优先烧掉）** | `workbuddy/auth.js:352` 只读 `CycleEndTime`；响应里同样存在 `DeductionEndTime` 却零使用 | **已实测确认并修复**：70 条包中 69 条两者相等，唯一不同的是「CodeBuddy个人体验版」（`CycleEndTime`=2026-10-31 / `DeductionEndTime`=2034-12-12，且真有 500 可用积分）→ FEFO 把这 500 个 2034 年才作废的积分当 17 天后作废，排到真正临期的积分前面烧掉。修法：`packExpireMs()` 取两者较晚者（单周期包行为不变），并把该事实打成可见日志 | **已修** |
| D12 | **日志目录不走 `workspaceDir`** | `log/traffic.js`、`log/crash.js` 硬编码 `ROOT/logs`；`log/stats.js`、`admin-debug.js`、`upstream/client.js` 读取/写入也用 `ROOT`；而 `log/audit.js` 用 `workspaceDir` | 设 `WORKSPACE_DIR` 隔离不了日志 → `npm test` 往真实 `traffic.jsonl` 追加 `model=test` 等行，而 `/v1/admin/stats/*` 与统计面板读的就是它 → **测试流量进统计与热力图** | **已修** |
| D13 | **`/health` 检查的 `model-router.json` 与实际使用的不是同一个文件** | `lib/startup-checks.js:103` 固定读 `<ROOT>/model-router.json`；而 `model-router/store.js:37` 读 `<workspaceDir>/model-router.json`，缺失才回退模板 | 双向误判：工作区文件损坏而模板完好 → `/health` 报 ok，**恰好漏掉该检查要拦的场景**（vm/* 被当物理模型必然 400）；模板损坏而工作区正常 → 误报不健康。实测本机 `/health` 一直报「1 个虚拟模型」而路由实际用 4 个 | **已修** |
| D14 | **无 usage 时也写 `0/0/0`，被 `isMetered` 判成 exact** | `routes/anthropic.js#emitLog`（原无条件写三个 token 字段） | 失败请求与本地应答都会被记成「上游真值」，虚高计量覆盖率。实测当前**零行受影响**（33,077 行全是 `/v1/chat/completions`，该端点一行都没有），属潜伏缺陷；本地应答一上线就会每次都写 0 | **已修**（无 usage 时不写字段） |

---

## 七、实施路线图（按依赖与 ROI 排序）

### 实施进度（2026-10-14）

| 批次 | 项 | 状态 |
|---|---|---|
| 批 1 | D2 + D3 + D9 + 第 10 项 P0、第 9 项热力图（含 D4 本地日期决策）、第 2 项 count_tokens、D8 + 4.2、D6 + D7 | **已完成**（`3ee8a1f`） |
| 决策 | ① 统一本地日期口径 ✅ ② `/v1/messages` 补非流式分支 ✅ ③ 本地应答记账（口径已定：0 token + 打标，随批 4 落地） | **已落地** |
| 批 2 | 第 4 项 降级链（含提交闸门与心跳） | **已完成**（`8ddbedb`）；形态按实测收敛为零 UX 成本版本，见 §1.3 实施记录 |
| 批 2 | 第 1 项 D11 实测 | **已完成**（`6372d3a`）：字段确实取错，已修；同批否掉了「永久积分闸门」（无数据可作用），见 §3.3①② |
| 批 2 | 第 3 项 SSE 嗅探、第 5 项 模态过滤、逻辑回合聚合（第 4 项的配套） | **全部已完成**：模态 `9826610`（§1.4）、SSE 形状判定 `29eb134`（§1.2）、逻辑回合见 §2.5 |
| 批 3 | D5 → RTK → 第 8 项 节省面板、第 6 项 effort 档位 | **已完成**（`d721fbd` D5、`faf3dbd` RTK+面板+档位）；RTK 剩 `openai.js` 直连路径与 `responses.js` 未接线；effort 的上游参数实测仍待做（本实现不依赖它） |
| 批 4 | 第 7 项 本地应答（+ 记账） | **已完成**（`c6dd224`，见 §2.1 实施记录）；5 类检测器 + 第四类 `local` 记账 + 修掉潜伏的 D14 |
| 批 4 | 第 13 项 P0-1 持久化日账 + `coversToday`（修 R3 + F6） | 待办（用户决定暂缓，是本路线图唯一剩余项） |
| 计划外 | 事故处置（见 `docs/05-incidents/incident-2026-10-14-test-db-pollution.md`）、**D12 日志目录隔离**（`b5acf75`）、**D13 `/health` 检查错文件** | **已完成** |
| 计划外 | **m-40 渠道接入入口**（ZCode 后端全就绪却零前端入口；见 §3.4 与 `docs/02-technical/channel-onboarding.md`） | **已完成** |
| 计划外 | **Raccoon（商汤小浣熊）渠道接入**——报告 §3.2 原判「暂不接入，除非确有账号与需求」，用户确认有账号后实施 | **已完成**（见 §3.5 与 `docs/02-technical/channels/raccoon-integration.md`） |

### 实测驱动的优先级修正

批 2 剩余的 SSE 嗅探 / 模态过滤，与新发现的两个缺陷相比 ROI 需要重排：

- `context length exceeded` 一度看似 bug（只估出 3008 token 却被判超窗口），实为 `security.test.js` 造的测试虚拟模型 `vm/sec-guard`（contextWindow=1000）把 400 写进了真实流量日志——正是 D12 修掉的那类污染；`vm/wb-free-model` 的 360040 > 300000 则是**正确拒绝**。
- WorkBuddy `11115`（一天 64 条）经实测是**守门余量的合理代价**，不是 bug：用日志自带的 `tokenEstimate`/`promptTokens` 对照 1272 组样本，启发式**单向偏低**（p50 = 1.185、p95 = 1.304、max = 1.325，高估样本 **0** 个），故 0.75 的名义余量实际约等于「放行到真实窗口的 ~89%」，贴近上游硬顶；而 27 天里**本地守门一次误拒都没有**（`no candidate can fit` 0 行）。结论是**不动这个阈值**，只把实测依据写进 `autotier.js` 的注释，防止后人按字面理解把它调小。
- 仍待处理：`access denied: resource_denied:model:trae/doubao-1-6`（近 7 天 59 条）。这是密钥 `resources` 未覆盖该模型导致的**正确的**鉴权拒绝——需把该模型加入密钥资源，或改客户端使用的模型名。属配置项，非代码缺陷。


### 第一批：低成本高收益，互不依赖（约 3-4 人日）
1. **D2 + D3 + D9 + 第 10 项 P0**（`byModel` 类型 + `days` 180 + 单模型曲线）——半天，立刻可见
2. **第 9 项 热力图**（含 D4 的 UTC 键决策）——1 人日
3. **第 2 项 count_tokens**——0.5 人日
4. **D8 + 4.2 的 config.reload 修复**——0.5 人日
5. **D6 + D7**（client_token 稳定键 + wb-checkin 回读）——0.5 人日

### 第二批：核心语义改造（约 6-8 人日，需测试护航）
6. **第 4 项 降级链**（含 2.5 的逻辑回合聚合 + SSE 心跳帧）——3-4 人日，**这是本次最有价值的一项**
7. **第 3 项 SSE 嗅探**——1-1.5 人日
8. **第 5 项 模态过滤**——1 人日
9. **第 1 项 渠道：D11 实测 + 永久积分闸门（可选）**——1-2 人日

### 第三批：省钱（约 4-6 人日，依赖 RTK）
10. **D5（is_error 透传）→ RTK 压缩 → 第 8 项 节省面板**——4-6 人日
11. **第 6 项 effort 档位**（需一次上游实测）——1.5-2 人日

### 第四批：可选 / 条件触发
12. **第 7 项 本地应答**（建议与 Claude Code 支持包一起评估）——1.5-2 人日
13. **第 13 项 P0-1（持久化日账 + coversToday）**——1-2 人日，修 R3 + F6
14. **第 13 项 P0-4 / P1-x**——按需
15. **第 1 项 Raccoon 渠道**——不建议（约 3300 行，需新增"本地页承载登录"基础设施）

### 明确不建议
- **A 的代码热重载**（形态不适用，见 4.2）
- **caveman / ponytail 提示词瘦身**（改变模型说话方式，对编码助手是负资产）
- **A 的 17 条车道体系**（OpenCode/Kilo/EAC 与 B 的账号计费体系不兼容）
- **A 的三处硬编码**：八色 `SEASON` 色板、`id="ofmFill"`、假 usage 常量——分别违反 B 的 token 纪律、`useId` 惯例、账单标定口径

---

## 八、需要你决策的三个点

1. **日期口径**：热力图/曲线走 **UTC 日键**（0 后端风险，与现有日志一致，但页面需标注"按 UTC 切分"），还是**统一改本地日**（语义正确，但要处理切换日的双文件并存）？**推荐先做 UTC 键，把本地化单独立项并记入 `known-limitations.md`**。
2. **`/v1/messages` 要不要补非流式分支**：现在是恒 SSE（`anthropic.js:112-115`），补了才能干净地支持本地应答，同时修掉一个既有缺陷。
3. **本地应答要不要记账**：不记则这些请求从 B 的看板消失（B 与 A 相反，转发路径是唯一数据源）；记则需新增 `local` 计数并避免污染计量覆盖率分母。**推荐记 0 token + 打标**。
