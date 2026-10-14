'use strict';
/**
 * qoder/catalog.js — Qoder 模型目录同步（双区域协议不同）。
 *
 * 国内版（realm=cn）：
 *   动态 COSY 拉取 `POST gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1`。
 *   必须带 COSY 签名（Bearer COSY.<payload>.<sig>）+ 自定义 Base64 请求体，
 *   否则 {"code":"101","message":"Signature invalid"}。
 *
 * 国际版（realm=intl）：
 *   本机客户端缓存 `~/.qoder/.models/<uid>/catalog-v6`（QMC v1 加密），
 *   或同样可走 COSY model/list。目录字段与国际版 catalog JSON 一致。
 *
 * 两个关键实证结论（勿改）：
 *   1. 限免模型双区域一致：`qfmodel`（Qwen3.8-Flash）`is_free=true, price_factor=0`。
 *      但 `is_free` **不等于可调用**——该 key 在 chat 端点返回 invalid_model_error，
 *      因此可调用集合必须由 probeModel 实测，不能按目录字段推断。
 *   2. `mmodel` 同名不同值：国际版 MiniMax-M3，国内版 MiniMax-M2.7。
 *      目录必须按 realm 分开存，不能合并成一张全局表。
 *
 * COSY 实现要点（错一个就 101，详见 docs/qoder-integration-analysis-v2.md 附录 A.4）：
 *   - cosyVersion = "1.1.64"（官方客户端内置常量，不是桌面版版本号）
 *   - ideVersion = ""，version = "v1"
 *   - identity 9 键：name/aid/uid/yx_uid/organization_id/organization_name/
 *     user_type/security_oauth_token/refresh_token
 *   - 头集合 16 项（cosy-data-policy / cosy-clientip / login-version / cosy-clienttype:5 等）
 *   - 请求必须带同款 body（qoder_encode("{}")），服务端校验签名与 body 一致
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('node:https');
const variant = require('../platform/variant');
const { QoderApiError } = require('./client');

const V = variant.variantOf(variant.QODER);
const ID = V.identity;

// ---- Qoder 自定义 Base64 变体（三段重排 + 自定义字母表）----
const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const STD_TO_CUSTOM = {};
for (let i = 0; i < 64; i++) STD_TO_CUSTOM[STD_ALPHABET[i]] = CUSTOM_ALPHABET[i];

/** 把明文编码成 Qoder 自定义 Base64 变体（出站请求体格式）。 */
function qoderEncode(buf) {
  const std = Buffer.from(buf).toString('base64');
  const n = std.length;
  const a = Math.floor(n / 3);
  // 尾/中/首 三段重排
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = '';
  for (const ch of rearranged) out += (ch === '=' ? '$' : STD_TO_CUSTOM[ch]);
  return out;
}

// ---- 官方客户端硬编码 RSA 公钥（qoder_sign.py: SERVER_PUB_PEM，1024 位）----
// 与 qoder_sign.py 442 行附近逐字一致。第 3 行是 "…236FZz73In/…"（FZz），
// 转录错一个字符会导致 exponent 解析失败、签名必然错。
const SERVER_PUB_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
const RSA_PUB = crypto.createPublicKey(SERVER_PUB_PEM);

const CLIENT_UA = 'Go-http-client/2.0';
const COSY_CLIENT_TYPE = '5';       // 老版 COSY 面按 CLI 身份（qoder_sign.py 同）
const COSY_CLIENT_IP = '169.254.198.161';

/** 稳定设备指纹派生（与 qoder_fingerprint.py 同构：按 uid 稳定，防多号关联）。 */
function deriveId(uid, salt) {
  return crypto.createHash('md5').update(`${salt}:${uid || 'anonymous'}`).digest('hex').slice(0, 36);
}

/**
 * 构造一次 COSY 签名头集合。
 * @param {string} bodyEnc qoderEncode 后的请求体
 * @param {string} rawUrl  完整 URL（签名只覆盖去 /algo 前缀的 path）
 * @param {object} cred    { token, refreshToken, uid, nickname }
 * @param {string} [modelKey] 非空时附带 x-model-key / x-model-source
 */
