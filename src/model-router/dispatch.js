'use strict';
/**
 * model-router/dispatch.js — 将一次 chat 请求派发到具体 Provider 候选。
 *
 * Provider 形态：
 * - openai：通用 OpenAI 兼容端点（baseUrl + apiKey）
 * - builtin/trae | builtin/workbuddy：复用现有账号池与上游客户端
 */
const { classifyError } = require('../upstream/errors');
const { logRequest } = require('../log/traffic');
const { createLineFeeder } = require('../lib/sse-lines');
const { exportOpenAI } = require('../transform/emitters');

function resolveApiKey(p) {
  // M-S6：明文 apiKey 已从存储剥离，密钥统一经环境变量注入（apiKeyEnv）
  if (p.apiKeyEnv && process.env[p.apiKeyEnv]) return process.env[p.apiKeyEnv];
  return null;
}

function safeBaseUrl(url) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) {
    const e = new Error('provider.baseUrl 必须是 http(s) URL');
    e.status = 400;
    throw e;
  }
  return u.replace(/\/+$/, '');
}

/** 通用 OpenAI 兼容：非流式。 */
async function dispatchOpenAINonStream(provider, remoteModel, body) {
  const base = safeBaseUrl(provider.baseUrl);
  const key = resolveApiKey(provider);
  if (!key) {
    const e = new Error(`provider 缺少 API Key（apiKeyEnv=${provider.apiKeyEnv || '未配置'}）`);
    e.status = 401;
    throw e;
  }
  const payload = {
    ...body,
    model: remoteModel,
    stream: false,
  };
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(provider.timeoutMs || 600000),
  });
  const text = await resp.text().catch(() => '');
  if (!resp.ok) {
    const e = new Error(`OpenAI provider HTTP ${resp.status} ${text.slice(0, 200)}`);
    e.status = resp.status;
    attachUpstreamCode(e, text);
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    const e = new Error('OpenAI provider 返回非 JSON');
    e.status = 502;
    throw e;
  }
}

/** 通用 OpenAI 兼容：流式（SSE 透传，失败且未写头时抛错以便切换）。 */
async function dispatchOpenAIStream(provider, remoteModel, body, res, opts = {}) {
  const base = safeBaseUrl(provider.baseUrl);
  const key = resolveApiKey(provider);
  if (!key) {
    const e = new Error(`provider 缺少 API Key（apiKeyEnv=${provider.apiKeyEnv || '未配置'}）`);
    e.status = 401;
    throw e;
  }
  const payload = { ...body, model: remoteModel, stream: true };
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(provider.timeoutMs || 600000),
  });
  const text = resp.ok ? '' : await resp.text().catch(() => '');
  if (!resp.ok || !resp.body) {
    const e = new Error(`OpenAI provider HTTP ${resp.status} ${text.slice(0, 200)}`);
    e.status = resp.status;
    attachUpstreamCode(e, text);
    throw e;
  }

  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let usage = null;
  try {
    // 旁路窥探 usage（转发字节原样写出，不经解析改写，保持透传语义）
    const feeder = createLineFeeder((line) => {
      const t = line.trim();
      if (!t.startsWith('data:')) return;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try {
        const ev = JSON.parse(payload);
        if (ev && ev.usage) usage = ev.usage;
      } catch { /* 非 JSON 帧忽略 */ }
    });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      feeder.feed(chunk);
      if (chunk && !res.writableEnded) res.write(chunk);
    }
    feeder.flush();
  } finally {
    if (!res.writableEnded) res.end();
  }
  return {
    streamed: true,
    durationMs: Date.now() - (opts.startedAt || Date.now()),
    usage: sanitizeUsage(usage),
  };
}

function attachUpstreamCode(err, text) {
  try {
    const o = JSON.parse(text);
    const code = o && (o.code != null ? o.code : (o.error && o.error.code));
    if (code != null && !Number.isNaN(Number(code))) err.upstreamCode = Number(code);
  } catch { /* 非 JSON 体忽略 */ }
}

/** usage 只保留 OpenAI 官方三字段，避免客户端 Type validation 失败后无限重试。 */
function sanitizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    prompt_tokens: Number(u.prompt_tokens) || 0,
    completion_tokens: Number(u.completion_tokens) || 0,
    total_tokens: Number(u.total_tokens) || 0,
  };
}

/** 上游因输出上限/内容策略提前中断的结束原因；这些必须原样透传给客户端。 */
const { isTruncatedFinish } = require('../transform/finish');

