'use strict';
/**
 * qoder/crypto.js — Qoder 桌面客户端凭据解密（Chromium os_crypt v10 + Windows DPAPI）。
 *
 * 客户端把凭据存在 `%APPDATA%\<appDir>\auth.v1.dat`：
 *   "v10" + nonce(12) + AES-256-GCM(ciphertext + tag)
 * 密钥在同目录 `Local State` 的 `os_crypt.encrypted_key`：
 *   base64( "DPAPI" + DPAPI 保护的 32 字节 AES key )
 *
 * DPAPI（CryptUnprotectData）没有 Node 原生绑定，两条路：
 *   1. Windows：借 powershell.exe 调 [System.Security.Cryptography.ProtectedData]
 *      —— 必须经 stdin 传 base64，命令行传参会被 PowerShell 当裸 token 解析
 *   2. 非 Windows / 无 powershell：直接失败（客户端只在 Windows 上跑，
 *      服务端跑在 Linux 时凭据应经导入而非本机扫描）
 *
 * 解密结果形如：
 *   { schemaVersion, token:"dt-…", refreshToken:"drt-…", expiresAt,
 *     refreshTokenExpiresAt, user:{ id, name, email } }
 *
 * 边界：本模块只做「解密」，不判定账号是否可用、不发起上游请求。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const V10_PREFIX = 'v10';
const DPAPI_PREFIX = 'DPAPI';

/** os_crypt 密钥长度（AES-256）。 */
const KEY_LEN = 32;

class QoderCryptoError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'QoderCryptoError';
    this.cause = cause;
  }
}

/** 是否为 Windows（DPAPI 仅 Windows 有）。 */
function isWindows() {
  return process.platform === 'win32';
}

/**
 * DPAPI CryptUnprotectData（CurrentUser scope）。
 * 经 stdin 传 base64：命令行传参在 PowerShell 里会被当作裸 token，ParserError。
 */
function dpapiUnprotect(buf) {
  if (!isWindows()) {
    throw new QoderCryptoError('DPAPI 仅支持 Windows（Qoder 客户端凭据只能在 Windows 本机解密）');
  }
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    '$out = [System.Security.Cryptography.ProtectedData]::Unprotect($in, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($out)',
  ].join('; ');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: Buffer.from(buf).toString('base64'),
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 20000,
    });
    const b = Buffer.from(String(out).trim(), 'base64');
    if (!b.length) throw new Error('DPAPI 返回空');
    return b;
  } catch (e) {
    throw new QoderCryptoError(`DPAPI 解密失败：${e.message}`, e);
  }
}

