# dsh-our-free-model × RelayGate 四组功能代码级对标报告

> **参考项目 A**：`C:\opt\workstations\project\web\dsh-our-free-model`（下文行号均以该仓库为根）
> **本项目 B**：`C:\opt\workstations\project\web\RelayGate`（下文行号均以该仓库为根）
> **方法**：两仓库均逐文件通读，结论全部给出 `文件:行号`。A 的实现细节按「可直接照抄」的粒度摘录；B 的现状按「缺什么、在哪一行缺」定位。
> **一句话结论**：四组功能里，**第 3 组（热力图）是性价比最高的移植项（后端 1 行 + 前端 ~150 行）**；**第 2 组（节省统计）必须先有 RTK 才有意义，落层应选 traffic.jsonl 而不是独立文件**；**第 4 组（单模型曲线）数据其实已经在 `/stats/daily` 里，只是前端没用、TS 没声明**；**第 1 组（五个本地应答）技术上最好移植，但 B 的 `/v1/messages` 恒流式、且命中后要不要记账必须先做产品决策**。

---

## 0. 结论速览

| 组 | 能力 | A | B 现状 | 移植难度 | 明确动作 |
|---|---|---|---|---|---|
| 1 | 五个本地应答（quota/prefix/title/suggestion/filepath） | ✅ 完整（`src/local-optimize.js` 446 行） | ❌ 无任何本地成型应答；只有 400/403/429 校验分支 | **低（纯函数可整文件照搬）**，但需要补流式帧渲染 + 记账决策 | 整文件搬 + 在 `routes/anthropic.js` 与 `routes/openai.js` 各插一个前置钩子 |
| 2 | 节省统计面板 | ✅ bytes 三态 + 6 计数 + percent/summary | ⚠️ 有完整 stats 管线，但没有「压缩」这件事 | 中（先要 RTK） | RTK 前置于上游；节省字段进 **traffic.jsonl**，走 stats-cache 桶，`BUCKET_VERSION 8→9` |
| 3 | Token 热力图（17 周） | ✅ 14 行算法 + 9 行 CSS + 40 项测试 | ❌ 无热力图；无图表基础件 | **低** | 后端 `days` 上限 90→180（1 行）；前端 ~150 行；色阶用 `--rg-brand-600` + `color-mix` |
| 4 | 总量曲线（总计/单模型） | ✅ 双维度切换（但有 2 个已知缺陷） | ⚠️ 双序列固定图，无双轴标注 | 低-中 | `byModel` 已在 `/stats/daily` 响应里，补 TS 类型即可；要 output 口径才需后端改 |

---

# 第 1 组：五个本地应答

## 1.1 A 全文精读

### 1.1.1 求值顺序与派发

```js
// src/local-optimize.js:26
export const OPTIMIZATIONS = ['quota', 'prefix', 'title', 'suggestion', 'filepath']
```

`firstAnswer(request, enabled)`（`src/local-optimize.js:382-389`）：

```js
for (const kind of OPTIMIZATIONS) {
  if (enabled?.[kind] === false) continue   // 只有显式 false 才跳过；缺省=开
  const answer = DETECTORS[kind](request)
  if (answer !== null) return { kind, ...answer }   // 首个命中即返回，不再看后面
}
return null
```

顺序理由（文件头注释 `src/local-optimize.js:21-25`）：quota 只需一个整数 + 一次子串判断，最先短路；需要分词命令行的是后三位。**`enabled` 的语义是「显式 false 才关」——`publicLocalOptimize` 也只写 `!== false`**（`index.js:2111-2116`）。

三个导出：`detectOptimization`（`:399`，只返回 kind）、`tryOptimizations`（`:413`，附带 model）、`toMessagesResponse`（`:432`，包成 Anthropic Messages 响应）。

### 1.1.2 四个共享读取器（移植时一并搬走）

| 函数 | 位置 | 语义 |
|---|---|---|
| `textOf(content)` | `:62-70` | string → 自身；数组 → **拼接所有 `typeof block.text === 'string' && block.text !== ''` 的块，块间无分隔符**（注释 `:56-61` 明确：分隔符会割断跨块的子串） |
| `systemText(request)` | `:73-83` | 顶层 `request.system` 的文本 + 每条 `role === 'system'` 消息的文本，`'\n'` 连接 |
| `singleUserTurn(request)` | `:91-99` | 遍历 messages 跳过 system；**必须恰好一个 user 消息，且没有任何 assistant / tool 消息**；否则返回 `undefined` |
| `hasTools(request)` | `:102-105` | Array → `length > 0`；否则 `Boolean(tools)` |

### 1.1.3 五个检测器：完整触发条件（逐条抄出）

#### ① quota — `quotaAnswer` `:307-315`

```js
const message = singleUserTurn(request); if (message === undefined) return null
const maxTokens = request?.max_tokens
if (!(maxTokens === 1 || maxTokens === '1')) return null        // 数值或数字字符串都收
if (!textOf(message.content).toLowerCase().includes('quota')) return null
return { text: 'Quota check passed.', usage: { input: 10, output: 5 } }
```

- 三个条件**全部**成立才命中：唯一 user 轮 + `max_tokens` 恰为 1 + 该轮文本小写含 `quota`。
- 反例（`scripts/local-optimize-test.mjs:66-67`）：`max_tokens:1024` 且文本含 quota → 不命中；文本 `we hit the quota, add a retry`（有实义）→ 不命中（因为无 `max_tokens:1`）。
- 返回固定 usage `{input:10, output:5}`。

#### ② prefix — `prefixAnswer` `:318-326`

```js
const message = singleUserTurn(request); if (message === undefined) return null
const content = textOf(message.content)
if (!content.includes('<policy_spec>') || !content.includes('Command:')) return null
const start = content.lastIndexOf('Command:') + 'Command:'.length   // ← lastIndexOf，不是 indexOf
return { text: extractCommandPrefix(content.slice(start).trim()), usage: { input: 100, output: 5 } }
```

- **`lastIndexOf`**：注释 `:323` 说明，policy spec 正文里可能自己引用 `Command:` 这个词。
- 只要求**唯一 user 轮**，不要求无 tools。
- 文本取自 `Command:` 之后到**整段末尾**（不截 `<`、不截空行）。

#### ③ title — `titleAnswer` `:329-338`

```js
if (hasTools(request)) return null                        // 有 tools 一律排除
const system = systemText(request).toLowerCase()
if (!system.includes('title')) return null
const sentenceCase = system.includes('sentence-case title')
const jsonField = system.includes('return json') && system.includes('field')
  && (system.includes('coding session') || system.includes('this session'))
if (!sentenceCase && !jsonField) return null
return { text: 'Conversation', usage: { input: 100, output: 5 } }
```

- **唯一看 system 的检测器**；不看 user 轮，可多轮。
- 两条**或**分支：`sentence-case title` 直命中；或三词共现（`return json` + `field` + `coding session`/`this session`）。

#### ④ suggestion — `suggestionAnswer` `:341-349`

```js
for (const message of request?.messages ?? []) {
  if (message?.role !== 'user') continue
  if (textOf(message.content).includes('[SUGGESTION MODE:')) return { text: '', usage: { input: 100, output: 1 } }
}
return null
```

- **唯一不要求单轮**的检测器：任意一条 user 消息带 `[SUGGESTION MODE:` 即命中。
- 严格含方括号（测试 `:205`：`SUGGESTION MODE without the bracket` → null）。
- 返回空文本（`:345` `text: ''`）+ `{input:100, output:1}`。

#### ⑤ filepath — `filepathAnswer` `:352-370`

```js
const message = singleUserTurn(request)
if (message === undefined || hasTools(request)) return null      // 单轮 + 无 tools
const content = textOf(message.content)
if (!content.includes('Command:') || !content.includes('Output:')) return null

const lower = content.toLowerCase()
const userNamesFilepaths = lower.includes('filepaths') || lower.includes('<filepaths>')
const system = systemText(request).toLowerCase()
const systemAsksForPaths = system.includes('extract any file paths')
  || system.includes('file paths that this command')
if (!userNamesFilepaths && !systemAsksForPaths) return null      // 两条或

const start = content.indexOf('Command:') + 'Command:'.length    // ← indexOf（与 prefix 相反）
const marker = content.indexOf('Output:', start)
if (marker === -1) return null
const command = content.slice(start, marker).trim()
const output = truncateOutput(content.slice(marker + 'Output:'.length).trim())
return { text: extractFilepathsFromCommand(command, output), usage: { input: 100, output: 10 } }
```

- 四个条件：单轮 & 无 tools；含 `Command:` 与 `Output:`；user 或 system 任一提及 filepaths；`Output:` 出现在 `Command:` 之后。
- **`indexOf('Command:')`（第一个）**，与 prefix 的 `lastIndexOf` 相反——这是最容易抄错的一行。
- `truncateOutput`（`:298-304`）：对 `'<'` 先切、再对 `'\n\n'` 切，各取第一段并 trim（顺序固定）。`output` 参数在 `extractFilepathsFromCommand` 里被显式忽略（`:246` `void output`，注释 `:239-243` 说明路径来自命令自身参数）。

### 1.1.4 `shellWords` 分词器 — `:122-169`

逐字符状态机（不调用任何 shell）：

| 状态 | 规则 | 行号 |
|---|---|---|
| 单引号内 | 除 `'` 外**全部字面**，`\` 无特殊含义 | `:128-132` |
| 双引号内 | `"` 结束；`\` **仅**对 `"` `\` `$` `` ` `` 转义（吞掉反斜杠），其它情况保留 `\` 字面 | `:133-147` |
| 引号外 `\` | 仅当后一字符 ∈ `ESCAPABLE`（空格/`\t`/`\n`/`\r`/`\f`/`\v`/`'`/`"`，`:108`）时转义；否则**保留 `\` 字面** → `type C:\notes\todo.md` 不被 `\n` 吃掉 | `:153-158` |
| 空白 | `' '` `\t` `\n` `\r` `\f` `\v` 分隔并 push 当前 word | `:159-162` |
| 收尾 | 未闭合引号 → `throw new Error('no closing quotation')`；有残留 word → push | `:166-167` |

细节：`word === null` 在进入引号或转义时被初始化为 `''`（`:150`、`:154`、`:163`），因此 `''`、`""` 会产出**空字符串 word**（不是被丢弃）。不处理 `#` 注释、不处理 `;` `&&` `|`（它们会成为普通 word 的一部分）。

**回退路径**（`extractCommandPrefix:203-208`）：分词抛错时不猜引号，改用 `text.split(/\s+/)` 去空串 + 去前导 env 赋值 + 取第一个；仍为空 → `'none'`。测试 `:471-477` 验证 `toMessagesResponse(tryOptimizations(prefixRequest))` 走的是这条回退。

### 1.1.5 命令注入检测 — `extractCommandPrefix` `:196-231`

