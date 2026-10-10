'use strict';
/**
 * middleware/rate-limit.js — 密钥级 RPM 限流（令牌桶简化为滑窗）。
 * 对齐 OWASP API4:2023 Unrestricted Resource Consumption。
 *
 * 默认值取舍：此前 fallback 是 0（不限），而面板创建访问密钥时从不设置
 * rpmLimit、.env.example 也从不定义 KEY_DEFAULT_RPM —— 结果是**实际部署中
 * 每把密钥都不限流**。本转发面烧的是真实账号积分（签到攒的、不可再生），
 * 任何持钥者（或拿到密钥的第三方）都能把整个池子烧穿；每请求还会同步全表读
 * （pool.pick → store.list）拖住事件循环。
 *
 * 因此默认改为 DEFAULT_RPM（60，即每秒 1 次）：单人 IDE 场景绰绰有余，
 * 批量任务走内部调度不经访问密钥。显式设 KEY_DEFAULT_RPM=0 可恢复不限流。
 */

/** 未单独配置时的默认每分钟上限。 */
const DEFAULT_RPM = 60;

/** @type {Map<string, number[]>} */
const windows = new Map();

function maxRpmFor(keyRec) {
  if (keyRec && keyRec.rpmLimit != null && Number.isFinite(Number(keyRec.rpmLimit))) {
    return Math.max(1, Math.trunc(Number(keyRec.rpmLimit)));
  }
  const raw = process.env.KEY_DEFAULT_RPM;
  // 未设置 → 用安全默认；显式设置为 0 → 尊重用户选择（不限流）
  if (raw == null || String(raw).trim() === '') return DEFAULT_RPM;
  const env = Number(raw);
  return Number.isFinite(env) && env > 0 ? Math.trunc(env) : 0;
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

module.exports = { keyRateLimit, maxRpmFor, DEFAULT_RPM };
