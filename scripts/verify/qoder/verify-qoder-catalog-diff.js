'use strict';
/**
 * CN / Intl 模型目录对比（用于验证「Qwen3.8-Flash 限免」在两个区域的落地差异）。
 * CN 走 COSY 老版 /algo/api/v2/model/list（本机已打通）；
 * Intl 目录已在本机 ~/.qoder/.models/<uid>/catalog-v6（QMC 加密），用 qmc_decrypt 解开。
 * 同时输出 CN 目录里 is_free / price_factor 的分布，回答「限免模型是否可调用」。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ---------- CN：COSY model/list ----------
const APP_DIR = path.join(process.env.APPDATA, 'com.qodercn.app.stable');
const CN_GATEWAY = 'https://gateway.qoder.com.cn';
const MODELS_PATH = '/algo/api/v2/model/list?Encode=1';
const CUSTOM = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const S2C = {}; for (let i = 0; i < 64; i++) S2C[STD[i]] = CUSTOM[i];
const qoderEncode = (buf) => {
  const std = Buffer.from(buf).toString('base64');
  const n = std.length, a = Math.floor(n / 3);
  return [...(std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a))].map((c) => (c === '=' ? '$' : S2C[c])).join('');
};
const SERVER_PUB_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
const RSA_PUB = crypto.createPublicKey(SERVER_PUB_PEM);
const COSY_VERSION = '1.1.64';
const USER_TYPE = 'personal_profession_trial';

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
const decryptV10 = (blob, key) => {
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.slice(3, 15));
  const ct = blob.slice(15);
  d.setAuthTag(ct.slice(ct.length - 16));
  return Buffer.concat([d.update(ct.slice(0, ct.length - 16)), d.final()]);
};
const state = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'Local State'), 'utf8'));
const key = dpapiUnprotect(Buffer.from(state.os_crypt.encrypted_key, 'base64').slice(5));
const auth = JSON.parse(decryptV10(fs.readFileSync(path.join(APP_DIR, 'auth.v1.dat')), key).toString('utf8'));
const token = auth.token;
const uid = (auth.user || {}).id;
const deriveId = (s) => crypto.createHash('md5').update(`${s}:${uid}`).digest('hex').slice(0, 36);
const machineToken = crypto.createHash('sha512').update(`machinetoken:${uid}`).digest('base64url').slice(0, 43);

function cosyHeaders(bodyEnc, rawUrl) {
  const tempKey = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const cosyKey = crypto.publicEncrypt({ key: RSA_PUB, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(tempKey, 'utf8')).toString('base64');
  const identity = {
    name: (auth.user || {}).name || '', aid: uid, uid, yx_uid: '',
    organization_id: '', organization_name: '', user_type: USER_TYPE,
    security_oauth_token: token, refresh_token: auth.refreshToken || '',
  };
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(tempKey, 'utf8'), Buffer.from(tempKey, 'utf8'));
  const info = Buffer.concat([cipher.update(JSON.stringify(identity, Object.keys(identity).sort()), 'utf8'), cipher.final()]).toString('base64');
  const payloadObj = { cosyVersion: COSY_VERSION, ideVersion: '', info, requestId: crypto.randomUUID(), version: 'v1' };
  const payload = Buffer.from(JSON.stringify(payloadObj, Object.keys(payloadObj).sort())).toString('base64');
  const date = String(Math.floor(Date.now() / 1000));
  let p = new URL(rawUrl).pathname;
  if (p.startsWith('/algo')) p = p.slice(5);
  const sig = crypto.createHash('md5').update(`${payload}\n${cosyKey}\n${date}\n${bodyEnc}\n${p}`, 'utf8').digest('hex');
  return {
    'cosy-data-policy': 'AGREE', 'content-type': 'application/json',
    'cosy-machinetype': deriveId('machinetype').replace(/-/g, '').slice(0, 18),
    'cosy-clienttype': '5', 'cosy-date': date, 'cosy-user': uid, 'cosy-key': cosyKey,
    'accept': 'application/json', 'cosy-clientip': '169.254.198.161',
    'authorization': `Bearer COSY.${payload}.${sig}`, 'accept-encoding': 'identity',
    'cosy-version': COSY_VERSION, 'cosy-machineid': deriveId('machine'),
    'cosy-machinetoken': machineToken, 'login-version': 'v2', 'user-agent': 'Go-http-client/2.0',
  };
}
const https = require('node:https');
function requestWithBody(url, headers, body) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET',
      headers: { ...headers, 'content-length': Buffer.byteLength(body) }, timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ---------- Intl：QMC v1 catalog-v6 解密（qoder_sign.py: qmc_decrypt）----------
// envelope = base64( magic(4) + nonce(12) + AES-256-GCM(ct+tag) )
// key = HKDF-SHA256(ikm=uid, salt="qoder-model-cache-enc", info="model-cache-v1", 32)
function qmcDecrypt(b64Blob, uidStr) {
  const env = Buffer.from(b64Blob.toString('utf8').trim(), 'base64');
  if (env.length < 4 + 12 + 16) throw new Error('envelope too short');
  const magic = env.slice(0, 4);
  if (magic[0] !== 0x51 || magic[1] !== 0x4D || magic[2] !== 0x43) {  // "QMC"
    throw new Error(`magic unsupported: ${JSON.stringify(magic.toString('latin1'))}`);
  }
  const version = magic[3];
  if (version !== 1) throw new Error(`QMC version unsupported: ${version}`);
  const nonce = env.slice(4, 16);
  const sealed = env.slice(16);
  const ct = sealed.slice(0, sealed.length - 16);
  const tag = sealed.slice(sealed.length - 16);
  const key = crypto.hkdfSync('sha256', Buffer.from(uidStr, 'utf8'), Buffer.from('qoder-model-cache-enc'), Buffer.from('model-cache-v1'), 32);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

(async () => {
  // ---- CN 目录 ----
  console.log('='.repeat(70));
  console.log('国内版（CN）模型目录 — COSY /algo/api/v2/model/list');
  console.log('='.repeat(70));
  const url = CN_GATEWAY + MODELS_PATH;
  const bodyEnc = qoderEncode(Buffer.from('{}', 'utf8'));
  const r = await requestWithBody(url, cosyHeaders(bodyEnc, url), bodyEnc);
  if (r.status !== 200) { console.log('HTTP', r.status, r.text.slice(0, 200)); return; }
  const cnPayload = JSON.parse(r.text);
  const cnModels = cnPayload.chat || [];
  console.log('总数:', cnModels.length, '\n');
  const row = (m) => {
    const promo = m.promotion || {};
    return {
      key: m.key,
      name: m.display_name,
      enable: m.enable,
      is_free: m.is_free,
      price_factor: m.price_factor,
      promotion: promo.active === true ? `${promo.discount_factor}折窗口` : (promo.active === false ? 'promotion(非活动)' : undefined),
      window: promo.window_start ? `${promo.window_start}-${promo.window_end}` : undefined,
      max_input: m.max_input_tokens,
    };
  };
  for (const m of cnModels) {
    const o = row(m);
    console.log(`  ${String(o.key).padEnd(16)} ${String(o.name).padEnd(18)} enable=${String(o.enable).padEnd(5)} is_free=${String(o.is_free).padEnd(5)} price=${String(o.price_factor).padEnd(5)}${o.promotion ? ` promo=${o.promotion}` : ''}`);
  }
  const freeCn = cnModels.filter((m) => m.is_free);
  console.log(`\nCN is_free=true 的模型 (${freeCn.length}):`, freeCn.map((m) => `${m.key}(${m.display_name})`).join(', ') || '（无）');

  // ---- Intl 目录（本机缓存）----
  const intlUid = '019f0dea-ce95-75ac-8e60-b5e973f3ed4f';
  const catPath = path.join(process.env.USERPROFILE, '.qoder', '.models', intlUid, 'catalog-v6');
  console.log('\n' + '='.repeat(70));
  console.log('国际版（Intl）模型目录 — QMC v1 本机缓存');
  console.log('='.repeat(70));
  if (!fs.existsSync(catPath)) { console.log('缓存不存在:', catPath); }
  else {
    try {
      // 文件本身是 base64 文本（UU1D... = QMC1），需先按 utf8 读再 base64 解
      const dec = JSON.parse(qmcDecrypt(fs.readFileSync(catPath, 'utf8'), intlUid));
      const list = Array.isArray(dec) ? dec : (dec.chat || dec.models || []);
      console.log('总数:', list.length, '\n');
      for (const m of list) {
        console.log(`  ${String(m.key).padEnd(16)} ${String(m.display_name).padEnd(18)} enable=${String(m.enable).padEnd(5)} is_free=${String(m.is_free).padEnd(5)} price=${String(m.price_factor).padEnd(5)}`);
      }
      const freeIntl = list.filter((m) => m.is_free);
      console.log(`\nIntl is_free=true 的模型 (${freeIntl.length}):`, freeIntl.map((m) => `${m.key}(${m.display_name})`).join(', ') || '（无）');
    } catch (e) { console.log('解密失败:', e.message); }
  }

  // ---- 对比 ----
  console.log('\n' + '='.repeat(70));
  console.log('CN / Intl 差异');
  console.log('='.repeat(70));
  const cnKeys = new Set(cnModels.map((m) => m.key));
  console.log('CN 独有:', [...cnKeys].filter((k) => !['auto', 'ultimate'].includes(k)).slice(0, 30).join(', '));
})().catch((e) => { console.error('失败:', e.message); process.exitCode = 1; });