```js
const text = typeof command === 'string' ? command : ''
if (text.includes('`') || text.includes('$(')) return 'command_injection_detected'   // :198 —— 最优先
```

- **先于分词**：只要出现反引号或 `$(` 就返回该字符串，不做任何前缀计算。测试 `:124` 覆盖。
- 注释理由（`:188-193`）：命令替换会执行第二条命令，而前缀只是权限对话框的标签，不是要执行的东西。
- 环境赋值：`isEnvAssignment`（`:172-174`，正则 `^[A-Za-z_][A-Za-z0-9_]*=[^\n]*$`，`:41`）。
- 前缀推导（`:211-231`）：
  1. 收集前导 env 赋值 `env[]`，`start` 指向命令首词；若**全是赋值** → `'none'`（`:218`）。
  2. `first ∈ TWO_WORD_COMMANDS` 且第二词存在且**不以 `-` 开头** → `"${first} ${second}"`。
  3. 第二词以 `-` 开头 → 只返回 `first`。
  4. 其余：`env.length === 0 ? first : \`${env.join(' ')} ${first}\``。
- **已固定的怪癖**（注释 `:227-229`）：单词语保 env 前缀（`FOO=1 ls` → `FOO=1 ls`），两词语丢 env（`FOO=1 git status` → `git status`）。抄的时候不要"顺手修正"，否则与 A 行为分叉。

### 1.1.6 `extractFilepathsFromCommand` 的命令分类 — `:245-283`

```js
const base = commandParts[0].split('/').pop().split('\\').pop().toLowerCase()   // :257 取 basename，兼容 C:\x\grep
if (LISTING_COMMANDS.has(base)) return EMPTY_FILEPATHS                          // :258
if (READING_COMMANDS.has(base)) return filepathBlock(commandParts.slice(1).filter(p => !p.startsWith('-')))  // :259-261
if (base !== 'grep') return EMPTY_FILEPATHS                                     // :262
```

- **先取 basename**：`/usr/bin/grep`、`C:\tools\cat.exe` 都能识别为 grep/cat。
- `LISTING_COMMANDS` 直接返回空块（列目录不读内容）。
- `READING_COMMANDS` 的**非 `-` 开头**参数即路径。
- 非 grep 的其它命令 → 空块。
- grep 分支（`:267-282`）：

```js
let patternViaFlag = false, positional = [], skipNext = false
for (const part of commandParts.slice(1)) {
  if (skipNext) { skipNext = false; continue }
  if (!part.startsWith('-')) { positional.push(part); continue }
  if (part === '-e' || part === '-f' || part === '--regexp') { patternViaFlag = true; skipNext = true }
  else if (part.startsWith('--regexp=')) { patternViaFlag = true }
  else if (GREP_FLAGS_WITH_ARGS.has(part)) { skipNext = true }
}
return filepathBlock(patternViaFlag ? positional : positional.slice(1))
```

  - `GREP_FLAGS_WITH_ARGS`（`:38`）= `{'-e','-f','-m','-A','-B','-C'}`。注意 `-e`/`-f` 已在上一分支命中，**该 Set 中的 `-e`/`-f` 是死条目**（保持与 Python 原实现一致，不要清理）。
  - `-m`（`--max-count`）、`-A`/`-B`/`-C`（上下文行）会**消费下一个 token**，因此不参与 positional。
  - `-i`/`-r`/`-n`/`-l` 等不吃参数，不设 `skipNext`。
  - `--regexp=pat` 走 `startsWith` 分支，**不设 skipNext、不入 positional**，正确。
  - 无 pattern flag 时，**第一个 positional 是 pattern**，其余才是路径（`slice(1)`）。

- `EMPTY_FILEPATHS`（`:44`）= `'<filepaths>\n</filepaths>'`；`filepathBlock`（`:286-288`）：空数组 → 空块，否则 `'<filepaths>\n' + paths.join('\n') + '\n</filepaths>'`。

### 1.1.7 三个集合（原文照抄）

```js
const TWO_WORD_COMMANDS = new Set(['git','npm','docker','kubectl','cargo','go','pip','yarn'])   // :29
const LISTING_COMMANDS  = new Set(['ls','dir','find','tree','pwd','cd','mkdir','rmdir','rm'])   // :32
const READING_COMMANDS  = new Set(['cat','head','tail','less','more','bat','type'])             // :35
const GREP_FLAGS_WITH_ARGS = new Set(['-e','-f','-m','-A','-B','-C'])                            // :38
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=[^\n]*$/                                        // :41
const ESCAPABLE = new Set([' ','\t','\n','\r','\f','\v',"'",'"'])                               // :108
```

`go`/`pip` 在 TWO_WORD 集合里意味着 `go build` → `go build`，而 `go -v` → `go`（第二词以 `-` 开头）。

### 1.1.8 响应包装与调用点

`toMessagesResponse`（`:432-446`）：

```js
id: typeof id === 'string' && id !== '' ? id : `msg_${randomUUID().replace(/-/g,'')}`,
type: 'message', role: 'assistant', model: model ?? result?.model ?? '',
content: [{ type: 'text', text: result?.text ?? '' }],
stop_reason: 'end_turn', stop_sequence: null,
usage: { input_tokens: ..., output_tokens: ... }
```

调用点 `src/forward.js:1111-1147`（`messagesEndpoint`）：

```js
const optimize = typeof options.optimize === 'function' ? options.optimize() : options.optimize
if (optimize !== null && optimize !== undefined && optimize.enabled === true) {   // :1126
  const local = tryOptimizations(body, { enabled: optimize, model })
  if (local !== null) {
    if (!wantsStream) { json(res, 200, toMessagesResponse(local, { model, id })); return }   // :1130-1132
    openStreamHeaders(res, options.heartbeatMs)
    const localState = newMessageState(id, model)
    for (const chunk of [
      { type: 'text-delta', text: local.text, index: 0 },
      { type: 'usage', usage: { inputTokens: ..., outputTokens: ... } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]) for (const frame of anthropicFrames(chunk, localState)) write(frame)      // :1139-1143
    res.end(); return
  }
}
```

**关键：本地应答路径完全不写 usage 记录。** 整个 `src/forward.js` 无 `recordUsage`/`recordTurn`（全文件 grep 为空）；A 的统计只由 dsh Harness 侧适配器写入（`src/adapter.js:400-402` → `savingsFields:769` → `src/store.js:377 accumulateSavings`）。因此 A 的五个本地应答**不会出现在它自己的 Token 看板里**。

开关侧：`index.js:2101-2122`（`OPTIMIZATION_KINDS = OPTIMIZATIONS`；`publicLocalOptimize` 输出 `{enabled, quota, prefix, title, suggestion, filepath}` 六个布尔；`optimizeConfig` 在 `enabled !== true` 时整体返回 `null`）；HTTP 路由 `GET/POST /local-optimize`（`index.js:1766-1772`）；前端面板在 `client.js:5068-5155`（`SaverPage` 内）与 `client.js:5070`（`Promise.all([api('/token-saver'), api('/local-optimize')])`）。

### 1.1.9 行为锁：测试提供的触发矩阵

`scripts/local-optimize-test.mjs`（485 行）是"触发条件"的权威回归集，移植时可直接改造成 B 的测试：

- `:52-62` quota 命中与两处反例；`:66-67` 反例。
- `:94-111` prefix：`FOO=1 git status` → `git status`；反例（只有 `Command:` 无 `<policy_spec>` / 只有 `<policy_spec>` 无 `Command:`）。
- `:124` 注入：反引号与 `$(`。
- `:136-164` title：`noBranch`（无 title）、`noTitle`。
- `:185-205` suggestion 与缺方括号反例。
- `:215-260` filepath：`cat src/local-optimize.js` → `<filepaths>\nsrc/local-optimize.js\n</filepaths>`；`git diff` → 空块；其它反例。
- `:278-287` **重叠请求**：一个请求同时满足 quota 与 prefix → 默认 quota，`{enabled:{quota:false}}` 后落到 prefix（验证顺序与开关都生效）。
- `:295-301` 每个 kind 的「开则中、关则不中」。
- `:309-316` 多轮/工具轮不误命中。
- `:327-328` `model` 归因（`options.model` 覆盖请求 model）。

## 1.2 B 的现状：确实没有任何本地短路应答

全仓检索 `quota|SUGGESTION MODE|sentence-case|filepaths|policy_spec|local-optimize|shortCircuit|synthetic` 共 61 处命中，**全部**属于账号额度（`src/credentials/pool.js:620-660`、`src/upstream/balance.js:281-328`）、错误分类（`src/upstream/errors.js:67-68`）与平台常量（`src/platform/variant.js:218-309`）。**请求侧成型应答为 0。**

逐条核对 B 的两个入口，所有提前返回都是失败分支：

| 文件 | 行号 | 提前返回的内容 | 性质 |
|---|---|---|---|
| `src/routes/openai.js` | `:166-168` | `messages is required` 400 | 校验 |
| | `:172-182` | 虚拟模型权限 403 `MODEL_ACCESS_DENIED` | 权限 |
| | `:221-230` | `canUseModel` 拒绝 403 | 权限 |
| | `:233-241` | `resolveModelForPlatform` 拒绝 400 | 校验 |
| | `:243-352` | WorkBuddy 直连分支 | **仍然调上游** |
| | `:436` / `:546` | 成功路径必调 `llmUtilsChat` / `wbChat.*` | 上游 |
| `src/model-router/index.js` | `:283-294` + `:317-318` | `checkContextLimit` 超窗 400 `context_length_exceeded` | 守门 |
| | `:338-350` | 无可用候选 400/429 `VIRTUAL_NO_CANDIDATE` | 失败 |
| `src/routes/anthropic.js` | `:74-81` | WB Key 拒绝 400 | 权限 |
| | `:83-94` | 非 Trae 模型 / 虚拟模型 403 | 权限 |
| | `:95-97` | `messages is required` 400 | 校验 |
| | `:152-153` | 成功路径必调 `llmUtilsChat` | 上游 |

**另有两处必须先处理的 B 侧事实：**

1. **`/v1/messages` 恒流式**：`src/routes/anthropic.js:82` 解构了 `stream = true`，但 `:112-115` **无条件**设置 `text/event-stream` 头并 `flushHeaders()`，此后 `stream` 变量再无使用。也就是说 B 目前**没有非流式 Messages 响应能力**（A 有，`src/forward.js:1130-1132`）。移植本地应答时，必须二选一：补非流式分支，或全部用 SSE 帧表达（见 1.3 的动作 (a)）。
2. **B 的 stats 唯一数据源是转发路径**：`logs/<date>/traffic.jsonl`（`src/log/traffic.js:57-100`），`/v1/admin/stats/daily|models|accounts` 全部由它聚合（`src/routes/admin-traffic.js:120-194`）。这与 A 相反（A 的转发路径不记账）。所以 B 一旦本地短路，**必须显式决定记不记账**，否则该请求在热力图/趋势/覆盖率里凭空消失。

## 1.3 移植清单：哪五个能直接搬、哪个要改、代价多少

前置结论：**A 的 `src/local-optimize.js` 是零依赖纯函数模块**（只 `import { randomUUID } from 'node:crypto'`，`:19`），B 是 CommonJS。搬运方式二选一：`src/local-optimize.js` 直接改成 `'use strict'` + `module.exports = {...}`（约 15 分钟），或保留 ESM 并用 `.mjs` + 动态 `import()`。**推荐前者**：B 全仓 CJS，混 ESM 会引入加载顺序问题。

| # | 检测器 | 可移植性 | 目标端点 | 触发条件是否需要改 | 代价 |
|---|---|---|---|---|---|
| 1 | **quota** | ✅ 直接搬 | `/v1/chat/completions` + `/v1/messages` | **不需要**。`max_tokens:1` + 唯一 user + 文本含 `quota` 与协议无关，通用 IDE/脚本也可能发 | ~0.5 h |
| 2 | **prefix** | ✅ 直接搬 | **仅 `/v1/messages`** | 不需要改代码，但**语义上只对 Claude Code 成立**（依赖 `<policy_spec>` + `Command:` 模板）。B 的 `/v1/messages` 收到的正是原始 Anthropic body（`routes/anthropic.js:82` 解构 `messages/system`，`:107` 才做 `anthropicToOpenAI`），所以在 `:107` **之前**调用即可 1:1 生效 | 0.5 h（+ 帧渲染） |
| 3 | **title** | ✅ 直接搬 | **仅 `/v1/messages`** | 不需要改。B 的 `system` 是顶层字段（`routes/anthropic.js:82`），`systemText` 读 `request.system` 与 `role==='system'` 消息都兼容；`textOf` 也兼容 Anthropic 的 block 数组 | 0.5 h |
| 4 | **suggestion** | ✅ 直接搬 | `/v1/messages`（`/v1/chat/completions` 可挂但永不触发） | 不需要改。`[SUGGESTION MODE:` 是 Claude Code 私有串，对通用 IDE/脚本**永远不会命中**（无害） | 0.25 h |
| 5 | **filepath** | ✅ 直接搬（`extractFilepathsFromCommand` 90 行 + `shellWords` 48 行） | **仅 `/v1/messages`** | 不需要改 | 1 h |

**必须新增的配套工作（这才是真正的成本）：**

**(a) 流式帧渲染（中，~0.5 天）** — A 在流式下复用 `anthropicFrames(chunk, state)` 生成 `text-delta`/`usage`/`finish`（`src/forward.js:1139-1143`）。B 的 `routes/anthropic.js:118` 已经**手工**写了 `message_start`，后续用 `exportAnthropic()` 的 emitters（`transform/emitters.js`，`:120`）。
两种落地方式：
- **方式 1（推荐，改动小）**：在 `:107` 之前判断，命中则**手工按 B 既有帧序**补齐 `content_block_start(index:0, content_block:{type:'text',text:''})` → N 个 `content_block_delta(text_delta)` → `content_block_stop` → `message_delta(delta:{stop_reason:'end_turn'}, usage:{input_tokens,output_tokens})` → `message_stop` → `res.end()`。需要照 `exportAnthropic` 的输出对齐字段名（读一次 `src/transform/emitters.js` 即可）。约 30-40 行。
- **方式 2（更省心但改动面大）**：给 `/v1/messages` 补非流式分支（`if (stream === false)`），命中本地应答时直接 `res.json(toMessagesResponse(...))`。这与 A 的行为一致，并顺手修掉 B「恒流式」这一既有缺陷。约 40-60 行 + 需要确认没有客户端依赖「永远 SSE」。

**(b) 开关（低-中）** — A 用 settings section + 五个独立开关 + 面板（`index.js:2101-2122`、`client.js:5068-5155`）。B 最小可用版本：`src/config.js` 加 `localAnswers`（`LOCAL_ANSWERS=off` 总开关 + `LOCAL_ANSWER_TITLE=off` 等五类），并在 `optimizeConfig` 等价物里组装成 `{enabled, quota, prefix, title, suggestion, filepath}`。想做到 A 那样有 UI 开关，需要动 `src/lib/settings-store.js` + 前端设置页（+0.5 天）。

**(c) 记账决策（中，1-2 h + 统计口径）** — **B 与 A 在这里必须分歧**：
- A 命中即 `return`，不写 usage（`src/forward.js:1128-1146`，全文件无记账调用）——所以在 A 里本地应答对看板不可见。
- B 的看板唯一数据源是 traffic.jsonl。**推荐显式记账并打标**：
  ```js
  logRequest({ endpoint: '/v1/messages', method: 'POST', model,
    status: 200, durationMs: Date.now() - startedAt,
    localAnswer: local.kind,            // 'quota' | 'prefix' | ...
    promptTokens: 0, completionTokens: 0, totalTokens: 0, tokensEstimated: true })
  ```
  配套：`src/log/stats.js` 的 `tokenSource`（`:137-141`）已把无 token 行判为 `'none'`，会污染"无 Token 请求"计数与计量覆盖率分母（`TokenStatsPage.tsx:299-301`、`:340-355`）。建议在 `dailyStats`（`:152-182`）与 `buildDayBucket`（`stats-cache.js:82-124`）各加一个 `local` 计数并在前端口径卡里单列，避免把"本地应答"读成"上游没回 usage"。
- **绝对不要照搬 A 的假 usage**（`{input:10,output:5}` 等）：B 有 `src/lib/token-precise.js` 与 `src/models/rates.js:estimateCost`，写假 token 会污染标定与账单对照（`src/models/pricing-calib.js` 的回归样本直接从 traffic 来）。本地应答写 0 并打标 `localAnswer` 更安全。

**(d) 不适用的部分** — A 的 `quota` 固定答复文本 `'Quota check passed.'`、`title` 的 `'Conversation'` 都是给 Claude Code 消费的常量，原样保留即可；B 若面向中文用户，也不要翻译——这些是协议契约文本，不是 UI 文案。

**总代价估计**：`src/local-optimize.js` 搬运 + 测试移植 0.5 天；`routes/anthropic.js` 钩子 + 帧渲染 0.5 天；`routes/openai.js` 只挂 quota（0.5 h）；开关与记账 0.5 天。**合计约 1.5-2 人日**，其中约 60% 是「B 没有的东西」（帧渲染 + 记账口径）。

---

# 第 2 组：节省统计面板

## 2.1 A 的实现链（四段）

### 2.1.1 管道返回结构 — `src/token-saver/index.js:69-102`

```js
export function applyTokenSavers(payload, wire, config) {
  const report = { prompt: null, rtk: null, saved: 0, bytesBefore: 0, bytesAfter: 0, notes: [] }   // :70
  if (config?.enabled === false || payload === null || typeof payload !== 'object') return report
  // ① 提示词瘦身（唯一能减 output 的 saver）
  if (config.caveman !== 'off' || config.ponytail !== 'off') { ... report.prompt = { injected, reason, families:['id:level'] } ... }  // :76-88
  // ② RTK 工具输出压缩
  if (config.rtk !== false) {
    const result = compressRequest(payload, wire, true)
    report.rtk = result.stats
    report.saved = Number(result.stats?.saved) || 0
    report.bytesBefore = Number(result.stats?.bytesBefore) || 0
    report.bytesAfter = Number(result.stats?.bytesAfter) || 0
  }                                                     // :90-100
  return report
}
```

- 顺序：**prompt 先、RTK 后**（注释 `:73-75`：这样报出的字节数是真正上路的 payload）。
- **fail-open**：任一段 throw 只往 `notes[]` 推一条 `prompt-failed:`/`rtk-failed:`（`:85-87`、`:97-99`）。
- 默认值（`saverConfig:42-53`）：总开关 `!== false`，**RTK 默认开**，两个 prompt 家族默认 `off`。
- `notes` 是字符串数组，用于面板/日志解释「为什么没生效」。

### 2.1.2 RTK stats 的形状与不变量 — `src/token-saver/rtk/index.js:258-278`

```js
const stats = { enabled, bytesBefore: 0, bytesAfter: 0, saved: 0, hits: [] }   // :260
...
stats.saved = stats.bytesBefore - stats.bytesAfter                             // :276
```

- **口径**：`bytesBefore`/`bytesAfter` **只统计被考虑过的工具输出文本**，不是整个请求体（注释 `:248-251`）。
- **不变量**：`bytesBefore - bytesAfter === saved === sum(hits[].saved)`；异常路径也会记账把书做平（`:270-274`）。
- `hits[] = { shape, filter, saved }`（`:214`）；`shape` 是 wire 形状标签，`filter` 是 12 个具名过滤器之一（`rtk/constants.js:129-142`）。
- 尺寸闸门（`:194-197`）：`bytesIn < MIN_COMPRESS_SIZE(500)` 或 `> RAW_CAP(10MiB)` 直接放过；替换结果必须**非空且严格更小**（`:208-211`）。
- 三个 wire 走三套 walker（`:281-341`）：`chat` 只看 `role==='tool'`；`messages` 只看 `content[].type==='tool_result'` 且 **`is_error === true` 跳过**（`:310`）；`responses` 只看 `input[].type==='function_call_output'`。
- 13 个过滤器文件共 ~36 KB（`src/token-saver/rtk/filters/`），自动识别顺序在 `rtk/autodetect.js:56-117`（顺序不可交换，注释 `:6-24`）。

### 2.1.3 生命周期聚合 — `src/token-saver/index.js:105-151`

```js
export function emptySavings() { return { bytesBefore:0, bytesAfter:0, saved:0, blocks:0, calls:0, promptCalls:0 } }   // :105-107

export function addSavings(total, report) {          // :117-128
  const blocks = Array.isArray(report?.rtk?.hits) ? report.rtk.hits.length : 0
  return {
    bytesBefore: base.bytesBefore + (Number(report?.bytesBefore) || 0),
    bytesAfter:  base.bytesAfter  + (Number(report?.bytesAfter)  || 0),
    saved:       base.saved       + (Number(report?.saved)       || 0),
    blocks:      base.blocks + blocks,
    calls:       base.calls + 1,                                        // 每次都 +1，含没压掉东西的
    promptCalls: base.promptCalls + (report?.prompt?.injected === true ? 1 : 0),
  }
}

export function savingsPercent(total) {              // :131-136 —— before<=0 → 0；Math.round
  if (before <= 0) return 0; return Math.round((saved / before) * 100)
}
export function describeSavingsTotal(total) {        // :139-144
  if (safe.calls === 0) return 'token saver: no requests measured yet'
  return `token saver: ${formatBytes(safe.saved)} saved over ${safe.calls} request(s) (${percent}%), ${safe.blocks} block(s) compacted`
}
```

`calls` 的语义被注释明确锁死（`:109-116`）：「400 次调用省 0 字节」与「0 次调用省 0 字节」是两件事。

### 2.1.4 持久化与聚合 — `src/store.js:377-395`、`src/core/stats.js:71,86`

- 每请求一条样本：`savingsSample`（`store.js:391-395`）**只在 `saved > 0` 时**写 `{saved, savedPrompt?}`；样本上限 400 条（`:351`）。
- 生命周期累加：`accumulateSavings`（`store.js:377-388`）——注意它**自己 `calls: +1`**，与 `addSavings:121` 是同一条规则的两次实现（一个有 report 一个有 savings 记录）。
- 默认形状写在状态文件里，老 stats 文件下次调用即获得该字段（`store.js:252` 默认值、`:476-480` 迁移）。
- 出站字段：`adapter.js:769-786 savingsFields(report)` —— **`saved === 0 && !promptInjected` 时返回 `{}`**（不写空对象）；`bytesAfter` 被显式携带而不事后推算（注释 `:778-781`：面板展示「before → after」，若 after 为 0 会被读成"body 变空了"）。
- `buildStats`（`src/core/stats.js:4-98`）：
  - `:71` `const savings = { ...emptySavings(), ...(stats.savings ?? {}) }` —— **用空形状兜底**，缺失字段不会变 `undefined`。
  - `:86` `savings: { ...savings, percent: savingsPercent(savings), summary: describeSavingsTotal(savings) }` —— percent/summary **在这里算且只在这里算**（注释 `:83-85`：面板不该用两个各自取整的数字推比率）。
- 暴露给前端：`index.js:1172` `get: () => ({ ...publicTokenSaver(settings.get().tokenSaver), savings: buildStats(stats.get(), state().catalog).savings })`。

### 2.1.5 面板组件 — `client.js:5040-5156`

- `SavingsMeter(props)`（`:5042-5057`）：`useState(0)` + `useEffect` 中 `setTimeout(..., 60)` 把宽度从 0 动画到 `clamp(percent,0,100)`（注释 `:5040-5041`：让数字读起来像测量而不是装饰）；`role="progressbar"` + `aria-valuenow/min/max`（`:5054-5055`）。
- `SaverPage`（`:5068` 起）：`usePanel(() => Promise.all([api('/token-saver'), api('/local-optimize')]))`（`:5070`）；两个 `save*` 函数都走「POST 后渲染 host 的答复」（`:5088-5099`），且 POST 答复不含测量值，因此 `panel.patch` 时**保留旧的 `current.saver?.savings`**（`:5092`）。dashboard 区：6 个 `stat`（bytesBefore/After/saved/blocks/calls/promptCalls，`:5128-5133`）+ `SavingsMeter`（仅 `bytesBefore > 0`，`:5134-5136`）+ `summary` 一行（`:5137-5139`）。
- CSS 类：`.ofm_meter`（`client.js` 内嵌样式表）。

## 2.2 B 的现状：字段结构与口径

### 2.2.1 `src/log/traffic.js`（150 行）

- `logRequest(entry)`（`:57-105`）：`base = { ts, seq, tag:'traffic', ...entry }`（`:60-65`）→ 缺 `estimatedCost` 时按费率补（`:67-75`）→ `sanitize(base)`（`:76`）→ 同步 `fs.appendFileSync(logs/<YYYY-MM-DD>/traffic.jsonl)`（`:88`）→ `require('./stats-cache').invalidateDay()`（`:91`）→ 可选旧格式逐文件（`:95-98`）。
- `sanitize(obj, depth)`（`:32-51`）：**数字/布尔/null 原样保留**（`:40`），键名匹配 `/authorization|token|password|secret|api[_-]?key/i` 的**字符串**值被 `maskSecret`（`:42-43`）；深度 > 3 截断。
  - **新增节省字段的约束**：键名不要含 `token`，且值写成**数字**，否则会被脱敏成 `***`（这正是 `stats.js:43-64` 那段历史血案的成因）。
- `usageToLogFields(u)`（`:117-132`）：归一蛇形/驼峰，抽出 `cacheReadTokens`（`Math.min(cr, pt)`，`:127`）与 `cacheWriteTokens`；**全 0 时返回 `{}`**（`:122`，让统计层记「未计量」而不是「0」）。
- 日志行没有「节省/压缩」相关字段。

### 2.2.2 `src/log/stats.js`（278 行）

- `readTrafficLines(days)`（`:14-35`）：逐日 `logs/<UTC 日>/traffic.jsonl` 全量读，标 `r._day`，单日内 `reverse()`。
- 计量口径三分类（这是 B 的核心资产，移植/新增字段必须复用）：
  - `isMetered`（`:43-45`）数值判定；`numTok`（`:60-64`）区分 `number`/纯数字字符串/`***`；`isMasked`（`:67-69`）。
  - `tokenSource`（`:137-141`）：`tokensEstimated===true → 'estimated'`；`isMetered → 'exact'`；否则 `'none'`。
  - `costOf`（`:117-126`）：一律按当前标定重算，返回 `{cost, priced, upperBound}`。
- `dailyStats`（`:152-201`）每日桶字段：`{date, requests, errors, tokens, metered, exact, estimated, none, tokensLost, priced, costUpper, estimatedCost, cacheReadTokens, byModel}`；`byModel[m] = {requests, tokens, metered, unmetered(= requests − metered，末映射), estimatedCost}`（`:176-181` 构建、`:196-199` 输出）。
- `modelStats`（`:208-246`）：窗口聚合，**无 date 维度**；字段 `{model, requests, errors, tokens, metered, unmetered, estimated, promptTokens, completionTokens, cacheReadTokens, estimatedCost, avgDurationMs, toolCalls}`。
- `accountStats`（`:249-273`）：`{accountId, requests, errors, tokens, metered, unmetered, estimatedCost, errorRate, tokenShare}`。

### 2.2.3 `src/log/stats-cache.js`（267 行）

- `BUCKET_VERSION = 8`（`:39`），版本注释 `:32-38` 记录了 v3→v8 每次口径变更——**任何新增字段都必须递增并在此登记**。
- `buildDayBucket(rows, dateKey)`（`:82-124`）：桶字段 `{date, requests, errors, tokens, metered, exact, estimated, none, tokensLost, priced, costUpper, estimatedCost, cacheReadTokens, durationSumMs, durationCount, toolCalls, byModel, byAccount}`；`byModel[m] = {requests, tokens, metered, cost, cacheReadTokens}`（`:114-115`）；`byAccount[a] = {requests, errors, tokens, metered, cost}`（`:117-121`）。
- `getBuckets(days)`（`:127-149`）：命中 `readCache` 直接用；未命中读文件 → `buildDayBucket` → `writeCache`；**文件不存在时写 `null` 占位**（`:137`）。
- 三个 `cached*` 函数签名与输出结构统一到 `stats.js`（`:152-245`），前端零改动可切换。
- **已存在的口径缺口（本次要顺手记下）**：`cachedModelStats`（`:185-218`）初始化 `promptTokens: 0, completionTokens: 0`（`:189`）后**从不累加**，输出恒为 0（`:210-211`）；`errors` 恒为 0（`:191-192` 注释自认近似）；`avgDurationMs` 按请求数比例摊（`:197-199`）。而 `STATS_CACHE` 默认是开的（`routes/admin-traffic.js:23` `process.env.STATS_CACHE !== 'off'`），所以 `/stats/models` 默认走的就是这个近似版本。

### 2.2.4 `web/src/features/stats/TokenStatsPage.tsx`（809 行）口径卡片区

- `CaliberCard`（`:43-95`）：三态 `caliber: 'exact' | 'estimate' | 'metered'`（`:55`）映射到三个色（`:61-66`）：
  - `exact` → `var(--rg-brand-600)`；`metered` → `var(--rg-text-primary)`；`estimate` → `var(--rg-text-tertiary)`。
  - 卡片右上角一个 6px 圆点复用同一 `accent`（`:76-80`）；`loading` 时主读数显示 `—` 而不是 `0`（注释 `:56`，实现 `:84`）。
- `CaliberRow`（`:98-113`）：卡片底部的拆解行，`tone: 'warn' | 'muted'`，值用 `font-mono tabular-nums`。
- 卡片区布局（`:262-356`）四卡一行：**官方账单积分**（exact，`:264-287`）、**Token 总量**（metered，`:290-316`）、**换算比**（exact，`:319-337`）、**计量覆盖率**（metered，`:340-355`）。
- 「Token 总量」卡的口径纪律（`:297-301`）：明确写「以下三行是**请求数**而非 Token 数，单位必须写明」——exact/estimated/none 三次。
- 缓存读占比（`:302-307`）、脱敏丢失行数（`:308-314`，warn）。
- 页脚统一声明（`:803-805`）：「带 * 的估算成本是网关推算值，仅供对照，官方账单与估算不可相加。」

## 2.3 对比：B 引入 RTK 压缩后，节省数据应该落在哪一层

### 结论（明确）：**落在 `traffic.jsonl` 的每请求行上，用 stats-cache 桶聚合；不要另开独立文件。**

理由（三条，都可从代码推出）：

1. **B 已经有「每请求一行 + 每日桶缓存」这套结构**，且 `stats-cache.js:11-13` 的注释明确写着产物结构统一到 `stats.js`、`admin-extras 可零改动接入`。节省是**请求级属性**（同一次请求压缩了多少字节），天然属于这行；独立文件会立刻引出"独立文件与 traffic.jsonl 如何对账/如何按日窗口裁剪/如何失效"三个新问题，而这三个问题 stats-cache 已经解决。
2. **`invalidateDay()` 已挂在写入路径上**（`traffic.js:91`），新增字段自动获得正确的缓存失效语义；独立文件需要自己再造一套失效逻辑。
3. **A 的做法就是每请求携带、生命周期累加**（`adapter.js:769-786` 出站字段 → `store.js:377-388` 累加），B 的等价物是「行内字段 → 桶内累加 → 输出字段」，映射是 1:1 的。

### 具体方案（可直接实施）

**步骤 1：writer 侧（`src/log/traffic.js`）**

在 RTK 压缩发生的调用点（见步骤 0）把测量值塞进 `logRequest` 的 entry：

```js
logRequest({
  ...,
  // 键名避开 /token/i，值必须是 number（traffic.js:40-43 的脱敏规则）
  rtkBytesBefore: stats.bytesBefore,
  rtkBytesAfter:  stats.bytesAfter,
  rtkSavedBytes:  stats.saved,
  rtkBlocks:      stats.hits.length,
  rtkFilters:     Array.from(new Set(stats.hits.map(h => h.filter))).join(','),  // 字符串，不会被脱敏
  promptInjected: promptInjected === true,   // boolean，原样保留（traffic.js:40）
})
```

**步骤 2：聚合侧（`src/log/stats.js`）**

`dailyStats`（`:156-160` 的桶初始化 + `:161-182` 的累加）新增：

```js
// 桶初始化
rtkCalls: 0, rtkBlocks: 0, rtkSavedBytes: 0, rtkBytesBefore: 0, rtkBytesAfter: 0, promptCalls: 0,
// 累加
if (numTok(r.rtkBytesBefore) != null) {              // 有测量才算一次「跑过压缩的调用」
  d.rtkCalls++
  d.rtkBlocks += Number(r.rtkBlocks) || 0
  d.rtkSavedBytes += Number(r.rtkSavedBytes) || 0
  d.rtkBytesBefore += Number(r.rtkBytesBefore) || 0
  d.rtkBytesAfter += Number(r.rtkBytesAfter) || 0
}
if (r.promptInjected === true) d.promptCalls++
```

输出映射（`:185-200`）加同名字段 + 一个派生率：

```js
rtkSavedBytes: round2(d.rtkSavedBytes),
rtkPercent: d.rtkBytesBefore > 0 ? Math.round((d.rtkSavedBytes / d.rtkBytesBefore) * 100) : 0,
```

**关键口径决策（与 A 一致）**：`rtkCalls` 计「压缩管道跑过的调用数」而不是「有命中的调用数」，与 A 的 `addSavings:125` 注释同一理由。

**步骤 3：缓存侧（`src/log/stats-cache.js`）**

- `buildDayBucket`（`:82-124`）桶字段加同一组键（`:87` 一行 + `:111-115` 附近累加）。
- `cachedDailyStats`（`:155-181`）输出加同名字段。
- **`BUCKET_VERSION` `8 → 9`**（`:39`），并在 `:32-38` 的版本注释追加一行：`9 补 RTK 节省字节（rtkBytesBefore/After/Saved/Blocks/Calls、promptCalls）`。
- 兼容性：`readCache`（`:59-71`）在 `raw.version !== BUCKET_VERSION` 时返回 `null` → 旧桶被自动丢弃并在下次请求时重建。**零迁移代码**，代价只是首个面板请求要重扫近 N 天 jsonl。
- 若不想让历史桶重建（担心首请求延迟），可在 `cachedDailyStats` 输出时对缺失字段用 `?? 0` 兜底——但**不建议**，因为「历史没有测量」和「历史省了 0 字节」是两件事（同一理由见 `stats.js:128-141`）。建议保留版本递增的严格语义，必要时在 UI 上对 `rtkCalls === 0` 的日期显示「未测量」。

**步骤 4：API 与前端**

- `routes/admin-traffic.js:120-156` 的 `/stats/daily` 直接透传 `data`（无需改），但**要加 `savings` 汇总**（对齐 A 的 `buildStats:86` 把 percent/summary 放在服务端算的口径）：
  ```js
  const savings = data.reduce((s, d) => ({
    bytesBefore: s.bytesBefore + (d.rtkBytesBefore ?? 0),
    bytesAfter:  s.bytesAfter  + (d.rtkBytesAfter  ?? 0),
    saved:       s.saved       + (d.rtkSavedBytes ?? 0),
    blocks:      s.blocks      + (d.rtkBlocks     ?? 0),
    calls:       s.calls       + (d.rtkCalls      ?? 0),
    promptCalls: s.promptCalls + (d.promptCalls   ?? 0),
  }), { bytesBefore:0, bytesAfter:0, saved:0, blocks:0, calls:0, promptCalls:0 })
  savings.percent = savings.bytesBefore > 0 ? Math.round((savings.saved / savings.bytesBefore) * 100) : 0
  res.json({ object:'list', days, totalRequests, data, official, savings, cached: ... })
  ```
- `web/src/shared/api/stats.ts:11-41` 的 `DailyStat` 加可选字段，`getStatsDaily` 返回类型加 `savings`。
- `TokenStatsPage.tsx`：新增第 5 张 `CaliberCard`（caliber 用 `'metered'`，因为这是**测量值不是账单值**），底部 `CaliberRow` 放 blocks/calls/promptCalls；卡片数从 4 变 5 时 `grid-cols-2 xl:grid-cols-4`（`:262`）需要改成 `xl:grid-cols-5` 或拆两行。
- `SavingsMeter` 的移植要点（`client.js:5042-5057`）：B 有现成的 `ProgressBar`（`web/src/shared/ui/index.tsx:418-433`，支持 `tone: 'brand'|'soft'|'warn'|'danger'`），直接 `<ProgressBar ratio={percent/100} tone="brand" />` 即可，**不需要搬 A 的 60ms 生长动画**（B 的全局样式有 `prefers-reduced-motion` 处理，`global.css:592-595`；若要做动画，用 `transition: width .3s` 而不是 setTimeout）。

**步骤 0（前提，不在本组但必须知道）**：B 目前**没有 RTK**。B 的规范化消息形态与 A 的 `chat` wire walker **完全兼容**：
`src/transform/request.js:37-41` 把 tool 结果写成 `{role:'tool', tool_call_id, content:[{type:'text', text}]}`，而 A 的 `compressChatPayload`（`rtk/index.js:289-298`）正是处理 `role==='tool'` + `content[].type==='text'`（shape 标签 `'openai-tool-array'`）。且 `/v1/messages` 的 `tool_result` 也在 `routes/anthropic.js:57` 先转成 `role:'tool'`，因此**一套 walker 覆盖 B 的全部三个入口**。
两点必须补的差异：
1. **`is_error` 在转换中丢失**：`routes/anthropic.js:57` 与 `transform/request.js:37-41` 都没保留 Anthropic 的 `is_error`，而 A 的 messages walker 靠它跳过错误轨迹（`rtk/index.js:310`，注释 `:16-19` 说明跳过错误的理由）。**移植 RTK 前必须先把 `is_error` 透传下来**，否则会压缩错误输出、诱发模型重试同样的调用。
2. **`compressText` 的字节口径是 `text.length`（UTF-16 码元，`rtk/index.js:191`）**，而 B 的统计到处用 `round2` 且展示为「B/KB」。中文工具输出下 `length` 与 UTF-8 字节数差 2-3 倍。**必须统一**：要么改为 `Buffer.byteLength(text,'utf8')`，要么把展示单位从「B」改成「字符」。否则"省了 1.2 MB"是假的。
   - 若改为字节数，A 的阈值 `MIN_COMPRESS_SIZE=500`/`RAW_CAP=10MiB`（`rtk/constants.js:23-32`）需要同步按字节理解（对 ASCII 无差异，对中文更早触发，属于可接受变化，但要在 `BUCKET_VERSION` 注释与 CHANGELOG 里写清）。

**为什么不用独立文件（反例记录）**：如果落在 `logs/<date>/savings.jsonl`，需要自己实现 ①按日窗口裁剪（`stats-cache.js:47-53` 已有一份）、②写入即失效（`traffic.js:91` 已有一份）、③与请求行的关联键（`seq` 或 requestId，traffic 行有 `seq`（`traffic.js:59`）但跨日会重排，需要额外做 join）。三件都是已解决问题，收益为零。

---

# 第 3 组：Token 热力图（17 周）

## 3.1 A 的实现（逐行）

### 3.1.1 `Heatmap` 组件 — `client.js:2545-2561`

```js
function Heatmap(props) {
  const { days, t } = props
  const cells = useMemo(() => buildHeatCells(days), [days])                    // :2547
  const peak = cells.reduce((max, cell) => Math.max(max, cell.total), 0)       // :2548
  if (cells.length === 0) return h('p', { className: 'ofm_note' }, t('heat.empty'))   // :2549
  const level = value => value === 0 ? ''                                      // :2550
    : peak === 0 ? ''
    : value / peak > 0.66 ? 'l4'
    : value / peak > 0.4  ? 'l3'
    : value / peak > 0.16 ? 'l2' : 'l1'
  return h(Fragment, null,
    h('div', { className: 'ofm_heat', role: 'img', 'aria-label': t('heat.title') },   // :2552
      cells.map((cell, index) => h('div', {
        key: `${cell.day}-${index}`,
        className: 'ofm_cell ' + level(cell.total),
        title: `${cell.day} · ${cell.total.toLocaleString()} tokens`
             + (cell.models.length ? ` · ${cell.models.join(', ')}` : ''),          // :2556
      }))),
    h('div', { className: 'ofm_scale' }, t('heat.legend'),
      ['l1','l2','l3','l4'].map(cls => h('span', { key: cls, className: `ofm_cell ${cls}` })),
      t('heat.legendMore')))                                                     // :2558-2560
}
```

- **色阶是相对峰值四档**（0.66/0.4/0.16 三个阈值），不是绝对值分位。
- `value === 0` 与 `peak === 0` 都返回**空 className**（即最低/无档），这是「零值 vs 无记录」呈现相同、靠 tooltip 区分的实现。
- **悬浮提示是原生 `title` 属性**（`:2556`），格式：`2026-10-04 · 200 tokens · model-a, model-b`（测试 `heatmap-test.mjs:96` 逐字符断言）。
- `key` 用 `${day}-${index}`（`:2554`）而不是 `${day}`——因为 cells 全程唯一，用 index 只是为了稳定。
- 图例：`label = t('heat.legend')`（中「少」/ 英 "Less"）+ 四格 + `t('heat.legendMore')`（「多」/ "More"）（`client.js:142-145`、`754-757`）。
- 空态文案：`'还没有用量记录。用一次对话后回来看看。'`（`client.js:145`）。

### 3.1.2 `buildHeatCells(days, span = 119)` — `client.js:2564-2579`（核心算法，14 行）

```js
function buildHeatCells(days, span = 119) {
  if (days.length === 0) return []                                   // :2565 ← issue-30 的修复点
  const byDay = new Map(days.map(row => [row.day, row]))             // :2566
  const end = new Date()
  end.setHours(12, 0, 0, 0)                                          // :2569 ← 本地正午锚点
  const cells = []
  const start = new Date(end)
  start.setDate(start.getDate() - end.getDay() - (Math.ceil(span / 7) - 1) * 7)   // :2572
  for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {   // :2573
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth()+1).padStart(2,'0')}-${String(cursor.getDate()).padStart(2,'0')}`
    const row = byDay.get(key)
    cells.push({ day: key, total: row?.total ?? 0,
                 models: (row?.models ?? []).filter(m => m.output > 0).map(m => m.model) })   // :2576
  }
  return cells
}
```

逐条对应到题目要求：

| 要求 | A 的做法 | 行号 |
|---|---|---|
| 列优先周对齐 | CSS `grid-auto-flow: column` + `grid-template-rows: repeat(7, 12px)`；数组按**日期升序**排列，第一列必然是 Sunday | `client.js:1336`（CSS）+ `:2573`（升序生成） |
| 本地日历锚点 | 用 `getFullYear/getMonth/getDate`（本地）生成 key，与存储的 `dayKey` 一致；`setDate` 是本地日历运算（不是 ms 加减） | `:2574`、`:2573` |
| 起点对齐 | `start = 本周周日 − (17−1)×7 天`，即先定当前周周日再回退 16 周 → **恒 17 列** | `:2572` |
| 不生成未来日期 | 循环条件 `cursor <= end`，`end` 是今天 | `:2573` |
| 跨年 / 闰日 | 靠 `Date.setDate` 的重量级进位（`2 月 29 日`、`12 月 31 日 +1` 都正确） | `:2573` |
| 夏令时 | `end.setHours(12,0,0,0)` 用**正午**做锚点：即使某天只有 23 小时，`setDate(+1)` 也不会跳到次日 01:00 而漏掉最后一天 | `:2568-2569`（注释原文）+ `docs/issue-30-heatmap.md:22` |
| 零值 vs 无记录 | `row?.total ?? 0`：**没有该日记录 → total 0 且不出现在 byDay**；有记录但 token 为 0 → total 0 但 models 可能非空。**两者 cell 相同**，但 `buildHeatCells([]) === []` 使「完全无数据」走空态分支（`:2549`），而「有记录但 0 token」仍渲染日历（测试 `heatmap-test.mjs:83-89`） | `:2576`、`:2565`、`:2549` |
| 四档色阶 | `>0.66 → l4`、`>0.4 → l3`、`>0.16 → l2`、其余 `l1`，`0` 无档 | `:2550` |
| 悬浮提示 | 原生 `title`：`日期 · N tokens · 模型列表`（模型经 `output > 0` 过滤） | `:2556`、`:2576` |

cells 数量：`span=119` → `Math.ceil(119/7)=17`；`start` 是周日，`end` 是今天 → 格数 `= 113 + end.getDay()`，落在 **113（周日）~119（周六）**，`Math.ceil(cells.length/7) === 17` 恒成立（测试 `heatmap-test.mjs:48-49` 断言）。

### 3.1.3 CSS — `client.js:1336-1344`

```css
.ofm_heat{display:grid;grid-auto-flow:column;grid-auto-columns:12px;grid-template-rows:repeat(7,12px);justify-content:start;gap:2px;overflow-x:auto;padding:2px 0 6px}
.ofm_cell{width:12px;height:12px;border-radius:3.5px;background:var(--dsw-alias-bg-layer-1);
          outline:1px solid var(--dsw-alias-border-l1);outline-offset:-1px;
          transition:transform .14s ease,background .3s ease}
