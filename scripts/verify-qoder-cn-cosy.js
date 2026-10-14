'use strict';
/**
 * Qoder CN 老版 COSY 协议连通性验证（最终版）。
 *
 * 本脚本的实现与 qoder_sign.py 逐项对齐，此前失败的原因已定位：
 *   1. cosyVersion 必须是 "1.1.64"（官方客户端内置常量），不是桌面版版本号
 *   2. ideVersion 必须是 ""（空串）
 *   3. version 必须是 "v1"
 *   4. identity 是 9 键：name/aid/uid/yx_uid/organization_id/organization_name/
 *      user_type/security_oauth_token/refresh_token
 *   5. 头集合 16 项缺一不可（cosy-data-policy/cosy-clientip/login-version/...）
 *   6. RSA 公钥 PEM 第 3 行是 "…236FZz73In/…"（FZz），转录错一个字符就 exponent 解析失败
 *   7. GET 请求必须带同款 body（服务端校验签名与 body 一致）
 *
 * 只打 /algo/api/v2/model/list（不发对话），用于确认签名链路正确。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('node:https');
const { execFileSync } = require('child_process');

const APP_DIR = path.join(process.env.APPDATA, 'com.qodercn.app.stable');
const CN_GATEWAY = 'https://gateway.qoder.com.cn';
const MODELS_PATH = '/algo/api/v2/model/list?Encode=1';

// ---- qoder_encode：Qoder 自定义 Base64 变体（尾/中/首三段重排 + 自定义字母表）----
const CUSTOM = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const S2C = {}; for (let i = 0; i < 64; i++) S2C[STD[i]] = CUSTOM[i];
function qoderEncode(buf) {
  const std = Buffer.from(buf).toString('base64');
  const n = std.length, a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  return [...rearranged].map((ch) => (ch === '=' ? '$' : S2C[ch])).join('');
}

// ---- 官方客户端硬编码 RSA 公钥（qoder_sign.py: SERVER_PUB_PEM）----
const SERVER_PUB_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
const RSA_PUB = crypto.createPublicKey(SERVER_PUB_PEM);

const COSY_VERSION = '1.1.64';                    // 官方常量，勿改成桌面版版本号
const USER_TYPE = 'personal_profession_trial';    // 注意：qoder_sign.py 用这个值
const CLIENT_UA = 'Go-http-client/2.0';

// ---- 本机凭据解密（os_crypt v10 + DPAPI）----
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
const token = auth.token;
const uid = (auth.user || {}).id;

// ---- 稳定设备指纹（qoder_fingerprint.py 同构）----
const deriveId = (salt) => crypto.createHash('md5').update(`${salt}:${uid}`).digest('hex').slice(0, 36);
const machineId = deriveId('machine');
const machineType = deriveId('machinetype').replace(/-/g, '').slice(0, 18);
const machineToken = crypto.createHash('sha512').update(`machinetoken:${uid}`).digest('base64url').slice(0, 43);

// ---- 构造一次 COSY 签名（CosySession + bearer + headers）----
function cosyHeaders(bodyEnc, rawUrl) {
  const tempKey = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const cosyKey = crypto.publicEncrypt(
    { key: RSA_PUB, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(tempKey, 'utf8'),
  ).toString('base64');

  // identity 9 键（唯一真源），键序 = 排序后
  const identity = {
    name: (auth.user || {}).name || '',
    aid: uid,
    uid: uid,
    yx_uid: '',
    organization_id: '',
    organization_name: '',
    user_type: USER_TYPE,
    security_oauth_token: token,
    refresh_token: auth.refreshToken || '',
  };
  const identityJson = JSON.stringify(identity, Object.keys(identity).sort());
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(tempKey, 'utf8'), Buffer.from(tempKey, 'utf8'));
  const info = Buffer.concat([cipher.update(identityJson, 'utf8'), cipher.final()]).toString('base64');

  // payload 5 键，键序 = 排序后
  const payloadObj = {
    cosyVersion: COSY_VERSION,
    ideVersion: '',
    info,
    requestId: crypto.randomUUID(),
    version: 'v1',
  };
  const payload = Buffer.from(JSON.stringify(payloadObj, Object.keys(payloadObj).sort())).toString('base64');

  const date = String(Math.floor(Date.now() / 1000));
  let pathStripped = new URL(rawUrl).pathname;
  if (pathStripped.startsWith('/algo')) pathStripped = pathStripped.slice('/algo'.length);
  const sig = crypto.createHash('md5').update(`${payload}\n${cosyKey}\n${date}\n${bodyEnc}\n${pathStripped}`, 'utf8').digest('hex');

  return {
    'cosy-data-policy': 'AGREE',
    'content-type': 'application/json',
    'cosy-machinetype': machineType,
    'cosy-clienttype': '5',
    'cosy-date': date,
    'cosy-user': uid,
    'cosy-key': cosyKey,
    'accept': 'application/json',
    'cosy-clientip': '169.254.198.161',
    'authorization': `Bearer COSY.${payload}.${sig}`,
    'accept-encoding': 'identity',
    'cosy-version': COSY_VERSION,
    'cosy-machineid': machineId,
    'cosy-machinetoken': machineToken,
    'login-version': 'v2',
    'user-agent': CLIENT_UA,
  };
}

// ---- 发请求：GET 带 body（node:https 支持，与 Python urllib 同形态）----
function requestWithBody(url, headers, body) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log('='.repeat(66));
  console.log('Qoder 国内版（CN）老版 COSY 协议连通性验证');
  console.log('='.repeat(66));
  console.log('uid:', uid);
  console.log('machineId  :', machineId);
  console.log('machineType:', machineType);
  console.log('machineTok :', machineToken);

  const url = CN_GATEWAY + MODELS_PATH;
  // 关键：签名的 body 是 qoder_encode("{}")，请求必须带同款 body
  const bodyEnc = qoderEncode(Buffer.from('{}', 'utf8'));
  console.log('\nGET', url);
  console.log('body =', bodyEnc);

  try {
    const h = cosyHeaders(bodyEnc, url);
    const r = await requestWithBody(url, h, bodyEnc);
    console.log('\nHTTP', r.status, '| len', r.text.length);
    console.log(r.text.slice(0, 1200));
    if (r.status === 200) console.log('\n>>> COSY 签名链路正确，老版协议鉴权通过');
    else if (r.status === 403) console.log('\n>>> 仍被拒（签名/凭据问题）');
  } catch (e) { console.log('\n失败:', e.message); }
})().catch((e) => { console.error('执行失败:', e.message); process.exitCode = 1; });
