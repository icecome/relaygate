'use strict';
/**
 * jobs/credit-alerts.js — 余额刷新后的积分临期 / 低余额告警。
 * 依赖 entitlement_snapshot 已写入的 packs / expiring 数据。
 */
const config = require('../config');
const store = require('../credentials/store');
const { notify, notifyDetail } = require('../notify');
const { summarizeExpiry } = require('../credentials/credits');
const { round2 } = require('../lib/round');

/** 从账号快照提取临期汇总。 */
function expiryOfAccount(acct) {
  const snap = acct && acct.entitlementSnapshot;
  if (!snap || !Array.isArray(snap.packs)) return { d3: 0, d7: 0 };
  return summarizeExpiry(snap.packs);
}

/**
 * 扫描启用账号，触发 credits_expiring / balance_low。
 * @param {object} [opts]
 * @param {number} [opts.lowThreshold] 低余额阈值；缺省用 config.minBalanceToUse（>0 时）
 * @param {boolean} [opts.force] 跳过 notify 去重
 */
async function checkCreditAlerts(opts = {}) {
  const accounts = store.list().filter((a) => a.enabled);
  if (!accounts.length) return { expiring3d: 0, expiring7d: 0, lowBalance: [] };

  let expiring3d = 0;
  let expiring7d = 0;
  const lowThreshold = Number(opts.lowThreshold != null ? opts.lowThreshold : config.minBalanceToUse) || 0;
  const lowBalance = [];

  for (const a of accounts) {
    const full = store.get(a.id) || a;
    const exp = expiryOfAccount(full);
    expiring3d += exp.d3 || 0;
    expiring7d += exp.d7 || 0;
    if (lowThreshold > 0 && typeof full.balance === 'number' && full.balance < lowThreshold) {
      lowBalance.push({
        accountId: full.id,
        label: full.label || full.id,
        balance: full.balance,
      });
    }
  }

  expiring3d = round2(expiring3d);
  expiring7d = round2(expiring7d);

  if (expiring3d > 0 || expiring7d > 0) {
    const send = opts.force
      ? notifyDetail('credits_expiring', {
        message: `3 天内过期 ${expiring3d} · 7 天内过期 ${expiring7d}`,
        expiring3d,
        expiring7d,
      }, '积分临期提醒', { force: true })
      : notify('credits_expiring', {
        message: `3 天内过期 ${expiring3d} · 7 天内过期 ${expiring7d}`,
        expiring3d,
        expiring7d,
      }, '积分临期提醒');
    await send.catch(() => {});
  }

  if (lowBalance.length) {
    const payload = {
      message: `${lowBalance.length} 个账号余额低于 ${lowThreshold}`,
      threshold: lowThreshold,
      accounts: lowBalance.map((x) => `${x.label || x.accountId}: ${x.balance}`),
    };
    const send = opts.force
      ? notifyDetail('balance_low', payload, '余额过低提醒', { force: true })
      : notify('balance_low', payload, '余额过低提醒');
    await send.catch(() => {});
  }

  return { expiring3d, expiring7d, lowBalance };
}

module.exports = { checkCreditAlerts, expiryOfAccount };