.ofm_cell:hover{transform:scale(1.25)}
.ofm_cell.l1{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 24%,transparent);outline-color:transparent}
.ofm_cell.l2{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);outline-color:transparent}
.ofm_cell.l3{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 68%,transparent);outline-color:transparent}
.ofm_cell.l4{background:var(--dsw-alias-state-business-primary);outline-color:transparent}
.ofm_scale{display:flex;align-items:center;gap:4px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-left:auto}
.ofm_scale .ofm_cell{width:10px;height:10px}
```

要点：`justify-content:start` + 固定 `grid-auto-columns:12px`（`docs/issue-30-heatmap.md:14-18` 解释：不写的话 `auto` 轨道会吃掉剩余宽度，560px 面板里每列多出约 19px 空白，格子仍 12px，观感是"被横向拉开"）；`outline-offset:-1px` 让描边画在内侧不撑大格子；四档用 `color-mix` 由**同一个**主题变量派生（A 用的是 DSH 宿主 token `--dsw-alias-*`）。

### 3.1.4 布局决策 — `docs/issue-30-heatmap.md` 全文要点

- 目标与约束（`:3-10`）：使用现有 12px 格子/主题变量/四档色阶/悬浮提示；保持 README 承诺的 17 周；每列从周日开始、到今天结束、不生成未来日期；本机日历与 `dayKey` 一致；跨月跨年 DST 不丢日期；无记录显示空态，**已记录的零 token 日期仍显示日历**；不加依赖/网络/存储。
- 证据与选择（`:12-25`）：`auto` 列宽拉伸（`:14-15`）→ 同时固定 12px 行列并保留窄容器横向滚动（`:17-18`）；原日期表达式不能稳定从周日开始（`:20-22`）→ 先定周日再回退 16 周，共 17 列 113-119 个日期、本地 `setDate` 递增、本地中午锚点避免午夜 DST 漏最后一天；`buildHeatCells([])` 原本仍生成零值格子使空态分支不可达（`:24-25`）→ 改为返回空数组，且不把零 token 记录误判为无记录。
- 验证（`:27-37`）：`scripts/heatmap-test.mjs` 通过**真实客户端测试接缝**覆盖一周七天、跨年、闰日、上海/纽约时区、夏令时、连续日期、数据投影、空态、零值记录、悬浮提示；临时 Chromium 复现页检查格子间距与窄容器滚动；本次 40 项检查通过；签名清单因 `client.js` 摘要变化失败（未配 `OFM_MANIFEST_KEY`），发布签署待维护者。

### 3.1.5 测试矩阵 — `scripts/heatmap-test.mjs`（99 行）

加载方式（移植参考）：用 `new Function('window','Date', source)` 把真实 `client.js` 注入，`Date` 用 `ClockDate extends Date` 覆写「无参构造返回固定 `today`」（`:6-21`），再从 `bundle.factory(...).__test` 取 `buildHeatCells`/`Heatmap`（`:22-25`）。这就是 `docs/issue-30-heatmap.md:29` 说的"真实客户端测试接缝"。

| # | 测试 | 行号 | 断言要点 |
|---|---|---|---|
| 1 | 时区 × 结束日矩阵 | `:41-64` | 3 时区（Asia/Shanghai、America/New_York、America/Sao_Paulo）× 12 个结束日（含 `2026-10-04..10-10` 覆盖一周七天、`2027-01-01` 跨年、`2028-03-01` 闰年（2/29 在窗口内）、`2026-03-08` 与 `2026-11-01` 美国 DST 切换日、`2018-11-05` 巴西 DST）。逐项断言：`cells.length === 113 + end.getDay()`、`Math.ceil(len/7) === 17`、`localDate(cells[0].day).getDay() === 0`、`cells.at(-1).day === endKey`、日期集合无重复、逐日连续（用 `expected.setDate(+1)` 对拍）、末日 `total === 200` 且 `models === ['model-a','model-b']`、其余全 0 |
| 2 | 稀疏数据投影 | `:66-74` | 窗口外记录（`2026-06-13`）被丢弃；`cells[0].day === '2026-06-14'`（被丢弃日的次日成为窗口首日）；缺失日填 0；总和 250 |
| 3 | 空态 | `:76-81` | `buildHeatCells([]) → []`；`Heatmap({days:[]})` 返回 `{type:'p'}` 且 children `['heat.empty']` |
| 4 | 零 token 记录仍渲染 | `:83-89` | `Heatmap({days:[row('2026-10-04', 0)]})` 返回 fragment，`.ofm_heat` 下有 113 个格子 |
| 5 | 色档与提示 | `:91-97` | 有用量的一天 className 恰为 `'ofm_cell l4'`（相对峰值），tooltip 恰为 `'2026-10-04 · 200 tokens · model-a, model-b'` |

## 3.2 B 的现有基础

### 3.2.1 `web/src/features/stats/DailyTrendChart.tsx`（155 行，纯 SVG）逐段分析

| 段落 | 行号 | 内容 | 对热力图的可复用性 |
|---|---|---|---|
| 常量 | `:12-13` | `PAD = {top:12,right:12,bottom:26,left:44}`、`HEIGHT=200` | ⚠️ 部分可借（PAD 是折线图专用，热力图不需要坐标轴留白） |
| 宽度 | `:19` | **硬编码 `width=760`** + `viewBox` + `className="chart"`（`w-full h-auto`，`global.css:541-544`）→ **等比缩放** | 热力图应改为固定格子尺寸 + `overflow-x:auto`（照 A），不要 `w-full` 缩放，否则 12px 格子会被拉伸（这正是 A 的 issue-30 要修的问题） |
| 单点居中 | `:26-27` | `rows.length === 1 ? innerW/2 : …` | ✅ 可借（热力图无此需求） |
| 双 Y 轴 | `:28-29` | `yReq` 用 `maxReq`、`yTokens` 用 `maxTokens`，**两条独立刻度但只画了一套 Y 轴刻度**（`:37-40` 用 `maxReq`） | ❌ 这是图表可信度问题，热力图不涉及，但第 4 组要修 |
| 路径构造 | `:31-33` | `M/L` 拼接 + 面积闭合 | ❌ 不需要 |
| 渐变 | `:16`、`:50-55` | `useId()` 生成 `gradientId`（避免同页 id 冲突）| ✅ 这个习惯必须继承（A 的 `TrendChart` 硬编码 `id="ofmFill"`，`client.js:2598` 是同页多图隐患） |
| 网格/刻度 | `:58-79` | `stroke=var(--rg-border)`、`fill=var(--rg-text-tertiary)`、`fontFamily=var(--rg-font-mono, monospace)` | ✅ token 用法可直接照抄 |
| 横轴抽稀 | `:36`、`:104-118` | `labelStep = Math.max(1, Math.ceil(rows.length/8))` | ⚠️ 热力图不需要（A 没有月份标签） |
| 错误柱 | `:121-136` | 每根柱**内部重算 `maxErr`**（`:123`，O(n²)）| ❌ 反面教材 |
| 图例 | `:139-152` | `.legend` + 色块 `i` | ✅ 结构与 `global.css:545-551` 可复用 |

### 3.2.2 `web/src/shared/ui` 有没有图表/色阶基础件？

**没有。** 全文件 `index.tsx:1-490` 导出：`Button`(24)、`Field`(50)、`FieldRow`(77)、`Stepper`(108)、`Panel`(183)、`MetricGrid`(209)、`Chip`(242)、`Segmented`(266)、`KeyValue`(299)、`KeyCards`(318)、`KeyCardGroups`(354)、`Note`(401)、`ProgressBar`(418)、`LoadingBlock`(437)、`EmptyState`(450)、`ErrorState`(479)。

最接近「图表基础件」的只有 `ProgressBar`（`:418-433`，`ratio` 0-1 + `tone`，CSS `.bar` 在 `global.css:528-537`）。CSS 侧只有 `.chart`（`:541-544`）与 `.legend`（`:545-551`）。

**这意味着热力图 / 曲线切换的色阶与图例都要新写**，并且必须通过 `web/scripts/check-css-tokens.mjs`（`:20` 采集 `global.css` 里所有 `--rg-*:` 定义，`:34` 采集 src 下所有 `var(--rg-*)` 引用，差集非空即 exit 1）。**新增变量必须写在 `global.css` 的 token 层**（`:root`，`:24-87`）。

### 3.2.3 色板 token（`global.css:24-87`）

| 用途 | token | 值 | 行号 |
|---|---|---|---|
| 品牌色阶 | `--rg-brand-50/100/200/300/400/500/600/700/800/900` | 600 = `#4b3fe3` | `:26-35` |
| 中性阶 | `--rg-grey-50…900` | 500 = `#737373` | `:38-47` |
| 表面 | `--rg-bg-base` / `-secondary` / `-tertiary` | `#fff` / `#f5f5f5` / `#e5e5e5` | `:50-52` |
| 文字 | `--rg-text-primary/-secondary/-tertiary/-disabled` | `#171717` / `#404040` / `#737373` / `#a1a1a1` | `:55-58` |
| 状态 | `--rg-state-success/-warning/-error/-info` + 各自 `-surface` | — | `:62-69` |
| 描边 | `--rg-border` / `-strong` / `-stronger` | rgba(115,115,115, .12/.18/.36) | `:72-74` |
| 图表序列 | `--rg-chart-1..5` | = brand-600 / brand-300 / grey-500 / brand-200 / grey-300 | `:77-81` |

