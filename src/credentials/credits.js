'use strict';
/**
 * credentials/credits.js — 权益包（积分）的纯计算。
 *
 * 从 upstream/balance.js 抽出：这些函数不涉及任何 IO，却被 credentials/pool.js
 * 用于调度排序（FEFO 临期优先）。留在 upstream 里会让 credentials 反向依赖
 * upstream——底层模块依赖上层模块，方向倒置。
 *
 * 放在 credentials 下是因为它描述的是「账号权益包」这一领域概念，
 * 与 credit-history.js 同域；upstream/balance.js 作为使用方从这里取。
 */

/** 积分四舍五入到 2 位小数，消除浮点累加噪声。 */
function roundCredits(n) {
  if (n == null || !Number.isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

/** 自然日差：expire 落在今天为 0，明天为 1，以此类推。 */
function naturalDayDiff(expireSec, nowMs) {
  if (typeof expireSec !== 'number' || expireSec <= 0) return null;
  const startOfDay = (ms) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const expireMs = expireSec * 1000;
  return Math.round((startOfDay(expireMs) - startOfDay(nowMs)) / 86400000);
}

/**
 * 汇总 3 天内 / 7 天内到期且未用完的积分。
 *
 * @param {Array<{expireTime?:number, remaining?:number|null, unlimited?:boolean}>} packs
 * @param {number} [nowMs]
 * @returns {{d3:number, d7:number}}
 */
function summarizeExpiry(packs, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  const empty = { d3: 0, d7: 0 };
  if (!Array.isArray(packs) || !packs.length) return empty;
  let d3 = 0;
  let d7 = 0;
  for (const p of packs) {
    const dayDiff = naturalDayDiff(p && p.expireTime, now);
    if (dayDiff == null || dayDiff < 0) continue;
    // unlimited（remaining=null）不计入临期金额
    if (p.remaining == null) continue;
    const rem = roundCredits(p.remaining);
    if (dayDiff <= 3) d3 += rem;
    if (dayDiff <= 7) d7 += rem;
  }
  return { d3: roundCredits(d3), d7: roundCredits(d7) };
}

/**
 * 汇总「最早到期」信息，供账号池 FEFO（先到期先用）排序。
 *
 * 背景：此前 least_balance 只按 d3/d7 金额分档排序，无法区分
 * 「3 天后到期的 68 分」与「7 天后到期的 68 分」，也分不出
 * 同档内到期时间更早的账号，临期积分会因余额策略被白白浪费。
 * FEFO 直接以最近一个未用尽权益包的到期时刻为准，先到期先消耗。
 *
 * 判定口径：
 * - 只统计 remaining > 0 且未过期的包（已用尽 / unlimited / 无到期时间的都跳过）。
 * - 多个包取 expireTime 最小者作为 soonest。
 * - 仅有 unlimited 包时视为「不会过期」，返回 never=true。
 *
 * @param {Array<{expireTime?:number, remaining?:number|null, unlimited?:boolean}>} packs
 * @param {number} [nowMs]
 * @returns {{soonest:number|null, soonestMs:number|null, soonestAmount:number,
 *            soonestDays:number|null, expiringAmount:number, never:boolean,
 *            hasExpiry:boolean}}
 */
function summarizeFefo(packs, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  const out = {
    soonest: null, soonestMs: null, soonestAmount: 0,
    soonestDays: null, expiringAmount: 0, never: false, hasExpiry: false,
  };
  if (!Array.isArray(packs) || !packs.length) return out;

  let sawUnlimited = false;
  for (const p of packs) {
    if (!p || typeof p !== 'object') continue;
    // unlimited 包永不过期：只在没有任何可计量包时作为兜底标记
    if (p.remaining == null || p.unlimited === true) { sawUnlimited = true; continue; }
    const rem = roundCredits(p.remaining);
    if (!(rem > 0)) continue; // 已用尽
    const expireSec = p.expireTime;
    // 无到期时间 = 长期有效，不参与 FEFO 抢占
    if (typeof expireSec !== 'number' || expireSec <= 0) continue;
    const ms = expireSec * 1000;
    if (ms <= now) continue; // 已过期
    out.expiringAmount = roundCredits(out.expiringAmount + rem);
    if (out.soonestMs === null || ms < out.soonestMs) {
      out.soonestMs = ms;
      out.soonest = expireSec;
      out.soonestAmount = rem;
    }
  }
  out.hasExpiry = out.soonestMs !== null;
  if (!out.hasExpiry) out.never = sawUnlimited;
  out.soonestDays = out.soonestMs === null
    ? null
    : Math.round(((out.soonestMs - now) / 86400000) * 100) / 100;
  return out;
}

module.exports = { roundCredits, naturalDayDiff, summarizeExpiry, summarizeFefo };