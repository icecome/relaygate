'use strict';
/**
 * Qoder 双区域（国内版 CN / 国际版 Intl）凭据解密 + 端点验证。
 *
 * 与 v2 的 verify-qoder-credential-read.js 同构，差异：
 *   - CN: app dir = com.qodercn.app.stable, home = ~/.qoder-cn
 *   - Intl: app dir = com.qoder.app.stable, home = ~/.qoder
 * 凭据加密链路两侧相同（Chromium os_crypt v10 + DPAPI），
 * 但 CN 的 auth.v1.dat 由国内版客户端写入，token 归属 CN 账号体系。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REALMS = {
  intl: {
    label: '国际版 (Global)',
    appDir: () => path.join(process.env.APPDATA, 'com.qoder.app.stable'),
    home: () => path.join(process.env.USERPROFILE, '.qoder'),
    domain: 'qoder.sh',
  },
  cn: {
    label: '国内版 (China)',
    appDir: () => path.join(process.env.APPDATA, 'com.qodercn.app.stable'),
    home: () => path.join(process.env.USERPROFILE, '.qoder-cn'),
    domain: 'qoder.com.cn',
  },
};

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
  if (blob.slice(0, 3).toString() !== 'v10') throw new Error('not a v10 payload');
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.slice(3, 15));
  const ct = blob.slice(15);
  d.setAuthTag(ct.slice(ct.length - 16));
  return Buffer.concat([d.update(ct.slice(0, ct.length - 16)), d.final()]);
}

function loadRealm(realm) {
  const cfg = REALMS[realm];
  const appDir = cfg.appDir();
  const authFile = path.join(appDir, 'auth.v1.dat');
  const localState = path.join(appDir, 'Local State');
  if (!fs.existsSync(authFile)) return { realm, cfg, error: `auth.v1.dat 不存在（${appDir}）` };

  const state = JSON.parse(fs.readFileSync(localState, 'utf8'));
  const ekBlob = Buffer.from((state.os_crypt || {}).encrypted_key || '', 'base64');
  if (!ekBlob.length || ekBlob.slice(0, 5).toString() !== 'DPAPI') {
    return { realm, cfg, error: 'Local State 无 DPAPI encrypted_key' };
  }
  const key = dpapiUnprotect(ekBlob.slice(5));
  const data = JSON.parse(decryptV10(fs.readFileSync(authFile), key).toString('utf8'));
  return { realm, cfg, data, keyLen: key.length };
}

function report(name, r) {
  console.log(`\n${'='.repeat(64)}`);
  console.log(`${r.cfg.label}  [${name}]`);
  console.log('='.repeat(64));
  if (r.error) { console.log('  ✗', r.error); return null; }
  const d = r.data;
  const u = d.user || {};
  console.log('  appDir      :', r.cfg.appDir());
  console.log('  key length  :', r.keyLen, 'bytes');
  console.log('  schemaVersion:', d.schemaVersion);
  console.log('  token       :', `${String(d.token || '').slice(0, 6)}… (len=${String(d.token || '').length})`);
  console.log('  refreshToken:', `${String(d.refreshToken || '').slice(0, 6)}… (len=${String(d.refreshToken || '').length})`);
  console.log('  expiresAt   :', d.expiresAt, '| refreshExpiresAt:', d.refreshTokenExpiresAt);
  console.log('  user        :', JSON.stringify({ id: u.id, name: u.name, email: u.email }));
  return r;
}

console.log('Qoder 双区域凭据解密对比');
const intl = report('intl', loadRealm('intl'));
const cn = report('cn', loadRealm('cn'));

// 端点缓存对比（客户端实证的服务发现结果）
console.log(`\n${'='.repeat(64)}`);
console.log('服务端点缓存对比（客户端实证）');
console.log('='.repeat(64));
for (const realm of ['intl', 'cn']) {
  const cfg = REALMS[realm];
  const f = path.join(cfg.home(), '.cache', 'endpoint-cache.json');
  console.log(`\n[${cfg.label}] ${f}`);
  if (!fs.existsSync(f)) { console.log('  (无缓存)'); continue; }
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const e = (j.entries || {}).prod || {};
    for (const k of ['endpoint', 'fastEndpoint', 'securityEndpoint', 'centerEndpoint', 'openapiEndpoint']) {
      if (e[k]) console.log(`  ${k.padEnd(20)}: ${e[k]}`);
    }
  } catch (err) { console.log('  解析失败:', err.message); }
}

// 账号 uid 对比：确认两侧是不同账号
console.log(`\n${'='.repeat(64)}`);
console.log('账号隔离确认');
console.log('='.repeat(64));
const uidOf = (r) => (r && r.data && r.data.user && r.data.user.id) || null;
console.log('  intl uid:', uidOf(intl));
console.log('  cn   uid:', uidOf(cn));
console.log('  同一账号?', uidOf(intl) && uidOf(cn) ? String(uidOf(intl) === uidOf(cn)) : 'N/A');
