'use strict';
/**
 * ZCode 口径修复后的回归验证（真实库）。
 * 断言：积分口径的三处聚合不再包含 ZCode 账号的 token 数。
 */
const store = require('../src/credentials/store');
const ch = require('../src/credentials/credit-history');
const { db } = require('../src/credentials/db');
const variant = require('../src/platform/variant');

const packsOf = (a) => (a.entitlementSnapshot && Array.isArray(a.entitlementSnapshot.packs)) ? a.entitlementSnapshot.packs : [];
const fail = [];

// 1) balance 列：ZCode 必须为 null
for (const a of store.list().filter((x) => variant.isEdition(x.edition, 'zcode'))) {
  if (a.balance != null) fail.push(`balance 未清空: ${a.id} = ${a.balance}`);
}
// 2) packs 键：ZCode 不得再有 packs（应换 tokenBuckets）
for (const a of store.list().filter((x) => variant.isEdition(x.edition, 'zcode'))) {
  if (packsOf(a).length) fail.push(`snapshot.packs 残留: ${a.id}`);
}
// 3) credit_history：ZCode 账号不得有记录
const zids = store.list().filter((x) => variant.isEdition(x.edition, 'zcode')).map((a) => a.id);
for (const id of zids) {
  const n = db().prepare('SELECT COUNT(*) AS n FROM credit_history WHERE account_id = ?').get(id).n;
  if (n > 0) fail.push(`credit_history 残留: ${id} x${n}`);
}

// 4) 全局口径恢复正常
const sum1 = ch.summary(1);
const totalUsed = sum1.reduce((s, d) => s + (d.usedTotal || 0), 0);
console.log('totalUsed（今日消耗）=', Math.round(totalUsed * 100) / 100);
if (totalUsed > 100000) fail.push(`totalUsed 仍异常偏大: ${totalUsed}`);

// 5) expiring / fefo（FEFO 排序信号）不含 token
const { summarizeExpiry, summarizeFefo } = require('../src/credentials/credits');
let d7 = 0;
for (const a of store.list()) d7 += summarizeExpiry(packsOf(a)).d7;
console.log('expiring7d =', Math.round(d7 * 100) / 100);
const fefoZ = summarizeFefo(packsOf(store.get(zids[0]) || {}));
if (fefoZ.soonestMs != null || fefoZ.expiringAmount > 0) fail.push(`FEFO 仍受 zcode 污染: ${JSON.stringify(fefoZ)}`);

// 6) tokenBuckets 已就位（ZCode 数据仍在，只是换了口径）
for (const a of store.list().filter((x) => variant.isEdition(x.edition, 'zcode'))) {
  const snap = a.entitlementSnapshot || {};
  const buckets = snap.tokenBuckets || [];
  console.log(`zcode ${a.id}: tokenBuckets=${buckets.length} tokenRemaining=${snap.tokenRemaining}`);
  if (!buckets.length && !snap.tokenRemaining) console.log('  （额度为空：今日已领完属正常）');
}

if (fail.length) {
  console.error('\nFAIL:');
  for (const f of fail) console.error('  ✘', f);
  process.exit(1);
}
console.log('\n✔ 口径修复验证通过：积分三处（balance/packs/credit_history）已与 token 隔离');