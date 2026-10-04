'use strict';
/**
 * lib/token-estimate.js — 请求上下文的 token 粗估（纯函数）。
 *
 * 用途：虚拟模型声明 contextWindow 后，网关在分发前估算 prompt token，
 * 超限显式返回 400（context_length_exceeded），避免上游静默截断头部
 * 导致会话记忆错乱、幻觉。
 *
 * 估算是量级近似（非 tokenizer 精确值）：中文按 0.7 token/字，
 * 其它按 4 字符/token，每条消息附加 8 token 结构开销，图片计固定值。
 * 已知偏差（可接受）：CJK 检测范围 \u3400-\u9fff 不含全角标点，
 * 全角标点按 0.25 token/字计，中文文本整体约低估 3-7%——
 * 只影响守门阈值精度，不改变拦截"量级偏差"的设计目标。
 * 精度目标是拦住"客户端按 1M 规划、真实窗口 168K"这类量级偏差，
 * 不是计费口径。
 */

const IMAGE_TOKENS = 1000;
const PER_MESSAGE_OVERHEAD = 8;
const CJK_TOKEN_PER_CHAR = 0.7;
const CHARS_PER_TOKEN = 4;

function textTokens(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  const cjk = (s.match(/[\u3400-\u9fff]/g) || []).length;
  const other = s.length - cjk;
  return Math.ceil(cjk * CJK_TOKEN_PER_CHAR + other / CHARS_PER_TOKEN);
}

function contentTokens(content) {
  if (content == null) return 0;
  if (typeof content === 'string') return textTokens(content);
  if (!Array.isArray(content)) return textTokens(JSON.stringify(content));
  let sum = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string') sum += textTokens(part.text);
    else if (/image/i.test(String(part.type || ''))) sum += IMAGE_TOKENS;
    else sum += textTokens(JSON.stringify(part));
  }
  return sum;
}

function estimatePromptTokens(messages) {
  let total = 0;
  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue;
    total += PER_MESSAGE_OVERHEAD;
    total += contentTokens(m.content);
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = (tc && (tc.function || tc.function_call)) || {};
        total += textTokens(fn.name) + textTokens(fn.arguments);
      }
    }
  }
  return total;
}

module.exports = { estimatePromptTokens, textTokens, IMAGE_TOKENS, PER_MESSAGE_OVERHEAD };
