'use strict';
/**
 * Qoder CN（国内版）积分活动查询与领取。
 *
 * 依据 v2 实证：`GET /sash/api/v1/me/campaigns` 返回活动列表，
 * 国内版基址 https://openapi.qoder.com.cn。
 *
 * 本脚本流程（与 qoder2api-hub 的 campaign_checkin 同构）：
 *   1. 解密 CN auth.v1.dat 取 dt- token
 *   2. 带桌面端头拉 campaigns
 *   3. 找出 kind=CREDITS 且 claimStatus=CLAIMABLE 的活动
 *   4. POST /sash/api/v1/me/campaigns/{id}/claim 领取
 *   5. 领取后复查 quota/usage 与 campaigns，确认积分到账
 *
 * 默认 DRY-RUN（只查不领）。传 --claim 才实际领取。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const APP_DIR = path.join(process.env.APPDATA, 'com.qodercn.app.stable');
const BASE = process.env.QODER_CN_OPENAPI || 'https://openapi.qoder.com.cn';
const DO_CLAIM = process.argv.includes('--claim');

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

// ---- 1. 取 CN token ----
const state = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'Local State'), 'utf8'));
const ekBlob = Buffer.from(state.os_crypt.encrypted_key, 'base64');
const key = dpapiUnprotect(ekBlob.slice(5));
const auth = JSON.parse(decryptV10(fs.readFileSync(path.join(APP_DIR, 'auth.v1.dat')), key).toString('utf8'));
const token = auth.token;
const uid = (auth.user || {}).id;

// 桌面端头（qoder2api-hub: desktop_headers）。
// CN 侧不发 cosy-machine* 六头是正确的（详见 v2 文档 3.2）；这里也不发。
function headers() {
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
  };
}

async function jget(p, label) {
  console.log(`\n--- GET ${p}  ${label ? '(' + label + ')' : ''}`);
  const r = await fetch(BASE + p, { headers: headers(), signal: AbortSignal.timeout(25000) });
  const t = await r.text();
  console.log('HTTP', r.status);
  let j = null;
  try { j = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, text: t, json: j };
}

(async () => {
  console.log('='.repeat(66));
  console.log('Qoder 国内版（CN）积分活动验证');
  console.log('='.repeat(66));
  console.log('BASE  :', BASE);
  console.log('uid   :', uid);
  console.log('token :', `${String(token).slice(0, 6)}… (len=${token.length})`);
  console.log('模式  :', DO_CLAIM ? '!! 实际领取（--claim） !!' : 'DRY-RUN（只查不领）');

  // 2. 用户信息 + 额度基线
  const info = await jget('/api/v1/userinfo', '用户信息');
  if (info.json) {
    console.log('  用户:', JSON.stringify({
      id: info.json.id, name: info.json.name, email: info.json.email, source: info.json.source,
    }));
  }
  const quota0 = await jget('/api/v2/quota/usage', '额度基线');
  const showQuota = (j) => j && {
    userType: j.userType, usageType: j.usageType,
    base: j.userQuota && { total: j.userQuota.total, used: j.userQuota.used, remaining: j.userQuota.remaining },
    addOn: j.addOnQuota && { total: j.addOnQuota.total, used: j.addOnQuota.used, remaining: j.addOnQuota.remaining },
    expiresAt: j.expiresAt && new Date(j.expiresAt).toISOString(),
    isQuotaExceeded: j.isQuotaExceeded,
  };
  console.log('  额度:', JSON.stringify(showQuota(quota0.json)));

  // 3. 活动列表
  const camp = await jget('/sash/api/v1/me/campaigns', '活动平台');
  const campaigns = (camp.json && camp.json.campaigns) || [];
  console.log(`  showCampaign=${camp.json && camp.json.showCampaign} claimable=${camp.json && camp.json.claimable} count=${campaigns.length}`);

  const claimable = [];
  for (const c of campaigns) {
    const b = c.benefit || {};
    const zh = ((c.placements || [])[0] || {}).content && ((c.placements || [])[0] || {}).content.zh || {};
    console.log('\n  活动:', c.campaignKey);
    console.log('    id         :', c.campaignId);
    console.log('    actionType :', c.actionType);
    console.log('    status     :', c.claimStatus);
    console.log('    benefit    :', JSON.stringify(b));
    console.log('    window     :', new Date(c.startAt * 1000).toISOString(), '→', new Date(c.endAt * 1000).toISOString());
    console.log('    title(zh)  :', zh.title);
    console.log('    desc(zh)   :', zh.description);
    console.log('    detailUrl  :', zh.detailUrl);
    if (c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE') {
      claimable.push({ c, kind: String(b.kind || '').toUpperCase(), amount: Number(b.amount || 0) });
    }
  }

  if (!claimable.length) {
    console.log('\n>>> 无可领取活动（全部已领取 / 非领取型 / 未开放）');
    return;
  }

  console.log(`\n>>> 发现 ${claimable.length} 个可领取活动：`);
  for (const x of claimable) console.log(`    ${x.c.campaignKey}  kind=${x.kind} amount=${x.amount}`);

  if (!DO_CLAIM) {
    console.log('\n（DRY-RUN：未传 --claim，跳过领取。确认无误后加 --claim 重跑）');
    return;
  }

  // 4. 逐个领取
  for (const x of claimable) {
    console.log(`\n--- POST /sash/api/v1/me/campaigns/${x.c.campaignId}/claim`);
    const r = await fetch(`${BASE}/sash/api/v1/me/campaigns/${x.c.campaignId}/claim`, {
      method: 'POST', headers: headers(), body: '{}', signal: AbortSignal.timeout(25000),
    });
    const t = await r.text();
    console.log('HTTP', r.status);
    console.log(t.slice(0, 800));
  }

  // 5. 复查
  console.log('\n--- 领取后复查 ---');
  const camp2 = await jget('/sash/api/v1/me/campaigns', '活动状态');
  for (const c of (camp2.json && camp2.json.campaigns) || []) {
    const b = c.benefit || {};
    console.log(`   ${c.campaignKey}: ${c.claimStatus} (${b.kind || '-'} ${b.amount || 0})`);
  }
  const quota1 = await jget('/api/v2/quota/usage', '额度（领取后）');
  console.log('   额度:', JSON.stringify(showQuota(quota1.json)));

  const q0 = showQuota(quota0.json), q1 = showQuota(quota1.json);
  if (q0 && q1) {
    const sum = (q) => ((q.base && q.base.remaining) || 0) + ((q.addOn && q.addOn.remaining) || 0);
    const b0 = sum(q0), b1 = sum(q1);
    console.log(`\n>>> 总剩余积分: ${b0} → ${b1}  (${b1 - b0 >= 0 ? '+' : ''}${b1 - b0})`);
    console.log('>>> addOnQuota(赠送/签到额度):', JSON.stringify(q0.addOn || null), '→', JSON.stringify(q1.addOn || null));
  }

  // 6. 幂等性验证：重复 claim 同一活动，应返回 replayed=true 且不重复发放
  if (DO_CLAIM) {
    const again = (camp2.json && camp2.json.campaigns || []).find((c) => c.campaignKey === 'act-20261013-250');
    if (again) {
      console.log(`\n--- 幂等验证：再次 POST claim ${again.campaignId}`);
      const r = await fetch(`${BASE}/sash/api/v1/me/campaigns/${again.campaignId}/claim`, {
        method: 'POST', headers: headers(), body: '{}', signal: AbortSignal.timeout(25000),
      });
      console.log('HTTP', r.status);
      console.log((await r.text()).slice(0, 600));
    }
  }
})().catch((e) => { console.error('\n执行失败:', e.message); process.exitCode = 1; });
