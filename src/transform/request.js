'use strict';
/**
 * transform/request.js — 请求侧消息规范化（纯函数，可单测）。
 * 把 OpenAI/Anthropic 混合格式的 messages 统一为 llm_utils_chat 需要的 LLMRawMessageContent 数组格式，
 * 并保留原生 assistant tool_calls 与 role=tool 结果，避免多轮工具历史退化为纯文本。
 */
function toContentArray(content) {
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? { type: 'text', text: c } : c));
  }
  return [{ type: 'text', text: String(content == null ? '' : content) }];
}

function normalizeTraeMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    const content = toContentArray(m.content);

    // assistant 携带原生 tool_calls：保结构，使多轮循环收敛，而非退化为文本
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const tc = m.tool_calls.map((c) => {
        const fn = c.function_call || c.function || {};
        return {
          id: c.id,
          type: 'function',
          function_call: {
            name: fn.name,
            arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
          },
        };
      });
      out.push({ role: 'assistant', content: [], tool_calls: tc });
      continue;
    }

    // role=tool：保留真实执行结果，供模型下一轮参考
    if (m.role === 'tool') {
      const text = content.map((c) => (c && c.text != null ? c.text : JSON.stringify(c))).join('\n');
      out.push({ role: 'tool', tool_call_id: m.tool_call_id || '', content: [{ type: 'text', text }] });
      continue;
    }

    out.push({ role: m.role, content });
  }

  // 合并连续 user 消息（上游可能拒绝连续同角色 user）
  const merged = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === 'user' && m.role === 'user') {
      last.content.push(...m.content);
    } else {
      merged.push(m);
    }
  }
  return merged;
}

module.exports = { normalizeTraeMessages, toContentArray };