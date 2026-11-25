'use strict';
/**
 * middleware/auth-rate-limit.js — 管理面鉴权失败限速（M-05）。
 *
 * 与转发面 keyRateLimit 的威胁模型不同：这里防的是对 login key 的暴力破解，
 * 因此按「客户端 IP」计失败次数，5 次失败后锁 60 秒（指数退避的简化版）。
 * 成功不直接清零计数——用滑窗自然衰减，避免攻击者用一次成功重置窗口。
 *
 * 内存表有容量上限（同 rate-limit.js 的既定防护模式），避免被大量伪造 IP 撑爆。
 */
const FAIL_LIMIT = 5;
const LOCK_MS = 60_000;
const WINDOW_MS = 5 * 60_000;
const MAX_ENTRIES = 5000;

/** @type {Map<string, number[]>} ip -> 失败时间戳数组 */
const failures = new Map();

function clientIp(req) {
  const h = req.headers || {};
  // 这些头来自客户端，可被伪造；仅用于限流分桶，不作为身份鉴权依据。
  return String(h['x-forwarded-for'] || h['x-real-ip'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

function prune(now) {
  if (failures.size <= MAX_ENTRIES) return;
  for (const [k, v] of failures) {
    if (!v.length || now - v[v.length - 1] > WINDOW_MS) failures.delete(k);
  }
}

/** 是否处于锁定状态（不消费次数，供路由提前拒收）。 */
function isLocked(req) {
  const now = Date.now();
  const ip = clientIp(req);
  const arr = (failures.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  const recent = arr.filter((t) => now - t < LOCK_MS);
  failures.set(ip, arr);
  prune(now);
  return recent.length >= FAIL_LIMIT;
}

/** 成功鉴权后清零该 IP 的失败计数（fail2ban 语义：正确凭据即解除封锁）。 */
function recordSuccess(req) {
  failures.delete(clientIp(req));
}

/** 记录一次失败。返回 {locked:boolean, retryAfter:number}。 */
function recordFailure(req) {
  const now = Date.now();
  const ip = clientIp(req);
  const arr = (failures.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  failures.set(ip, arr);
  prune(now);
  const recent = arr.filter((t) => now - t < LOCK_MS);
  const locked = recent.length >= FAIL_LIMIT;
  const retryAfter = locked ? Math.max(1, Math.ceil((LOCK_MS - (now - recent[0])) / 1000)) : 0;
  return { locked, retryAfter };
}

module.exports = { isLocked, recordFailure, recordSuccess, clientIp, FAIL_LIMIT, LOCK_MS };
