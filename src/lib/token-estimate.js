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

/**
 * 精确模式的字符上限。js-tiktoken 为同步 BPE，40K 字符约 150ms，
 * 超限输入（如 1M 窗口装满的会话）会阻塞事件循环数百毫秒——
 * 估算口径下这个代价不值，超过上限直接回退启发式。
 */
const PRECISE_CHAR_LIMIT = 60_000;

let _encoder = null;
let _encoderFailed = false;

/** 懒加载 tiktoken 编码器（首次调用约 100-300ms，之后复用）。失败则永久回退启发式。 */
function getEncoder() {
  if (_encoder) return _encoder;
  if (_encoderFailed) return null;
  try {
    _encoder = require('js-tiktoken').getEncoding('cl100k_base');
  } catch {
    _encoderFailed = true;
    _encoder = null;
  }
  return _encoder;
}

function textTokens(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  const cjk = (s.match(/[\u3400-\u9fff]/g) || []).length;
  const other = s.length - cjk;
  return Math.ceil(cjk * CJK_TOKEN_PER_CHAR + other / CHARS_PER_TOKEN);
}

/**
 * 真实分词器计数（cl100k_base）。上游未回传 usage 时的补算口径。
 * 已知偏差：Trae/WorkBuddy 侧模型（Doubao/GLM/Kimi/DeepSeek 等）并非
 * OpenAI 分词器，cl100k 对 CJK 约 1 token/字，与上述模型普遍接近但非一致；
 * 结果仍标注 estimated，不当作账单精确值。
 */
function textTokensPrecise(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  if (s.length > PRECISE_CHAR_LIMIT) return textTokens(s);
  const enc = getEncoder();
  if (!enc) return textTokens(s);
  try {
    return enc.encode(s).length;
  } catch {
    return textTokens(s);
  }
}

function contentTokens(content, precise) {
  const tokOf = precise ? textTokensPrecise : textTokens;
  if (content == null) return 0;
  if (typeof content === 'string') return tokOf(content);
  if (!Array.isArray(content)) return tokOf(JSON.stringify(content));
  let sum = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string') sum += tokOf(part.text);
    else if (/image/i.test(String(part.type || ''))) sum += IMAGE_TOKENS;
    else sum += tokOf(JSON.stringify(part));
  }
  return sum;
}

function estimateTokensOf(messages, precise) {
  const tokOf = precise ? textTokensPrecise : textTokens;
  let total = 0;
  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue;
    total += PER_MESSAGE_OVERHEAD;
    total += contentTokens(m.content, precise);
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = (tc && (tc.function || tc.function_call)) || {};
        total += tokOf(fn.name) + tokOf(fn.arguments);
      }
    }
  }
  return total;
}

function estimatePromptTokens(messages) {
  return estimateTokensOf(messages, false);
}

/** 与 estimatePromptTokens 同口径，但用真实分词器（超限自动回退启发式）。 */
function estimatePromptTokensPrecise(messages) {
  return estimateTokensOf(messages, true);
}

module.exports = {
  estimatePromptTokens,
  estimatePromptTokensPrecise,
  textTokens,
  textTokensPrecise,
  IMAGE_TOKENS,
  PER_MESSAGE_OVERHEAD,
  PRECISE_CHAR_LIMIT,
};
