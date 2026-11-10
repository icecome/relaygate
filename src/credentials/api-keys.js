'use strict';
/**
 * credentials/api-keys.js — 密钥存储与生命周期（登录密钥 + 访问密钥）。
 *
 * - login：管理面板登录密钥；库内至多一把有效。
 * - access：转发面访问密钥。
 *   platform: trae|workbuddy|all（all=通用）
 *   key_type: universal|dedicated
 *   scopes:   JSON 数组，如 ["models:invoke","models:read"]
 *   resources: JSON 数组，如 ["*","model:workbuddy/*","model:virtual:vm/x"]
 * 生命周期：创建 → 使用 → 轮换（双密钥窗口）→ 暂停/撤销 → 过期
 * 存储：SHA-256 哈希（鉴权）+ AES 密文（供复制接口解密，界面不展示明文）。
 */
const nodeCrypto = require('crypto');
const { db } = require('./db');
const cryptoLib = require('../lib/crypto');

const KINDS = new Set(['login', 'access']);
// 'all' = 通用密钥：可调虚拟模型与全部渠道；trae|workbuddy = 平台密钥，仅本平台
const PLATFORMS = new Set(['trae', 'workbuddy', 'all']);
const KEY_TYPES = new Set(['universal', 'dedicated']);
const SCOPES = new Set([
  'models:read',
  'models:invoke',
  'router:read',
  'router:invoke',
  'admin:keys',
  'admin:catalog',
]);
// K-3：平台密钥默认 scope 补齐 models:read —— /v1/models 双面端点对访问密钥
// 强制 scope 校验后，存量平台密钥（只有 models:invoke）会在模型列表直接 403，
// 因此新建与迁移口径都包含 models:read。
const DEFAULT_SCOPES = {
  all: ['models:read', 'models:invoke', 'router:read', 'router:invoke'],
  trae: ['models:read', 'models:invoke'],
  workbuddy: ['models:read', 'models:invoke'],
};
const DEFAULT_RESOURCES = {
  all: ['*'],
  trae: ['model:trae/*'],
  workbuddy: ['model:workbuddy/*'],
};
const PLATFORM_LABELS = {
  trae: 'Trae 平台',
  workbuddy: 'WorkBuddy 平台',
  all: '通用（全部模型）',
};

function genId(prefix = 'key') {
  return `${prefix}_${Date.now().toString(36)}${nodeCrypto.randomBytes(4).toString('hex')}`;
}

function genPlainKey(prefix = 'sk') {
  return prefix + '-' + nodeCrypto.randomBytes(24).toString('hex');
}

function hashKey(plain) {
  return nodeCrypto.createHash('sha256').update(String(plain), 'utf8').digest('hex');
}

