'use strict';
/**
 * lib/token-precise.js — 上游未回传 usage 时的 token 补算。
 *
 * 为什么需要：流量统计里 unmetered 请求的 token 恒为 0，费用估算无从下手。
 * 上游 usage 是权威口径，本模块只在它缺失时兜底，且结果始终标记为估算值。
 *
 * 口径说明（重要）：
 * - 分词器取 cl100k_base（OpenAI 口径）。Trae / WorkBuddy 侧的模型
 *   （Doubao / GLM / Kimi / DeepSeek 等）并非 OpenAI 分词器，
 *   cl100k 对中文约 1 token/字，与这些模型普遍接近但**并不一致**，
 *   因此补算值只用于趋势与量级参考，不可当作账单精确值。
 * - 输入侧按 messages 逐条累计（含结构开销与工具参数）；
 *   输出侧由调用方传入已聚合的助手文本，二者相加为总 token。
 */
const { estimatePromptTokensPrecise } = require('./token-estimate');

/**
 * 补算一次请求的 token。
 * @param {Array} messages 请求上下文（OpenAI 形态）
 * @param {string} [outputText] 已聚合的助手输出文本；无则只算输入侧
 * @returns {{promptTokens:number, completionTokens:number, totalTokens:number}}
 */
function estimateTokensOfText(messages, outputText) {
  const promptTokens = estimatePromptTokensPrecise(messages);
  const completionTokens = outputText ? estimatePromptTokensPrecise([{ role: 'assistant', content: outputText }]) : 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

module.exports = { estimateTokensOfText };
