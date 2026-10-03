'use strict';
/**
 * routes/openai.js — OpenAI /v1/chat/completions（SSE + 非流式）。
 *
 * Agent 关键：有 tool_calls 时 finish_reason 必须是 tool_calls，
 * 否则客户端会在首段文本后把任务当成已完成而自动停止。
 */
const { Router } = require('express');
const { llmUtilsChat, consumeStream } = require('../upstream/client');
const { isRateLimitCode, isModelConfigError } = require('../upstream/errors');
const wbChat = require('../workbuddy/chat');
const auth = require('../auth');
const { normalizeTraeMessages } = require('../transform/request');
const { createStreamHandler } = require('../transform/sse');
const { exportOpenAI } = require('../transform/emitters');
const { logRequest } = require('../log/traffic');
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
 * 通用密钥（platform=all）按模型名分派到实际上游平台。
 * 虚拟模型在调用前已拦截到 model-router，此处只处理物理模型。
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
 * - trae：若误带 wb/ 前缀则报错（应换 WB Key / 通用 Key）
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
  // WB 独有且 Trae 未登记：明确报错，避免上游 4001 难排查
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
  } = body;
  const tools = extractTools(body);
  const startedAt = Date.now();
  let toolCalls = 0;
  let requestError = null;
  let requestStatus = 200;
  let lastUsage = null; // 上游 token_usage 事件（流式/非流式均捕获）
  const usageFields = () => {
    const pt = lastUsage ? (lastUsage.prompt_tokens || 0) : 0;
    const ct = lastUsage ? (lastUsage.completion_tokens || 0) : 0;
    const tt = lastUsage ? (lastUsage.total_tokens || 0) : 0;
    const base = lastUsage ? { promptTokens: pt, completionTokens: ct, totalTokens: tt } : {};
    // 费用估算：有 token 用量时按模型费率估算积分（T5）
    if (pt || ct || tt) {
      const c = estimateCost(model, pt, ct);
      if (c != null) base.estimatedCost = c;
    }
    return base;
  };

  const userText = lastUserText(messages);

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'messages is required', type: 'invalid_request_error' } });
  }

  // 虚拟模型 ID：走 model-router 分发（限流自动切换 / 优先级权重）
  // 权限：通用密钥（all）可调；平台密钥拒绝
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
        max_tokens,
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
          error: { message: err.message, type: 'upstream_error' },
        });
      }
    }
    return;
  }

  // ===== 密钥权限 + 平台路由 =====
  // 通用密钥（all）：虚拟模型 / 按模型名自动分派 trae|workbuddy
  // 平台密钥：仅本平台；虚拟模型与外平台模型拒绝
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
    const wbBody = {
      model: wbModel,
      messages,
      temperature, top_p, max_tokens, stop,
      tools: tools || undefined,
      tool_choice,
    };
    const wbStickyKey = sticky.stickyKeyFromRequest(req);
    const wbStickyAcct = sticky.lookup(wbStickyKey);
    const wbRunOpts = { stickyKey: wbStickyKey, stickyAccountId: wbStickyAcct, edition: 'workbuddy' };
    try {
      if (stream !== false) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        await pool.run(async (accountId) => {
          const acct = await auth.ensureAuth(accountId);
          req.accountId = accountId;
          const up = await wbChat.chatStream(acct, Object.assign({ stream: true }, wbBody));
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
          // SSE 直通（上游即 OpenAI 格式）
          await consumeStream(up.body, (text) => { if (!res.writableEnded) res.write(text); });
          if (!res.writableEnded) res.end();
        }, wbRunOpts);
      } else {
        const { result } = await pool.run(async (accountId) => {
          const acct = await auth.ensureAuth(accountId);
          req.accountId = accountId;
          if (wbStickyKey && accountId) sticky.bind(wbStickyKey, accountId);
          return wbChat.chatAggregate(acct, Object.assign({}, wbBody, { stream: true }));
        }, wbRunOpts);
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
      logRequest({
        endpoint: '/v1/chat/completions', method: 'POST', model,
        account: req.accountId || null,
        status: requestError ? 500 : 200,
        toolCalls: 0, toolsIn: tools ? tools.length : 0,
        durationMs: Date.now() - startedAt,
        error: requestError,
        platform: 'workbuddy',
        wbModel,
      });
    }
    return;
  }

  const completionId = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const stickyKey = sticky.stickyKeyFromRequest(req);
  const stickyAccountId = sticky.lookup(stickyKey);
  const runOpts = { stickyKey, stickyAccountId };

  const callOpts = {
    tools: tools || undefined,
    tool_choice: tool_choice || undefined,
    userText,
    temperature: typeof temperature === 'number' ? temperature : undefined,
    top_p: typeof top_p === 'number' ? top_p : undefined,
    max_tokens: typeof max_tokens === 'number' ? max_tokens : undefined,
    seed: typeof seed === 'number' ? seed : undefined,
    stop: Array.isArray(stop) ? stop : undefined,
  };

  if (stream !== false) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const out = exportOpenAI();
    let finished = false;
    let toolCallIndex = 0;
    let started = false; // out.start 是否已下发（延迟到首个上游事件，保证流未开始时可整体轮换）
    const finishReason = () => (toolCalls > 0 ? 'tool_calls' : 'stop');

    const write = (bytes) => bytes.forEach((d) => { if (!res.writableEnded) res.write(d); });
    const ensureStart = () => {
      if (!started) {
        started = true;
        write(out.start(completionId, model));
      }
    };

    try {
      await pool.run(async (accountId) => {
        // 每次尝试独立的流解析状态；轮换重试时全部复位
        finished = false;
        toolCallIndex = 0;
        toolCalls = 0;
        started = false;
        requestError = null;

        const handler = createStreamHandler((evt) => {
          let bytes = [];
          switch (evt.type) {
            case 'text':
              ensureStart();
              bytes = out.text(completionId, model, evt.content, evt.reasoning);
              break;
            case 'tool_call':
              ensureStart();
              toolCalls += 1;
              bytes = out.toolCall(completionId, model, evt.call, toolCallIndex);
              toolCallIndex += 1;
              break;
            case 'done':
              ensureStart();
              if (!finished) {
                bytes = out.done(completionId, model, evt.finish_reason === 'tool_calls' ? 'tool_calls' : finishReason());
                finished = true;
              }
              break;
            case 'error':
              requestError = evt.message;
              if (!started) {
                // 流未开始（一个字节都没发给客户端）：抛错交还账号池冷却并轮换。
                // 多数 3004 限流在首个 output 之前到达，此窗口轮换收益最大。
                const e = new Error(evt.message || 'upstream stream error');
                e.code = 'UPSTREAM_STREAM_ERROR';
                if (evt.code != null) e.upstreamCode = evt.code;
                throw e;
              }
              // 已有输出后的流内错误：回灌账号池冷却，并向客户端下发错误事件
              if (isRateLimitCode(evt.code)) pool.record(accountId, 'rate_limit');
              bytes = out.error(completionId, model, evt.code, evt.message);
              break;
            case 'token_usage':
              // 上游真实 token 消耗（进流量日志，供门户展示）
              lastUsage = evt.data || null;
              return;
            default:
              return;
          }
          write(bytes);
        }, { userText });

        const up = await llmUtilsChat(normalizeTraeMessages(messages), model, true, { ...callOpts, accountId });
        req.accountId = accountId;
        const feeder = createLineFeeder((line) => handler.feedLine(line));
        await consumeStream(up.body, (text) => feeder.feed(text), { requestId: completionId, accountId, model });
        feeder.flush();
        handler.flushToolAccum();
        ensureStart();
        if (!finished && !res.writableEnded) {
          write(out.done(completionId, model, finishReason()));
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
        ...usageFields(),
      });
    }
    return;
  }

  // ----- 非流式 -----
  try {
    const { result: up, accountId } = await pool.run(async (accountId) =>
      llmUtilsChat(normalizeTraeMessages(messages), model, false, { ...callOpts, accountId }), runOpts);
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
        // Agent 关键：有 tool_calls 时强制 tool_calls，避免上游误写 stop 导致客户端提前收工
        data.choices[0].finish_reason = 'tool_calls';
      }
      logRequest({
        endpoint: '/v1/chat/completions',
        method: 'POST',
        model,
        account: req.accountId,
        status: 200,
        toolCalls,
        toolsIn: tools ? tools.length : 0,
        durationMs: Date.now() - startedAt,
        ...usageFields(),
      });
      return res.json(data);
    }
    const content = data.response || data.content || '';
    logRequest({
      endpoint: '/v1/chat/completions',
      method: 'POST',
      model,
      account: req.accountId,
      status: 200,
      toolCalls,
      toolsIn: tools ? tools.length : 0,
      durationMs: Date.now() - startedAt,
      ...usageFields(),
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
