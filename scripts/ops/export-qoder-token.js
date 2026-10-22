'use strict';
/**
 * scripts/export-qoder-token.js — 在装有 Qoder 客户端的那台 Windows 上，
 * 解出本机登录态并打印完整 dt- token，供粘到另一台机器的
 * 「接入 Qoder → 手动粘贴 token」里导入。
 *
 * 为什么需要它：DPAPI 密文绑「生成它的那个 Windows 用户」，auth.v1.dat 与
 * Local State 拷到别的机器/别的用户下**永远解不开**（实测：同机换个用户即
 * CryptographicException，见 docs/known-limitations.md F7）。但 Qoder 上游只认
 * 纯 Bearer 的 dt- token，凭据本身不绑机器——所以正确做法是「在能解的机器上
 * 解，把 token 带过去」。
 *
 * 用法（在目标机器上执行，不需要 RelayGate 仓库）：
 *   node export-qoder-token.js            # 两个区域都打印
 *   node export-qoder-token.js intl       # 只打印国际版
 *   node export-qoder-token.js cn
 *
 * 只读不写：不修改客户端任何文件，不发任何网络请求。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/** 区域 → 客户端目录与家目录（与 platform/variant.js 的 realms 表一致，此处自含以免依赖仓库）。 */
const REALMS = {
  cn: { appDir: 'com.qodercn.app.stable', label: '国内版' },
  intl: { appDir: 'com.qoder.app.stable', label: '国际版' },
};

const V10_PREFIX = 'v10';
const DPAPI_PREFIX = 'DPAPI';
const KEY_LEN = 32;

if (process.platform !== 'win32') {
  console.error('本脚本只支持 Windows：DPAPI 依赖 System.Security.Cryptography.ProtectedData。');
  process.exit(1);
}

/** DPAPI CryptUnprotectData（CurrentUser）。经 stdin 传 base64——命令行传参会被 PowerShell 当裸 token 解析。 */
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
    timeout: 30000,
  });
  const b = Buffer.from(String(out).trim(), 'base64');
  if (!b.length) throw new Error('DPAPI 返回空');
  return b;
}

/** Chromium os_crypt v10：v10 + nonce(12) + AES-256-GCM(ciphertext + tag)。 */
function decryptV10(blob, key) {
  if (blob.slice(0, 3).toString('latin1') !== V10_PREFIX) throw new Error('前缀不是 "v10"');
  const nonce = blob.slice(3, 15);
  const sealed = blob.slice(15);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(sealed.slice(sealed.length - 16));
  return Buffer.concat([d.update(sealed.slice(0, sealed.length - 16)), d.final()]);
}

/**
 * 解出并打印一个区域的凭据。
 * @returns {{realm:string, token:string}|null} 成功时返回 token（供调用方汇总），失败返回 null
 */
function exportRealm(realm) {
  const cfg = REALMS[realm];
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const dir = path.join(roaming, cfg.appDir);
  const authFile = path.join(dir, 'auth.v1.dat');
  const localState = path.join(dir, 'Local State');

  console.log(`\n=== ${cfg.label}（${realm}）===`);
  console.log('客户端目录:', dir);

  if (!fs.existsSync(authFile)) {
    console.log('RESULT: 未找到 auth.v1.dat（本机未安装或未登录该区域客户端）');
    return null;
  }
  if (!fs.existsSync(localState)) {
    console.log('RESULT: 未找到 Local State（无法取 os_crypt 密钥）');
    return null;
  }

  let key;
  try {
    const state = JSON.parse(fs.readFileSync(localState, 'utf8'));
    const ek = state && state.os_crypt && state.os_crypt.encrypted_key;
    if (typeof ek !== 'string' || !ek) throw new Error('Local State 缺少 os_crypt.encrypted_key');
    const blob = Buffer.from(ek, 'base64');
    if (blob.slice(0, 5).toString('latin1') !== DPAPI_PREFIX) throw new Error('encrypted_key 头不是 DPAPI');
    key = dpapiUnprotect(blob.slice(5));
  } catch (e) {
    console.log(`RESULT: 解不开 —— ${e.message.split('\n')[0]}`);
    console.log('  常见原因：本机当前 Windows 用户不是登录该客户端的那个人。');
    console.log('  请用当初登录 Qoder 的那个 Windows 账户重新运行本脚本。');
    return null;
  }
  if (key.length !== KEY_LEN) {
    console.log(`RESULT: 密钥长度异常（${key.length} 字节）`);
    return null;
  }

  let data;
  try {
    data = JSON.parse(decryptV10(fs.readFileSync(authFile), key).toString('utf8'));
  } catch (e) {
    console.log(`RESULT: auth.v1.dat 解密失败（AES 认证不通过）—— ${e.message}`);
    return null;
  }

  const user = (data && data.user) || {};
  const token = String(data.token || '').trim();
  if (!token) {
    console.log('RESULT: 解密结果里没有 token（客户端可能未完成登录）');
    return null;
  }

  console.log('账号:', JSON.stringify({
    id: user.id != null ? String(user.id) : null,
    name: user.name != null ? String(user.name) : null,
    email: user.email != null ? String(user.email) : null,
  }));
  console.log('token 有效期至:', data.expiresAt || '(未记录)');
  console.log('\n----- 下面这行整行复制，粘到另一台机器的「手动粘贴 token」里 -----');
  console.log(token);
  console.log('------------------------------------------------------------------');
  console.log('注意：token 等同账号密码，请只粘给可信的管理面板，勿发到聊天/邮件/截图。');
  return { realm, token };
}

const only = process.argv[2] ? String(process.argv[2]).toLowerCase() : null;
if (only && !REALMS[only]) {
  console.error(`未知区域 "${only}"，只接受 cn / intl`);
  process.exit(1);
}
const targets = only ? [only] : Object.keys(REALMS);

const got = [];
for (const r of targets) {
  const one = exportRealm(r);
  if (one) got.push(one);
}

if (got.length > 1) {
  console.log('\n=== 汇总（两个区域账号体系独立，需分别导入，别粘错区域）===');
  for (const g of got) console.log(`${REALMS[g.realm].label}（${g.realm}）: ${g.token}`);
}
if (got.length === 0) {
  console.log('\n两个区域都没解出凭据。若换了 Windows 账户后仍失败，请确认客户端确实已登录。');
}
