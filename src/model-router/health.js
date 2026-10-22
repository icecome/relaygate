'use strict';
/**
 * model-router/health.js — 候选目标健康度与限流冷却。
 *
 * key = `${virtualId}::${candidateId}`，内存态（进程重启后自然恢复）。
 * 记录：成功率、平均延迟、连续失败、冷却截止、最近错误。
 */

/** @typedef {{ok:number, fail:number, totalMs:number, lastError:string|null, lastStatus:number|null, coolUntil:number, lastRateLimitAt:number|null, lastChannelBlockAt:number|null, lastAccountRestrictedAt:number|null}} Entry */

/** @type {Map<string, Entry>} */
const stats = new Map();

/**
 * 账号受限（11140）冷却时长。取 2 小时：受限大概率是账号级风控处置，
 * 几分钟内恢复无先例（社区案例按小时/天计）；又不至于 24h——若上游是
 * 临时限制（限流升级形态），2h 后放一次探测请求，成功即由 markOk 清零。
 */
const ACCOUNT_RESTRICT_COOLDOWN_MS = 2 * 3600_000;

/** 本地 maxRpm 滑窗：key → number[]（请求起点时间戳） */
const rpmWindow = new Map();

function keyOf(virtualId, candidateId) {
  return `${virtualId}::${candidateId}`;
}

function entry(virtualId, candidateId) {
  const k = keyOf(virtualId, candidateId);
  let e = stats.get(k);
  if (!e) {
    e = {
      ok: 0,
      fail: 0,
      totalMs: 0,
      lastError: null,
      lastStatus: null,
      coolUntil: 0,
      lastRateLimitAt: null,
      lastChannelBlockAt: null,
      lastAccountRestrictedAt: null,
    };
    stats.set(k, e);
  }
  return e;
}

function markOk(virtualId, candidateId, durationMs) {
  const e = entry(virtualId, candidateId);
  e.ok += 1;
  e.totalMs += Math.max(0, durationMs || 0);
  e.lastError = null;
  e.coolUntil = 0;
}

function markFail(virtualId, candidateId, kind, err, cooldownMs) {
  const e = entry(virtualId, candidateId);
  e.fail += 1;
  e.lastError = (err && err.message) ? String(err.message).slice(0, 200) : String(kind || 'error');
  e.lastStatus = err && err.status != null ? err.status : null;
  // 渠道校验（11128）：账号与模型都健康，是「请求形状不被认可」。
  // 冷却候选只会让面板显示一片红、并让本可用的候选被跳过——实际恢复靠改请求头。
  // 因此只记失败次数与末次错误（可观测），不设 coolUntil。
  if (kind === 'channel') {
    e.lastChannelBlockAt = Date.now();
    return { cooledForMs: 0 };
  }
  // rate_limit 与 model（6004 模型频控）：冷却该候选并允许 failover
  if (kind === 'rate_limit' || kind === 'model') {
    e.lastRateLimitAt = Date.now();
    const ms = resolveCooldownMs(err, cooldownMs);
    e.coolUntil = Date.now() + ms;
    return { cooledForMs: ms };
  }
  // 账号受限（11140）：账号被上游风控处置。短冷却会在到期后反复撞墙（每撞一次
  // 都是在被风控的账号上继续打请求，只会加重画像）；长冷却（默认 2h）把它排到
  // 候选队尾，同虚拟模型有其他候选时自然切走，没有时也把重试频率压到风控友好档。
  if (kind === 'account') {
    const ms = ACCOUNT_RESTRICT_COOLDOWN_MS;
    e.coolUntil = Date.now() + ms;
    e.lastAccountRestrictedAt = Date.now();
    return { cooledForMs: ms };
  }
  if (kind === 'auth' || kind === 'quota' || kind === '5xx') {
    const ms = kind === 'quota' ? 3600_000 : (cooldownMs || 20000);
    e.coolUntil = Date.now() + ms;
    return { cooledForMs: ms };
  }
  return { cooledForMs: 0 };
}

/**
 * 限流冷却时长：优先解析上游消息里的重置时刻（「将在 2026-09-29 20:16:21 UTC+8 重置」），
 * 否则用配置的 cooldownMs。
 */
function resolveCooldownMs(err, fallbackMs) {
  const fb = Number(fallbackMs) > 0 ? Number(fallbackMs) : 20000;
  const msg = String((err && err.message) || '');
  const m = msg.match(/将在\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s*UTC([+-]\d{1,2})?/);
  if (m) {
    try {
      const offset = m[3] ? Number(m[3]) : 8;
      const local = new Date(`${m[1]}T${m[2]}${offset >= 0 ? '+' : ''}${String(offset).padStart(2, '0')}:00`);
      const delta = local.getTime() - Date.now();
      if (Number.isFinite(delta) && delta > 0) return Math.min(delta + 5000, 6 * 3600_000);
    } catch { /* 解析失败则用最后手段 */ }
  }
  return fb;
}

function isCooling(virtualId, candidateId) {
  const e = stats.get(keyOf(virtualId, candidateId));
  return !!(e && e.coolUntil > Date.now());
}

function cooldownRemaining(virtualId, candidateId) {
  const e = stats.get(keyOf(virtualId, candidateId));
  if (!e || e.coolUntil <= Date.now()) return 0;
  return e.coolUntil - Date.now();
}

function clearCooldown(virtualId, candidateId) {
  const e = stats.get(keyOf(virtualId, candidateId));
  if (e) e.coolUntil = 0;
}

function clearAllCooldowns(virtualId) {
  const prefix = virtualId ? `${virtualId}::` : '';
  for (const [k, e] of stats) {
    if (!prefix || k.startsWith(prefix)) e.coolUntil = 0;
  }
}

/** maxRpm：返回 true 表示允许发送。 */
function allowRpm(virtualId, candidateId, maxRpm) {
  if (!maxRpm || maxRpm <= 0) return true;
  const k = keyOf(virtualId, candidateId);
  const now = Date.now();
  const arr = (rpmWindow.get(k) || []).filter((t) => now - t < 60_000);
  if (arr.length >= maxRpm) {
    rpmWindow.set(k, arr);
    return false;
  }
  arr.push(now);
  rpmWindow.set(k, arr);
  return true;
}

function snapshot() {
  const now = Date.now();
  return [...stats.entries()].map(([k, e]) => {
    const [virtualId, candidateId] = k.split('::');
    const n = e.ok + e.fail;
    return {
      virtualId,
      candidateId,
      ok: e.ok,
      fail: e.fail,
      successRate: n ? Math.round((e.ok / n) * 1000) / 10 : null,
      avgLatencyMs: e.ok ? Math.round(e.totalMs / e.ok) : null,
      lastError: e.lastError,
      lastStatus: e.lastStatus,
      cooling: e.coolUntil > now,
      cooldownRemainingMs: e.coolUntil > now ? e.coolUntil - now : 0,
      lastRateLimitAt: e.lastRateLimitAt,
      lastChannelBlockAt: e.lastChannelBlockAt,
      lastAccountRestrictedAt: e.lastAccountRestrictedAt,
    };
  });
}

module.exports = {
  markOk,
  markFail,
  isCooling,
  cooldownRemaining,
  clearCooldown,
  clearAllCooldowns,
  allowRpm,
  snapshot,
  resolveCooldownMs,
};
