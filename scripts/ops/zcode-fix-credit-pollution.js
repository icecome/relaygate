'use strict';
/**
 * 一次性修复：清除 ZCode 账号写入积分口径的历史污染。
 *
 * 背景：早期实现把 ZCode 的 token 额度写进了三处「积分」口径，使总积分与
 * 今日消耗被抬高约 4 个数量级：
 *   1. accounts.balance —— 积分列（MIN_BALANCE_TO_USE / least_balance 读取）
 *   2. entitlement_snapshot.packs —— 前端 creditTotals / summarizeExpiry / FEFO 读取
 *   3. credit_history —— /v1/admin/credit-history 的 totalUsed 读取
 *
 * 修复动作：1 置 null；2 的 packs 换成 tokenBuckets；删除 3 中 source 为
 * zcode 的记录。幂等，可重复执行。
 *
 * 用法：node scripts/zcode-fix-credit-pollution.js [--apply]；不带 --apply 仅预览（dry-run）。
 */
const store = require('../../src/credentials/store');
const { db } = require('../../src/credentials/db');
const variant = require('../../src/platform/variant');

const APPLY = process.argv.includes('--apply');

function zcodeAccounts() {
  return store.list()
    .filter((a) => variant.isEdition(a.edition, variant.ZCODE))
    .map((a) => store.get(a.id))
    .filter(Boolean);
}

function main() {
  const accounts = zcodeAccounts();
  if (!accounts.length) {
    console.log('无 ZCode 账号，无需修复');
    return;
  }
  console.log(`ZCode 账号 ${accounts.length} 个${APPLY ? '' : '（dry-run，加 --apply 生效）'}\n`);

  for (const a of accounts) {
    const snap = a.entitlementSnapshot || {};
    const packs = Array.isArray(snap.packs) ? snap.packs : [];
    const tokenSum = packs.reduce((s, p) => s + (Number(p.remaining) || 0), 0);

    console.log(`- ${a.id} (${a.label})`);
    console.log(`    balance: ${a.balance} -> null`);
    console.log(`    snapshot.packs: ${packs.length} 项（剩余合计 ${tokenSum}）-> tokenBuckets`);

    if (APPLY) {
      // packs 里的条目本就是 token 桶，改键名即可保留数据并脱离积分口径
      const tokenBuckets = packs.map((p) => ({
        name: p.name,
        bucketId: p.packId || null,
        planId: p.planId || null,
        meter: p.meter || 'model_usage',
        unit: 'token',
        limit: p.limit,
        used: p.used,
        remaining: p.remaining,
        expireTime: p.expireTime,
      }));
      const { packs: _drop, expiring: _drop2, ...rest } = snap;
      store.update(a.id, {
        balance: null,
        entitlementSnapshot: {
          ...rest,
          tokenBuckets,
          tokenRemaining: tokenBuckets.reduce((s, b) => s + (Number(b.remaining) || 0), 0),
          repairedAt: new Date().toISOString(),
        },
      });
      console.log('    ✔ 账号口径已修复');
    }
  }

  // credit_history：删除 ZCode 账号的历史快照
  const ids = accounts.map((a) => a.id);
  const placeholders = ids.map(() => '?').join(',');
  const before = db().prepare(
    `SELECT COUNT(*) AS n FROM credit_history WHERE account_id IN (${placeholders})`
  ).get(...ids).n;
  console.log(`\ncredit_history：待删除 ${before} 条 ZCode 快照`);
  if (APPLY && before > 0) {
    const info = db().prepare(
      `DELETE FROM credit_history WHERE account_id IN (${placeholders})`
    ).run(...ids);
    console.log(`  ✔ 已删除 ${info.changes} 条`);
  }
  if (!APPLY) console.log('\n（dry-run 结束；确认无误后加 --apply 执行）');
}

main();