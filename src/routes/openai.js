'use strict';
/**
 * routes/openai.js —— OpenAI /v1/chat/completions（SSE + 非流式）。
 * Agent 场景要求：有 tool_calls 时 finish_reason 必须是 tool_calls，
 * 否则客户端会在首段文本后认为任务已完成而自动停止。
 */
const { Router } = require('express');
const { llmUtilsChat, consumeStream } = require('../upstream/client');
const { isRateLimitCode, isModelConfigError } = require('../upstream/errors');
const { sniffHead } = require('../lib/sse-sniff');
const { resolveMaxTokens } = require('../lib/effort');
const wbChat = require('../workbuddy/chat');
const auth = require('../auth');
const { normalizeTraeMessages } = require('../transform/request');
const { createStreamHandler } = require('../transform/sse');
const { isTruncatedFinish } = require('../transform/finish');
const { runWithContinuation } = require('../transform/continue');
const { exportOpenAI } = require('../transform/emitters');
const { logRequest, usageToLogFields } = require('../log/traffic');
const { estimateCost } = require('../models/rates');
const pool = require('../credentials/pool');
const sticky = require('../session/sticky');
const availability = require('../models/availability');
const config = require('../config');
const modelRouter = require('../model-router');
const { canUseModel, isWorkBuddyOnlyModel } = require('../middleware/model-access');
const { createLineFeeder } = require('../lib/sse-lines');

const router = Router();

/** 兼容 tools 与旧版 functions 字段。 */
function extractTools(body) {
  if (Array.isArray(body.tools) && body.tools.length) return body.tools;
  if (Array.isArray(body.functions) && body.functions.length) {
    return body.functions.map((f) => ({ type: 'function', function: f }));
  }
  return null;
}

function lastUserText(messages) {
  let userText = '';
  for (const m of messages || []) {
    if (m.role === 'user') {
      userText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    }
  }
  return userText;
}

/** model-config.json 是否登记了该模型（含大小写不敏感 key）。 */
function inLocalTraeModels(model) {
  const lower = String(model || '').toLowerCase();
  const mc = (config.modelConfig && config.modelConfig.models) || {};
  if (mc[lower]) return true;
  return Object.keys(mc).some((k) => k.toLowerCase() === lower);
}

/**
 * 通用密钥（platform=all）按模型名分派到实际上游平台（trae 或 workbuddy）。
 * 虚拟模型在调用前已被 model-router 拦截，此处只处理物理模型。
 *
 * Qoder 模型不在此分派：它有专属端点 /v1/qoder/chat/completions，
 * 在这里被当成 Trae 模型只会拿到「模型不存在」而非「你走错端点了」。
 * 拒绝由 canUseModel 的 isQoderOnlyModel 分支负责（见 middleware/model-access.js）。
 */
function resolveKeyPlatform(keyPlatform, model) {
  if (keyPlatform === 'all') {
    const raw = String(model || '');
    if (raw.startsWith('wb/') || isWorkBuddyOnlyModel(raw)) return 'workbuddy';
    return 'trae';
  }
  return keyPlatform === 'workbuddy' ? 'workbuddy' : 'trae';
}

/**
 * 按 Key 绑定平台解析实际 model id：
 * - workbuddy：剥离可选 wb/ 前缀（客户端可能保留或剥离）
 * - trae：若误带 wb/ 前缀则报错（应换 WB Key 或通用 Key）
 * @returns {{ok:true, platform:string, modelId:string}|{ok:false, message:string}}
 */
