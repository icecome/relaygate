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

module.exports = { roundCredits, naturalDayDiff, summarizeExpiry };