规则（`global.css:20-21`）：「组件层只允许引用这里的语义变量，**不允许硬编码色值**」。→ **A 的 `SEASON` 八色硬编码数组（`client.js:2143`：`['#4C8DFF','#3ECFA0','#F2A65A','#E36AA6','#8B7BF0','#39B8C4','#D9743E','#7BB24A']`）不能照抄。**

### 3.2.4 数据来源与后端缺口

`GET /v1/admin/stats/daily?days=N`（`src/routes/admin-traffic.js:120-156`）返回：

```json
{ "object":"list", "days":30, "totalRequests":123,
  "data":[ { "date":"2026-10-13", "requests":40, "errors":2, "tokens":123456,
             "metered":38, "unmetered":2, "exact":30, "estimated":8, "none":2,
             "tokensLost":0, "priced":38, "costUpper":3, "cacheReadTokens":90000,
             "estimatedCost":12.3456, "byModel": { "qwen3.8-flash@max": { "requests":30, "tokens":100000, "metered":29, "unmetered":1, "estimatedCost":9.9 } },
             "officialCredit":..., "officialTraeCredit":..., "officialTokens":..., "officialSessions":..., "officialRequests":..., "officialCovered":true } ],
  "official": {...}, "cached": true }
```

- 字段定义：`web/src/shared/api/stats.ts:11-41`（**注意 `byModel` 未声明，但后端确实返回**：`stats.js:196-199`、`stats-cache.js:170-180`）。
- **参数缺口**：`days` 被夹在 `[1, 90]`（`admin-traffic.js:122`），**17 周需要 119 天，取不到** → 必须放宽。
- **日期口径冲突（B 独有的坑，必须先决策）**：

