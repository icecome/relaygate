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
/** WorkBuddy 侧「模型服务不存在 / 后端类型不支持」的业务码。 */
const WB_MODEL_UNAVAILABLE_CODES = Array.from(new Set([
  WB_ERR.modelUnavailable,
  WB_ERR.modelBackendUnsupported,
].filter((c) => Number.isFinite(Number(c)))));
/** 模型级限流（非账号问题，不冷却整号）。 */
const CODE_MODEL_RATE_LIMIT = WB_ERR.modelRateLimit ?? TRAE_ERR.modelRateLimit;
/** 套餐额度耗尽（账号级，应换号）。 */
const CODE_PLAN_LIMIT = TRAE_ERR.planLimit;
/**
 * 渠道校验拒绝（WorkBuddy 2026-10-21 起）：HTTP 400，
 * {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}。
 *
 * 语义是「请求形状不像官方客户端」——与账号权益、模型可用性、限流都无关。
 * 因此：不冷却账号（账号本身健康），不在同平台内换候选（换模型同样是同一个
 * 渠道校验），但**允许 failover 到其它平台**（Trae 链路有自己的身份体系）。
 */
const CODE_CHANNEL_BLOCKED = WB_ERR.channelBlocked;
/**
 * 上下文窗口超限码（两平台并集）：WorkBuddy 11115；Trae 无独立码（null），
 * 靠 isContextLengthError 的文案正则兜底。
 */
const CONTEXT_TOO_LONG_CODES = Array.from(new Set([
  TRAE_ERR.contextTooLong,
  WB_ERR.contextTooLong,
].filter((c) => Number.isFinite(Number(c)))));

/** 上游 context_length / "prompt is too long" 的识别（两平台同语义）。 */
function isContextLengthError(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  if (err.code === 'context_length_exceeded') return true;
  if (CONTEXT_TOO_LONG_CODES.some((c) => Number(err.upstreamCode) === c || err.status === c)) return true;
  // 上游正文：{"code":11115,"msg":"prompt is too long: 100001 tokens > 100000 maximum"}
  if (CONTEXT_TOO_LONG_CODES.some((c) => new RegExp(`"code"\\s*:\\s*${c}\\b`).test(msg))) return true;
  return /context[_\s-]?length[_\s-]?exceeded/i.test(msg)
    || /prompt is too long/i.test(msg)
    || /上下文.*超(?:长|出)|超出.*上下文|token.*超过.*(?:上限|最大)/i.test(msg);
}

/**
 * 解析上游错误，返回分类标签。
 * @param {Error} err
 * @returns {'rate_limit'|'auth'|'network'|'5xx'|'quota'|'model'|'context_length'|'channel'|'other'}
 */
function classifyError(err) {
  if (!err) return 'other';
  const msg = String(err.message || '');
  // 从消息体回填业务码（WorkBuddy 429 body: {"code":6004,...} 等）
  if (err.upstreamCode == null) {
    const m = msg.match(/"code"\s*:\s*(\d{3,5})/);
    if (m) err.upstreamCode = Number(m[1]);
  }
  // 渠道校验先于一切：它不是账号/模型/窗口问题，判成 'other' 会去逐个候选撞同一
  // 堵墙并冷却健康账号；判成 'auth' 会触发续期（无效，token 完全正常）。
  if (isChannelBlockedError(err)) return 'channel';
  // 上下文超限先于其它分类：窗口问题与账号/模型健康度无关，
  // 误判成 'other' 会触发无意义 failover（逐个候选撞同一天花板）并冷却健康模型。
  if (isContextLengthError(err)) return 'context_length';
  // 套餐额度耗尽（账号级额度问题）：应换号；额度与扣费口径对比见
  // docs/06-deliverables/comparisons/workbuddy-comparison-report.md
  if (Number(err.upstreamCode) === CODE_PLAN_LIMIT || /PlanLimit|plan.?limit/i.test(msg)) return 'quota';
  if (err.status === 402 || /quota|积分已耗尽|余额不足|credits.?exhaust/i.test(msg)) return 'quota';
  // 模型级限流须先于泛化 429 判定：模型问题非账号问题，换号/冷却整号无意义
  if (isModelRateLimitError(err)) return 'model';
  // 模型在当前 function 下不可用（model config is empty / WorkBuddy 11102、11103）——
  // 模型问题非账号问题，换候选即可
  if (isModelConfigError(err)) return 'model';
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
 * 是否为模型配置问题（上游业务码 modelUnavailable / modelBackendUnsupported /
 * "model config is empty" / "service info not found"）：
 * 模型在当前 function 下不可用，属模型问题非账号问题。
 */
function isModelConfigError(err) {
  if (!err) return false;
  const code = Number(err.upstreamCode);
  if (WB_MODEL_UNAVAILABLE_CODES.includes(code)) return true;
  if (code === CODE_MODEL_UNAVAILABLE || err.status === CODE_MODEL_UNAVAILABLE) return true;
  const msg = String(err.message || '');
  return /model config is empty/i.test(msg)
    || /service info not found/i.test(msg)
    || /Backend \[[^\]]*\] is not supported/i.test(msg);
}

