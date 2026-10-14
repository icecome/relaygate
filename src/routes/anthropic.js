'use strict';
/**
 * routes/anthropic.js —— Anthropic /v1/messages（SSE 流式 + tool_use 输出）
 * 与 /v1/messages/count_tokens（本地 token 估算）。
 *
 * Anthropic 的 content 为 block 数组（assistant 输出 tool_use，user 可带 tool_result）；
 * 此处转换为 OpenAI 风格 messages 供上传，再用 exportAnthropic 渲染回 Anthropic 流。
 *
 * stream 语义：Anthropic 规范里 stream 缺省为 false，但本端点历史上缺省发 SSE，
 * 而 Claude Code 这类客户端总会显式带上 stream:true。为不破坏既有客户端，
 * 缺省仍按流式处理，只在客户端**显式**传 stream:false 时走非流式 JSON 分支。
 */
const { Router } = require('express');
const { llmUtilsChat, consumeStream } = require('../upstream/client');
const { isRateLimitCode } = require('../upstream/errors');
const { createStreamHandler } = require('../transform/sse');
const { isTruncatedFinish } = require('../transform/finish');
const config = require('../config');
const { exportAnthropic } = require('../transform/emitters');
const { logRequest, rtkLogFields } = require('../log/traffic');
const pool = require('../credentials/pool');
const { createLineFeeder } = require('../lib/sse-lines');
const { estimateRequestTokens } = require('../lib/token-estimate');
const { sniffHead } = require('../lib/sse-sniff');
const { countToolErrors } = require('../transform/request');
const { resolveMaxTokens } = require('../lib/effort');
const { compressMessages } = require('../lib/rtk');
// 模型 ACL 在模块加载期解析：若包在请求路径的 try/catch 里，require 失败
// 会变成 fail-open（ACL 静默跳过）。加载失败应表现为启动期错误，而非运行期放行。
const { canUseModel, isVirtualModel } = require('../middleware/model-access');

const router = Router();

// Anthropic block 转文本
function blockToText(block) {
  if (typeof block === 'string') return block;
  if (block.type === 'text') return block.text || '';
  if (block.type === 'tool_result') {
    const c = block.content;
    return Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x.text || '')).join('\n') : String(c || '');
  }
  return '';
}

// Anthropic messages → OpenAI 风格，保留 tool_use / tool_result 原生结构
function anthropicToOpenAI(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role === 'assistant') {
      const contentBlocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
      const text = contentBlocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('');
      const toolUses = contentBlocks.filter((b) => b.type === 'tool_use');
      const msg = { role: 'assistant' };
      const tool_calls = toolUses.map((b) => ({
        id: b.id || 'call_' + Math.random().toString(36).slice(2, 8),
        type: 'function',
        function_call: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));
      if (tool_calls.length) { msg.content = []; msg.tool_calls = tool_calls; }
      else msg.content = text ? [{ type: 'text', text }] : [];
      out.push(msg);
    } else if (m.role === 'user') {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
      // tool_result 视作 tool 消息
      if (blocks.some((b) => b.type === 'tool_result')) {
        for (const b of blocks) {
          if (b.type === 'tool_result') {
            // is_error 必须保留：它区分「工具正常返回」与「工具执行失败」。
            // 丢掉它，模型会把错误轨迹当正常结果读，于是重试同一次调用，
            // 用户为这个循环付钱（参照项目对 RTK 的错误轨迹跳过有同源论证）。
            // 注意：这是**内部信号**，不能上行——Trae 协议没有这个字段，
            // 而实测未知字段会偶发 503。由 buildBody 在序列化前剥掉。
            out.push({
              role: 'tool',
              tool_call_id: b.tool_use_id || '',
              content: [{ type: 'text', text: blockToText(b) }],
              ...(b.is_error === true ? { is_error: true } : {}),
            });
          } else {
            out.push({ role: 'user', content: [{ type: 'text', text: blockToText(b) }] });
          }
        }
      } else {
        out.push({ role: 'user', content: blocks.map((b) => ({ type: 'text', text: blockToText(b) })).filter((b) => b.text) });
      }
    } else {
      out.push({ role: m.role, content: [{ type: 'text', text: blockToText(m.content) }] });
    }
  }
  return out;
}

/** system 提示词拼成一条置顶消息（Anthropic 允许字符串或 block 数组两种形态）。 */
function systemMessage(system) {
  if (!system) return null;
  const text = Array.isArray(system) ? system.map((s) => s.text || '').join('\n') : system;
  return { role: 'system', content: [{ type: 'text', text }] };
}

