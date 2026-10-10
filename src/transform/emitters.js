'use strict';
/**
 * transform/emitters.js — 双协议输出发射器（纯函数，可单测）。
 * 把归一化的 stream event ({type:'text'|'tool_call'|'done'|'error'|'token_usage'})
 * 渲染成 OpenAI SSE 或 Anthropic SSE 字节块。
 */
const now = () => Math.floor(Date.now() / 1000);

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// ---------- OpenAI ----------
function openaiChunk(id, model, delta, finishReason) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: now(),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason || null }],
  };
}

function exportOpenAI() {
  return {
    start(id, model) { return [sse(openaiChunk(id, model, { role: 'assistant', content: '' }, null))]; },
    text(id, model, content, reasoning) {
      const delta = {};
      if (content) delta.content = content;
      if (reasoning) delta.reasoning_content = reasoning;
      if (!Object.keys(delta).length) return [];
      return [sse(openaiChunk(id, model, delta, null))];
    },
    toolCall(id, model, call, index) {
      const idx = typeof index === 'number' ? index : 0;
      return [sse(openaiChunk(id, model, {
        tool_calls: [{
          index: idx,
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments || '{}' },
        }],
      }, null))];
    },
    done(id, model, finishReason) {
      return [sse(openaiChunk(id, model, {}, finishReason)), 'data: [DONE]\n\n'];
    },
    /**
     * 流内错误帧。
     *
     * 历史实现把错误文本塞进 delta.content（`[Error 3004: …]`），HTTP 仍是 200，
     * 且没有 finish_reason、没有 [DONE] —— agent 客户端会把这段错误当成模型
     * 输出并入对话上下文，污染后续所有轮次。
     *
     * 现在按 OpenAI 生态通行做法发三帧：
     *   1) finish_reason:'stop' 的空 delta —— 不检查错误的客户端能正常收尾；
     *   2) 顶层 error 对象 —— 官方 SDK 遇到 chunk 内 error 会抛 APIError；
     *   3) [DONE] —— 明确结束，客户端不会永远等下去。
     * 错误文本一律不进 content。
     */
    error(id, model, code, message) {
      const detail = message || 'upstream error';
      return [
        sse(openaiChunk(id, model, {}, 'stop')),
        sse({
          error: {
            message: detail,
            type: 'upstream_error',
            ...(code != null ? { code } : {}),
          },
        }),
        'data: [DONE]\n\n',
      ];
    },
    stop() { return ['data: [DONE]\n\n']; },
  };
}

// ---------- Anthropic ----------
function anthropicContentBlock(text) {
  return { type: 'text', text };
}

function exportAnthropic() {
  return {
    start(id, model) { return []; }, // message_start 由路由层控制更精细
    text(id, model, content, reasoning) {
      // Anthropic 无 reasoning 字段时仅输出 content
      return content ? [sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } })] : [];
    },
    toolCall(id, model, call) {
      return [sse({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: call.id, name: call.name, input: safeParse(call.arguments) },
      }), sse({ type: 'content_block_stop', index: 0 })];
    },
    done(id, model, finishReason) {
      return [sse({ type: 'message_delta', delta: { stop_reason: finishReason || 'end_turn' } })];
    },
    error(id, model, code, message) {
      return [sse({ type: 'error', error: { type: 'api_error', message: `${code || ''} ${message || ''}` } })];
    },
    stop() { return []; },
  };
}

/** 把 JSON 字符串的参数解析为对象供 Anthropic input 使用，解析失败则用 {}。 */
function safeParse(args) {
  if (!args) return {};
  if (typeof args === 'object') return args;
  try { return JSON.parse(args); } catch (e) { return {}; }
}

module.exports = { exportOpenAI, exportAnthropic, sse };