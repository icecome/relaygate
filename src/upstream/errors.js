'use strict';
/**
 * upstream/errors.js — 错误分类与重试策略。
 * 吸收自 workbuddy2api 的稳定性设计：将上游错误分门别类，
 * 不同错误类型采用不同的重试/丢弃策略，避免无条件指数退避造成长阻塞。
 *
 * 业务码语义来自 platform/variant.js（单一事实源）：Trae 与 WorkBuddy 各有
 * 一套码，合并判定时取并集——分类器不区分平台，同一码在两个平台语义一致。
 */
const { sleep } = require('../lib/util');
const variant = require('../platform/variant');

const TRAE_ERR = variant.variantOf(variant.TRAE).errors;
const WB_ERR = variant.variantOf(variant.WORKBUDDY).errors;

/** 限流类业务码（两平台并集，去重）。 */
const RATE_LIMIT_CODES = Array.from(new Set([
  ...(TRAE_ERR.rateLimitCodes || []),
  ...(WB_ERR.rateLimitCodes || []),
]));

/** 模型在当前 function 下不可用。 */
const CODE_MODEL_UNAVAILABLE = TRAE_ERR.modelUnavailable;
/** 模型级限流（非账号问题，不冷却整号）。 */
const CODE_MODEL_RATE_LIMIT = WB_ERR.modelRateLimit ?? TRAE_ERR.modelRateLimit;
/** 套餐额度耗尽（账号级，应换号）。 */
const CODE_PLAN_LIMIT = TRAE_ERR.planLimit;

/**
 * 解析上游错误，返回分类标签。
 * @param {Error} err
 * @returns {'rate_limit'|'auth'|'network'|'5xx'|'quota'|'model'|'other'}
 */
function classifyError(err) {
  if (!err) return 'other';
  const msg = String(err.message || '');
  // 从消息体回填业务码（WorkBuddy 429 body: {"code":6004,...} 等）
  if (err.upstreamCode == null) {
    const m = msg.match(/"code"\s*:\s*(\d{3,5})/);
    if (m) err.upstreamCode = Number(m[1]);
  }
  // 套餐额度尽（账号级额度问题）：应换号；见 TRADEWORK-ASSISTANT-COMPARISON §1.4
  if (Number(err.upstreamCode) === CODE_PLAN_LIMIT || /PlanLimit|plan.?limit/i.test(msg)) return 'quota';
  if (err.status === 402 || /quota|积分已耗尽|余额不足|credits.?exhaust/i.test(msg)) return 'quota';
  // 模型级限流须先于泛化 429 判定：模型问题非账号问题，换号/冷却整号无意义
  if (isModelRateLimitError(err)) return 'model';
  // 模型在当前 function 下不可用（model config is empty）——模型问题非账号问题
  if (Number(err.upstreamCode) === CODE_MODEL_UNAVAILABLE || /model config is empty/i.test(msg)) return 'model';
  if (err.status >= 500 && err.status < 600) return '5xx';
  if (err.status === 401 || err.status === 403) return 'auth';
  // 上游 SSE 内嵌 error 事件（HTTP 200）时，错误码只能靠 err.upstreamCode 携带
  if (isRateLimitCode(err.upstreamCode) || err.status === 429 || RATE_LIMIT_CODES.some((c) => msg.includes(String(c)))) return 'rate_limit';
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED' || err.code === 'ENOTFOUND') {
    return 'network';
  }
  return 'other';
}

/** 上游业务码是否为限流类（SSE error 事件与异常对象共用）。 */
function isRateLimitCode(code) {
  return code != null && RATE_LIMIT_CODES.includes(Number(code));
}

/**
 * 是否为模型配置问题（上游业务码 modelUnavailable / "model config is empty"）：
 * 模型在当前 function 下不可用，属模型问题非账号问题。
 */
function isModelConfigError(err) {
  if (!err) return false;
  return Number(err.upstreamCode) === CODE_MODEL_UNAVAILABLE
    || err.status === CODE_MODEL_UNAVAILABLE
    || /model config is empty/i.test(String(err.message || ''));
}

/** 是否为套餐额度耗尽（planLimit）。 */
function isPlanLimitError(err) {
  if (!err) return false;
  return Number(err.upstreamCode) === CODE_PLAN_LIMIT || /PlanLimit|plan.?limit/i.test(String(err.message || ''));
}

/**
 * 是否为模型级限流（modelRateLimit / "exceeded the rate limit"）：
 * 模型在当前时刻被限流，属模型问题非账号问题，不冷却账号（对齐 Sliverkiss）。
 */
function isModelRateLimitError(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  if (Number(err.upstreamCode) === CODE_MODEL_RATE_LIMIT || err.status === CODE_MODEL_RATE_LIMIT) return true;
  // WorkBuddy 中文「使用量已超出频率限制…切换其他模型」；勿用过于宽泛的英文
  // “exceeded the rate limit”——那会把 3004 账号级限流误判成 model 类
  return /model rate limit/i.test(msg)
    || (/使用量已超出频率限制/.test(msg) && /切换其他模型/.test(msg));
}

/**
 * 是否值得重试：限流/网络/5xx 可重试；auth 与 other 不重试。
 */
function isRetryable(kind) {
  return kind === 'rate_limit' || kind === 'network' || kind === '5xx';
}

/**
 * 指数退避重试，仅对可重试错误生效。
 * @param {Function} fn
 * @param {{maxRetries?:number, baseDelay?:number}} opts
 */
async function retryWithBackoff(fn, opts = {}) {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelay = opts.baseDelay ?? 2000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const kind = classifyError(err);
      // 限流时上游恢复窗口远大于退避时长，同账号重试基本无意义，尽快交还账号池轮换
      const maxAttempt = kind === 'rate_limit' ? 1 : maxRetries;
      const last = attempt >= maxAttempt;
      if (!isRetryable(kind) || last) throw err;
      const wait = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
      console.log(`[retry] ${kind}, waiting ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${maxAttempt})`);
      await sleep(wait);
    }
  }
}

module.exports = {
  classifyError,
  isRetryable,
  retryWithBackoff,
  isRateLimitCode,
  isModelConfigError,
  isPlanLimitError,
  isModelRateLimitError,
  RATE_LIMIT_CODES,
};
