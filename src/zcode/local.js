'use strict';
/**
 * zcode/local.js — 从本机 ZCode 桌面客户端凭据导入账号。
 *
 * 客户端把凭据存在 ~/.zcode/v2/credentials.json，字段为 AES-256-GCM 密文
 * （"enc:v1:<iv>.<tag>.<ciphertext>"，base64url 三段）。加密实现取自客户端
 * asar（app/host/index.js 的 createCredentialCipherProvider）：
 *
 *   key   = sha256(secret)
 *   secret= env.ZCODE_CREDENTIAL_SECRET
 *         || `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`
 *
 * 平台语义：os.platform() → 'win32'；homedir 用绝对路径（C:\Users\<user>）。
 * 本模块只做「读自己机器上自己账号的凭据」，不接受远程导入。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function credentialsPath() {
  const p = String(process.env.ZCODE_CLIENT_CREDENTIALS || '').trim();
  if (p) return p;
  return path.join(os.homedir(), '.zcode', 'v2', 'credentials.json');
}

function telemetryPath() {
  const p = String(process.env.ZCODE_CLIENT_TELEMETRY || '').trim();
  if (p) return p;
  return path.join(os.homedir(), '.zcode', 'v2', 'telemetry-state.json');
}

/** 与客户端 t7() 同源的密钥派生。 */
function deriveSecret() {
  const env = String(process.env.ZCODE_CREDENTIAL_SECRET || '').trim();
  if (env) return env;
  const platform = os.platform(); // 'win32' / 'darwin' / 'linux'
  const home = os.homedir();
  let username = '';
  try { username = os.userInfo().username; } catch { username = ''; }
  return `zcode-credential-fallback:${platform}:${home}:${username}`;
}

function b64urlToBuf(s) {
  return Buffer.from(s, 'base64url');
}

/** 解密单个字段；非密文原样返回。 */
function decryptField(val, key) {
  if (typeof val !== 'string' || !val.startsWith(PREFIX)) return val;
  const [ivB, tagB, ctB] = val.slice(PREFIX.length).split('.');
  if (!ivB || !tagB || !ctB) throw new Error('密文格式非法（应为 iv.tag.ct 三段）');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, b64urlToBuf(ivB));
  decipher.setAuthTag(b64urlToBuf(tagB));
  return Buffer.concat([decipher.update(b64urlToBuf(ctB)), decipher.final()]).toString('utf-8');
}

/** 本机客户端是否安装（凭据文件存在）。 */
function isClientInstalled() {
  return fs.existsSync(credentialsPath());
}

/**
 * 读取并解密本机客户端凭据。
 * @returns {object} { 'zcodejwttoken': '...', 'oauth:bigmodel:access_token': '...', ... }
 */
function readLocalCredentials() {
  const file = credentialsPath();
  if (!fs.existsSync(file)) {
    throw new Error(`未找到 ZCode 客户端凭据文件：${file}（请确认已安装并登录过客户端）`);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const key = crypto.createHash('sha256').update(deriveSecret()).digest();
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    try { out[k] = decryptField(v, key); } catch (e) {
      // 密钥不匹配（用户改过用户名/家目录）时逐字段报错，便于定位
      throw new Error(`字段 ${k} 解密失败：${e.message}（若客户端重装过，请检查 ZCODE_CREDENTIAL_SECRET）`);
    }
  }
  return out;
}

/** 读 deviceMid（客户端设备标识；导入时作为指纹 device_mid 的初始值）。 */
function readDeviceMid() {
  try {
    const raw = JSON.parse(fs.readFileSync(telemetryPath(), 'utf-8'));
    return raw && typeof raw.deviceMid === 'string' ? raw.deviceMid : null;
  } catch {
    return null;
  }
}

/**
 * 从本机客户端凭据构造 store 账号记录（未入库）。
 * mode 固定 'jwt'（billing 面只认 zcodejwttoken）；api_key 通道本机客户端不产生。
 *
 * 设备档案用 forHost 而非随机 SKU：本机账号就是这台机器上的真实客户端账号，
 * 沿用真实 deviceMid 与宿主平台形态，比随机「伦敦的 Mac」更少设备维度风险
 * （客户端自己上报的激活/日活事件用的就是这个 deviceMid）。
 */
function buildAccountFromLocal() {
  const creds = readLocalCredentials();
  const jwt = String(creds.zcodejwttoken || '').trim();
  if (!jwt) throw new Error('本机凭据中无 zcodejwttoken（客户端可能未完成登录）');
  const userId = jwtUserId(jwt);
  const deviceMid = readDeviceMid();
  const label = `zcode-local${userId ? `-${userId}` : ''}`;
  return {
    label,
    edition: 'zcode',
    mode: 'jwt',
    token: jwt,
    refreshToken: null,   // 客户端 bigmodel OAuth 流程不返回 refresh_token
    expiredAt: null,      // JWT 无 exp 字段，长期有效
    userId,
    host: 'https://zcode.z.ai',
    source: 'local',
    fingerprint: require('./fingerprint').forHost(deviceMid),
  };
}

/** JWT payload 的 user_id（sub 兜底）。 */
function jwtUserId(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  const seg = t.split('.')[1];
  if (!seg) return null;
  try {
    const payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf-8'));
    const uid = payload.user_id || payload.sub;
    return uid != null && String(uid).trim() ? String(uid).trim() : null;
  } catch {
    return null;
  }
}

module.exports = {
  PREFIX,
  credentialsPath,
  telemetryPath,
  deriveSecret,
  decryptField,
  isClientInstalled,
  readLocalCredentials,
  readDeviceMid,
  buildAccountFromLocal,
  jwtUserId,
};