function cosyHeaders(bodyEnc, rawUrl, cred, modelKey = '') {
  const uid = String(cred.uid || '');
  // 16 字节 tempKey：RSA 包裹成 cosyKey，同时作为 AES-128-CBC 的 key 与 iv
  const tempKey = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const cosyKey = crypto.publicEncrypt(
    { key: RSA_PUB, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(tempKey, 'utf8'),
  ).toString('base64');

  // identity 9 键（唯一真源），键序 = 排序后
  const identity = {
    name: cred.nickname || '',
    aid: uid,
    uid,
    yx_uid: '',
    organization_id: '',
    organization_name: '',
    user_type: ID.defaultUserType,
    security_oauth_token: cred.token || '',
    refresh_token: cred.refreshToken || '',
  };
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(tempKey, 'utf8'), Buffer.from(tempKey, 'utf8'));
  const info = Buffer.concat([
    cipher.update(JSON.stringify(identity, Object.keys(identity).sort()), 'utf8'),
    cipher.final(),
  ]).toString('base64');

  // payload 5 键，键序 = 排序后
  const payloadObj = {
    cosyVersion: ID.cosyVersion,
    ideVersion: '',
    info,
    requestId: crypto.randomUUID(),
    version: 'v1',
  };
  const payload = Buffer.from(JSON.stringify(payloadObj, Object.keys(payloadObj).sort())).toString('base64');

  const date = String(Math.floor(Date.now() / 1000));
  let p;
  try { p = new URL(rawUrl).pathname; } catch { p = String(rawUrl); }
  if (p.startsWith('/algo')) p = p.slice('/algo'.length);
  const sig = crypto.createHash('md5')
    .update(`${payload}\n${cosyKey}\n${date}\n${bodyEnc}\n${p}`, 'utf8')
    .digest('hex');

  const h = {
    'cosy-data-policy': 'AGREE',
    'content-type': 'application/json',
    'cosy-machinetype': deriveId(uid, 'machinetype').replace(/-/g, '').slice(0, 18),
    'cosy-clienttype': COSY_CLIENT_TYPE,
    'cosy-date': date,
    'cosy-user': uid,
    'cosy-key': cosyKey,
    accept: 'application/json',
    'cosy-clientip': COSY_CLIENT_IP,
    authorization: `Bearer COSY.${payload}.${sig}`,
    'accept-encoding': 'identity',
    'cosy-version': ID.cosyVersion,
    'cosy-machineid': deriveId(uid, 'machine'),
    'cosy-machinetoken': crypto.createHash('sha512').update(`machinetoken:${uid}`).digest('base64url').slice(0, 43),
    'login-version': 'v2',
    'user-agent': CLIENT_UA,
  };
  if (modelKey) {
    h['x-model-key'] = modelKey;
    h['x-model-source'] = 'system';
  }
  return h;
}

/**
 * 发一次 GET-with-body 请求（COSY 面要求请求体与签名一致；
 * Node 的 fetch 不允许 GET 带 body，故用 node:https）。
 */
function cosyGet(url, headers, body, timeoutMs = 30000) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * COSY 拉取模型目录（双区域通用；国内版的唯一途径，国际版也可用）。
 *
 * 注意 host 选择：COSY 老版 `/algo/*` 面在国际版不在 api2-v2 上（实测 404），
 * 官方候选推理主机是 api1/api2/api3.qoder.sh（见客户端 endpoint 缓存的 infer 项）。
 * 国内版统一走 gateway.qoder.com.cn（/algo 与 /model/v1 同域）。
 *
 * @param {object} acct 需含 token / refreshToken / userId / qoderRealm
 * @returns {Promise<Array<object>>} 归一化后的模型条目
 */