| 位置 | 用的日键 | 代码 |
|---|---|---|
| 日志目录名 | **UTC** | `traffic.js:22` `d.toISOString().slice(0,10)` |
| `readTrafficLines` | **UTC** | `stats.js:18` `new Date(Date.now()-d*86400000).toISOString().slice(0,10)` |
| `stats-cache.recentDays` | **UTC** | `stats-cache.js:50` |
| `stats-cache.todayKey`（缓存失效） | **本地** | `stats-cache.js:41-44` `getFullYear/getMonth/getDate` |
| A 的热力图 | **本地** | `client.js:2574` |

在中国区（UTC+8），UTC 日键意味着**本地 00:00-08:00 的请求记到前一天的文件里**。若 B 的热力图按 A 那样用本地日历生成键，会系统性地错位一格；而 `todayKey` 与 `recentDays` 已经不一致（前者本地、后者 UTC），属于既有隐患。

## 3.3 对比：给 B 的 Heatmap 实现方案

### 3.3.1 后端改什么（1-3 行）

```js
// src/routes/admin-traffic.js:122 —— 放宽上限，让 17 周（119 天）可请求
const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 180);
```

- `readTrafficLines(180)` / `recentDays(180)` 都是「逐日 `existsSync` + 读文件」（`stats.js:14-35`、`stats-cache.js:47-53`），180 次 `existsSync` 可忽略；命中缓存时只读 180 个小 JSON。
- **可选（若载荷成为问题）**：加 `GET /v1/admin/stats/heatmap?days=119`，只回 `{date, tokens, requests, unmetered, topModels:[{model,tokens}]}`。实测 119 天 × 若 20 模型/天 ≈ 2380 个 byModel 条目，JSON 约 200-300 KB，**可接受**，因此**建议先不做新端点**，直接复用 `/stats/daily`（省一个端点的测试与文档成本）。
- **日期口径决策（二选一，必须先定）**：
  - **方案 1（推荐，零后端风险）**：前端按**UTC 日键**生成 17 周网格（与 `stats.js:18` 的键一致）。做法：把 A 的 `buildHeatCells` 里 `setHours/getDay/setDate/getFullYear/...` 全换成 `setUTCHours/getUTCDay/setUTCDate/getUTCFullYear/...`，锚点用 `end.setUTCHours(12,0,0,0)`（UTC 中午同样规避 DST，虽然 UTC 本身无 DST，但保持与 A 同构便于对拍）。在页面上用一行 `Note` 说明「按 UTC 日切分」。**代价：0 行后端**。
  - **方案 2（语义最正确，但要处理迁移）**：把后端统一为本地日键——`traffic.js:22 todayDir()` 改用 `stats-cache.todayKey()` 的算法（`:41-44`），`stats.js:18` 与 `stats-cache.js:50` 的 `recentDays` 改用本地 `setDate`。**风险**：切换当天会同时存在 UTC 名的旧文件与本地名的新文件；且 `recentDays` 只按本地键找文件，会漏读切换前几小时写入的 UTC 名文件。缓解：`recentDays` 同时返回本地键与前一日 UTC 键，读两处并去重（按 `ts` 排序）。**代价：~20 行 + 需要一次数据核对 + 影响所有按日聚合口径，必须单独立项**。
  - **结论**：本次热力图先做方案 1，把方案 2 记入 `docs/01-architecture/known-limitations.md`。

