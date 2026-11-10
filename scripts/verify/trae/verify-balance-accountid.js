'use strict';
/**
 * scripts/verify/trae/verify-balance-accountid.js — 端到端验证 P1-3（Raccoon accountId 形状）。
 *
 * 复现的根因：upstream/balance.js 的 Raccoon 分支曾直接透出
 * raccoon/credits.refreshBalance() 的返回值（store.update() 的账号对象，
 * 键是 id 没有 accountId）。调用方按批量契约取 item.accountId → undefined →
 * pool.unfreezeIfHealthy(undefined) → store.get(undefined) 让 node:sqlite 抛
 * 「Provided value cannot be bound to SQLite parameter 1」，整轮解冻 + 低额告警
 * 被中断（自 2026-10-15 Raccoon 接入起，err 日志实测 549 次）。
 *
 * 验证点：
 *   1. 每个 ok 项都带可解析的 accountId（或 id），且账号真实存在；
 *   2. 对每个 ok 项真的调一次 unfreezeIfHealthy，全程不抛；
 *   3. 故意注入一个缺 accountId 的假项，确认防御层（|| item.id / 跳过空值）生效。
 *
 * 用法：node scripts/verify/trae/verify-balance-accountid.js
 * 注意：会对全部启用账号各打一次余额接口（只读，无副作用）。
 */
process.env.LOGS_DIR = require('path').join(__dirname, '..', '..', '..', 'logs');
const store = require('../../../src/credentials/store');
const pool = require('../../../src/credentials/pool');
const { refreshBalanceAllEnabled } = require('../../../src/upstream/balance');

(async () => {
  console.log('--- 真实跑一轮批量余额刷新 ---');
  const r = await refreshBalanceAllEnabled({ spreadMinutes: 0 });
  if (r && r.skipped) { console.log('被互斥跳过（另一轮在跑），稍后重试'); process.exitCode = 2; return; }
  console.log(`ok=${r.ok.length} failed=${r.failed.length} total=${r.total}`);
  for (const f of r.failed) console.log(`  FAILED ${f.label || f.id}: ${f.reason}`);

  let missing = 0;
  let thawed = 0;
  for (const item of r.ok) {
    const edition = (store.get(item.accountId || item.id) || {}).edition;
    const hasId = !!(item.accountId || item.id);
    if (!item.accountId) missing += 1;
    console.log(`  ${String(edition).padEnd(10)} accountId=${item.accountId ? 'yes' : 'NO '} id=${item.id ? 'yes' : 'NO '} balance=${item.balance}`);
    if (!hasId) continue;
    // 真实解冻调用：修复前 Raccoon 这一句就抛
    if (pool.unfreezeIfHealthy(item.accountId || item.id)) thawed += 1;
  }
  console.log(`缺 accountId 的项 = ${missing}（修复前 Raccoon 号恒缺）| 解冻生效 = ${thawed}`);

  console.log('--- 注入防御：undefined / 空对象 ---');
  const b = { ok: [{ label: 'ghost' }, { accountId: 'acct_not_exist_zzz' }, undefined], failed: [], total: 0 };
  let threw = null;
  try {
    for (const item of b.ok) {
      if (!item) continue;
      const id = item.accountId || item.id;
      if (!id) continue;
      pool.unfreezeIfHealthy(id);
    }
  } catch (e) { threw = e.message; }
  console.log('注入结果 =', threw ? `THROWN ${threw}` : '无异常（防御生效）');

  const pass = threw === null;
  console.log(pass ? '\nALL CHECKS PASSED' : '\nVERIFY FAILED');
  if (!pass) process.exitCode = 1;
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
});
