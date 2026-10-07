'use strict';
/**
 * credentials/import.js — 凭据导入（面向"免本机登录"）。
 *
 * 允许从多种来源导入 Trae 账号凭据并写入 SQLite 存储，无需本机登录：
 *  - storageJsonText：上传的 storage.json 原始文本（自动解密 iCubeAuthInfo，并抽取 telemetry 设备指纹）
 *  - authObject：已解密的认证对象 { token, refreshToken, userId, ... }
 *  - refreshToken：仅 refreshToken 字符串（后续自动 ExchangeToken 续期）
 *
 * 设备指纹：上游签到按设备限次。导入/回填时保证每账号有独立 devices，避免共享本机指纹。
 */
const crypto = require('crypto');
const store = require('./store');
const traeDecrypt = require('../lib/trae-decrypt.js');
const { hashDeviceId } = require('../lib/util');

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] != null) out[k] = obj[k];
  return out;
}

/** 校验是否能拿到有效 token 或 refreshToken；两者皆无则拒绝。 */
function hasCredibleToken(auth) {
  return !!(auth.token || auth.refreshToken);
}

/** 解析 storage.json 文本为对象。 */
function parseStorageJson(text) {
  if (!text || typeof text !== 'string') throw new Error('storage.json content is required');
  return JSON.parse(text);
}

/** 从 storage.json 原始文本提取 iCubeAuthInfo（自动解密 tc 加密/明文）。 */
function authFromStorageJson(text) {
  const storage = parseStorageJson(text);
  const key = 'iCubeAuthInfo://icube.cloudide';
  const raw = storage[key];
  if (!raw) throw new Error(`key "${key}" not found in storage.json`);
  const s = String(raw).trim();
  if (s.startsWith('{') || s.startsWith('"')) return JSON.parse(raw);
  const decrypted = traeDecrypt.decryptStorageValue(raw);
  return JSON.parse(decrypted);
}

/** 生成稳定且互不相同的账号级设备指纹。字段形态对齐真实 Trae telemetry。 */
function genDevices(seed) {
  const h = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
  const base = seed != null && seed !== '' ? String(seed) : crypto.randomBytes(16).toString('hex');
  const machineId = h(`machine:${base}`);
  return {
    machineId,
    sqmId: guidBraced(h(`sqm:${base}`)),
    devDeviceId: uuidLoose(h(`dev:${base}`)),
    // 与 lib/auth.hashDeviceId 输出形态一致：最多 19 位十进制（前导零常见）
    deviceId: hashDeviceId(machineId),
    deviceModel: process.env.TRAE_DEVICE_MODEL || '82RF',
    osName: process.env.TRAE_OS_NAME || 'windows',
    osVersion: process.env.TRAE_OS_VERSION || 'Windows 10',
    cpu: process.env.TRAE_CPU || 'Intel',
  };
}

