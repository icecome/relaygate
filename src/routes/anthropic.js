'use strict';
/**
 * routes/anthropic.js — Anthropic /v1/messages（SSE 流式 + tool_use 输出）。
 *
 * Anthropic 消息格式：content 为 block 数组，assistant 输出 tool_use、user 可带 tool_result。
 * 此处转换为 OpenAI 风格 messages 供上传，再用 exportAnthropic 渲染回 Anthropic 流。
 */
const { Router } = require('express');
const { llmUtilsChat, consumeStream } = require('../upstream/client');
const { isRateLimitCode } = require('../upstream/errors');
const { createStreamHandler } = require('../transform/sse');
const { exportAnthropic } = require('../transform/emitters');
const { logRequest } = require('../log/traffic');
const pool = require('../credentials/pool');
const { createLineFeeder } = require('../lib/sse-lines');

const router = Router();

// Anthropic block → 文本
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
            out.push({ role: 'tool', tool_call_id: b.tool_use_id || '', content: [{ type: 'text', text: blockToText(b) }] });
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

router.post('/v1/messages', async (req, res) => {
  // 本端点仅实现 Trae 上游；WB Key / 虚拟模型调用时明确拒绝
  if (req.platform === 'workbuddy') {
    return res.status(400).json({
      error: {
        message: '/v1/messages currently supports Trae only. Use a trae-bound API key or universal key (all).',
        type: 'invalid_request_error',
      },
    });
  }
  const { model = 'glm-5', messages, system, max_tokens, tools, stream = true } = req.body || {};
  try {
    const { canUseModel, isVirtualModel } = require('../middleware/model-access');
    const acc = canUseModel(req.platform, model, req.authKey || null);
    if (!acc.ok || isVirtualModel(model) || String(model).startsWith('wb/')) {
      return res.status(403).json({
        error: {
          message: acc.ok
            ? `/v1/messages currently supports Trae models only (got "${model}").`
            : acc.message,
          type: 'auth_error',
          code: 'MODEL_ACCESS_DENIED',
        },
      });
    }
  } catch { /* model-access 加载失败不阻断主路径 */ }
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: { type: 'invalid_request_error', message: 'messages is required' } });
  }

  const startedAt = Date.now();
  const msgId = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let lastUsage = null;
  let requestError = null;
  let requestStatus = 200;
  let toolCallCount = 0;

  const built = anthropicToOpenAI(messages);
  if (system) {
    built.unshift({ role: 'system', content: [{ type: 'text', text: Array.isArray(system) ? system.map((s) => s.text || '').join('\n') : system }] });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // message_start
  res.write(`data: ${JSON.stringify({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);

  const out = exportAnthropic();
  let hadToolCall = false;
  let streamAccountId = null; // 流式错误回灌账号池用（pool.run 成功后赋值）
  const handler = createStreamHandler((evt) => {
    let bytes = [];
    switch (evt.type) {
      case 'text': bytes = out.text(msgId, model, evt.content, evt.reasoning); break;
      case 'tool_call': hadToolCall = true; toolCallCount += 1; bytes = out.toolCall(msgId, model, evt.call); break;
      case 'token_usage': lastUsage = evt.data || null; return;
      case 'error':
        requestError = evt.message;
        if (isRateLimitCode(evt.code) && streamAccountId) pool.record(streamAccountId, 'rate_limit');
        bytes = out.error(msgId, model, evt.code, evt.message);
        break;
      default: return;
    }
    bytes.forEach((d) => { if (!res.writableEnded) res.write(d); });
  });

  try {
    const { result: up, accountId } = await pool.run(async (accountId) =>
      llmUtilsChat(built, model, true, { tools, max_tokens, accountId }));
    streamAccountId = accountId;
    const feeder = createLineFeeder((line) => handler.feedLine(line));
    await consumeStream(up.body, (text) => feeder.feed(text));
    feeder.flush();
    handler.flushToolAccum();
    if (!res.writableEnded) {
      if (hadToolCall) {
        res.write(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 0 } })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } })}\n\n`);
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
    logRequest({
      endpoint: '/v1/messages',
      method: 'POST',
      model,
      account: streamAccountId || null,
      status: requestStatus,
      toolCalls: toolCallCount,
      toolsIn: tools ? tools.length : 0,
      durationMs: Date.now() - startedAt,
      error: requestError,
      promptTokens: lastUsage ? lastUsage.prompt_tokens || 0 : 0,
      completionTokens: lastUsage ? lastUsage.completion_tokens || 0 : 0,
      totalTokens: lastUsage ? lastUsage.total_tokens || 0 : 0,
    });
  }
});

module.exports = router;