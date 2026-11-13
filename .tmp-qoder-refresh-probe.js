'use strict';
/**
 * 一次性探针：用库里「已被客户端轮换掉」的旧 refresh_token 打续期端点，
 * 观测终态语义（预期 401 → 证明 drt- 是轮换制、旧值即失效）。
 * 不会产生新凭据，也不写入任何文件。
 */
const store = require('./src/credentials/store');
const variant = require('./src/platform/variant');

const ID = process.argv[2] || 'acct_mv7tozq8fbea8e1e'; // 国际版 local 账号
const MACHINE = process.argv[3] || '40fd0e5d-6f52-426d-bfb2-f450615cdf93';

(async () => {
  const acct = store.get(ID);
  if (!acct) throw new Error(`账号不存在: ${ID}`);
  const realm = variant.qoderRealmOfAccount(acct);
  const base = variant.qoderOpenapiBase(realm);
  const path = variant.variantOf(variant.QODER).paths.deviceRefresh;
  console.log(`账号 ${acct.id} realm=${realm} rt尾=${String(acct.refreshToken || '').slice(-6)} machine=${MACHINE}`);
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'qoder/1.0.0' },
    body: JSON.stringify({ refresh_token: acct.refreshToken, machine_id: MACHINE }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  console.log(`HTTP ${r.status} :: ${text.slice(0, 400)}`);
})();