/**
 * 流式末帧 finish_reason 决策。
 * - 截断（length/max_tokens/content_filter）优先：让客户端走「续写/提示超长」而非「执行工具」
 * - 未被截断且有 tool_calls：必须是 tool_calls，否则客户端会在首段文本后自动停止
 */
function resolveStreamFinish({ sawToolCalls, lastFinish } = {}) {
  if (isTruncatedFinish(lastFinish)) return lastFinish;
  if (sawToolCalls) return 'tool_calls';
  return lastFinish || 'stop';
}

/**
 * 将聚合 completion 写成标准 OpenAI SSE chunk 流。
 * 顺序：role → content/tool_calls → finish(+usage) → [DONE]
 * 每个 data 块都带 choices，避免「usage-only chunk」触发客户端 schema 校验失败。
 */
function writeCompletionChunks(res, data, shownModel) {
  const id = data.id || `chatcmpl-${Date.now().toString(36)}`;
  const created = data.created || Math.floor(Date.now() / 1000);
  const model = shownModel || data.model || 'unknown';
  const choice = (data.choices && data.choices[0]) || {};
  const msg = choice.message || {};
  const hasTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
  const finish = resolveStreamFinish({ sawToolCalls: hasTools, lastFinish: choice.finish_reason });
  const usage = sanitizeUsage(data.usage);

  const base = { id, object: 'chat.completion.chunk', created, model };
  const write = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  write({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });

  if (msg.reasoning_content) {
    // 仅透出标准字段，reasoning 不进 delta，避免非标字段校验失败
  }
  if (msg.content) {
    write({ ...base, choices: [{ index: 0, delta: { content: msg.content }, finish_reason: null }] });
  }
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    msg.tool_calls.forEach((tc, i) => {
      write({
        ...base,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: i,
              id: tc.id,
              type: 'function',
              function: {
                name: tc.function && tc.function.name,
                arguments: tc.function && tc.function.arguments,
              },
            }],
          },
          finish_reason: null,
        }],
      });
    });
  }

  write({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });
  if (!res.writableEnded) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
  return { id, finish, usage };
}

/** 内置 WorkBuddy：走账号池 + wbChat 聚合。 */
async function dispatchWorkBuddy(provider, remoteModel, body, opts = {}) {
  const pool = require('../credentials/pool');
  const auth = require('../auth');
  const wbChat = require('../workbuddy/chat');
  const { result } = await pool.run(async (accountId) => {
    const acct = await auth.ensureAuth(accountId);
    try {
      return await wbChat.chatAggregate(acct, { ...body, model: remoteModel, stream: true });
    } catch (err) {
      attachUpstreamCode(err, err.message || '');
      throw err;
    }
  }, { edition: 'workbuddy', stickyKey: opts.stickyKey, stickyAccountId: opts.stickyAccountId });
  return result;
}

/**
 * 内置 Trae：走账号池 + llmUtilsChat（非流式聚合）。
 * 流式场景由 handleVirtual 的 SSE 路径调用 dispatchTraeStream。
 */