function resolveModelForPlatform(platform, model) {
  const raw = String(model == null ? '' : model);
  if (platform === 'workbuddy') {
    const id = raw.startsWith('wb/') ? raw.slice(3) : raw;
    if (!id) {
      return { ok: false, message: 'model is required' };
    }
    return { ok: true, platform, modelId: id };
  }
  // trae
  if (raw.startsWith('wb/')) {
    return {
      ok: false,
      message: `model "${raw}" is WorkBuddy-only. Use a workbuddy-bound API key, or call a Trae model id without the wb/ prefix.`,
    };
  }
  if (!raw) {
    return { ok: false, message: 'model is required' };
  }
  // WB 独有且 Trae 未登记：明确报错，避免上游 4001 难以排查
  const lower = raw.toLowerCase();
  if (!inLocalTraeModels(lower) && wbChat.WB_MODELS.includes(lower) && lower !== 'auto' && lower !== 'default') {
    return {
      ok: false,
      message: `model "${raw}" is a WorkBuddy model. Use a workbuddy-bound API key.`,
    };
  }
  return { ok: true, platform, modelId: raw };
}

router.post('/v1/chat/completions', async (req, res) => {
  const body = req.body || {};
  const {
    model = 'auto',
    messages,
    stream = true,
    temperature,
    top_p,
    max_tokens,
    seed,
    stop,
    tool_choice,
    reasoning_effort,
    thinking,
  } = body;
  const tools = extractTools(body);
  // 思考强度折算（见 lib/effort.js）：客户端没传 max_tokens、但表达了思考预算时，
  // 把它翻译成上游**唯一真正生效**的参数 max_tokens；两者都没给则 undefined
  // （不设上限，与改动前完全一致）。已传 max_tokens 时原样尊重客户端。
  const effort = resolveMaxTokens({ requested: max_tokens, reasoningEffort: reasoning_effort, thinking });
  const effMaxTokens = effort.maxTokens;
  const startedAt = Date.now();
  let toolCalls = 0;
  let requestError = null;
  let requestStatus = 200;
  let lastUsage = null; // 上游 token_usage 事件（流式与非流式均捕获）
  let resolvedPlatformTag = null; // 命中的平台（'trae'|'workbuddy'），供费率标定选表
  // 计费模型名：直连路径下 model 就是物理模型；WB 路径会剥掉 wb/ 前缀后另存。
  // 必须与 model 分开——费率表/标定表按物理模型名建键，别名查不到条目。
  let pricedModel = model;
  let finalFinishReason = null; // 实际下发给客户端的结束原因（可观测性：能直接查出截断）
  let continueCount = 0; // 截断自动续写的实际轮数
  const finishFields = () => {
    if (!finalFinishReason) return {};
    return {
      finishReason: finalFinishReason,
      truncated: isTruncatedFinish(finalFinishReason),
      ...(continueCount > 0 ? { continues: continueCount } : {}),
    };
  };
  // 末帧结束原因：上游截断信号优先，其次 tool_calls，无信号时取 stop
  const finalFinish = (upstreamFinish) => {
    if (isTruncatedFinish(upstreamFinish)) return upstreamFinish;
    if (upstreamFinish === 'tool_calls') return 'tool_calls';
    if (toolCalls > 0) return 'tool_calls';
    return upstreamFinish || 'stop';
  };
  const usageFields = () => {
    // 统一走 usageToLogFields：兼容蛇形/驼峰键名，并抽出缓存读/写 token
    // （标定费率对三类 token 分别计价，缺缓存字段会系统性高估积分消耗）。
    const base = usageToLogFields(lastUsage);
    // 费用估算：有 token 用量时按模型费率估算积分（标定系数优先）
    if (base.promptTokens || base.completionTokens || base.totalTokens) {
      const c = estimateCost(pricedModel, base.promptTokens, base.completionTokens, {
        cacheRead: Number(base.cacheReadTokens) || 0,
        platform: resolvedPlatformTag || undefined,
      });
      if (c != null) base.estimatedCost = c;
    }
    return base;
  };

  const userText = lastUserText(messages);

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'messages is required', type: 'invalid_request_error' } });
  }

  // 虚拟模型 ID 走 model-router 分发（限流自动切换、优先级权重）。
  // 权限：通用密钥（all）可调；平台密钥拒绝。
  if (modelRouter.hasVirtualModel(model)) {
    const vAccess = canUseModel(req.platform, model, req.authKey || null);
    if (!vAccess.ok) {
      logRequest({
        endpoint: '/v1/chat/completions', method: 'POST', model,
        account: null, status: 403, toolCalls: 0, toolsIn: tools ? tools.length : 0,
        durationMs: Date.now() - startedAt, error: vAccess.message,
        platform: req.platform || 'trae',
      });
      return res.status(403).json({ error: { message: vAccess.message, type: 'auth_error', code: 'MODEL_ACCESS_DENIED' } });
    }
    const stickyKey = sticky.stickyKeyFromRequest(req);
    const stickyAccountId = sticky.lookup(stickyKey);
    try {
      await modelRouter.handleChat(req, res, {
        model,
        messages,
        stream,
        temperature,
        top_p,
        max_tokens: effMaxTokens,
        stop,
        tools: tools || undefined,
        tool_choice,
        stickyKey,
        stickyAccountId,
        startedAt,
        keyPlatform: req.platform || 'all',
      });
    } catch (err) {
      logRequest({
        endpoint: '/v1/chat/completions', method: 'POST', model,
        account: null, status: err.status && err.status >= 400 ? err.status : 500,
        toolCalls: 0, toolsIn: tools ? tools.length : 0,
        durationMs: Date.now() - startedAt, error: err.message,
        platform: 'virtual', virtualModel: model,
      });
      if (!res.writableEnded && !res.headersSent) {
        res.status(err.status && err.status >= 400 ? err.status : 500).json({
          error: { message: err.message, type: 'upstream_error', ...(err.code ? { code: err.code } : {}) },
        });
      }
    }
    return;
  }

  // 密钥权限与平台路由
  // 通用密钥（all）：虚拟模型 / 按模型名自动分派 trae|workbuddy
  // 平台密钥：仅限本平台；虚拟模型与外平台模型一律拒绝
  const access = canUseModel(req.platform, model, req.authKey || null);
  if (!access.ok) {
    logRequest({
      endpoint: '/v1/chat/completions', method: 'POST', model,
      account: null, status: 403, toolCalls: 0, toolsIn: tools ? tools.length : 0,
      durationMs: Date.now() - startedAt, error: access.message,
      platform: req.platform || 'trae',
    });
    return res.status(403).json({ error: { message: access.message, type: 'auth_error', code: 'MODEL_ACCESS_DENIED' } });
  }
  const keyPlatform = resolveKeyPlatform(req.platform, model);
  const resolved = resolveModelForPlatform(keyPlatform, model);
  if (!resolved.ok) {
    logRequest({
      endpoint: '/v1/chat/completions', method: 'POST', model,
      account: null, status: 400, toolCalls: 0, toolsIn: tools ? tools.length : 0,
      durationMs: Date.now() - startedAt, error: resolved.message,
      platform: keyPlatform,
    });
    return res.status(400).json({ error: { message: resolved.message, type: 'invalid_request_error' } });
  }

  if (resolved.platform === 'workbuddy') {
    const wbModel = resolved.modelId;
    resolvedPlatformTag = 'workbuddy';
    const wbBody = {
      model: wbModel,
      messages,
      temperature, top_p, max_tokens: effMaxTokens, stop,
      tools: tools || undefined,
      tool_choice,
    };
    const wbStickyKey = sticky.stickyKeyFromRequest(req);
    const wbStickyAcct = sticky.lookup(wbStickyKey);
    const wbRunOpts = { stickyKey: wbStickyKey, stickyAccountId: wbStickyAcct, edition: 'workbuddy', model: wbModel };
    // 会话/请求幂等键：与 model-router 走同一份派生逻辑，保证「同一客户端会话」
    // 在直连 WB 与虚拟模型两条路径上发出相同的 X-Conversation-ID。
    const wbConvOpts = require('../model-router/dispatch').wbConversationOpts({ stickyKey: wbStickyKey });
    // 直连 WB 路径的 usage：非流式取聚合结果，流式需从 SSE 旁路提取。
    // 原实现两条路径都不写日志，导致 WB 直连请求的 token 恒为 0。
    let wbUsage = null;
    try {
      if (stream !== false) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        await pool.run(async (accountId) => {
          const acct = await auth.ensureAuth(accountId);
          req.accountId = accountId;
          const up = await wbChat.chatStream(acct, Object.assign({ stream: true }, wbBody), wbConvOpts);
          if (up.status !== 200 || !up.body) {
            const e = new Error('WorkBuddy upstream HTTP ' + up.status + ' ' + (up.text || '').slice(0, 200));
            e.status = up.status;
            try {
              const parsed = JSON.parse(up.text || '');
              const code = parsed && parsed.code != null ? parsed.code : null;
              if (code != null && !Number.isNaN(Number(code))) e.upstreamCode = Number(code);
            } catch { /* 非 JSON 体忽略 */ }
            throw e;
          }
          if (wbStickyKey && accountId) sticky.bind(wbStickyKey, accountId);
          // SSE 直通（上游即 OpenAI 格式）；旁路读取 usage，不影响转发的字节
          const reader = up.body.getReader();
          const dec = new TextDecoder();
          const feeder = createLineFeeder((line) => {
            const t = line.trim();
            if (!t.startsWith('data:')) return;
            const payload = t.slice(5).trim();
            if (!payload || payload === '[DONE]') return;
            try {
              const ev = JSON.parse(payload);
              if (ev && ev.usage) wbUsage = ev.usage;
            } catch { /* 非 JSON 帧忽略 */ }
          });
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = dec.decode(value, { stream: true });
            feeder.feed(text);
            if (text && !res.writableEnded) res.write(text);
          }
          feeder.flush();
          if (!res.writableEnded) res.end();
        }, wbRunOpts);
      } else {
        const { result } = await pool.run(async (accountId) => {
          const acct = await auth.ensureAuth(accountId);
          req.accountId = accountId;
          if (wbStickyKey && accountId) sticky.bind(wbStickyKey, accountId);
          return wbChat.chatAggregate(acct, Object.assign({}, wbBody, { stream: true }), wbConvOpts);
        }, wbRunOpts);
        wbUsage = result && result.usage;
        return res.json(result);
      }
    } catch (err) {
      requestError = err.message;
      if (!res.writableEnded) {
        if (res.headersSent) {
          // SSE 头已下发：补错误帧后结束，避免 ERR_HTTP_HEADERS_SENT
          try {
            res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'upstream_error' } })}\n\n`);
            res.write('data: [DONE]\n\n');
          } catch { /* ignore */ }
          res.end();
        } else {
          res.status(err.status && err.status >= 400 ? err.status : 500).json({ error: { message: err.message, type: 'upstream_error' } });
        }
      }
    } finally {
      // 费率按真实模型 wbModel 计（model 可能是 WB 别名，费率表里没有条目）
      const wbUsageFields = usageToLogFields(wbUsage);
      const wbCost = wbUsageFields.totalTokens
        ? estimateCost(wbModel, wbUsageFields.promptTokens, wbUsageFields.completionTokens, {
          cacheRead: Number(wbUsageFields.cacheReadTokens) || 0,
          platform: 'workbuddy',
        })
        : null;
      logRequest({
        endpoint: '/v1/chat/completions', method: 'POST', model,
        account: req.accountId || null,
        status: requestError ? 500 : 200,
        toolCalls: 0, toolsIn: tools ? tools.length : 0,
        durationMs: Date.now() - startedAt,
        error: requestError,
        platform: 'workbuddy',
        wbModel,
        pricedModel: wbModel,
        routedTo: `workbuddy/${wbModel}`,
        ...wbUsageFields,
        ...(wbCost != null ? { estimatedCost: wbCost } : {}),
      });
    }
    return;
  }

  const completionId = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const stickyKey = sticky.stickyKeyFromRequest(req);
  const stickyAccountId = sticky.lookup(stickyKey);
  const runOpts = { stickyKey, stickyAccountId, model };

  const callOpts = {
    tools: tools || undefined,
    tool_choice: tool_choice || undefined,
    userText,
    temperature: typeof temperature === 'number' ? temperature : undefined,
    top_p: typeof top_p === 'number' ? top_p : undefined,
    max_tokens: effMaxTokens,
    seed: typeof seed === 'number' ? seed : undefined,
    stop: Array.isArray(stop) ? stop : undefined,
  };
  resolvedPlatformTag = resolved.platform;

  if (stream !== false) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const out = exportOpenAI();
    let finished = false;
    let toolCallIndex = 0;
    let started = false; // out.start 是否已下发（延迟到首个上游事件，保证流未开始时可整体轮换）

    const write = (bytes) => bytes.forEach((d) => { if (!res.writableEnded) res.write(d); });
    const ensureStart = () => {
      if (!started) {
        started = true;
        write(out.start(completionId, model));
      }
    };

    /**
     * 单轮流式消费。emitBytes=true 时边收边发给客户端（原行为）；
     * false 时只缓冲，供续写模式聚合后一次性下发。
     */
    const runRound = async (roundMessages, accountId, emitBytes) => {
      let roundContent = '';
      let roundFinish = null;
      let roundUsage = null;
      const roundToolCalls = [];
      let roundIncompleteTools = false;
      // 形状判定兜底（见 lib/sse-sniff.js）：上游忽略 stream=true 返回 JSON 时，
      // SSE 解析器一个事件都不产出，而这里会照样收尾成「正常结束、内容为空」。
      let sawEvent = false;
      let firstRaw = '';

      const handler = createStreamHandler((evt) => {
        sawEvent = true;
        switch (evt.type) {
          case 'text':
            if (evt.content) roundContent += evt.content;
            if (emitBytes) { ensureStart(); write(out.text(completionId, model, evt.content, evt.reasoning)); }
            break;
          case 'tool_call':
            roundToolCalls.push(evt.call);
            if (emitBytes) {
              ensureStart();
              write(out.toolCall(completionId, model, evt.call, toolCallIndex));
              toolCallIndex += 1;
            }
            break;
          case 'done':
            roundFinish = evt.finish_reason || 'stop';
            break;
          case 'error': {
            // 抛错交还账号池：流未开始时由外层整体轮换；已开始则由外层补错误帧
            requestError = evt.message;
            if (isRateLimitCode(evt.code)) pool.record(accountId, 'rate_limit', { model, message: evt.message });
            const e = new Error(evt.message || 'upstream stream error');
            e.code = 'UPSTREAM_STREAM_ERROR';
            if (evt.code != null) e.upstreamCode = evt.code;
            throw e;
          }
          case 'token_usage':
            roundUsage = evt.data || null;
            lastUsage = evt.data || null;
            return;
          default:
            return;
        }
      }, { userText, markIncomplete: config.markIncompleteToolArgs });

      const up = await llmUtilsChat(normalizeTraeMessages(roundMessages), model, true, { ...callOpts, accountId });
      const feeder = createLineFeeder((line) => handler.feedLine(line));
      await consumeStream(up.body, (text) => {
        if (firstRaw.length < 200) firstRaw += text.slice(0, 200 - firstRaw.length);
        feeder.feed(text);
      }, { requestId: completionId, accountId, model });
      feeder.flush();
      handler.flushToolAccum();

      // 没解析出任何事件 = 上游故障，不是「空回复成功」。抛错交还 pool.run：
      // 流未开始时整体轮换账号；已开始时由外层补错误帧。绝不让客户端拿到空答案。
      if (!sawEvent) {
        const kind = sniffHead(firstRaw);
        const e = new Error(`upstream sent no SSE event (shape=${kind}) for a streaming request`
          + (kind === 'json' ? '：上游忽略了 stream=true，返回的是完整 JSON 正文' : ''));
        e.status = 502;
        e.code = 'UPSTREAM_NOT_STREAM';
        throw e;
      }

      // B2：参数残缺的工具调用按截断收尾（不续写工具轮，交由客户端处置）
      if (handler.sawIncompleteToolArgs && handler.sawIncompleteToolArgs()) {
        roundFinish = 'length';
        roundIncompleteTools = true;
      }
      return { content: roundContent, finishReason: roundFinish, usage: roundUsage, toolCalls: roundToolCalls, incompleteTools: roundIncompleteTools };
    };

    const continueEnabled = config.autoContinue && config.maxContinues > 0;

    try {
      await pool.run(async (accountId) => {
        // 每次尝试使用独立的流解析状态；轮换重试时全部复位
        finished = false;
        toolCallIndex = 0;
        toolCalls = 0;
        started = false;
        requestError = null;

        // 续写模式需缓冲后再下发（已发出的半截内容无法撤回），故 emitBytes=false
        const emitDuringRound = !continueEnabled;

        let finalContent = '';
        let finalToolCalls = [];
        let finalReason = null;

        if (!continueEnabled) {
          const r = await runRound(messages, accountId, emitDuringRound);
          finalContent = r.content;
          finalToolCalls = r.toolCalls;
          finalReason = r.finishReason;
          toolCalls = r.toolCalls.length;
          continueCount = 0;
        } else {
          const agg = await runWithContinuation({
            callOnce: (msgs) => runRound(msgs, accountId, false),
            messages,
            maxContinues: config.maxContinues,
          });
          finalContent = agg.content;
          finalToolCalls = agg.toolCalls;
          finalReason = agg.finishReason;
          continueCount = agg.continues || 0;
        }

        req.accountId = accountId;
        ensureStart();

        if (continueEnabled) {
          // 聚合结果一次性下发
          if (finalContent) write(out.text(completionId, model, finalContent));
          finalToolCalls.forEach((c, i) => write(out.toolCall(completionId, model, c, i)));
          toolCalls = finalToolCalls.length;
        }

        if (!finished) {
          const fr = finalFinish(finalReason);
          finalFinishReason = fr;
          write(out.done(completionId, model, fr));
          finished = true;
        }
        if (!res.writableEnded) res.end();
      }, runOpts);
      if (req.accountId && stickyKey) sticky.bind(stickyKey, req.accountId);
      if (model && model !== 'auto') availability.markUsable(model);
    } catch (err) {
      requestError = err.message;
      requestStatus = err.status && err.status >= 400 ? err.status : 500;
      if (model && model !== 'auto' && isModelConfigError(err)) {
        availability.markUnavailable(model, err.message);
      }
      if (!res.writableEnded) {
        // SSE 头已下发，无法改状态码：code 传 429 让客户端识别为「过载可重试」
        write(out.error(completionId, model, err.upstreamCode ?? (err.status === 429 ? 429 : null), err.message));
        res.end();
      }
    } finally {
      logRequest({
        endpoint: '/v1/chat/completions',
        method: 'POST',
        model,
        account: req.accountId || null,
        status: requestStatus,
        toolCalls,
        toolsIn: tools ? tools.length : 0,
        durationMs: Date.now() - startedAt,
        error: requestError,
        platform: resolvedPlatformTag || undefined,
        pricedModel,
        ...usageFields(),
        ...finishFields(),
      });
    }
    return;
  }

  // 非流式分支
  try {
    const continueEnabled = config.autoContinue && config.maxContinues > 0;
    let up = null;
    let accountId = null;

    if (!continueEnabled) {
      const r = await pool.run(async (id) =>
        llmUtilsChat(normalizeTraeMessages(messages), model, false, { ...callOpts, accountId: id }), runOpts);
      up = r.result;
      accountId = r.accountId;
    } else {
      // 续写模式：逐轮调用，把截断的产出拼回上下文直到正常结束或达上限
      const agg = await runWithContinuation({
        messages,
        maxContinues: config.maxContinues,
        callOnce: async (msgs) => {
          const r = await pool.run(async (id) =>
            llmUtilsChat(normalizeTraeMessages(msgs), model, false, { ...callOpts, accountId: id }), runOpts);
          accountId = r.accountId;
          const d = (r.result && r.result.data) || {};
          const choice = (d.choices && d.choices[0]) || {};
          const msg = choice.message || {};
          return {
            content: msg.content || d.response || d.content || '',
            finishReason: choice.finish_reason || 'stop',
            toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
            usage: d.usage || null,
          };
        },
      });
      // 组装成本地 completion 对象，与原非流式响应形态保持一致
      up = {
        data: {
          id: completionId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: agg.content,
              ...(agg.toolCalls.length ? { tool_calls: agg.toolCalls } : {}),
            },
            finish_reason: agg.toolCalls.length
              ? (isTruncatedFinish(agg.finishReason) ? agg.finishReason : 'tool_calls')
              : (agg.finishReason || 'stop'),
          }],
          usage: agg.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        },
      };
      continueCount = agg.continues || 0;
    }

    req.accountId = accountId || req.accountId;
    if (stickyKey && accountId) sticky.bind(stickyKey, accountId);
    if (model && model !== 'auto') availability.markUsable(model);
    const data = up.data || {};
    if (data.usage && (data.usage.total_tokens || data.usage.prompt_tokens)) {
      lastUsage = data.usage; // 非流式：聚合层已回填真实 usage
    }
    if (data.choices && data.choices[0]) {
      const msg = data.choices[0].message || {};
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        toolCalls = msg.tool_calls.length;
        // 截断优先于 tool_calls：参数可能半截，报 tool_calls 会让客户端执行残缺调用
        const fr = data.choices[0].finish_reason;
        if (!isTruncatedFinish(fr)) data.choices[0].finish_reason = 'tool_calls';
      }
      finalFinishReason = data.choices[0].finish_reason || null;
      logRequest({
        endpoint: '/v1/chat/completions',
        method: 'POST',
        model,
        account: req.accountId,
        status: 200,
        toolCalls,
        toolsIn: tools ? tools.length : 0,
        durationMs: Date.now() - startedAt,
        platform: resolvedPlatformTag || undefined,
        pricedModel,
        ...usageFields(),
        ...finishFields(),
      });
      return res.json(data);
    }
    const content = data.response || data.content || '';
    finalFinishReason = 'stop';
    logRequest({
      endpoint: '/v1/chat/completions',
      method: 'POST',
      model,
      account: req.accountId,
      status: 200,
      toolCalls,
      toolsIn: tools ? tools.length : 0,
      durationMs: Date.now() - startedAt,
      platform: resolvedPlatformTag || undefined,
      pricedModel,
      ...usageFields(),
      ...finishFields(),
    });
    return res.json({
      id: completionId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: lastUsage ? {
        prompt_tokens: lastUsage.prompt_tokens || 0,
        completion_tokens: lastUsage.completion_tokens || 0,
        total_tokens: lastUsage.total_tokens || 0,
      } : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (err) {
    const status = err.status && err.status >= 400 ? err.status : 500;
    logRequest({
      endpoint: '/v1/chat/completions',
      method: 'POST',
      model,
      status,
      toolCalls,
      toolsIn: tools ? tools.length : 0,
      durationMs: Date.now() - startedAt,
      error: err.message,
    });
    return res.status(status).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

module.exports = router;