function parseJsonArr(v, fallback) {
  if (v == null || v === '') return fallback;
  if (Array.isArray(v)) return v.map(String);
  try {
    const o = JSON.parse(v);
    return Array.isArray(o) ? o.map(String) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeScopes(platform, scopes) {
  const base = DEFAULT_SCOPES[platform] || DEFAULT_SCOPES.trae;
  if (scopes == null) return base.slice();
  const list = parseJsonArr(scopes, base).filter((s) => SCOPES.has(s));
  return list.length ? list : base.slice();
}

function normalizeResources(platform, resources) {
  const base = DEFAULT_RESOURCES[platform] || ['*'];
  if (resources == null) return base.slice();
  const list = parseJsonArr(resources, base).map(String).filter(Boolean);
  return list.length ? list : base.slice();
}

function normalizeExpires(expiresAt, defaultDays = 90) {
  if (expiresAt === null) return null; // 显式永不过期
  if (expiresAt === undefined) {
    const days = Number(process.env.KEY_DEFAULT_TTL_DAYS || defaultDays);
    if (!Number.isFinite(days) || days <= 0) return null;
    return new Date(Date.now() + days * 86400_000).toISOString();
  }
  const s = String(expiresAt);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function rowToKey(r) {
  return {
    id: r.id,
    label: r.label,
    kind: r.kind || 'access',
    platform: r.platform || null,
    keyType: r.key_type || (r.platform === 'all' ? 'universal' : 'dedicated'),
    scopes: parseJsonArr(r.scopes, DEFAULT_SCOPES[r.platform] || []),
    resources: parseJsonArr(r.resources, DEFAULT_RESOURCES[r.platform] || []),
    expiresAt: r.expires_at || null,
    revokedAt: r.revoked_at || null,
    rotatedFrom: r.rotated_from || null,
    rpmLimit: r.rpm_limit != null ? Number(r.rpm_limit) : null,
    enabled: !!r.enabled,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at || null,
    // 明文掩码提示（不可逆推）
    hint: r.key_hash ? `sk-…${r.key_hash.slice(-4)}` : null,
    // 派生状态
    status: r.revoked_at ? 'revoked' : (!r.enabled ? 'disabled' : (r.expires_at && Date.parse(r.expires_at) < Date.now() ? 'expired' : 'active')),
  };
}

/**
 * 创建密钥。
 * @param {{label?:string|null, kind?:'login'|'access', platform?:string|null, plainKey?:string,
 *          scopes?:string[]|null, resources?:string[]|null, expiresAt?:string|null|undefined,
 *          rpmLimit?:number|null, keyType?:string|null, rotatedFrom?:string|null}} opts
 */
function createKey({
  label = null,
  kind = 'access',
  platform = null,
  plainKey = null,
  scopes = undefined,
  resources = undefined,
  expiresAt = undefined,
  rpmLimit = undefined,
  keyType = undefined,
  rotatedFrom = null,
} = {}) {
  if (!KINDS.has(kind)) throw new Error(`invalid kind: ${kind} (expected login|access)`);
  if (kind === 'access') {
    if (!PLATFORMS.has(platform)) {
      throw new Error(`invalid platform: ${platform} (expected trae|workbuddy|all)`);
    }
    if (keyType != null && !KEY_TYPES.has(keyType)) {
      throw new Error(`invalid keyType: ${keyType} (expected universal|dedicated)`);
    }
  }
  if (kind === 'login') {
    // 登录密钥唯一：禁用旧的
    db().prepare("UPDATE api_keys SET enabled = 0 WHERE kind = 'login' AND enabled = 1").run();
  }
  const plain = plainKey || genPlainKey(kind === 'login' ? 'sk-admin' : 'sk');
  const id = genId(kind === 'login' ? 'login' : 'key');
  const createdAt = new Date().toISOString();
  const kType = keyType || (platform === 'all' ? 'universal' : 'dedicated');
  const scopeList = kind === 'login' ? [] : normalizeScopes(platform, scopes);
  const resList = kind === 'login' ? [] : normalizeResources(platform, resources);
  const exp = kind === 'login' ? null : normalizeExpires(expiresAt);
  const rpm = kind === 'login' ? null : (rpmLimit != null && Number.isFinite(Number(rpmLimit)) ? Math.trunc(Number(rpmLimit)) : null);

  db().prepare(
    `INSERT INTO api_keys
      (id, label, kind, platform, key_hash, key_enc, enabled, created_at, key_type, scopes, resources, expires_at, rpm_limit, rotated_from)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, label, kind, platform, hashKey(plain), cryptoLib.encrypt(plain), createdAt,
    kType, JSON.stringify(scopeList), JSON.stringify(resList), exp, rpm, rotatedFrom,
  );
  return {
    ...rowToKey({
      id, label, kind, platform, key_type: kType,
      scopes: JSON.stringify(scopeList), resources: JSON.stringify(resList),
      expires_at: exp, rpm_limit: rpm, rotated_from: rotatedFrom,
      enabled: 1, created_at: createdAt, last_used_at: null,
      key_hash: hashKey(plain),
    }),
    key: plain,
  };
}

/**
 * 解密取出明文（供复制接口；列表/详情均不返回）。
 * @returns {string|null} 无记录或无密文备份时 null
 */
function revealKeyPlain(id) {
  const r = db().prepare('SELECT key_enc FROM api_keys WHERE id = ?').get(id);
  if (!r || !r.key_enc) return null;
  try {
    return cryptoLib.decrypt(r.key_enc);
  } catch {
    return null;
  }
}

function listKeys({ kind = null } = {}) {
  const rows = kind
    ? db().prepare('SELECT * FROM api_keys WHERE kind = ? ORDER BY created_at DESC').all(kind)
    : db().prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all();
  return rows.map(rowToKey);
}

function getKey(id) {
  const r = db().prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
  return r ? rowToKey(r) : null;
}

function updateKey(id, patch = {}) {
  const existing = db().prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
  if (!existing) return null;
  const label = patch.label !== undefined ? patch.label : existing.label;
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled;
  let scopes = existing.scopes;
  if (patch.scopes !== undefined) {
    scopes = JSON.stringify(normalizeScopes(existing.platform, patch.scopes));
  }
  let resources = existing.resources;
  if (patch.resources !== undefined) {
    resources = JSON.stringify(normalizeResources(existing.platform, patch.resources));
  }
  let expiresAt = existing.expires_at;
  if (patch.expiresAt !== undefined) {
    expiresAt = normalizeExpires(patch.expiresAt);
  }
  let rpm = existing.rpm_limit;
  if (patch.rpmLimit !== undefined) {
    rpm = patch.rpmLimit == null ? null : Math.trunc(Number(patch.rpmLimit));
  }
  db().prepare(
    'UPDATE api_keys SET label = ?, enabled = ?, scopes = ?, resources = ?, expires_at = ?, rpm_limit = ?, platform = ? WHERE id = ?',
  ).run(label, enabled, scopes, resources, expiresAt, rpm, existing.platform, id);
  return getKey(id);
}

/** 撤销：不可再鉴权，记录 revoked_at（保留行做审计）。 */
function revokeKey(id) {
  const info = db().prepare(
    "UPDATE api_keys SET revoked_at = ?, enabled = 0 WHERE id = ? AND revoked_at IS NULL",
  ).run(new Date().toISOString(), id);
  return info.changes > 0;
}

/**
 * 轮换：生成新密钥（继承 label/platform/scope/resources），旧密钥进入宽限期后自动失效。
 * @param {string} id
 * @param {{graceMs?:number, label?:string}} opts
 */
function rotateKey(id, { graceMs = 24 * 3600_000, label } = {}) {
  const old = db().prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
  if (!old) return null;
  const created = createKey({
    label: label != null ? label : old.label,
    kind: old.kind || 'access',
    platform: old.platform,
    scopes: parseJsonArr(old.scopes, null),
    resources: parseJsonArr(old.resources, null),
    expiresAt: old.expires_at || undefined,
    rpmLimit: old.rpm_limit,
    keyType: old.key_type || undefined,
    rotatedFrom: old.id,
  });
  // 旧密钥宽限期：默认保留 enabled，到点后由 sweepExpired 处理。
  // 这里把 grace 截止时间写入 expires_at：last_used 语义不合适，
  // 约定为旧密钥 expires_at 未到则取 min(now+grace, expires_at)。
  const graceUntil = new Date(Date.now() + Math.max(0, graceMs)).toISOString();
  const newExp = old.expires_at && Date.parse(old.expires_at) < Date.parse(graceUntil)
    ? old.expires_at
    : graceUntil;
  db().prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run(newExp, old.id);
  return { newKey: created, oldExpiresAt: newExp };
}

function deleteKey(id) {
  const info = db().prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  return info.changes > 0;
}

/** 是否已有启用的登录密钥。 */
function hasLoginKey() {
  const r = db().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE kind = 'login' AND enabled = 1").get();
  return r.n > 0;
}

/** 该记录是否可鉴权（未撤销、未过期、enabled）。 */
function isUsableRow(r) {
  if (!r || !r.enabled || r.revoked_at) return false;
  if (r.expires_at && Date.parse(r.expires_at) < Date.now()) return false;
  return true;
}

/**
 * 校验明文 → 访问密钥记录（kind=access 且可用）。
 */
function verifyAccessKey(plain) {
  if (!plain) return null;
  const r = db().prepare("SELECT * FROM api_keys WHERE key_hash = ? AND kind = 'access' AND enabled = 1").get(hashKey(plain));
  if (!r || !r.platform || !isUsableRow(r)) return null;
  return {
    id: r.id,
    platform: r.platform,
    label: r.label || null,
    kind: 'access',
    keyType: r.key_type || (r.platform === 'all' ? 'universal' : 'dedicated'),
    scopes: parseJsonArr(r.scopes, DEFAULT_SCOPES[r.platform] || []),
    resources: parseJsonArr(r.resources, DEFAULT_RESOURCES[r.platform] || []),
    expiresAt: r.expires_at || null,
    rpmLimit: r.rpm_limit != null ? Number(r.rpm_limit) : null,
    // 通用密钥可跨平台与虚拟模型；平台密钥仅本平台
    scope: r.platform === 'all' ? 'universal' : 'platform',
  };
}

/**
 * 校验明文 → 登录密钥记录（kind=login 且可用）。
 */
function verifyLoginKey(plain) {
  if (!plain) return null;
  const r = db().prepare("SELECT * FROM api_keys WHERE key_hash = ? AND kind = 'login' AND enabled = 1").get(hashKey(plain));
  if (!r || !isUsableRow(r)) return null;
  return { id: r.id, label: r.label || null, kind: 'login' };
}

/** 兼容旧名。 */
const verifyKey = verifyAccessKey;

function touchLastUsed(id) {
  try {
    db().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  } catch { /* best-effort */ }
}

/** 清理过期密钥状态（调用频繁，可放缓；启动与定时任务可调）。 */
function sweepExpired() {
  const now = new Date().toISOString();
  const info = db().prepare(
    "UPDATE api_keys SET enabled = 0 WHERE enabled = 1 AND expires_at IS NOT NULL AND expires_at < ?",
  ).run(now);
  return info.changes;
}

/** 重置登录密钥：作废旧的并新建。 */
function resetLoginKey({ label = 'login', plainKey = null } = {}) {
  db().prepare("UPDATE api_keys SET enabled = 0 WHERE kind = 'login'").run();
  return createKey({ label, kind: 'login', plainKey });
}

/**
 * K-3 存量密钥 scope 迁移：补齐 models:read。
 *
 * 背景：/v1/models 对访问密钥实施 scope 强校验（requireKeyScope），而历史创建的
 * 平台密钥默认 scopes 只有 models:invoke，直接上线会导致存量客户端模型列表 403。
 * 迁移在启动时执行一次：为所有启用且缺 models:read 的 access 密钥补上，幂等；
 * 管理面模型列表是双面端点的基础可用性，因此显式收窄过 scope 的密钥同样补齐。
 *
 * ⚠️ 2026-11-07 根因修复（本函数此前是「单个模型全部 401/403、只剩聚合虚拟模型
 * 可用」的直接原因）：
 *
 * 上一版对**scopes 为 NULL 的历史密钥**（scopes 列引入于 2026-10-03，此前创建的
 * 密钥该列为空）取 `parseJsonArr(row.scopes, [])` 得到 `[]`，再 `[...[], 'models:read']`
 * 写回，于是把「NULL = 走默认值（含 models:invoke）」硬写成「只有 models:read」。
 * 结果：这些密钥能列模型（models:read 命中）却**调不动任何单个物理模型**
 * （`canUseModel` → `canInvokeModel` 要求 models:invoke），返回
 * `403 access denied: scope_missing:models:invoke`，type=auth_error。
 * 而虚拟模型分支不校验 scope（见 middleware/model-access.js 的虚拟分支），
 * 于是症状恰好是「聚合虚拟模型可用、后端单个模型提示密钥失效」。
 *
 * 现在的口径分两路，不再有「空列表」这条静默降级路径：
 *   - scopes 为 NULL/空（历史密钥，从未显式收窄）→ 物化该平台的完整默认 scope；
 *   - scopes 非空（用户显式配过）→ 只补 models:read，尊重显式收窄。
 *
 * @returns {string[]} 补齐过的密钥 ID 列表
 */
function ensureModelsReadScope() {
  const patched = [];
  const rows = db().prepare("SELECT id, platform, scopes FROM api_keys WHERE kind = 'access' AND enabled = 1").all();
  for (const row of rows) {
    const raw = parseJsonArr(row.scopes, null);
    // 历史密钥：列值为 NULL/空 → 按平台默认值物化（与 verifyAccessKey 的隐含默认一致，
    // 因此对鉴权结果零行为差异，只是把「隐含」变成「显式」）
    if (raw == null || !raw.length) {
      const full = DEFAULT_SCOPES[row.platform] || DEFAULT_SCOPES.trae;
      db().prepare('UPDATE api_keys SET scopes = ? WHERE id = ?').run(JSON.stringify(full), row.id);
      patched.push(row.id);
      continue;
    }
    if (raw.includes('models:read')) continue;
    const merged = [...raw, 'models:read'];
    db().prepare('UPDATE api_keys SET scopes = ? WHERE id = ?').run(JSON.stringify(merged), row.id);
    patched.push(row.id);
  }
  return patched;
}

/** 「能发起调用」的 scope：一把 access 密钥至少要有一个，否则它只能列模型、调不动任何东西。 */
const INVOKE_SCOPES = ['models:invoke', 'router:invoke'];

/**
 * 访问密钥 scope 不变式修复：补齐缺失的 invoke 能力。
 *
 * 为什么单独一个函数而不是并进 ensureModelsReadScope：两者的判据不同——
 * 前者是「缺一个具体 scope」，这里是「缺一整类能力」。把上一版迁移写坏的行
 * （scopes 恰好被写成 `["models:read"]`）与「用户显式只要 models:read」区分不开，
 * 但两者的**实际后果完全一样**：密钥调不动任何模型。既然 models:read 单独存在
 * 没有任何可用场景（列得出模型却一个都调不了），这里按「坏行」修，并按平台
 * 默认值补齐 invoke（不动用户已有的其它 scope）。
 *
 * 幂等：已有任一 invoke scope 的行不动。
 * @returns {{id:string, platform:string, before:string[], after:string[]}[]}
 */
function ensureInvokeScope() {
  const repaired = [];
  const rows = db().prepare("SELECT id, platform, scopes FROM api_keys WHERE kind = 'access' AND enabled = 1").all();
  for (const row of rows) {
    const raw = parseJsonArr(row.scopes, null);
    // NULL/空由 ensureModelsReadScope 负责物化，这里不重复处理
    if (raw == null || !raw.length) continue;
    if (INVOKE_SCOPES.some((s) => raw.includes(s))) continue;
    const defaults = DEFAULT_SCOPES[row.platform] || DEFAULT_SCOPES.trae;
    const merged = [...raw];
    for (const s of defaults) if (!merged.includes(s)) merged.push(s);
    db().prepare('UPDATE api_keys SET scopes = ? WHERE id = ?').run(JSON.stringify(merged), row.id);
    repaired.push({ id: row.id, platform: row.platform, before: raw, after: merged });
  }
  return repaired;
}

/**
 * 启动引导（仅 access；login 走首登 setup 或 CLI）：
 * 库内无 access key 时，用 API_KEY 建 trae 访问密钥。
 * 若存在 ADMIN_KEY 且无 login key，建 login 密钥（兼容旧部署）。
 */
function bootstrapFromEnv() {
  const created = [];
  const loginCount = db().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE kind = 'login' AND enabled = 1").get().n;
  if (loginCount === 0 && process.env.ADMIN_KEY) {
    created.push(createKey({ label: 'bootstrap-login', kind: 'login', plainKey: process.env.ADMIN_KEY }));
  }
  const accessCount = db().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE kind = 'access' AND enabled = 1").get().n;
  if (accessCount === 0) {
    if (process.env.API_KEY) {
      created.push(createKey({ label: 'bootstrap-trae', kind: 'access', platform: 'trae', plainKey: process.env.API_KEY }));
    }
    if (process.env.WORKBUDDY_API_KEY) {
      created.push(createKey({ label: 'bootstrap-workbuddy', kind: 'access', platform: 'workbuddy', plainKey: process.env.WORKBUDDY_API_KEY }));
    }
    if (process.env.UNIVERSAL_API_KEY) {
      created.push(createKey({ label: 'bootstrap-universal', kind: 'access', platform: 'all', plainKey: process.env.UNIVERSAL_API_KEY }));
    }
  }
  return created;
}

module.exports = {
  KINDS,
  PLATFORMS,
  PLATFORM_LABELS,
  SCOPES,
  KEY_TYPES,
  DEFAULT_SCOPES,
  DEFAULT_RESOURCES,
  createKey,
  listKeys,
  getKey,
  updateKey,
  revokeKey,
  rotateKey,
  deleteKey,
  revealKeyPlain,
  verifyKey,
  verifyAccessKey,
  verifyLoginKey,
  hasLoginKey,
  resetLoginKey,
  touchLastUsed,
  sweepExpired,
  bootstrapFromEnv,
  ensureModelsReadScope,
  ensureInvokeScope,
  hashKey,
  genPlainKey,
  isUsableRow,
};