### 3.3.2 前端组件方案

新建 `web/src/features/stats/TokenHeatmap.tsx`（约 140-180 行），导出两个东西：

```ts
export function buildHeatCells(rows: DailyStat[], span = 119): HeatCell[]   // 纯函数，可单测
export function TokenHeatmap({ rows, weeks = 17 }: { rows: DailyStat[]; weeks?: number }): JSX.Element
```

**`buildHeatCells`（照抄 A 的 14 行，日期算术换 UTC）**：

```ts
export interface HeatCell { key: string; total: number; requests: number; recorded: boolean; unmetered: boolean; models: string[] }

export function buildHeatCells(rows: DailyStat[], span = 119): HeatCell[] {
  if (rows.length === 0) return [];                                  // 无数据 → 空态（对齐 A client.js:2565）
  const byDay = new Map(rows.map((r) => [r.date, r]));
  const end = new Date();
  end.setUTCHours(12, 0, 0, 0);                                      // 正午锚点（对齐 A client.js:2569 的理由）
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - end.getUTCDay() - (Math.ceil(span / 7) - 1) * 7);   // 对齐 A client.js:2572
  const cells: HeatCell[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}-${String(cursor.getUTCDate()).padStart(2, '0')}`;
    const row = byDay.get(key);
    const tokens = row?.tokens ?? 0;
    cells.push({
      key,
      total: tokens,
      requests: row?.requests ?? 0,
      recorded: row != null,                                          // ← B 需要的新区分：有记录 vs 无记录
      unmetered: row != null && tokens === 0 && (row.requests ?? 0) > 0,   // ← B 需要的新区分：未计量
      models: Object.entries(row?.byModel ?? {})
        .filter(([, v]) => (v.tokens ?? 0) > 0)
        .sort((a, b) => b[1].tokens - a[1].tokens)
        .map(([m]) => m),
    });
  }
  return cells;
}
```

**`recorded` 的必要性**：A 靠「`rows.length === 0` → 空数组」区分「完全无数据」，靠「有行但 total 0」区分「已记录的零」。B 必须**额外**区分「有请求但上游没回 usage（`unmetered`/`none`）」——因为 B 的 WorkBuddy 平台全部不带 usage（`stats.js:38-42` 注释），若把这些日子渲染成最低档，用户会读成"这天没消耗"，而实际上是"计量缺失"。这与 B 现有口径纪律一致（`stats.ts:4-7`、`TokenStatsPage.tsx:297-301`）。

**渲染：网格 vs SVG（给两版，推荐网格）**

- **推荐：CSS Grid（与 A 完全一致）**。理由：① hover/tooltip 用原生 `title` 属性，零 JS；② 119 个 DOM 节点，性能无虞；③ 与 A 的测试对拍成本最低。新增类到 `global.css` 的 `@layer components`（`:541` 附近 `.chart` 旁边）：

```css
.heat { display: grid; grid-auto-flow: column; grid-auto-columns: 12px;
        grid-template-rows: repeat(7, 12px); justify-content: start;
        gap: 2px; overflow-x: auto; padding: 2px 0 6px; }
.heat-cell { width: 12px; height: 12px; border-radius: 3.5px;
             background: var(--rg-bg-secondary);
             box-shadow: inset 0 0 0 1px var(--rg-border);        /* 替 A 的 outline，避免撑大 */
             transition: transform .14s ease, background .3s ease; }
.heat-cell:hover { transform: scale(1.25); }
.heat-l1 { background: color-mix(in srgb, var(--rg-brand-600) 22%, transparent); box-shadow: none; }
.heat-l2 { background: color-mix(in srgb, var(--rg-brand-600) 44%, transparent); box-shadow: none; }
.heat-l3 { background: color-mix(in srgb, var(--rg-brand-600) 66%, transparent); box-shadow: none; }
.heat-l4 { background: var(--rg-brand-600); box-shadow: none; }
.heat-cell.heat-unmetered { background: var(--rg-state-warning-surface);
                            box-shadow: inset 0 0 0 1px var(--rg-state-warning); }