async function dispatchTraeNonStream(provider, remoteModel, body, opts = {}) {
  const pool = require('../credentials/pool');
  const { llmUtilsChat } = require('../upstream/client');
  const { normalizeTraeMessages } = require('../transform/request');
  const callOpts = {
    tools: body.tools || undefined,
    tool_choice: body.tool_choice || undefined,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    top_p: typeof body.top_p === 'number' ? body.top_p : undefined,
    max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
  };
  const { result: up } = await pool.run(async (accountId) => {
    const r = await llmUtilsChat(normalizeTraeMessages(body.messages), remoteModel, false, { ...callOpts, accountId });
    return r;
  }, { edition: 'trae', stickyKey: opts.stickyKey, stickyAccountId: opts.stickyAccountId });

  const data = (up && up.data) || {};
  if (data.choices) return data;
  const content = data.response || data.content || '';
  // 上游 usage 优先保留：原实现无条件填 {0,0,0}，把上游真实用量抹成 0，
  // 导致日志与统计层既拿不到 token、也无法区分「未计量」与「真为 0」。
  const rawUsage = data.usage || (up && up.usage) || null;
  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: remoteModel,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: sanitizeUsage(rawUsage) || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** 非流式统一入口。 */
async function dispatchNonStream(provider, remoteModel, body, opts = {}) {
  if (provider.type === 'openai') return dispatchOpenAINonStream(provider, remoteModel, body);
  if (provider.builtin === 'workbuddy') return dispatchWorkBuddy(provider, remoteModel, body, opts);
  return dispatchTraeNonStream(provider, remoteModel, body, opts);
}

/**
 * 流式统一入口：
 * - openai：SSE 直通
 * - workbuddy：上游 SSE 直通（改写 model 字段可选）
 * - trae：真流式（M-P1 根因修复）——llmUtilsChat(stream=true) 逐事件下发，
 *   出口统一走 exportOpenAI 规范化；usage 合并进末帧、finish_reason 语义
 *   （tool_calls / 截断优先）与聚合出口 writeCompletionChunks 保持等价。
 *   上游失败时抛错，交由 handleChat 切换候选或补错误帧（与旧聚合行为一致）。
 */
async function dispatchStream(provider, remoteModel, body, res, opts = {}) {
  if (provider.type === 'openai') {
    return dispatchOpenAIStream(provider, remoteModel, body, res, opts);
  }
  if (provider.builtin === 'workbuddy') {
    return dispatchWorkBuddyStream(provider, remoteModel, body, res, opts);
  }
  return dispatchTraeStream(provider, remoteModel, body, res, opts);
}

/**
 * 内置 Trae 真流式：pool.run 租约 + llmUtilsChat(stream=true) + createStreamHandler。
 * 事件边界（text/tool_call/done/token_usage/error）与 routes/openai.js 同一套解析层，
 * 差异仅在出口：这里直接写 SSE 字节（echoModel 改写 model 字段），无续写聚合。
 */
async function dispatchTraeStream(provider, remoteModel, body, res, opts = {}) {
  const pool = require('../credentials/pool');
  const { llmUtilsChat, consumeStream } = require('../upstream/client');
  const { normalizeTraeMessages } = require('../transform/request');
  const { createStreamHandler } = require('../transform/sse');
  const out = exportOpenAI();
  const shownModel = opts.echoModel || remoteModel;
  const completionId = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const callOpts = {
    tools: body.tools || undefined,
    tool_choice: body.tool_choice || undefined,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    top_p: typeof body.top_p === 'number' ? body.top_p : undefined,
    max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
  };

  let outFinish = null;
  let outUsage = null;
  let outText = '';
  let lastUsage = null;
  let started = false;
  const ensureStart = () => {
    if (started) return;
    started = true;
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
    }
    for (const s of out.start(completionId, shownModel)) {
      if (!res.writableEnded) res.write(s);
    }
  };

  await pool.run(async (accountId) => {
    let roundFinish = null;
    let sawToolCalls = false;
    const handler = createStreamHandler((evt) => {
      switch (evt.type) {
        case 'text':
          if (evt.content || evt.reasoning) {
            // 输出侧 token 补算的原料（usage 缺失时由 handleChat 使用）
            if (evt.content) outText += evt.content;
            ensureStart();
            for (const s of out.text(completionId, shownModel, evt.content, evt.reasoning)) {
              if (!res.writableEnded) res.write(s);
            }
          }
          break;
        case 'tool_call':
          sawToolCalls = true;
          ensureStart();
          for (const s of out.toolCall(completionId, shownModel, evt.call)) {
            if (!res.writableEnded) res.write(s);
          }
          break;
        case 'done':
          roundFinish = evt.finish_reason || 'stop';
          break;
        case 'error': {
          // 抛错交还上层：未写头 → handleChat 切换候选；已写头 → 补错误帧路径收尾。
          const e = new Error(evt.message || 'upstream stream error');
          e.code = 'UPSTREAM_STREAM_ERROR';
          if (evt.code != null) e.upstreamCode = evt.code;
          throw e;
        }
        case 'token_usage':
          lastUsage = evt.data || null;
          return;
        default:
          return;
      }
    }, { markIncomplete: false });

    const up = await llmUtilsChat(normalizeTraeMessages(body.messages), remoteModel, true, { ...callOpts, accountId });
    const feeder = createLineFeeder((line) => handler.feedLine(line));
    await consumeStream(up.body, (text) => feeder.feed(text), { requestId: completionId, accountId, model: remoteModel });
    feeder.flush();
    handler.flushToolAccum();

    // B2 口径：参数残缺的工具调用按截断收尾（与聚合出口一致）
    const incomplete = handler.sawIncompleteToolArgs && handler.sawIncompleteToolArgs();
    const resolvedFinish = resolveStreamFinish({
      sawToolCalls: sawToolCalls && !incomplete,
      lastFinish: incomplete ? 'length' : roundFinish,
    });

    ensureStart();
    // usage 合并进末帧（官方三字段），与 WB 直通路径同形
    const usage = sanitizeUsage(lastUsage);
    outUsage = usage;
    const finalChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: shownModel,
      choices: [{ index: 0, delta: {}, finish_reason: resolvedFinish }],
      ...(usage ? { usage } : {}),
    };
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    if (!res.writableEnded) res.write('data: [DONE]\n\n');
    if (!res.writableEnded) res.end();
    outFinish = resolvedFinish;
  }, { edition: 'trae', stickyKey: opts.stickyKey, stickyAccountId: opts.stickyAccountId });

  return { streamed: true, finishReason: outFinish, usage: outUsage, outputText: outText, messages: body.messages };
}