async function fetchModelsViaCosy(acct) {
  const realm = variant.qoderRealmOfAccount(acct);
  // 国际版 COSY 面的候选主机（按官方顺序；切换主机不影响签名，签名只覆盖 path）
  const hosts = realm === 'cn'
    ? [variant.qoderGatewayBase('cn')]
    : ['https://api1.qoder.sh', 'https://api2.qoder.sh', 'https://api3.qoder.sh'];
  const bodyEnc = qoderEncode(Buffer.from('{}', 'utf8'));
  const cred = {
    token: acct.token,
    refreshToken: acct.refreshToken,
    uid: acct.userId,
    nickname: acct.userName || acct.label || '',
  };

  let lastErr = null;
  for (const base of hosts) {
    const url = base + V.paths.cosyModels;
    try {
      const headers = cosyHeaders(bodyEnc, url, cred);
      // eslint-disable-next-line no-await-in-loop
      const r = await cosyGet(url, headers, bodyEnc);
      if (r.status !== 200) {
        lastErr = new QoderApiError(
          `Qoder COSY model/list 失败 HTTP ${r.status} (${base}): ${r.text.slice(0, 160)}`,
          { status: r.status, method: 'GET', url },
        );
        continue;
      }
      let json;
      try { json = JSON.parse(r.text); } catch {
        lastErr = new QoderApiError(`COSY model/list 响应非 JSON (${base}): ${r.text.slice(0, 120)}`, { status: r.status, url });
        continue;
      }
      const list = Array.isArray(json && json.chat) ? json.chat : [];
      return list.map(normalizeModel).filter(Boolean);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new QoderApiError('COSY model/list 全部候选主机失败');
}

/** QMC v1 解密（国际版本机 catalog-v6）。 */
function qmcDecrypt(b64Blob, uid) {
  const env = Buffer.from(String(b64Blob).trim(), 'base64');
  if (env.length < 4 + 12 + 16) throw new QoderApiError('QMC 信封过短');
  if (env[0] !== 0x51 || env[1] !== 0x4D || env[2] !== 0x43) {  // "QMC"
    throw new QoderApiError('QMC 魔数不匹配');
  }
  if (env[3] !== 1) throw new QoderApiError(`QMC 版本不支持: ${env[3]}`);
  const nonce = env.slice(4, 16);
  const sealed = env.slice(16);
  const ct = sealed.slice(0, sealed.length - 16);
  const tag = sealed.slice(sealed.length - 16);
  const key = crypto.hkdfSync(
    'sha256',
    Buffer.from(String(uid), 'utf8'),
    Buffer.from('qoder-model-cache-enc'),
    Buffer.from('model-cache-v1'),
    32,
  );
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  return JSON.parse(plain);
}

/** 本机 catalog-v6 路径（国际版）。 */
function catalogCachePath(realm, uid) {
  const cfg = variant.qoderRealmConfig(realm);
  return path.join(os.homedir(), cfg.homeDir, '.models', String(uid), 'catalog-v6');
}

/**
 * 从本机缓存读国际版目录（服务端部署在本机时可用）。
 * @returns {Promise<Array<object>>}
 */
async function fetchModelsFromCache(acct) {
  const realm = variant.qoderRealmOfAccount(acct);
  const file = catalogCachePath(realm, acct.userId);
  if (!fs.existsSync(file)) {
    throw new QoderApiError(`未找到模型目录缓存：${file}`);
  }
  const dec = qmcDecrypt(fs.readFileSync(file, 'utf8'), acct.userId);
  const list = Array.isArray(dec) ? dec : (Array.isArray(dec && dec.chat) ? dec.chat : []);
  return list.map(normalizeModel).filter(Boolean);
}

/**
 * 归一化模型条目（保留官方全字段，仅补 id/name 兼容键）。
 * 刻意不裁剪 enable / strategies / promotion / is_editable 等——面板与计费
 * 都要按官方原始语义展示，裁剪会让「限免」这类信息静默丢失。
 */
function normalizeModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = String(raw.key || raw.id || '').trim();
  if (!key) return null;
  const promo = (raw.promotion && typeof raw.promotion === 'object') ? raw.promotion : null;
  return {
    ...raw,
    id: key,
    key,
    name: String(raw.display_name || raw.name || key),
    // 限免标识：is_free=true 且 price_factor=0。注意 is_free 不等于可调用，
    // 可调用集合必须由 probeModel 实测（见模块头结论 1）。
    isFree: raw.is_free === true,
    priceFactor: Number.isFinite(Number(raw.price_factor)) ? Number(raw.price_factor) : null,
    maxInputTokens: Number.isFinite(Number(raw.max_input_tokens)) ? Number(raw.max_input_tokens) : null,
    promotion: promo ? {
      active: promo.active === true,
      discountFactor: Number.isFinite(Number(promo.discount_factor)) ? Number(promo.discount_factor) : null,
      windowStart: promo.window_start || null,
      windowEnd: promo.window_end || null,
      ruleId: promo.rule_id || null,
    } : null,
  };
}

/**
 * 同步账号模型目录（按 realm 选路径）。
 * @param {object} acct
 * @param {{prefer?: 'cosy'|'cache'|'auto'}} [opts]
 * @returns {Promise<{realm:string, source:string, models:Array}>}
 */
async function syncCatalog(acct, opts = {}) {
  const realm = variant.qoderRealmOfAccount(acct);
  const prefer = opts.prefer || 'auto';
  // 国内版只能走 COSY（/model/v1/* 实测 503，本机缓存也不存在）
  if (realm === 'cn' || prefer === 'cosy') {
    const models = await fetchModelsViaCosy(acct);
    return { realm, source: 'cosy', models };
  }
  if (prefer === 'cache') {
    const models = await fetchModelsFromCache(acct);
    return { realm, source: 'cache', models };
  }
  // auto：国际版优先本机缓存（快、免签名），失败回退 COSY
  try {
    const models = await fetchModelsFromCache(acct);
    return { realm, source: 'cache', models };
  } catch {
    const models = await fetchModelsViaCosy(acct);
    return { realm, source: 'cosy', models };
  }
}

/** 目录里的限免模型（is_free=true）。 */
function freeModels(models) {
  return (models || []).filter((m) => m.isFree);
}

module.exports = {
  CUSTOM_ALPHABET,
  SERVER_PUB_PEM,
  qoderEncode,
  cosyHeaders,
  cosyGet,
  fetchModelsViaCosy,
  fetchModelsFromCache,
  qmcDecrypt,
  catalogCachePath,
  normalizeModel,
  syncCatalog,
  freeModels,
};
