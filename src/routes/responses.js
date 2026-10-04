'use strict';
/**
 * routes/responses.js — OpenAI Responses 最小兼容（Codex 友好）。
 *
 * POST /v1/responses
 * 入参：{ model, input, instructions?, stream? }
 * 实现策略：映射为 Chat 消息 → 复用 llmUtilsChat（非流式聚合 / 简化 SSE）。
 * 完整 Responses 事件族（response.output_item.* 等）后续增强；当前保证：
 * - 非流式：response.completed + output 文本
 * - 流式：有限 SSE 事件（response.created / output_text.delta / completed）
 */
const { Router } = require('express');
const { llmUtilsChat, consumeStream } = require('../upstream/client');
const { isRateLimitCode } = require('../upstream/errors');
const { normalizeTraeMessages } = require('../transform/request');
const { createStreamHandler } = require('../transform/sse');
const { logRequest } = require('../log/traffic');
const pool = require('../credentials/pool');
const sticky = require('../session/sticky');
const { createLineFeeder } = require('../lib/sse-lines');
const config = require('../config');

const router = Router();

function inputToMessages(body) {
  const messages = [];
  if (body.instructions) {
    messages.push({ role: 'system', content: String(body.instructions) });
  }
  const input = body.input;
  if (typeof input === 'string' && input) {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item) continue;
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
      } else if (item.role && item.content != null) {
        messages.push({ role: item.role, content: item.content });
      } else if (item.type === 'message' && Array.isArray(item.content)) {
        const text = item.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('');
        messages.push({ role: item.role || 'user', content: text });
      }
    }
  }
  if (!messages.length) {
    throw new Error('input is required');
  }
  return messages;
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

router.post('/v1/responses', async (req, res) => {
  // 本端点仅实现 Trae 上游；WB Key / 虚拟模型调用时明确拒绝
  if (req.platform === 'workbuddy') {
    return res.status(400).json({
      error: {
        message: '/v1/responses currently supports Trae only. Use a trae-bound API key or universal key (all).',
        type: 'invalid_request_error',
      },
    });
  }
  const body = req.body || {};
  const model = body.model || 'auto';
  try {
    const { canUseModel, isVirtualModel } = require('../middleware/model-access');
    const acc = canUseModel(req.platform, model, req.authKey || null);
    if (!acc.ok || isVirtualModel(model) || String(model).startsWith('wb/')) {
      return res.status(403).json({
        error: {
          message: acc.ok
            ? `/v1/responses currently supports Trae models only (got "${model}").`
            : acc.message,
          type: 'auth_error',
          code: 'MODEL_ACCESS_DENIED',
        },
      });
    }
  } catch { /* ignore */ }
  const stream = body.stream !== false;
  const startedAt = Date.now();

  let messages;
  try {
    messages = inputToMessages(body);
  } catch (e) {
    return res.status(400).json({ error: { message: e.message, type: 'invalid_request_error' } });
  }

  const stickyKey = sticky.stickyKeyFromRequest(req);
  const stickyAccountId = sticky.lookup(stickyKey);
  const responseId = `resp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    sseWrite(res, 'response.created', {
      type: 'response.created',
      response: { id: responseId, status: 'in_progress', model },
    });

    let streamAccountId = null;
    let lastUsage = null;
    try {
      const { result: up, accountId } = await pool.run(async (accountId) =>
        llmUtilsChat(normalizeTraeMessages(messages), model, true, { tools: body.tools, accountId }),
        { stickyKey, stickyAccountId });
      streamAccountId = accountId;
      if (stickyKey && accountId) sticky.bind(stickyKey, accountId);

      const handler = createStreamHandler((evt) => {
        if (evt.type === 'text' && evt.content) {
          sseWrite(res, 'response.output_text.delta', {
            type: 'response.output_text.delta',
            delta: evt.content,
          });
        } else if (evt.type === 'token_usage') {
          lastUsage = evt.data || null;
        } else if (evt.type === 'error') {
          // 上游流内错误（如 3004）：转成异常走统一 catch，回灌账号池并返回 response.failed
          const e = new Error(evt.message || 'upstream stream error');
          e.code = 'UPSTREAM_STREAM_ERROR';
          if (evt.code != null) e.upstreamCode = evt.code;
          throw e;
        }
      }, { markIncomplete: config.markIncompleteToolArgs });
      // 保留跨块残行：上游 JSON 事件被 chunk 边界切开时，整行解析会失败并丢事件
      const feeder = createLineFeeder((line) => handler.feedLine(line));
      await consumeStream(up.body, (text) => feeder.feed(text));
      feeder.flush();
      handler.flushToolAccum();
      sseWrite(res, 'response.completed', {
        type: 'response.completed',
        response: { id: responseId, status: 'completed', model, account_id: accountId || null },
      });
      res.end();
      logRequest({
        endpoint: '/v1/responses', method: 'POST', model, account: accountId, status: 200,
        durationMs: Date.now() - startedAt,
        promptTokens: lastUsage ? lastUsage.prompt_tokens || 0 : 0,
        completionTokens: lastUsage ? lastUsage.completion_tokens || 0 : 0,
        totalTokens: lastUsage ? lastUsage.total_tokens || 0 : 0,
      });
    } catch (err) {
      // 流内错误经 handler 抛出，这里回灌账号池触发冷却/轮换
      if (isRateLimitCode(err.upstreamCode) && streamAccountId) pool.record(streamAccountId, 'rate_limit');
      const status = err.status && err.status >= 400 ? err.status : 500;
      sseWrite(res, 'response.failed', {
        type: 'response.failed',
        response: {
          id: responseId,
          status: 'failed',
          error: { message: err.message, code: err.status === 429 ? 'overloaded' : null },
        },
      });
      res.end();
      logRequest({ endpoint: '/v1/responses', method: 'POST', model, status, durationMs: Date.now() - startedAt, error: err.message });
    }
    return;
  }

  // 非流式
  try {
    const { result: up, accountId } = await pool.run(async (accountId) =>
      llmUtilsChat(normalizeTraeMessages(messages), model, false, { tools: body.tools, accountId }),
      { stickyKey, stickyAccountId });
    if (stickyKey && accountId) sticky.bind(stickyKey, accountId);
    const data = up.data || {};
    let text = '';
    if (data.choices && data.choices[0]) {
      const m = data.choices[0].message || {};
      text = m.content || '';
      if (Array.isArray(text)) text = text.map((c) => c.text || '').join('');
    } else {
      text = data.response || data.content || '';
    }
    logRequest({ endpoint: '/v1/responses', method: 'POST', model, account: accountId, status: 200, durationMs: Date.now() - startedAt });
    res.json({
      id: responseId,
      object: 'response',
      status: 'completed',
      model,
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: String(text) }],
        },
      ],
      output_text: String(text),
      usage: data.usage || null,
    });
  } catch (err) {
    const status = err.status && err.status >= 400 ? err.status : 500;
    logRequest({ endpoint: '/v1/responses', method: 'POST', model, status, durationMs: Date.now() - startedAt, error: err.message });
    res.status(status).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

module.exports = router;