/** WorkBuddy 流式：上游 OpenAI SSE 直通，必要时改写 model。 */
async function dispatchWorkBuddyStream(provider, remoteModel, body, res, opts = {}) {
  const pool = require('../credentials/pool');
  const auth = require('../auth');
  const wbChat = require('../workbuddy/chat');
  const shownModel = opts.echoModel || remoteModel;

  // outFinish 须存活到 pool.run 回调之外（流结束后返回），故声明在外层作用域
  let outFinish = null;
  let outUsage = null;
  let outText = '';
  await pool.run(async (accountId) => {
    const acct = await auth.ensureAuth(accountId);
    const up = await wbChat.chatStream(acct, { ...body, model: remoteModel, stream: true });
    if (up.status !== 200 || !up.body) {
      const e = new Error('WorkBuddy upstream HTTP ' + up.status + ' ' + (up.text || '').slice(0, 200));
      e.status = up.status;
      attachUpstreamCode(e, up.text || '');
      throw e;
    }
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
    }
    const reader = up.body.getReader();
    const dec = new TextDecoder();
    let usage = null;
    let sawDone = false;
    let sawToolCalls = false;
    let lastFinish = null;
    const feeder = createLineFeeder(handleLine);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      feeder.feed(dec.decode(value, { stream: true }));
    }
    feeder.flush();

    function handleLine(line) {
      const t = line.trim();
      if (!t) return;
      if (!t.startsWith('data:')) {
        if (!res.writableEnded) res.write(t + '\n');
        return;
      }
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') {
        sawDone = true;
        return;
      }
      let ev;
      try { ev = JSON.parse(payload); } catch {
        if (!res.writableEnded) res.write(t + '\n');
        return;
      }
      // 裁剪 usage 到官方三字段；记录后合并进末帧
      if (ev.usage) {
        usage = sanitizeUsage(ev.usage);
        delete ev.usage;
      }
      // 去掉可能触发客户端校验的非标字段；并记录 tool_calls / finish_reason
      const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
      if (d) {
        // 输出侧 token 补算的原料（usage 缺失时由 handleChat 使用）
        if (d.content) outText += d.content;
        if (d.reasoning_content) delete d.reasoning_content;
        if (Array.isArray(d.tool_calls) && d.tool_calls.length) sawToolCalls = true;
      }
      if (ev.choices && ev.choices[0] && ev.choices[0].finish_reason) {
        lastFinish = ev.choices[0].finish_reason;
        // 截断信号不覆盖：其余情况有 tool_calls 才改写成 tool_calls
        if (sawToolCalls && !isTruncatedFinish(lastFinish)) ev.choices[0].finish_reason = 'tool_calls';
      }
      if (shownModel && ev.model) ev.model = shownModel;
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
    const resolvedFinish = resolveStreamFinish({ sawToolCalls, lastFinish });
    if (usage && !res.writableEnded) {
      const id = 'chatcmpl-wb-' + Date.now().toString(36);
      const created = Math.floor(Date.now() / 1000);
      res.write(`data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: shownModel,
        choices: [{ index: 0, delta: {}, finish_reason: resolvedFinish }],
        usage,
      })}\n\n`);
    }
    if (!sawDone && !res.writableEnded) res.write('data: [DONE]\n\n');
    if (!res.writableEnded) res.end();
    outFinish = resolvedFinish;
    outUsage = usage;
  }, { edition: 'workbuddy', stickyKey: opts.stickyKey, stickyAccountId: opts.stickyAccountId });

  return { streamed: true, finishReason: outFinish, usage: outUsage, outputText: outText, messages: body.messages };
}

module.exports = {
  dispatchNonStream,
  dispatchStream,
  resolveApiKey,
  attachUpstreamCode,
  sanitizeUsage,
  resolveStreamFinish,
  isTruncatedFinish,
  writeCompletionChunks,
};