/**
 * 两个端点共用的入参校验与归一化。
 *
 * 校验失败时**已写出响应**并返回 null，调用方直接 return。这样做的原因：
 * 早期实现把这段校验内联在 /v1/messages 里，新增 count_tokens 时若各自复制一份，
 * 两边的模型 ACL 迟早会漂移（一个放行一个拒绝），而 ACL 漂移是越权风险，
 * 不是风格问题。
 */
function normalizeRequest(req, res) {
  // 本端点仅实现 Trae 上游；WB Key / 虚拟模型调用时明确拒绝
  if (req.platform === 'workbuddy') {
    res.status(400).json({
      error: {
        message: '/v1/messages currently supports Trae only. Use a trae-bound API key or universal key (all).',
        type: 'invalid_request_error',
      },
    });
    return null;
  }
  const { model = 'glm-5', messages, system, max_tokens, tools, stream = true, thinking } = req.body || {};
  const acc = canUseModel(req.platform, model, req.authKey || null);
  if (!acc.ok || isVirtualModel(model) || String(model).startsWith('wb/')) {
    res.status(403).json({
      error: {
        message: acc.ok
          ? `/v1/messages currently supports Trae models only (got "${model}").`
          : acc.message,
        type: 'auth_error',
        code: 'MODEL_ACCESS_DENIED',
      },
    });
    return null;
  }
  if (!Array.isArray(messages) || !messages.length) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'messages is required' } });
    return null;
  }
  return { model, messages, system, max_tokens, tools, stream, thinking };
}

/** 解析工具调用的 arguments（上游给的可能是 JSON 字符串或已是对象）。 */
function parseToolInput(args) {
  if (!args) return {};
  if (typeof args === 'object') return args;
  try {
    const v = JSON.parse(args);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * 把一次完成的 OpenAI 形态 completion 折叠成 Anthropic Message 对象。
 *
 * 非流式分支专用：Anthropic 非流式响应没有 SSE 帧，必须一次性给出完整
 * content block 数组。Anthropic 无 reasoning 字段，思维链不在此输出
 * （与流式分支的实际行为一致：exportAnthropic.text 只渲染 content）。
 */
function completionToAnthropic(data, { id, model }) {
  const choice = (data.choices && data.choices[0]) || {};
  const msg = choice.message || {};
  const text = typeof msg.content === 'string' && msg.content
    ? msg.content
    : (data.response || data.content || '');

  const content = [];
  if (text) content.push({ type: 'text', text });

  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const c of calls) {
    const fn = c.function || c.function_call || {};
    content.push({
      type: 'tool_use',
      id: c.id || 'toolu_' + Math.random().toString(36).slice(2, 10),
      name: fn.name || '',
      input: parseToolInput(fn.arguments),
    });
  }
  // Anthropic 要求 content 非空；上游什么都没产出时给一个空文本块，
  // 让客户端能正常收尾而不是拿到畸形响应。
  if (!content.length) content.push({ type: 'text', text: '' });

  // 截断优先于 tool_use：参数可能半截，报 tool_use 会让客户端执行残缺调用
  const stopReason = isTruncatedFinish(choice.finish_reason)
    ? 'max_tokens'
    : (calls.length ? 'tool_use' : 'end_turn');

  const u = data.usage || null;
  return {
    body: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: u ? (u.prompt_tokens || 0) : 0,
        output_tokens: u ? (u.completion_tokens || 0) : 0,
      },
    },
    toolCalls: calls.length,
    stopReason,
  };
}

/**
 * 本地估算输入 token（Anthropic /v1/messages/count_tokens）。
 *
 * 只做本地计算，不请求上游：该端点在上游没有对应能力，且客户端在每次
 * 请求前都会调它，转发一次会白白烧掉账号额度。精确度上优先用 tiktoken
 * （js-tiktoken cl100k_base），超长输入自动回退到字符启发式，见
 * lib/token-estimate.js。
 *
 * Anthropic 的响应体只有 input_tokens 一个字段，不要自行加 object/type
 * 之类的包装——按官方 SDK 的类型定义，多余字段会被逐字回给调用方。
 */
router.post('/v1/messages/count_tokens', (req, res) => {
  const norm = normalizeRequest(req, res);
  if (!norm) return;
  const { messages, system, tools } = norm;
  const built = anthropicToOpenAI(messages);
  const sys = systemMessage(system);
  if (sys) built.unshift(sys);
  try {
    const inputTokens = estimateRequestTokens(built, tools, true);
    res.json({ input_tokens: inputTokens });
  } catch (err) {
    res.status(500).json({ error: { type: 'api_error', message: err.message } });
  }
});

