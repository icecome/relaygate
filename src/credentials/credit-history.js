'use strict';
/**
 * credentials/credit-history.js — 积分快照历史与差分统计。
 *
 * 两个口径，精度差别很大，必须分开返回、不可混用：
 *
 * 1. usedTotal（首选）—— 上游 consumed_amount（累计已用）的增量。
 *    单调性较好，与官方账单基本吻合。
 * 2. remainingDelta（对照）—— remaining（剩余）的下降量。
 *    会被「权益包到期作废」污染：包过期时 remaining 直接掉一块，
 *    但并不是消耗。实测 WB 账号该口径可达官方账单的 80 倍（783 vs 9.10），
 *    因此只能作下界参考，不作为消耗口径。
 *
 * 时间窗口按「本地自然日」而非滚动 24 小时：
 * 滚动窗口会把「今天 0 点到上次刷新点」之间的消耗整段丢掉，
 * 且每天数字随刷新时刻漂移。同时窗口首条要取窗口前最近一条快照做基线，
 * 否则跨零点的消耗同样丢失。
 */
const { db } = require('./db');

/** 追加一条快照。 */
function add(accountId, data = {}) {
  if (!accountId) return;
  db().prepare(
    'INSERT INTO credit_history (account_id, ts, remaining, used_total, source) VALUES (?, ?, ?, ?, ?)'
  ).run(
    accountId,
    new Date().toISOString(),
    data.remaining != null ? Number(data.remaining) : null,
    data.used != null ? Number(data.used) : null,
    data.source || 'refresh',
  );
}

/** days 天前的本地 0 点（自然日窗口起点）。 */
function localMidnightDaysAgo(days, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return d;
}

/**
 * 按账号聚合一段时间内的消耗。
 * @param {number} days 统计最近 N 个自然日（含今天）
 * @returns {{accountId:string,label:string,group:string|null,usedTotal:number,remainingDelta:number,snapshots:number,latestRemaining:number|null,covered:boolean}[]}
 */
function summary(days = 1) {
  const store = require('./store');
  const sinceIso = localMidnightDaysAgo(Math.max(1, days)).toISOString();
  const rows = db().prepare(
    'SELECT account_id, ts, remaining, used_total FROM credit_history WHERE ts >= ? ORDER BY account_id, ts ASC'
  ).all(sinceIso);

  const byAcct = new Map();
  for (const r of rows) {
    const list = byAcct.get(r.account_id) || [];
    list.push(r);
    byAcct.set(r.account_id, list);
  }

  /** 窗口前最近一条快照，作为跨零点的差分基线。 */
  const baselineOf = (accountId) => db().prepare(
    'SELECT remaining, used_total FROM credit_history WHERE account_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1'
  ).get(accountId, sinceIso) || null;

  const out = [];
  for (const a of store.list()) {
    const snaps = byAcct.get(a.id) || [];
    const base = snaps.length ? baselineOf(a.id) : null;

    let usedTotal = 0;
    let remainingDelta = 0;
    let prevRemaining = base ? base.remaining : null;
    let prevUsed = base ? base.used_total : null;
    for (const s of snaps) {
      // used_total 增量：只累计正向（回退多为上游重算或包到期，不计消耗）
      if (s.used_total != null && prevUsed != null) {
        const d = s.used_total - prevUsed;
        if (d > 0) usedTotal += d;
      }
      if (s.used_total != null) prevUsed = s.used_total;
      // remaining 下降量：受包到期污染，仅作对照
      if (s.remaining != null && prevRemaining != null) {
        const d = prevRemaining - s.remaining;
        if (d > 0) remainingDelta += d;
      }
      if (s.remaining != null) prevRemaining = s.remaining;
    }
    const latest = snaps.length ? snaps[snaps.length - 1] : null;
    out.push({
      accountId: a.id,
      label: a.label || a.id,
      group: a.group || null,
      usedTotal: Math.round(usedTotal * 100) / 100,
      remainingDelta: Math.round(remainingDelta * 100) / 100,
      snapshots: snaps.length,
      latestRemaining: latest ? latest.remaining : null,
      // covered：窗口内是否有可差分的快照对（单条快照算不出消耗，不能读作 0 消耗）
      covered: snaps.length >= 2 || !!base,
    });
  }
  return out;
}

module.exports = { add, summary, localMidnightDaysAgo };