.heat-scale { display: flex; align-items: center; gap: 4px; margin-left: auto;
              font-size: 10.5px; color: var(--rg-text-tertiary); }
.heat-scale .heat-cell { width: 10px; height: 10px; }
```

  色阶从 A 的 `--dsw-alias-state-business-primary` 换成 B 的 **`--rg-brand-600`**（= `--rg-chart-1`，`global.css:77`），四档用 `color-mix` 同源派生。未计量态用 `--rg-state-warning` + `-surface`（`global.css:64-65`），复用 B 既有的"警告=口径存疑"语义（`TokenStatsPage.tsx:309-313` 的 warn 用法）。**全部经 `check-css-tokens.mjs` 校验通过**（不新增变量，只用已定义的）。

- **备选：纯 SVG（按题目要求给出结构，约 60 行）**：

```tsx
const CELL = 12, GAP = 2, PITCH = CELL + GAP;          // 14
const COLS = 17, ROWS = 7;
<svg width={COLS * PITCH} height={ROWS * PITCH}
     viewBox={`0 0 ${COLS * PITCH} ${ROWS * PITCH}`}
     role="img" aria-label={`Token 热力图，近 ${COLS} 周`}
     className="block" style={{ overflow: 'visible' }}>
  {cells.map((c, i) => {
    const col = Math.floor(i / ROWS), row = i % ROWS;   // ← 列优先：cells 是日期升序
    return (
      <rect key={c.key} x={col * PITCH} y={row * PITCH} width={CELL} height={CELL} rx={3}
            fill={fillOf(c)} fillOpacity={opacityOf(c)} stroke={strokeOf(c)} strokeWidth={1}>
        <title>{tipOf(c)}</title>                        {/* 原生 tooltip，无需 JS 层 */}
      </rect>);
  })}
