'use strict';
/**
 * 一次性：把上一次探针换回的凭据落库，并验证新 token 可用。
 * 硬编码的只是「探针产物」——正式实现见 src/qoder/refresh.js。
 */
const store = require('./src/credentials/store');
const variant = require('./src/platform/variant');
const client = require('./src/qoder/client');

const ID = 'acct_mv7tozq8fbea8e1e';
const NEXT = {
  token: 'dt-JUAR6KWvqe5cnAtGNz8v8xsY',
  refreshToken: 'drt-sVKLOi6IgsT1cjaxDBuGFQI0',
  expiredAt: '2026-12-13T03:11:44Z',
  refreshExpiredAt: '2027-11-08T03:11:44Z',
};

(async () => {
  const acct = store.get(ID);
  const realm = variant.qoderRealmOfAccount(acct);
  const j = await client.request({ method: 'GET', path: 'userinfo', token: NEXT.token, realm });
  console.log('新 token userinfo:', JSON.stringify({ name: j && j.name, id: j && j.id }).slice(0, 200));
  const saved = store.update(ID, {
    ...NEXT,
    lastRefreshAt: new Date().toISOString(),
    lastKeepaliveAt: new Date().toISOString(),
    lastKeepaliveResult: 'ok (manual probe refresh)',
  });
  console.log('已落库:', JSON.stringify({
    id: saved.id, expiredAt: saved.expiredAt, refreshExpiredAt: saved.refreshExpiredAt,
    hasToken: !!saved.token, hasRefreshToken: !!saved.refreshToken,
  }));
})();