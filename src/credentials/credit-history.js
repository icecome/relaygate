'use strict';
/**
 * credentials/credit-history.js — 积分快照历史与差分统计。
 *
 * 背景：上游不提供单次调用积分粒度，只在权益接口暴露 remaining（剩余）
 * 与 usage.credits_amount（累计已用）。本模块在每次余额刷新时追加快照，
 * 消耗 = 相邻快照 remaining 的差值（used_total 增量交叉验证）。
 */
const { db } = require('./db');

/**
 * 追加一条快照。
 * @param {string} accountId
 * @param {{remaining?:number|null, used?:number|null, source?:string}} data
 */
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

/**
 * 按账号聚合一段时间内的消耗（相邻快照差分）。
 * @param {number} days 统计最近 N 天（默认 1）
 * @returns {{accountId:string, label:string, todayUsed:number, snapshots:number, latestRemaining:number|null}[]}
 */
function summary(days = 1) {
  const store = require('./store');
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db().prepare(
    'SELECT account_id, ts, remaining, used_total FROM credit_history WHERE ts >= ? ORDER BY account_id, ts ASC'
  ).all(since);

  const byAcct = new Map();
  for (const r of rows) {
    const list = byAcct.get(r.account_id) || [];
    list.push(r);
    byAcct.set(r.account_id, list);
  }

  const out = [];
  for (const a of store.list()) {
    const snaps = byAcct.get(a.id) || [];
    let todayUsed = 0;
    let prevRemaining = null;
    for (const s of snaps) {
      if (s.remaining != null && prevRemaining != null) {
        const delta = prevRemaining - s.remaining;
        if (delta > 0) todayUsed += delta; // 余额上涨（签到/充值）不计消耗
      }
      if (s.remaining != null) prevRemaining = s.remaining;
    }
    const latest = snaps.length ? snaps[snaps.length - 1] : null;
    out.push({
      accountId: a.id,
      label: a.label || a.id,
      group: a.group || null,
      todayUsed: Math.round(todayUsed * 100) / 100,
      snapshots: snaps.length,
      latestRemaining: latest ? latest.remaining : null,
    });
  }
  return out;
}

module.exports = { add, summary };
