'use strict';
/**
 * middleware/rate-limit.js — 密钥级 RPM 限流（令牌桶简化为滑窗）。
 * 对齐 OWASP API4:2023 Unrestricted Resource Consumption。
 */

/** @type {Map<string, number[]>} */
const windows = new Map();

function maxRpmFor(keyRec) {
  if (keyRec && keyRec.rpmLimit != null && Number.isFinite(Number(keyRec.rpmLimit))) {
    return Math.max(1, Math.trunc(Number(keyRec.rpmLimit)));
  }
  const env = Number(process.env.KEY_DEFAULT_RPM || 0);
  return Number.isFinite(env) && env > 0 ? Math.trunc(env) : 0; // 0 = 不限
}

/**
 * Express 中间件：需先 authenticate，依赖 req.apiKeyId / req 附带密钥记录。
 */
function keyRateLimit() {
  return (req, res, next) => {
    const id = req.apiKeyId || 'anon';
    const limit = maxRpmFor(req.authKey);
    if (!limit) return next();
    const now = Date.now();
    const arr = (windows.get(id) || []).filter((t) => now - t < 60_000);
    if (arr.length >= limit) {
      windows.set(id, arr);
      const retryAfter = Math.ceil((60_000 - (now - arr[0])) / 1000);
      res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
      return res.status(429).json({
        error: {
          message: `rate limit exceeded for key (rpm=${limit})`,
          type: 'rate_limit_error',
          code: 'KEY_RPM_LIMIT',
        },
      });
    }
    arr.push(now);
    windows.set(id, arr);
    // 简单内存清理
    if (windows.size > 5000) {
      for (const [k, v] of windows) {
        if (!v.length || now - v[v.length - 1] > 60_000) windows.delete(k);
      }
    }
    next();
  };
}

module.exports = { keyRateLimit, maxRpmFor };
