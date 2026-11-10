'use strict';
/**
 * scripts/verify/trae/verify-checkin-status.js — 只读核对：每个启用 Trae 账号今日是否已签。
 *
 * 只打 status 端点，绝不 claim，可反复运行（status 不计签到次）。
 * 用途：回答「claimed=N / already=M 里那 M 个是谁签的」——面板与 task-log 只记
 * 数量不记账号，本脚本逐号打印上游权威结论 + 本地 DB 记录做对照。
 *
 * 用法：node scripts/verify/trae/verify-checkin-status.js
 * 覆盖：TRAE_UG_HOST（与 src/upstream/checkin.js 同一变量）。
 */
const path = require('path');
process.env.LOGS_DIR = process.env.LOGS_DIR || path.join(__dirname, '..', '..', '..', 'logs');
const store = require('../../../src/credentials/store');
const auth = require('../../../src/auth');
const headersLib = require('../../../src/lib/headers');
const variant = require('../../../src/platform/variant');

const PATHS = variant.variantOf(variant.TRAE).paths;
const HOST = (process.env.TRAE_UG_HOST || variant.variantOf(variant.TRAE).hosts.ug).replace(/\/$/, '');

(async () => {
  const accounts = store.list().filter((a) => a.enabled && variant.isTrae(a.edition));
  console.log(`host=${HOST} path=${PATHS.checkinStatus} accounts=${accounts.length}`);
  let signed = 0;
  let unsigned = 0;
  let errored = 0;
  for (const a of accounts) {
    const full = store.get(a.id);
    try {
      const info = await auth.ensureAuth(a.id);
      const acct = { ...full, ...info };
      const resp = await fetch(HOST + PATHS.checkinStatus, {
        method: 'POST',
        headers: headersLib.buildCommonHeaders({
          token: acct.token,
          userId: acct.userId,
          devices: acct.devices,
          _edition: acct.edition || 'cn',
        }),
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15000),
      });
      const data = await resp.json().catch(() => null);
      const root = (data && typeof data === 'object') ? data : {};
      const d = (root.data && typeof root.data === 'object') ? root.data : root;
      const ci = d.checked_in ?? d.checkedIn ?? d.did_checked_in ?? d.didCheckedIn;
      const code = root.code ?? d.code;
      const credits = typeof d.credits === 'number'
        ? d.credits
        : (typeof root.credits === 'number' ? root.credits : null);
      const enable = d.enable !== false && d.enabled !== false;
      const flag = !!ci;
      if (flag) signed += 1;
      else unsigned += 1;
      const dev = acct.devices || {};
      console.log([
        flag ? 'SIGNED  ' : 'UNSIGNED',
        String(a.label || a.id).padEnd(14),
        a.id,
        'code=' + code,
        'enable=' + enable,
        'credits=' + credits,
        'http=' + resp.status,
        'xdev=' + (dev.deviceId || ''),
        'db=' + (full.lastCheckinAt || '-'),
        full.lastCheckinResult || '-',
      ].join(' | '));
    } catch (e) {
      errored += 1;
      console.log(`ERROR       ${a.label} ${a.id} ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  console.log(`SUMMARY signed=${signed} unsigned=${unsigned} error=${errored} total=${accounts.length}`);
})().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
