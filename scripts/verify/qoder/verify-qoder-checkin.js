'use strict';
/**
 * 验证 Qoder 每日积分（100 Credits）查询端点。
 * 依据：qoder2api-hub/qoder_accounts.py
 *   PATH_CHECKIN_STATUS = "/sash/api/v1/me/daily-check-in/status"
 *   PATH_CHECKIN_CLAIM  = "/sash/api/v1/me/daily-check-in/claim"
 *   PATH_QUOTA          = "/api/v2/quota/usage"
 *   PATH_CAMPAIGNS      = "/sash/api/v1/me/campaigns"
 *
 * 本脚本只做 GET（status / quota / campaigns），**不发起 claim**——
 * 领取是不可逆写操作，应由产品侧的定时任务在确认语义后执行。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const APP_DIR = path.join(process.env.APPDATA, 'com.qoder.app.stable');
const BASE = process.env.QODER_OPENAPI || 'https://openapi.qoder.sh';

function dpapiUnprotect(buf) {
  const ps = [
    'Add-Type -AssemblyName System.Security',
    '$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    '$out = [System.Security.Cryptography.ProtectedData]::Unprotect($in, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($out)',
  ].join('; ');
  return Buffer.from(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    input: buf.toString('base64'), encoding: 'utf8', windowsHide: true,
  }).trim(), 'base64');
}

function decryptV10(blob, key) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.slice(3, 15));
  const ct = blob.slice(15);
  d.setAuthTag(ct.slice(ct.length - 16));
  return Buffer.concat([d.update(ct.slice(0, ct.length - 16)), d.final()]);
}

const state = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'Local State'), 'utf8'));
const ekBlob = Buffer.from(state.os_crypt.encrypted_key, 'base64');
const key = dpapiUnprotect(ekBlob.slice(5));
const auth = JSON.parse(decryptV10(fs.readFileSync(path.join(APP_DIR, 'auth.v1.dat')), key).toString('utf8'));
const token = auth.token;
const uid = (auth.user || {}).id;

// 桌面端头形态（qoder2api-hub: desktop_headers / headers）
function headers(extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'Qoder',
    'cosy-clienttype': '10',
    'cosy-version': '0.4.3',
    'cosy-machineos': 'x86_64_win32',
    'cosy-machinehostname': 'DESKTOP-QODER',
    'cosy-machineid': crypto.createHash('md5').update(`machine:${uid}`).digest('hex'),
    ...extra,
  };
}

async function get(p, label, hdrs) {
  console.log(`\n=== ${label} ===`);
  console.log(`GET ${BASE}${p}`);
  try {
    const r = await fetch(BASE + p, { headers: hdrs || headers(), signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    console.log('HTTP', r.status);
    console.log(t.slice(0, 900));
    return { status: r.status, body: t };
  } catch (e) {
    console.log('请求失败:', e.message);
    return { status: 0, body: '' };
  }
}

(async () => {
  console.log('uid:', uid, '| token:', String(token).slice(0, 6) + '…');

  const info = await get('/api/v1/userinfo', '用户信息');
  const quota = await get('/api/v2/quota/usage', '额度（积分余额）');
  const status = await get('/sash/api/v1/me/daily-check-in/status', '每日签到状态（旧 sash 接口）');
  const camp = await get('/sash/api/v1/me/campaigns', '活动平台列表（每日 100 Credits）');

  // 结构化摘要：把本次实证到的关键事实打出来，便于写接入文档时直接引用
  console.log('\n\n========== 实证摘要 ==========');
  try {
    const q = JSON.parse(quota.body);
    console.log('积分口径  :', JSON.stringify({
      userType: q.userType, usageType: q.usageType,
      userQuota: q.userQuota, addOnQuota: q.addOnQuota,
      expiresAt: new Date(q.expiresAt).toISOString(), isQuotaExceeded: q.isQuotaExceeded,
    }));
  } catch { /* ignore */ }
  try {
    const c = JSON.parse(camp.body);
    console.log('showCampaign:', c.showCampaign, '| claimable:', c.claimable);
    for (const it of c.campaigns || []) {
      const b = it.benefit || {};
      const zh = (it.placements && it.placements[0] && it.placements[0].content && it.placements[0].content.zh) || {};
      console.log('\n活动:', it.campaignKey, '| id:', it.campaignId);
      console.log('  actionType :', it.actionType);
      console.log('  claimStatus:', it.claimStatus);
      console.log('  benefit    :', JSON.stringify(b));
      console.log('  startAt    :', new Date(it.startAt * 1000).toISOString());
      console.log('  endAt      :', new Date(it.endAt * 1000).toISOString());
      console.log('  title(zh)  :', zh.title);
      console.log('  desc(zh)   :', zh.description);
      console.log('  detailUrl  :', zh.detailUrl);
    }
  } catch { /* ignore */ }

  // claim 端点语义探测：只在存在 CLAIMABLE 活动时才有意义。
  // 本账号今日已 CLAIMED，若强行 claim 可观察幂等行为（返回 replayed=true 而非重复发放）。
  const claimable = (() => {
    try {
      const c = JSON.parse(camp.body);
      return (c.campaigns || []).filter((x) => x.claimStatus === 'CLAIMABLE');
    } catch { return []; }
  })();
  if (process.env.QODER_TRY_CLAIM === '1' && claimable.length) {
    for (const it of claimable) {
      console.log(`\n=== 尝试领取 ${it.campaignKey}（POST claim）===`);
      try {
        const r = await fetch(`${BASE}/sash/api/v1/me/campaigns/${it.campaignId}/claim`, {
          method: 'POST', headers: headers(), body: '{}', signal: AbortSignal.timeout(20000),
        });
        console.log('HTTP', r.status);
        console.log((await r.text()).slice(0, 600));
      } catch (e) { console.log('请求失败:', e.message); }
    }
  } else {
    console.log('\n（未设 QODER_TRY_CLAIM=1 或无 CLAIMABLE 活动，跳过 claim 写操作）');
  }
})();