/** 是否为套餐额度耗尽（planLimit）。 */
function isPlanLimitError(err) {
  if (!err) return false;
  return Number(err.upstreamCode) === CODE_PLAN_LIMIT || /PlanLimit|plan.?limit/i.test(String(err.message || ''));
}

/**
 * 是否为模型级限流（modelRateLimit / "exceeded the rate limit"）：
 * 模型在当前时刻被限流，属模型问题非账号问题，不冷却账号（与 Sliverkiss 一致）。
 */
function isModelRateLimitError(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  if (Number(err.upstreamCode) === CODE_MODEL_RATE_LIMIT || err.status === CODE_MODEL_RATE_LIMIT) return true;
  // WorkBuddy 中文「使用量已超出频率限制…切换其他模型」；勿用过宽的英文
  // 「exceeded the rate limit」——那会把 3004 账号级限流误判成 model 类
  return /model rate limit/i.test(msg)
    || (/使用量已超出频率限制/.test(msg) && /切换其他模型/.test(msg));
}

/**
 * 从上游限流文案中解析精确恢复时刻。
 * 实测两种形态（输入面与 hub parse_rate_limit_reset 一致）：
 *   - WorkBuddy 6004 中文: "…将在 2026-09-29 20:48:47 UTC+8 重置…"
 *   - 英文: "usage will reset at 2026-10-04 23:00:00"（按本地时区解释）
 * 解析失败返回 null，调用方退回指数退避。
 * @param {string} text
 * @returns {string|null} ISO 时刻
 */
function parseRateLimitReset(text) {
  const s = String(text || '');
  // 中文形态：UTC+8（固定偏移，不依赖本机时区）
  const zh = s.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*UTC\+8/);
  if (zh) {
    const [, y, mo, d, h, mi, sec] = zh;
    // Date.UTC 的 month 从 0 起
    const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec || 0)) - 8 * 3600 * 1000;
    return new Date(ms).toISOString();
  }
  // 英文形态：无时区后缀，按上游惯用的 UTC 解释（与 hub 口径一致）
  const en = s.match(/(?:usage will )?reset at (\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/i);
  if (en) {
    const [, y, mo, d, h, mi, sec] = en;
    const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec || 0));
    return new Date(ms).toISOString();
  }
  return null;
}

/**
 * 是否为渠道校验拒绝（11128）。三路判定：业务码、HTTP 状态恰好等于该码（少见）、
 * 以及文案兜底（上游换码或改文案时仍能识别）。
 */
function isChannelBlockedError(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  if (Number(err.upstreamCode) === CODE_CHANNEL_BLOCKED) return true;
  if (err.status === CODE_CHANNEL_BLOCKED) return true;
  if (new RegExp(`"code"\\s*:\\s*${CODE_CHANNEL_BLOCKED}\\b`).test(msg)) return true;
  return /unapproved channel/i.test(msg)
    || /Illegal API invocation/i.test(msg)
    || /没通过渠道校验/.test(msg);
}

/**
 * 是否值得重试：限流/网络/5xx 可重试；auth、channel、other、context_length 不重试。
 * 渠道校验是确定性的请求形状判定，同账号同请求重试结果不变，只会白白多打一次上游。
 * 上下文超限属终端错误——换候选与冷却账号都解决不了窗口问题，重试只会
 * 把每个候选都撞一遍同一天花板并污染健康度表。
 */
function isRetryable(kind) {
  return kind === 'rate_limit' || kind === 'network' || kind === '5xx';
}

/** 是否为上下文超限（输入超模型真实窗口）：终端错误，不 failover、不冷却。 */
function isContextLengthErrorKind(kind) {
  return kind === 'context_length';
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
  isContextLengthError,
  isContextLengthErrorKind,
  isChannelBlockedError,
  parseRateLimitReset,
  RATE_LIMIT_CODES,
  CONTEXT_TOO_LONG_CODES,
  CODE_CHANNEL_BLOCKED,
};