function guidBraced(hex) {
  const h = (String(hex) + '0'.repeat(32)).slice(0, 32).toUpperCase();
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}}`;
}

function uuidLoose(hex) {
  const h = (String(hex) + '0'.repeat(32)).slice(0, 32).toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * 从 storage.json 对象抽取 telemetry 作为 devices。
 * 无 telemetry 时用 userId/随机数生成独立指纹。
 */
function devicesFromStorage(storage, seed) {
  const machineId = storage && storage['telemetry.machineId'];
  const sqmId = storage && storage['telemetry.sqmId'];
  const devDeviceId = storage && storage['telemetry.devDeviceId'];
  if (machineId || devDeviceId) {
    const fallback = genDevices(seed);
    return {
      machineId: machineId || fallback.machineId,
      sqmId: sqmId || null,
      devDeviceId: devDeviceId || fallback.devDeviceId,
      deviceId: machineId ? (hashDeviceId(machineId) || fallback.deviceId) : fallback.deviceId,
      deviceModel: process.env.TRAE_DEVICE_MODEL || '82RF',
      osName: process.env.TRAE_OS_NAME || 'windows',
      osVersion: process.env.TRAE_OS_VERSION || 'Windows 10',
      cpu: process.env.TRAE_CPU || 'Intel',
    };
  }
  return genDevices(seed);
}

/** 兼容 authObject 里可能自带的 devices。 */
function normalizeDevices(devices) {
  if (!devices || typeof devices !== 'object') return null;
  const machineId = devices.machineId || devices.machine_id || null;
  const devDeviceId = devices.devDeviceId || devices.dev_device_id || devices.deviceId || devices.device_id || null;
  if (!machineId && !devDeviceId) return null;
  return {
    machineId: machineId || genDevices(devDeviceId).machineId,
    sqmId: devices.sqmId || devices.sqm_id || null,
    devDeviceId: devDeviceId || genDevices(machineId).devDeviceId,
    // deviceId 缺失时按 machineId 推导，保证与登录面/签到面的 x-device-id 同源
    deviceId: devices.deviceId || devices.device_id || hashDeviceId(machineId || genDevices(devDeviceId).machineId),
    deviceModel: devices.deviceModel || devices.device_model || process.env.TRAE_DEVICE_MODEL || '82RF',
    osName: devices.osName || devices.os_name || process.env.TRAE_OS_NAME || 'windows',
    osVersion: devices.osVersion || devices.os_version || process.env.TRAE_OS_VERSION || 'Windows 10',
    cpu: devices.cpu || process.env.TRAE_CPU || 'Intel',
  };
}

/** 统一的账号结构映射：外部字段 → store 字段。 */
function toAccount(auth, extra = {}) {
  const labelSrc = extra.label || auth.account || auth.userId;
  const account = {
    label: typeof labelSrc === 'object' && labelSrc != null ? JSON.stringify(labelSrc) : (labelSrc || 'imported account'),
    edition: String(extra.edition || auth.opera_user_region || 'cn').toLowerCase(),
    token: auth.token || null,
    refreshToken: auth.refreshToken || auth.refresh_token || null,
    expiredAt: auth.expiredAt || auth.expire_time || null,
    refreshExpiredAt: auth.refreshExpiredAt || auth.refresh_expire_time || null,
    tokenReleaseAt: auth.tokenReleaseAt || auth.token_release_time || null,
    userId: auth.userId || auth.user_id || auth.account || null,
    host: auth.host || null,
    userRegion: extra.userRegion || auth.userRegion || null,
    devices: extra.devices || null,
    group: extra.group != null && extra.group !== '' ? String(extra.group) : (auth.group || null),
    // OAuth 账号记住自己的 ClientID/authHost（refreshToken 必须同 ClientID 换新）
    authClientId: extra.authClientId || auth.authClientId || null,
    authHost: extra.authHost || auth.authHost || null,
  };
  return account;
}

/** 按 userId 查已有账号（列表脱敏够用；命中后再 get 全量）。 */
function findAccountByUserId(userId) {
  if (userId == null || userId === '') return null;
  const key = String(userId);
  const hit = store.list().find((a) => a.userId != null && String(a.userId) === key);
  return hit ? store.get(hit.id) : null;
}

/**
 * 账号缺少 devices 时生成并落库（已有账号回填）。
 * @returns {object|null} 更新后的脱敏账号；已有 devices 则返回 null
 */
function ensureAccountDevices(accountId) {
  const acct = store.get(accountId);
  if (!acct) return null;
  const normalized = normalizeDevices(acct.devices);
  if (normalized && normalized.machineId && normalized.devDeviceId) {
    return null;
  }
  const seed = acct.userId || acct.id;
  const devices = genDevices(seed);
  const updated = store.update(acct.id, { devices });
  console.log(`[import] backfilled devices for account ${acct.id}`);
  return updated;
}

/**
 * 遍历账号，为 devices 缺失者回填。
 *
 * 按平台分流：ZCode 账号的设备身份是 accounts.fingerprint（成套桌面 SKU +
 * device_mid，见 zcode/fingerprint.js），不适用 Trae 的 machineId/devDeviceId
 * 两件套，给它填 Trae devices 没有意义且会被误当作 Trae 账号。
 */
function ensureAllMissingDevices() {
  const list = store.list();
  const variant = require('../platform/variant');
  let filled = 0;
  let filledZcode = 0;
  for (const a of list) {
    const full = store.get(a.id);
    if (!full) continue;
    if (variant.isEdition(full.edition, variant.ZCODE)) {
      // ZCode：缺 fingerprint 时分配一套成套桌面档案
      if (require('../zcode/fingerprint').validate(full.fingerprint)) {
        require('../zcode/fingerprint').profileFor(full, (fp) => {
          store.update(full.id, { fingerprint: fp });
        });
        filled += 1;
        filledZcode += 1;
      }
      continue;
    }
    const n = normalizeDevices(full.devices);
    if (n && n.machineId && n.devDeviceId) continue;
    ensureAccountDevices(a.id);
    filled += 1;
  }
  return { total: list.length, filled, filledZcode };
}

/**
 * 重复导入时的设备指纹取舍：原账号已有完整指纹则保留（身份稳定优先），
 * 否则用本次导入的指纹补齐。storage.json 导入带真实 telemetry，视为可信更新。
 */
function keepExistingDevices(existingDevices, incomingDevices) {
  const cur = normalizeDevices(existingDevices);
  const inc = normalizeDevices(incomingDevices);
  if (cur && cur.machineId && cur.devDeviceId) return cur;
  return inc || cur;
}

/**
 * 导入账号凭据。
 * @param {object} input { storageJsonText?, authObject?, refreshToken?, label?, devices?, edition?, forceNew? }
 * @returns {object} 已入库账号（脱敏）；重复 userId 且非 forceNew 时更新凭据并带 action:'updated'
 */
function importAccount(input = {}) {
  let auth = null;
  let storageDevices = null;

  if (input.authObject) {
    auth = input.authObject;
    storageDevices = normalizeDevices(input.devices) || normalizeDevices(input.authObject.devices);
  } else if (input.refreshToken) {
    auth = { refreshToken: input.refreshToken, label: input.label };
    storageDevices = normalizeDevices(input.devices);
  } else if (input.storageJsonText) {
    const storage = parseStorageJson(input.storageJsonText);
    auth = authFromStorageJson(input.storageJsonText);
    const seed = auth.userId || auth.account || input.label || Date.now();
    storageDevices = normalizeDevices(input.devices) || devicesFromStorage(storage, seed);
  } else {
    throw new Error('Provide one of: storageJsonText, authObject, refreshToken');
  }

  if (!hasCredibleToken(auth)) {
    throw new Error('imported credential has neither token nor refreshToken');
  }

  // 任何导入路径最终都保证有独立设备指纹；OAuth 登录传入的 pending.device（input.devices）
  // 优先于随机生成，使登录面与 API 面使用同一设备身份
  const devices = storageDevices || genDevices(auth.userId || input.label || Date.now());

  const account = toAccount(auth, {
    label: input.label,
    edition: input.edition,
    userRegion: auth.export_region || input.userRegion,
    devices,
    authClientId: input.authClientId,
    authHost: input.authHost,
  });

  if (!input.forceNew && account.userId != null && account.userId !== '') {
    const existing = findAccountByUserId(account.userId);
    if (existing) {
      const patch = {
        label: input.label || existing.label,
        edition: account.edition || existing.edition,
        host: account.host || existing.host,
        userRegion: account.userRegion || existing.userRegion,
        // 保留既有稳定指纹优先：同账号反复登录不应漂移设备身份（设备维度风控的典型信号）。
        // 仅当原账号缺指纹或本次导入带全新指纹（storage.json 来源）时才更新。
        devices: keepExistingDevices(existing.devices, account.devices),
        lastCheckinResult: 'import_updated',
      };
      if (account.token) patch.token = account.token;
      if (account.refreshToken) patch.refreshToken = account.refreshToken;
      if (account.expiredAt) patch.expiredAt = account.expiredAt;
      if (account.refreshExpiredAt) patch.refreshExpiredAt = account.refreshExpiredAt;
      if (account.tokenReleaseAt) patch.tokenReleaseAt = account.tokenReleaseAt;
      // OAuth 来源的凭据必须记住自己的 ClientID/authHost（refreshToken 与 ClientID 绑定）
      if (account.authClientId) patch.authClientId = account.authClientId;
      if (account.authHost) patch.authHost = account.authHost;
      const updated = store.update(existing.id, patch);
      updated.action = 'updated';
      updated.replacedId = existing.id;
      return updated;
    }
  }

  const created = store.add(account, 'import');
  created.action = 'created';
  return created;
}

/**
 * 批量导入。逐条失败不中断；同 userId 更新而非重复插入。
 * @returns {ok, updated, failed}
 */
function importMany(items) {
  const ok = [];
  const updated = [];
  const failed = [];
  for (const item of items) {
    try {
      const r = importAccount(item);
      if (r.action === 'updated') updated.push(r);
      else ok.push(r);
    } catch (e) {
      failed.push({ reason: e.message, input: pick(item, ['label', 'storageJsonText']) });
    }
  }
  return { ok, updated, failed };
}

/**
 * 重置账号设备指纹：新随机种子重新生成 devices，deviceGen 自增。
 * 用途：签到按设备限次 / 风控按设备维度，重置即换新设备身份。
 * @returns {object} 重置后的摘要（脱敏，仅前 8 位）
 */
function resetAccountDevices(accountId) {
  const acct = store.get(accountId);
  if (!acct) throw new Error(`account not found: ${accountId}`);
  const devices = genDevices(crypto.randomBytes(16).toString('hex'));
  const deviceGen = (Number(acct.deviceGen) || 0) + 1;
  store.update(accountId, { devices, deviceGen });
  console.log(`[import] devices reset for ${accountId} (gen=${deviceGen})`);
  return {
    accountId,
    deviceGen,
    machineId: devices.machineId.slice(0, 8),
    devDeviceId: devices.devDeviceId.slice(0, 8),
  };
}

module.exports = {
  importAccount,
  importMany,
  toAccount,
  authFromStorageJson,
  findAccountByUserId,
  genDevices,
  devicesFromStorage,
  normalizeDevices,
  keepExistingDevices,
  ensureAccountDevices,
  ensureAllMissingDevices,
  resetAccountDevices,
};
