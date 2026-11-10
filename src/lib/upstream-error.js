'use strict';
/**
 * lib/upstream-error.js — 上游错误面向客户端的统一出口。
 *
 * 为什么需要一层：Raccoon / WorkBuddy 的上游错误对象里，err.message 是从
 * 上游响应体拼出来的（含业务码、内部字段、非 JSON 响应的前 200 字）。
 * 这些细节对运维排障有价值，但不应出现在公开转发面的响应/错误帧里 ——
 * 那是把上游内部结构原样交给调用方。
 *
 * 口径（单一事实源，避免每个路由各写一份映射）：
 *   - 客户端侧：只回泛化后的 message + 结构化 type/code/retryAfter；
 *   - 服务端侧：err.message / err.body 全量进日志，不截断；
 *   - err.body 与 err.status 继续留给 limiter.classifyThrottle / dispatch 分类，
 *     本模块不改写错误对象本身。
 *
 * 用法（示例，避免在注释里写出会被 unit.test.js 双向依赖扫描误判的字面量）：
 *   const upstreamErr = require(这里填相对路径);
 *   console.error('[raccoon] upstream error:', upstreamErr.logUpstreamError(err));
 *   res.status(status).json(upstreamErr.errorJson(err, status));
 *   // SSE 已下发头时：raccoonStream.writeErrorFrame(res, upstreamErr.clientMessage(err));
 */

/** 允许透出给客户端的、非敏感的业务码（上游 code 字段）。白名单之外一律不回。 */
const PUBLIC_CODES = new Set([
  'INVALID_MODEL',
  'MODEL_ACCESS_DENIED',
  'RACCOON_GLOBAL_COOLING',
  'RACCOON_QUEUE_TIMEOUT',
  'ABORT_ERR',
]);

/**
 * 面向客户端的泛化文案。按状态语义分档，不拼接 err.message。
 * @param {any} err
 * @returns {string}
 */
function clientMessage(err) {
  // 网关自产的可行动指引（无账号怎么接、冷却怎么退避）不是上游报文，
  // 必须原样给用户；只有「可能含上游响应片段」的错误才泛化。
  if (err && err.gatewayError && typeof err.message === 'string') {
    return err.message.slice(0, 500);
  }
  const status = Number(err && err.status);
  if (err && (err.aborted || err.code === 'ABORT_ERR' || status === 499)) {
    return '请求已取消';
  }
  if (status === 429 || err && err.code === 'RACCOON_GLOBAL_COOLING'
    || err && err.code === 'RACCOON_QUEUE_TIMEOUT') {
    return '上游限流，请按 Retry-After 退避';
  }
  if (status >= 500 || status === 502 || status === 503 || status === 504) {
    return '上游暂时不可用';
  }
  if (status >= 400) {
    return '上游请求被拒绝';
  }
  return '上游请求失败';
}

/** 错误类型（与 OpenAI error.type 口径一致）。 */
function errorType(status) {
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'upstream_error';
  if (status >= 400) return 'invalid_request_error';
  return 'upstream_error';
}

/**
 * 服务端日志用的完整详情：保留上游报文，但不把凭据类字段写进日志。
 * @param {any} err
 * @returns {string}
 */
function logUpstreamError(err) {
  const parts = [];
  if (err && err.message) parts.push(String(err.message).slice(0, 2000));
  if (err && err.status) parts.push(`status=${err.status}`);
  if (err && err.code) parts.push(`code=${err.code}`);
  if (err && err.body) parts.push(`body=${String(err.body).slice(0, 1000)}`);
  return parts.join(' | ') || 'unknown upstream error';
}

/** 非流式 JSON 响应体。 */
function errorJson(err, status) {
  const s = Number(status) || 502;
  // 网关自产的 code 是客户端契约（如 NO_RACCOON_ACCOUNT），必须透出；
  // 上游来源的 code 只放行白名单，避免把内部业务码交给调用方。
  const rawCode = err && typeof err.code === 'string' ? err.code : undefined;
  const code = rawCode && (err.gatewayError || PUBLIC_CODES.has(rawCode)) ? rawCode : undefined;
  return {
    error: {
      message: clientMessage(err),
      type: errorType(s),
      ...(code ? { code } : {}),
    },
  };
}

/**
 * 统一响应：已下发头走 SSE 错误帧，未下发头走 JSON；两种情况都先记日志。
 * @param {import('express').Response} res
 * @param {any} err
 * @param {{writeFrame?:(res:any,msg:string)=>void, tag?:string}} [opts]
 */
function replyUpstreamError(res, err, opts = {}) {
  console.error(`[${opts.tag || 'upstream'}] upstream error: ${logUpstreamError(err)}`);
  const msg = clientMessage(err);
  if (res.writableEnded) return;
  if (res.headersSent) {
    if (typeof opts.writeFrame === 'function') opts.writeFrame(res, msg);
    else {
      try {
        res.write(`data: ${JSON.stringify({ error: { message: msg, type: 'upstream_error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch { /* 客户端已断开 */ }
    }
    return;
  }
  const status = Number(err && err.status) >= 400 && Number(err && err.status) < 600
    ? Number(err.status) : 502;
  const cooldownMs = err && err.raccoonCooldown && err.raccoonCooldown.cooldownMs;
  // 与旧出口保持一致：冷却值优先，其次 err.retryAfterMs，429 无值时兜底 60s。
  const retryMs = cooldownMs || (err && err.retryAfterMs)
    || (status === 429 ? 60_000 : 0);
  if (retryMs > 0) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryMs / 1000))));
  }
  res.status(status).json(errorJson(err, status));
}

module.exports = {
  clientMessage,
  errorType,
  logUpstreamError,
  errorJson,
  replyUpstreamError,
};
