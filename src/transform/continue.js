'use strict';
/**
 * transform/continue.js — 截断自动续写（AUTO_CONTINUE）。
 *
 * 背景：上游因输出上限中断（finish_reason=length）时，客户端只会看到半截内容。
 * 网关把已产出内容作为 assistant 上文拼回，再请求一次，直到上游自然结束或
 * 达到 MAX_CONTINUES 上限。对客户端表现为一次完整回复。
 *
 * 边界（刻意不做的事）：
 * - 不做跨平台续写（trae 与 workbuddy 各自独立）；
 * - 工具调用被截断时不续写：残缺工具参数拼接可能导致二次错误，交由客户端处置。
 */

/** 续写提示词：要求直接继续，不要重复已输出内容、不要重新开头。 */
const CONTINUE_PROMPT = '继续输出剩余内容。不要重复已经输出的部分，不要重新开头或添加任何说明前缀。';

/**
 * 是否需要为该结束原因触发续写。
 * 仅 length / max_tokens 触发；content_filter 是内容策略拦截，重试无意义。
 * @param {string|null|undefined} finish
 */
function shouldContinue(finish) {
  return finish === 'length' || finish === 'max_tokens';
}

/**
 * 构造续写请求的 messages：原文 + 已产出的 assistant 内容 + 续写指令。
 * @param {Array} messages 原始请求 messages
 * @param {string} produced 已产出的 assistant 文本
 * @returns {Array}
 */
function buildContinueMessages(messages, produced) {
  const out = Array.isArray(messages) ? messages.slice() : [];
  if (!produced) return out;
  out.push({ role: 'assistant', content: produced });
  out.push({ role: 'user', content: CONTINUE_PROMPT });
  return out;
}

/**
 * 执行带续写的聚合调用。
 *
 * @param {object} deps
 * @param {(messages:Array)=>Promise<{content:string, finishReason:string|null, usage:object|null, toolCalls:Array}>} deps.callOnce
 *        单次调用；返回该轮的产出与结束原因
 * @param {Array} deps.messages 原始 messages
 * @param {number} deps.maxContinues 最大续写次数（0 = 不续写）
 * @returns {Promise<{content:string,toolCalls:Array,finishReason:string|null,usage:object|null,continues:number,truncated:boolean}>}
 */
async function runWithContinuation({ callOnce, messages, maxContinues }) {
  const limit = Math.max(0, Number(maxContinues) || 0);
  let content = '';
  let toolCalls = [];
  let finishReason = null;
  let usage = null;
  let continues = 0;
  let rounds = [messages];

  for (let i = 0; ; i++) {
    const round = await callOnce(rounds[rounds.length - 1]);
    if (round && round.content) content += round.content;
    if (round && Array.isArray(round.toolCalls) && round.toolCalls.length) {
      toolCalls = toolCalls.concat(round.toolCalls);
    }
    if (round && round.usage) usage = round.usage;
    finishReason = (round && round.finishReason) || finishReason;

    // 有工具调用即停止续写：残缺工具参数二次拼接风险高，交由客户端处置
    if (toolCalls.length) break;
    if (i >= limit) break;
    if (!shouldContinue(finishReason)) break;

    continues++;
    rounds.push(buildContinueMessages(messages, content));
  }

  return {
    content,
    toolCalls,
    finishReason,
    usage,
    continues,
    // 到达上限仍在截断 => 客户端拿到的仍是截断内容，如实标记
    truncated: shouldContinue(finishReason),
  };
}

module.exports = {
  CONTINUE_PROMPT,
  shouldContinue,
  buildContinueMessages,
  runWithContinuation,
};