</svg>
```

  其中 `fillOf`：未计量 → `var(--rg-state-warning-surface)`；否则 `var(--rg-brand-600)`（档 0 时 `fillOpacity=0`）；`opacityOf` = `total === 0 ? 0 : total/peak > 0.66 ? 1 : total/peak > 0.4 ? 0.66 : total/peak > 0.16 ? 0.44 : 0.22`；档 0 时 `stroke=var(--rg-border)`、`strokeOpacity=1`，其余 `stroke="none"`。**注意 SVG 的 `<title>` 必须是被引用元素的子元素**（Chromium/WebKit 支持）；`<svg>` 内不要用 `w-full h-auto`（`global.css:541-544` 的 `.chart` 会等比缩放导致格子被拉伸），改为固定 `width/height` + 外层容器 `overflow-x:auto`。

**数据字段映射表**

| 用途 | 来源字段 | 备注 |
|---|---|---|
| 格子键 / 周对齐 | `DailyStat.date`（`YYYY-MM-DD`，UTC 日键） | 与 `stats.js:18` 一致 |
| 色阶 | `DailyStat.tokens` | A 用的是 `row.total`（=`day.total`），语义等价 |
| 未计量态 | `DailyStat.requests` / `DailyStat.unmetered` / `DailyStat.none` | `tokens===0 && requests>0` → 未计量 |
| tooltip 模型列表 | `DailyStat.byModel[].tokens`（需补 TS 类型） | 对应 A 的 `models.filter(m => m.output > 0)`（`client.js:2576`） |
| tooltip 请求数 | `DailyStat.requests` | B 比 A 多的信息，建议加上 |
| 「已记录」判定 | 该 `date` 是否出现在 `data` 数组 | 无记录的日子后端不会返回该行 |

**tooltip 文案（对齐 B 的口径纪律，比 A 多说一句）**：

```
有用量：  2026-10-13 · 123,456 Token · 40 次请求 · qwen3.8-flash@max, …
未计量：  2026-10-13 · 0 Token（40 次请求未回传 usage，非零消耗）
无记录：  2026-10-12 · 无请求记录
```

**阈值**：沿用 A 的相对峰值三阈值 `0.66/0.4/0.16`（`client.js:2550`）。理由：不依赖窗口总量、与 A 行为对拍、且 B 的 `tokens` 在历史脱敏缺陷下是下界（`stats.js:167-169`），绝对分位会被异常日主导。`peak === 0`（全窗口 0 token）时全部无档 + 仍渲染日历（对齐 A `:2550` 的 `peak === 0 ? ''`）。

### 3.3.3 测试方案与代价

- B **没有前端测试运行器**（`web/package.json` scripts 只有 `dev/build/lint/check:tokens/preview`；`npm test` 只跑 `src/test/*.test.js` 的 node:test）。
- 三条可选路径，按成本排序：
  1. **纯函数测试落在后端**（~30 行，最省）：把 `buildHeatCells` 的**同一算法**在 `src/test/heatmap.test.js` 里用 `node:test` 实现一份（或把纯函数放在一个 CJS 可 `require` 的共享文件），断言与 A 的 `heatmap-test.mjs:41-64` 同样的矩阵（17 列、113~119 格、周日对齐、无未来日期、跨年/闰日、无记录 vs 零记录）。缺点：测的不是前端那份代码。
  2. **加前端测试运行器**（vitest，~0.5 天含配置）：直接测 `TokenHeatmap.tsx` 导出的纯函数。**推荐**，因为第 4 组的曲线切换也受益。
  3. 手工核对 + `npm run lint` + `check:tokens`（~0.5 h）。**最低要求**（`check:tokens` 必须过）。
- **代价合计**：后端 1 行；`TokenHeatmap.tsx` ~150 行；`global.css` 新增 ~15 行；`stats.ts` 类型 +10 行；`TokenStatsPage.tsx` 挂载 +15 行；测试按路径 1 约 0.5 天、按路径 2 约 1 天。**总计 1-1.5 人日**（若已有 vitest 则 0.5-1 人日）。**这是四组里 ROI 最高的一项。**

---

# 第 4 组：总量曲线（总计 / 单模型切换）

## 4.1 A 的实现

### 4.1.1 `TrendChart` — `client.js:2581-2611`

```js
function TrendChart(props) {
  const { series, metric, mode } = props
  const width = 900, height = 168
  const pad = { top: 12, right: 8, bottom: 18, left: 40 }
  const rows = series.length === 0 ? [{ day: '', total: 0 }] : series          // :2586
  const valueOf = row => mode === 'requests'                                   // :2587-2589
    ? row.models.reduce((sum, m) => sum + m.calls, 0)                          //   ← 完全忽略 metric！
    : metric === 'total' ? row.total
    : (row.models.find(m => m.model === metric)?.output ?? 0)
  const points = rows.map((row, index) => ({
    x: rows.length === 1 ? width / 2 : pad.left + (index / (rows.length - 1)) * (width - pad.left - pad.right),
    y: 0, value: valueOf(row), day: row.day }))                                // :2590
  const peak = Math.max(1, ...points.map(p => p.value))                        // :2591 ← 只按选中序列缩放（单轴）
  for (const point of points) point.y = pad.top + (1 - point.value / peak) * (height - pad.top - pad.bottom)
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')   // :2593
  const area = `${line} L${points.at(-1).x.toFixed(1)},${height - pad.bottom} L${points[0].x.toFixed(1)},${height - pad.bottom} Z`   // :2594
  const color = metric === 'total' ? 'var(--dsw-alias-state-business-primary)' : (props.color ?? '…')      // :2595
  const ticks = [0, 0.5, 1].map(frac => ({
    y: pad.top + frac * (height - pad.top - pad.bottom), label: kilo(peak * (1 - frac)) }))                // :2596
  return h('svg', { className: 'ofm_svg', viewBox: `0 0 ${width} ${height}`,
                    preserveAspectRatio: 'none', role: 'img' },                             // :2597 ← 非等比 + non-scaling-stroke
    h('defs', null, h('linearGradient', { id: 'ofmFill', … })),                                 // :2598 ← 硬编码 id（同页多图冲突）
    ticks.map(tick => h('g', …line + text…)),                                                   // :2601-2603
    h('path', { d: area, fill: 'url(#ofmFill)' }),                                              // :2604
    h('path', { d: line, fill: 'none', stroke: color, strokeWidth: 1.9,
                strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke' }),   // :2605
    rows.length > 1 ? [rows[0], rows[Math.floor(rows.length/2)], rows.at(-1)].map((row, i) => h('text', {
      key: `x${i}`,
      x: points[Math.min(points.length - 1, Math.round(i === 0 ? 0 : i === 1 ? (rows.length - 1) / 2 : rows.length - 1))].x,
      y: height - 4, textAnchor: i === 0 ? 'start' : i === 2 ? 'end' : 'middle',
      fontSize: 9.5, fill: 'var(--dsw-alias-label-tertiary)' }, row.day.slice(5))) : null)       // :2606-2610
}
```

**数据组织（`StatsPage`，`client.js:3016-3060`）**：

```js
const [mode, setMode]   = useState('tokens')     // :3016  'tokens' | 'requests'
const [metric, setMetric] = useState('total')    // :3017  'total' | modelId

const cumulative = useMemo(() => {               // :3019-3027
  let tokenRun = 0, requestRun = 0
  return days.map(row => {
    tokenRun   += row.total
    requestRun += row.models.reduce((sum, m) => sum + m.calls, 0)
    return { ...row, total: mode === 'requests' ? requestRun : tokenRun }
  })
}, [days, mode])                                  // ← 总量是「累计曲线」

const active = metric === 'total' ? undefined : models.find(m => m.model === metric)      // :3029
const color = metric === 'total' ? 'var(--dsw-alias-state-business-primary)'
  : SEASON[Math.max(0, models.findIndex(m => m.model === metric)) % SEASON.length]        // :3030-3032

const legend = h('div', { className: 'ofm_chips' },                                       // :3046-3048
  chip(t('curve.total'), metric === 'total', SEASON[0], () => setMetric('total')),
  models.map((m, index) => chip(m.name, metric === m.model, SEASON[index % SEASON.length], () => setMetric(m.model))))

const curve = h(Panel, { title: t('curve.title') },
  h('div', { className: 'ofm_row' },
    h('div', { className: 'ofm_seg' },
      segButton(t('curve.tokens'),   mode === 'tokens',   () => setMode('tokens')),
      segButton(t('curve.requests'), mode === 'requests', () => setMode('requests'))),
    legend),
  h(TrendChart, { series: cumulative, mode, metric, color }),
  active === undefined ? null : h('p', { className: 'ofm_note' },
    active.name, ' · ', String(active.calls), ' ', t('speed.calls'), …))                   // :3056-3060
```

**多序列渲染方式 = 单序列重绘**：A **不叠加多条线**，而是「同一张单线图 + 切换要画哪一条」。`metric` 只影响 `valueOf` 取哪个数、`color` 取哪个色、以及下方一行注解。这正是"总计/单模型切换"的最省实现。

**A 的两个已知缺陷（B 不要照抄）**：

1. **`valueOf` 在 `requests` 模式下完全忽略 `metric`**（`:2587`）：`mode === 'requests'` 分支直接返回全部模型的 `calls` 之和，所以切到单个模型时请求数曲线**没有任何变化**。正确做法是 `mode==='requests' ? (metric==='total' ? sum(calls) : byModel[metric].requests)`。
2. **总量用累计、单模型用每日值**（`:3019-3027` 累加 `row.total`；`:2589` 取 `row.models.find(...).output` 是当日值）：同图两种口径，y 轴刻度含义随 metric 静默改变。B 应统一为「每日值」并把面板标题写成「每日趋势」，或统一为累计并标注「累计」。
3. `id="ofmFill"` 硬编码（`:2598`）——B 的 `DailyTrendChart.tsx:16` 已用 `useId()` 修过，保持 B 的做法。

### 4.1.2 `Sparkline` — `client.js:2613-2624`（附带资产）

```js
function Sparkline(props) {
  const values = props.values
  if (values.length < 2) return h('span', { className: 'ofm_note' }, props.t('speed.none'))   // :2615
  const width = 150, height = 30
  const peak = Math.max(...values, 1), floor = Math.min(...values, 0)
  const span = Math.max(1e-6, peak - floor)                                                   // :2620
  const line = values.map((value, index) =>
    `${index === 0 ? 'M' : 'L'}${(index / (values.length - 1) * width).toFixed(1)},${(height - ((value - floor) / span) * (height - 4) - 2).toFixed(1)}`).join(' ')
  return h('svg', { className: 'ofm_svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', style: { height } },
    h('path', { d: line, fill: 'none', stroke: props.color ?? '…', strokeWidth: 1.6, strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke' }))
}
```

- 与 `TrendChart` 的差别：**min/max 双端归一化**（保留 `floor`，避免把缓升序列画成陡升），`1e-6` 防除零，`-2` 上边距、`height-4` 下边距，无渐变、无刻度、无轴标签。用作 KPI 卡里的小趋势（`sparkCell` 在 `:3124-3130`）。
- 对 B 的用途：`TokenStatsPage` 的口径卡片（`:43-95`）如果要加迷你趋势线，这段是现成模板（B 目前没有）。

## 4.2 B 的现状

### 4.2.1 `DailyTrendChart.tsx` 的双序列实现

- 序列 1：`requests`（面积 `areaPath` + 实线，`stroke=var(--rg-chart-1)`，`:82-83`），用 `maxReq` 缩放（`:23`、`:28`）。
- 序列 2：`tokens`（虚线 `strokeDasharray="3 3"`，`stroke=var(--rg-chart-3)`，`:86-92`），用 `maxTokens` 缩放（`:24`、`:29`）。
- 序列 3：`errors` 柱（`:121-136`，`var(--rg-state-error)`，高度按 `maxErr` 取 `innerH*0.35`）。
- **Y 轴刻度只有一套**（`:37-40` 用 `maxReq`），所以 `tokens` 虚线的纵向位置**无法从图上读出数值**——这是现有图表的口径缺陷（用户只能看趋势形状）。
- 无交互、无 tooltip、无切换控件。

### 4.2.2 两个端点返回的数据形状

**`GET /v1/admin/stats/daily?days=N`**（`routes/admin-traffic.js:120-156`）

- 响应：`{object:'list', days, totalRequests, data: DailyStat[], official, cached}`
- `data[i]` 有**按日 + 按模型**两层：`date/requests/errors/tokens/metered/unmetered/exact/estimated/none/tokensLost/priced/costUpper/cacheReadTokens/estimatedCost/official*` 以及 **`byModel: Record<model, {requests, tokens, metered, unmetered, cacheReadTokens, estimatedCost}>`**
  - 构建：`stats.js:176-181`（非缓存）/ `stats-cache.js:114-115`（缓存）
  - 输出：`stats.js:196-199` / `stats-cache.js:170-180`
  - **前端未声明**：`web/src/shared/api/stats.ts:11-41` 的 `DailyStat` 里没有 `byModel`（全前端只有 `OfficialUsageAccount.byModel` 与 `admin.ts:43` 的计数版 `byModel` 用了这个名字）。

**`GET /v1/admin/stats/models?days=N`**（`routes/admin-traffic.js:159-175`）

- 响应：`{object:'list', days, totalRequests, data: ModelStat[], cached?}`
- `ModelStat`（`stats.ts:43-58`）：`{model, requests, errors, tokens, metered, unmetered, estimated?, promptTokens, completionTokens, cacheReadTokens?, estimatedCost, avgDurationMs, toolCalls}`
- **没有 `date` 维度**（`stats.js:208-246` 是纯窗口聚合）。

### 4.2.3 结论：`/stats/models` 能否直接支撑「单模型曲线」？

**不能。** 三条硬理由：

1. **缺日期维度**：`modelStats` 的返回是「N 天内的合计」，一条曲线需要「每天一个点」。`/stats/models` 只能画一个柱/一个点。
2. **即使改造它，也要按 (model, date) 分组重写**，而这份数据**已经在 `/stats/daily` 的 `byModel` 里了**（`stats.js:176-181`）。从 `/stats/models` 出发做单模型曲线属于重复实现。
3. **默认路径下 `/stats/models` 本身是不可信的**：`STATS_CACHE` 默认开（`admin-traffic.js:23`），走 `cachedModelStats`（`stats-cache.js:185-218`），其中 `promptTokens`/`completionTokens` **恒为 0**（`:189` 初始化、`:210-211` 输出，桶里根本没这两个字段）、`errors` 恒为 0（`:191-192` 注释自认近似）、`avgDurationMs` 是按请求数比例摊的（`:197-199`）。用它做 output 曲线会全是 0。

**所以：单模型曲线的唯一正确数据源是 `/stats/daily` 的 `byModel`。**

## 4.3 对比：B 实现"单模型曲线切换"要补什么

### 4.3.1 后端（分级）

| 级别 | 改什么 | 文件:行号 | 代价 |
|---|---|---|---|
| **P0 必需** | 把 `byModel` 暴露给前端类型（零后端改动） | `web/src/shared/api/stats.ts:11-41` 加 `byModel?: Record<string, DailyModelStat>` | 10 行 TS |
| **P0 必需** | 放宽 `days` 上限（若与热力图共用 119 天请求） | `src/routes/admin-traffic.js:122` `90 → 180` | 1 行 |
| **P1 要「仅输出 token」口径** | `byModel` 里补 `promptTokens/completionTokens`：桶内累加 + 输出映射 | `src/log/stats.js:176-181`（累加）、`:196-199`（输出）；`src/log/stats-cache.js:114-115`（桶）、`:170-180`（输出） | ~30 行 |
| **P1 配套** | `BUCKET_VERSION 8 → 9` 并在版本注释登记 | `src/log/stats-cache.js:39`、`:32-38` | 2 行 |
| **P2 顺手修** | `cachedModelStats` 的 `promptTokens/completionTokens/errors` 恒 0 | `src/log/stats-cache.js:189`、`:210-211`、`:191-192` | ~15 行（桶里要加这两个字段，即 P1 的同一改动就能顺带修） |
| **P3 建议** | 模型清单（chips）用 `/stats/daily` 窗口内 `byModel` 的键并集，而不是 `/stats/models` 的列表 | 前端 | 5 行 |

**「仅输出 token」是否值得做？** A 的单模型曲线画的是 `m.output`（输出 token，`client.js:2589`），因为输出 token 才是模型"写出来的量"。B 的 `byModel.tokens` 是 `totalTokens`（含输入），对同一模型的长上下文调用会极大抬高曲线（B 的输入通常远大于输出，`cacheReadTokens` 单列即为此）。**结论：若要做数值可信的单模型曲线，P1 必做**；若只做"形状对比"，`byModel.tokens` 够用但必须在图例/副标题写明"含输入 Token"。

### 4.3.2 前端

**改造 `DailyTrendChart.tsx` 为受控组件**（~80 行改动）：

```tsx
interface Props {
  rows: DailyStat[];
  mode: 'tokens' | 'requests';                    // 来自 Segmented
  metric: 'total' | string;                       // 'total' 或 model id
  /** total 口径下的取值方式：'daily'（默认，每日值）| 'cumulative'（累计） */
  scale?: 'daily' | 'cumulative';
  onMetricChange?: (m: string) => void;
}
```

取值（对齐 A 的 `valueOf` 但修掉它的两个缺陷）：

```ts
const valueOf = (r: DailyStat) => {
  if (mode === 'requests') {
    return metric === 'total'
      ? r.requests                                          // 全模型：直接用日桶 requests（等价 A 的 sum(m.calls)）
      : (r.byModel?.[metric]?.requests ?? 0);               // ← 修 A 的缺陷 1
  }
  return metric === 'total' ? r.tokens : (r.byModel?.[metric]?.tokens ?? 0);
};
```

- 单轴自适应：`peak = Math.max(1, ...values)`，**删掉双 Y 轴**（`DailyTrendChart.tsx:23-29` 的 `maxReq`/`maxTokens` 只保留一个），Y 轴刻度改为 `[0, 0.5, 1] × peak` 并复用现有 `yTicks` 结构（`:37-40`）。这同时修掉 B 现图「tokens 虚线无刻度」的可信度问题。
- 累计模式（若要做）：在组件内做前缀和，**不要**像 A 那样只对 `row.total` 累加而单模型分支忘记累加（`client.js:3019-3027` vs `:2589` 的不一致）。
- 切换控件：`Segmented`（`shared/ui/index.tsx:266-288`）放 tokens/requests；模型 chips 用 `Chip`（`:242-249`）+ `Button`（`:24-35`），选中态用 `aria-pressed`（对齐 A 的 `chip`，`client.js:3137`）。
- 色板：**禁止照抄 A 的 `SEASON` 硬编码 8 色**（`client.js:2143`）。用 `--rg-chart-1..5`（`global.css:77-81`）循环；若要区分 >5 个模型，在 token 层补三条（`global.css:81` 之后）：
  ```css
  --rg-chart-6: var(--rg-brand-400);
  --rg-chart-7: var(--rg-grey-400);
  --rg-chart-8: var(--rg-brand-800);
  ```
  （`check-css-tokens.mjs` 会自动覆盖新增变量。）
- 图例中"总计"固定用 `var(--rg-chart-1)`（= brand-600），与口径卡片 `exact` 的强调色一致（`TokenStatsPage.tsx:63`）。
- tooltip：B 现图无 tooltip，A 也没有（只有 x 轴三个标签）。若加，用 `<title>` 子元素（成本近零），并在 tabs 的 `:hover` 命中区放一个透明 `rect` 而不是绑在 1.75px 的 path 上。

### 4.3.3 代价

| 项 | 量 |
|---|---|
| 后端 P0（types + days 上限） | 0.5 h |
| 后端 P1（byModel 补 prompt/completion + BUCKET_VERSION） | 2 h |
| 前端 `DailyTrendChart` 改造（受控 + 单轴 + chips + 色板） | 0.5-1 天 |
| 测试（若已上 vitest，纯函数 `valueOf`/prefix-sum 易测） | 0.5 天 |
| **合计** | **1.5-2 人日**（只做 P0 则 1 人日） |

---

# 5. 四组共用的横切事项（先做这些，四组都省事）

1. **日期口径统一**（影响第 3、4 组，也是既有隐患）：`logs` 目录名与 `readTrafficLines`/`recentDays` 用 UTC（`traffic.js:22`、`stats.js:18`、`stats-cache.js:50`），`stats-cache.todayKey` 用本地（`stats-cache.js:41-44`）。建议先只做「前端按 UTC 键」的最小改动（热力图与曲线都吃同一个 `/stats/daily`），把「后端统一本地日」单独立项。
2. **`byModel` 进 TS 类型**：一旦声明（`stats.ts:11-41`），第 3 组的 tooltip 与第 4 组的单模型曲线同时解锁，成本 10 行。
3. **`BUCKET_VERSION` 纪律**：任何新增聚合字段（节省字节、byModel 的 prompt/completion）都要在 `stats-cache.js:39` 递增并在 `:32-38` 注释登记，否则旧桶会被继续读、新字段恒为 0/undefined。这是 B 已有明确约定的地方（v3→v8 的历史注释就是证据），新改动必须遵守。
4. **`check-css-tokens.mjs` 是硬门槛**：新增任何 `var(--rg-*)` 引用前，先在 `global.css:24-87` 的 token 层定义（`web/package.json` 的 `scripts.check:tokens`）。
5. **不照抄 A 的三处硬编码**：八色 `SEASON`（`client.js:2143`）、`id="ofmFill"`（`client.js:2598`）、假 usage 常量（`local-optimize.js:314/325/337/345/369`）。前两者违反 B 的 token 纪律与 `useId` 惯例，后者污染 B 的账单标定口径。
6. **A 的测试接缝不可直接复用**：A 用 `new Function('window','Date', src)` 注入 `client.js`（`heatmap-test.mjs:6-25`），B 是 React+Vite+TS，等价做法是 vitest + `import { buildHeatCells }`，或把纯函数抽到无 React 依赖的模块里。

---

# 6. 建议实施顺序（按 ROI）

| 顺序 | 项 | 理由 | 人日 |
|---|---|---|---|
| 1 | **热力图**（第 3 组） | 后端 1 行 + 前端 150 行，立刻可见，复用 `/stats/daily`，风险最低；顺带把 `byModel` 类型补上 | 0.5-1 |
| 2 | `byModel` 类型 + `days` 上限 + `cachedModelStats` 恒 0 修复 | 为第 4 组铺路，同时修掉一个既有错误 | 0.5 |
| 3 | **单模型曲线**（第 4 组） | 数据已就绪，前端 0.5-1 天；若要 output 口径再加 P1 | 1-1.5 |
| 4 | **五个本地应答**（第 1 组） | 纯函数搬运最省，但要先做「流式帧渲染」与「记账口径」两个决策 | 1.5-2 |
| 5 | **RTK + 节省面板**（第 2 组） | 依赖最大化：13 个过滤器 + `is_error` 透传 + 字节口径修正；面板只是最后一层 | 3-5 |

