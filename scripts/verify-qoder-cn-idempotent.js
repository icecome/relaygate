'use strict';
/**
 * Qoder CN 幂等性验证：对已领取活动重复 POST claim。
 * 期望：HTTP 200 + {"status":"CLAIMED","replayed":true}，且额度不重复增加。
 * 依据：qoder2api-hub 注释「已领取返回 {"status":"CLAIMED","replayed":true}，不会重复发放」。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const APP_DIR = path.join(process.env.APPDATA, 'com.qodercn.app.stable');
const BASE = 'https://openapi.qoder.com.cn';

function dpapiUnprotect(buf) {
  const ps = [
    'Add-Type -AssemblyName System.Security',
    '$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    '$out = [System.Security.Cryptography.ProtectedData]::Unprotect($in, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($out)',
  ].join('; ');
  return Buffer.from(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    input: buf.toString('base64'), encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  }).trim(), 'base64');
}
function decryptV10(blob, key) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.slice(3, 15));
  const ct = blob.slice(15);
  d.setAuthTag(ct.slice(ct.length - 16));
  return Buffer.concat([d.update(ct.slice(0, ct.length - 16)), d.final()]);
}

const state = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'Local State'), 'utf8'));
const key = dpapiUnprotect(Buffer.from(state.os_crypt.encrypted_key, 'base64').slice(5));
const auth = JSON.parse(decryptV10(fs.readFileSync(path.join(APP_DIR, 'auth.v1.dat')), key).toString('utf8'));
const uid = (auth.user || {}).id;
const headers = {
  Authorization: `Bearer ${auth.token}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'User-Agent': 'Qoder',
  'cosy-clienttype': '10',
  'cosy-version': '0.4.3',
};

const quotaRemain = async () => {
  const r = await fetch(BASE + '/api/v2/quota/usage', { headers, signal: AbortSignal.timeout(25000) });
  const j = await r.json();
  return ((j.userQuota || {}).remaining || 0) + ((j.addOnQuota || {}).remaining || 0);
};

(async () => {
  const before = await quotaRemain();
  console.log('领取前总剩余积分:', before);

  // 取已领取的每日活动 id
  const r = await fetch(BASE + '/sash/api/v1/me/campaigns', { headers, signal: AbortSignal.timeout(25000) });
  const j = await r.json();
  const claimed = (j.campaigns || []).find((c) => c.claimStatus === 'CLAIMED' && (c.benefit || {}).kind === 'CREDITS');
  if (!claimed) { console.log('未找到已领取的 CREDITS 活动'); return; }
  console.log('目标活动:', claimed.campaignKey, '| id:', claimed.campaignId, '| amount:', claimed.benefit.amount);

  console.log('\n--- 第 1 次重复 claim ---');
  let rr = await fetch(`${BASE}/sash/api/v1/me/campaigns/${claimed.campaignId}/claim`, {
    method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(25000),
  });
  console.log('HTTP', rr.status);
  console.log((await rr.text()).slice(0, 500));

  console.log('\n--- 第 2 次重复 claim ---');
  rr = await fetch(`${BASE}/sash/api/v1/me/campaigns/${claimed.campaignId}/claim`, {
    method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(25000),
  });
  console.log('HTTP', rr.status);
  console.log((await rr.text()).slice(0, 500));

  const after = await quotaRemain();
  console.log('\n领取后总剩余积分:', after);
  console.log(`>>> 幂等结论: ${after === before ? 'PASS — 重复领取未增加额度' : `FAIL — 额度变化 ${before} → ${after}`}`);
})().catch((e) => { console.error('失败:', e.message); process.exitCode = 1; });
