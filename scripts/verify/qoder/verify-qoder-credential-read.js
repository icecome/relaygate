'use strict';
/**
 * 验证 Qoder 本机凭据是否可解密（Electron os_crypt v10 + DPAPI）。
 * 与 qoder2api-hub/qoder_accounts.py::scan_desktop_credentials 同构，
 * 用 Node 原生 crypto 复现，避免引入 Python 依赖。
 *
 * 结论用途：判断 RelayGate 能否像 ZCode 那样「读文件自动导入 Qoder 账号」。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const APP_DIR = path.join(process.env.APPDATA, 'com.qoder.app.stable');
const AUTH_FILE = path.join(APP_DIR, 'auth.v1.dat');
const LOCAL_STATE = path.join(APP_DIR, 'Local State');

/** DPAPI CryptUnprotectData：借 PowerShell 的 ProtectedData（.NET）实现，无原生模块。
 *  经 stdin 传 base64——命令行传参会被 PowerShell 当裸 token 解析而 ParserError。 */
function dpapiUnprotect(buf) {
  const ps = [
    'Add-Type -AssemblyName System.Security',
    '$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    '$out = [System.Security.Cryptography.ProtectedData]::Unprotect($in, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($out)',
  ].join('; ');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    input: buf.toString('base64'),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return Buffer.from(out.trim(), 'base64');
}

/** Chromium os_crypt v10: "v10" + nonce(12) + AES-256-GCM ciphertext+tag */
function chromiumDecryptV10(blob, key) {
  if (blob.slice(0, 3).toString() !== 'v10') throw new Error('not a v10 payload');
  const nonce = blob.slice(3, 15);
  const ct = blob.slice(15);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(ct.slice(ct.length - 16));
  return Buffer.concat([d.update(ct.slice(0, ct.length - 16)), d.final()]);
}

console.log('app dir :', APP_DIR);
if (!fs.existsSync(AUTH_FILE)) {
  console.log('RESULT: auth.v1.dat 不存在（本机未以该形态登录）');
  process.exit(0);
}

const state = JSON.parse(fs.readFileSync(LOCAL_STATE, 'utf8'));
const ek = (state.os_crypt || {}).encrypted_key;
if (!ek) throw new Error('Local State 无 os_crypt.encrypted_key');
const ekBlob = Buffer.from(ek, 'base64');
console.log('encrypted_key prefix:', ekBlob.slice(0, 5).toString('latin1'));
if (ekBlob.slice(0, 5).toString() !== 'DPAPI') throw new Error('encrypted_key 头不是 DPAPI');

const key = dpapiUnprotect(ekBlob.slice(5));
console.log('DPAPI 解出 key 长度:', key.length, 'bytes');

const blob = fs.readFileSync(AUTH_FILE);
console.log('auth.v1.dat 前缀:', JSON.stringify(blob.slice(0, 3).toString('latin1')), 'size:', blob.length);

const plain = chromiumDecryptV10(blob, key);
const data = JSON.parse(plain.toString('utf8'));
console.log('\n=== 解密成功 ===');
console.log('keys      :', Object.keys(data).join(', '));
console.log('token     :', String(data.token || '').slice(0, 6) + '…(len=' + String(data.token || '').length + ')');
console.log('refresh   :', String(data.refreshToken || '').slice(0, 6) + '…(len=' + String(data.refreshToken || '').length + ')');
console.log('expiresAt :', data.expiresAt);
const u = data.user || {};
console.log('user      :', JSON.stringify({ id: u.id, name: u.name, email: u.email }));
console.log('\nRESULT: 可解密 → RelayGate 能像 ZCode 一样读文件自动导入 Qoder 账号');
