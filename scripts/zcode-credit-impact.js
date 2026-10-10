const store = require('../src/credentials/store');
const ch = require('../src/credentials/credit-history');
const { summarizeExpiry } = require('../src/credentials/credits');
const variant = require('../src/platform/variant');

const packsOf = (a) => (a.entitlementSnapshot && Array.isArray(a.entitlementSnapshot.packs)) ? a.entitlementSnapshot.packs : [];

console.log('=== zcode 账号快照全貌 ===');
for (const a of store.list().filter((x) => variant.isEdition(x.edition, 'zcode'))) {
  const full = store.get(a.id);
  console.log('balance =', full.balance);
  console.log('packs   =', JSON.stringify(packsOf(full), null, 1));
  console.log('snapshot keys =', Object.keys(full.entitlementSnapshot || {}));
}

console.log();
console.log('=== credit-history summary(1)：/v1/admin/credit-history 口径 ===');
const sum1 = ch.summary(1);
const sumUsed = sum1.reduce((s, d) => s + (d.usedTotal || 0), 0);
const sumDelta = sum1.reduce((s, d) => s + (d.remainingDelta || 0), 0);
console.log('totalUsed =', Math.round(sumUsed * 100) / 100);
console.log('remainingDelta =', Math.round(sumDelta * 100) / 100);
for (const d of sum1.filter((x) => x.usedTotal !== 0 || x.remainingDelta !== 0)) {
  console.log(`  ${d.label}: usedTotal=${d.usedTotal} remainingDelta=${d.remainingDelta} snaps=${d.snapshots}`);
}

console.log();
console.log('=== summarizeExpiry 汇总（前端 expiring3d/7d 口径）===');
let d3 = 0, d7 = 0;
const byEd = {};
for (const a of store.list()) {
  const e = summarizeExpiry(packsOf(a));
  d3 += e.d3; d7 += e.d7;
  byEd[a.edition] = (byEd[a.edition] || 0) + e.d7;
}
console.log('expiring3d =', Math.round(d3 * 100) / 100);
console.log('expiring7d =', Math.round(d7 * 100) / 100);
console.log('by edition (d7) =', byEd);

console.log();
console.log('=== balance 列（MIN_BALANCE_TO_USE / least_balance 口径）===');
const byEdBal = {};
for (const a of store.list()) byEdBal[a.edition] = (byEdBal[a.edition] || 0) + (a.balance || 0);
console.log(byEdBal);