/** 解 Chromium os_crypt "v10" 载荷：v10 + nonce(12) + AES-256-GCM(ct+tag)。 */
function decryptV10(blob, key) {
  if (!Buffer.isBuffer(blob) || blob.length < 3 + 12 + 16) {
    throw new QoderCryptoError('os_crypt 载荷过短，不是有效的 v10 密文');
  }
  if (blob.slice(0, 3).toString('latin1') !== V10_PREFIX) {
    throw new QoderCryptoError(`载荷前缀不是 "v10"（实际 ${JSON.stringify(blob.slice(0, 3).toString('latin1'))}）`);
  }
  if (key.length !== KEY_LEN) {
    throw new QoderCryptoError(`AES 密钥长度应为 ${KEY_LEN} 字节（实际 ${key.length}）`);
  }
  const nonce = blob.slice(3, 15);
  const sealed = blob.slice(15);
  const ct = sealed.slice(0, sealed.length - 16);
  const tag = sealed.slice(sealed.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (e) {
    // tag 校验失败通常是「密钥不匹配」——用户改过 Windows 用户名/密码，或凭据由另一账户写入
    throw new QoderCryptoError(`AES-256-GCM 认证失败（密钥不匹配或凭据已损坏）：${e.message}`, e);
  }
}

/**
 * 从 Local State 解出 os_crypt 的 32 字节 AES 密钥。
 * @param {string} localStatePath Local State 文件路径
 * @returns {Buffer} 32 字节密钥
 */
function readOsCryptKey(localStatePath) {
  if (!fs.existsSync(localStatePath)) {
    throw new QoderCryptoError(`未找到 Local State：${localStatePath}`);
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  } catch (e) {
    throw new QoderCryptoError(`Local State 不是合法 JSON：${e.message}`, e);
  }
  const ek = state && state.os_crypt && state.os_crypt.encrypted_key;
  if (typeof ek !== 'string' || !ek) {
    throw new QoderCryptoError('Local State 缺少 os_crypt.encrypted_key');
  }
  let blob;
  try {
    blob = Buffer.from(ek, 'base64');
  } catch (e) {
    throw new QoderCryptoError(`encrypted_key 不是合法 base64：${e.message}`, e);
  }
  if (blob.slice(0, 5).toString('latin1') !== DPAPI_PREFIX) {
    throw new QoderCryptoError('encrypted_key 前缀不是 "DPAPI"（客户端版本可能已升级加密方案）');
  }
  const key = dpapiUnprotect(blob.slice(5));
  if (key.length !== KEY_LEN) {
    throw new QoderCryptoError(`DPAPI 解出的密钥长度应为 ${KEY_LEN} 字节（实际 ${key.length}）`);
  }
  return key;
}

/**
 * 解密 auth.v1.dat，返回凭据对象。
 * @param {string} appDir 客户端 app 目录（含 Local State 与 auth.v1.dat）
 */
function readAuthFile(appDir) {
  const authFile = path.join(appDir, 'auth.v1.dat');
  const localState = path.join(appDir, 'Local State');
  if (!fs.existsSync(authFile)) {
    throw new QoderCryptoError(`未找到 auth.v1.dat：${authFile}`);
  }
  const key = readOsCryptKey(localState);
  const plain = decryptV10(fs.readFileSync(authFile), key);
  let data;
  try {
    data = JSON.parse(plain.toString('utf8'));
  } catch (e) {
    throw new QoderCryptoError(`auth.v1.dat 解密结果不是合法 JSON：${e.message}`, e);
  }
  if (!data || typeof data !== 'object') {
    throw new QoderCryptoError('auth.v1.dat 解密结果为空');
  }
  return data;
}

/**
 * 归一化凭据对象（字段名兼容 + 缺省补齐）。
 * 上游 schemaVersion=1，字段为 token / refreshToken / expiresAt / refreshTokenExpiresAt / user。
 * @returns {{token:string, refreshToken:string|null, expiresAt:string|null,
 *            refreshExpiresAt:string|null, userId:string|null,
 *            userName:string|null, userEmail:string|null, schemaVersion:*}}
 */
function normalizeAuth(data) {
  const token = String(data.token || data.accessToken || data.access_token || '').trim();
  if (!token) throw new QoderCryptoError('凭据中无 token（客户端可能未完成登录）');
  const user = (data.user && typeof data.user === 'object') ? data.user : {};
  return {
    token,
    refreshToken: String(data.refreshToken || data.refresh_token || '').trim() || null,
    expiresAt: data.expiresAt || data.expires_at || null,
    refreshExpiresAt: data.refreshTokenExpiresAt || data.refresh_expires_at || null,
    userId: user.id != null && String(user.id).trim() ? String(user.id).trim() : null,
    userName: user.name != null && String(user.name).trim() ? String(user.name).trim() : null,
    userEmail: user.email != null && String(user.email).trim() ? String(user.email).trim() : null,
    schemaVersion: data.schemaVersion != null ? data.schemaVersion : null,
  };
}

/** 便捷：一步拿到归一化凭据。 */
function readCredentials(appDir) {
  return normalizeAuth(readAuthFile(appDir));
}

/** 候选 app 目录列表（realm 已知时只有一个；未知时两个都试）。 */
function candidateAppDirs(realm) {
  const variant = require('../platform/variant');
  const names = realm
    ? [variant.qoderRealmConfig(realm).appDir]
    : [variant.qoderRealmConfig('cn').appDir, variant.qoderRealmConfig('intl').appDir];
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return names.map((n) => path.join(roaming, n));
}

module.exports = {
  V10_PREFIX,
  DPAPI_PREFIX,
  KEY_LEN,
  QoderCryptoError,
  isWindows,
  dpapiUnprotect,
  decryptV10,
  readOsCryptKey,
  readAuthFile,
  normalizeAuth,
  readCredentials,
  candidateAppDirs,
};