router.post('/v1/messages', async (req, res) => {
  const norm = normalizeRequest(req, res);
  if (!norm) return;
  const { model, messages, system, max_tokens, tools, stream, thinking } = norm;

  const startedAt = Date.now();
  const msgId = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let lastUsage = null;
  let requestError = null;
  let requestStatus = 200;
  let toolCallCount = 0;
  let finishReasonForLog = null; // 下发给客户端的 stop_reason（可观测性）
  let logAccountId = null;

  const built = anthropicToOpenAI(messages);
  const sys = systemMessage(system);
  if (sys) built.unshift(sys);
  // 工具失败数：从**原始** Anthropic 形态统计（tool_result 上的 is_error）。
  // 只有 Anthropic 入口能表达它——OpenAI 协议的 tool 消息没有这个字段，
  // 故不要在 openai.js 那边也记一份「恒为 0」的口径。
  const toolErrors = countToolErrors(messages);
  // 思考强度折算（见 lib/effort.js）：Anthropic 客户端用 `thinking.budget_tokens`
  // 表达思考预算，而上游忽略该字段——翻译成唯一生效的 max_tokens。
  // 客户端已传 max_tokens 或没表达意图时，本模块不介入（零行为变化）。
  const effort = resolveMaxTokens({ requested: max_tokens, thinking });
  const effMaxTokens = effort.maxTokens;
  // 工具输出压缩（RTK）：在派发前就地重写工具结果的文本。
  // **只压一次**——pool.run 的账号重试与流式/非流式两条分支共用这份结果，
  // 否则同一次客户端请求会被重复计数，节省量虚高（记账口径见 log/stats.js）。
  const rtk = compressMessages(built, { enabled: config.rtkEnabled });
  const upstreamMessages = rtk.messages;

  /** 两个分支共用的一条流量日志（字段口径必须一致，否则同端点出现两种统计口径）。 */
  const emitLog = () => {
    logRequest({
      endpoint: '/v1/messages',
      method: 'POST',
      model,
      account: logAccountId,
      status: requestStatus,
      toolCalls: toolCallCount,
      toolsIn: tools ? tools.length : 0,
      // 工具失败率（is_error 为内部信号，不上行；见 transform/request.js#countToolErrors）。
      // Anthropic 入口是工具最密集的客户端（Claude Code），这项最有参考价值。
      ...(toolErrors > 0 ? { toolErrors } : {}),
      // 思考强度折算是否介入（介入时记档位名，便于长期观察客户端都在要什么档）
      ...(effort.level ? { effortLevel: effort.level, maxTokensApplied: effMaxTokens } : {}),
      // 工具输出压缩节省（单位 UTF-8 字节；键名避开 token 以免被 sanitize 掩码）。
      // 字段拼装收口在 log/traffic.js#rtkLogFields，避免两处各写一套。
      ...rtkLogFields(rtk.stats),
      durationMs: Date.now() - startedAt,
      error: requestError,
      stream: stream !== false,
      promptTokens: lastUsage ? lastUsage.prompt_tokens || 0 : 0,
      completionTokens: lastUsage ? lastUsage.completion_tokens || 0 : 0,
      totalTokens: lastUsage ? lastUsage.total_tokens || 0 : 0,
      ...(finishReasonForLog
        ? { finishReason: finishReasonForLog, truncated: finishReasonForLog === 'max_tokens' }
        : {}),
    });
  };

  // ---- 非流式分支 ----
  //
  // 早期实现解构出 stream 却忽略它，无条件设 SSE 头（旧 :112-115），
  // 于是显式传 stream:false 的客户端（Anthropic 官方 SDK 非流式调用、
  // 只做一次性补全的脚本）拿到的是 SSE 帧，会直接解析失败。
  if (stream === false) {
    try {
      const { result: up, accountId } = await pool.run(async (accountId) =>
        llmUtilsChat(upstreamMessages, model, false, { tools, max_tokens: effMaxTokens, accountId }), { model });
      logAccountId = accountId;
      const folded = completionToAnthropic(up.data || {}, { id: msgId, model });
      lastUsage = (up.data && up.data.usage) || null;
      toolCallCount = folded.toolCalls;
      finishReasonForLog = folded.stopReason;
      res.json(folded.body);
    } catch (err) {
      requestError = err.message;
      requestStatus = err.status && err.status >= 400 ? err.status : 500;
      // 非流式尚未下发响应体，可以正常用 HTTP 状态码表达失败
      res.status(requestStatus).json({
        type: 'error',
        error: {
          type: err.status === 429 ? 'overloaded_error' : 'api_error',
          message: err.message,
        },
      });
    } finally {
      emitLog();
    }
    return;
  }

  // ---- 流式分支（原行为，逐字保留） ----
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // message_start
  res.write(`data: ${JSON.stringify({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);

  const out = exportAnthropic();
  let hadToolCall = false;
  let upstreamFinish = null; // 上游 done 事件的结束原因（截断判定依据）
  /**
   * 流式错误回灌账号池用的账号 id。
   *
   * 必须是 ref 而非普通变量：handler 回调在 `pool.run(...)` 内部被调用，
   * 此刻 pool.run 尚未返回，外层 `let` 变量仍为 null —— 用普通变量会让
   * /v1/messages 的流内限流错误永远无法回灌账号池（openai.js 用闭包参数、
   * responses.js 在 run 之后使用，两者均正确，只有此处必须用 ref）。
   */
  const streamAccountIdRef = { current: null };
  // 形状判定兜底（见 lib/sse-sniff.js）：上游忽略 stream=true 返回 JSON 时，
  // 这里会照样收尾成 stop_reason=end_turn + 空 content —— 一个不报错的空答案。
  let sawEvent = false;
  let firstRaw = '';
  const handler = createStreamHandler((evt) => {
    sawEvent = true;
    let bytes = [];
    switch (evt.type) {
      case 'text': bytes = out.text(msgId, model, evt.content, evt.reasoning); break;
      case 'tool_call': hadToolCall = true; toolCallCount += 1; bytes = out.toolCall(msgId, model, evt.call); break;
      case 'done': upstreamFinish = evt.finish_reason || 'stop'; return;
      case 'token_usage': lastUsage = evt.data || null; return;
      case 'error':
        requestError = evt.message;
        if (isRateLimitCode(evt.code) && streamAccountIdRef.current) {
          pool.record(streamAccountIdRef.current, 'rate_limit', { model, message: evt.message });
        }
        bytes = out.error(msgId, model, evt.code, evt.message);
        break;
      default: return;
    }
    bytes.forEach((d) => { if (!res.writableEnded) res.write(d); });
  }, { markIncomplete: config.markIncompleteToolArgs });

  try {
    const { result: up, accountId } = await pool.run(async (accountId) =>
      llmUtilsChat(upstreamMessages, model, true, { tools, max_tokens: effMaxTokens, accountId }), { model });
    // 先记下账号再开始喂流：流内回调依赖它回灌限流计数
    streamAccountIdRef.current = accountId;
    logAccountId = accountId;
    const feeder = createLineFeeder((line) => handler.feedLine(line));
    await consumeStream(up.body, (text) => {
      if (firstRaw.length < 200) firstRaw += text.slice(0, 200 - firstRaw.length);
      feeder.feed(text);
    });
    feeder.flush();
    handler.flushToolAccum();
    // 没解析出任何事件 = 上游故障，不是「空回复成功」。此处 message_start 已下发，
    // 故抛错走 catch 的流内错误帧路径（客户端至少能看到错误，而不是空答案）。
    if (!sawEvent) {
      const kind = sniffHead(firstRaw);
      const e = new Error(`upstream sent no SSE event (shape=${kind}) for a streaming request`
        + (kind === 'json' ? '：上游忽略了 stream=true，返回的是完整 JSON 正文' : ''));
      e.status = 502;
      e.code = 'UPSTREAM_NOT_STREAM';
      throw e;
    }
    if (!res.writableEnded) {
      // 结束原因：截断优先（避免客户端执行参数残缺的工具）。Anthropic 用
      // max_tokens 表达截断，tool_use 表达工具请求，end_turn 表达正常结束。
      const truncated = isTruncatedFinish(upstreamFinish)
        || (handler.sawIncompleteToolArgs && handler.sawIncompleteToolArgs());
      const stopReason = truncated ? 'max_tokens' : (hadToolCall ? 'tool_use' : 'end_turn');
      finishReasonForLog = stopReason;
      if (hadToolCall) {
        res.write(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 0 } })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 0 } })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.end();
    }
  } catch (err) {
    requestError = err.message;
    requestStatus = err.status && err.status >= 400 ? err.status : 500;
    if (!res.writableEnded) {
      // SSE 头已下发，无法改 HTTP 状态码：用事件类型区分「过载可重试」与「服务错误」
      const type = err.status === 429 ? 'overloaded_error' : 'api_error';
      res.write(`data: ${JSON.stringify({ type: 'error', error: { type, message: err.message } })}\n\n`);
      res.end();
    }
  } finally {
    emitLog();
  }
});

module.exports = router;
