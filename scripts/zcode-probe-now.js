'use strict';
/**
 * 只读探测：ZCode 当前可领取套餐 + 持有权益（完整原始响应，便于判断
 * 「确实无活动」还是「请求失败/资格不符」）。
 */
const store = require('../src/credentials/store');
const variant = require('../src/platform/variant');
const rewards = require('../src/zcode/rewards');
const identity = require('../src/zcode/identity');
const fingerprint = require('../src/zcode/fingerprint');
const { request } = require('../src/zcode/client');
const V = variant.variantOf('zcode');

(async () => {
  const z = store.list().find((a) => variant.isEdition(a.edition, 'zcode'));
  if (!z) { console.log('库内无 zcode 账号'); process.exit(1); }
  const acct = store.get(z.id);
  const fp = fingerprint.profileFor(acct);
  console.log('账号:', acct.label, acct.id);
  console.log('指纹:', fp.platform + '-' + fp.arch, fp.deviceMid, '| appVersion=' + identity.appVersion());
  console.log('本地时间:', new Date().toString());

  // 1) 激活上报（资格信号）
  console.log('\n[1] 激活上报:', JSON.stringify(await rewards.reportActivation(acct)));

  // 2) preview 原始响应
  const pv = await request({
    method: 'GET', path: V.paths.billingPreview,
    headers: identity.identityHeaders(fp, { token: acct.token }),
    query: { app_version: identity.appVersion() },
  });
  console.log('\n[2] billing/preview 原始响应:');
  console.log(JSON.stringify(pv, null, 1));

  // 3) balance 原始响应
  const bal = await request({
    method: 'GET', path: V.paths.billingBalance,
    headers: identity.identityHeaders(fp, { token: acct.token }),
    query: { app_version: identity.appVersion() },
  });
  console.log('\n[3] billing/balance:');
  console.log(JSON.stringify(bal, null, 1).slice(0, 1500));

  // 4) 活动投放（banner/popup 里若有 claim_zcode_plan 动作即有活动）
  const mt = await request({
    method: 'GET', path: V.paths.marketingTouch,
    headers: identity.identityHeaders(fp, { token: acct.token }),
    query: { seq: String(Date.now() % 10000) },
  });
  console.log('\n[4] marketing/touch:');
  console.log(JSON.stringify(mt, null, 1).slice(0, 1200));

  // 5) 服务端下发的 startPlanPreview（活动模板声明，非账号态）
  const cfg = await request({
    method: 'GET', path: V.paths.clientConfigs,
    headers: {
      Accept: 'application/json',
      'User-Agent': `ZCode/${identity.appVersion()}`,
      'HTTP-Referer': V.identity.referer,
      'X-Title': identity.TITLE,
      'X-ZCode-App-Version': identity.appVersion(),
    },
    query: { app_version: identity.appVersion() },
    // 注意：client/configs 禁止带 platform 参数
  });
  const conf = (cfg.data && cfg.data.configs) || {};
  console.log('\n[5] client/configs:');
  console.log('  startPlanPreview =', JSON.stringify(conf.startPlanPreview));
  console.log('  captcha =', JSON.stringify(conf.captcha));
  process.exit(0);
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });