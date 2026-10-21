'use strict';
/**
 * credentials/store.js — 多账号凭据存储（SQLite 版，面向「免本机登录」）。
 *
 * 不依赖本机 Trae storage.json，通过导入凭据或 OAuth 连接账号。
 * 对 SQLite accounts 表做增删改查，敏感字段（token/refreshToken）写入数据库前加密。
 * 数据源来自 credentials/db.js；此处只做 ORM 映射与加密解密封装。
 * source 取值 'import'|'oauth'|'local'；local 表示本机登录回退（无持久化账号）。
 */
const config = require('../config');
const { db } = require('./db');
const crypto = require('../lib/crypto.js');
const nodeCrypto = require('crypto');

/** 生成简短的账号 ID（加密随机，避免 Math.random 可预测）。 */
function genId() {
  return `acct_${Date.now().toString(36)}${nodeCrypto.randomBytes(4).toString('hex')}`;
}

function enc(v) {
  return v == null ? null : crypto.encrypt(String(v));
}

/** SQLite 绑定安全：仅允许 string / number / null。对象、布尔等转字符串或 null。 */
function bindText(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  try { return JSON.stringify(v); } catch { return String(v); }
}

function bindNum(v, fallback = null) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bindInt(v, fallback = 0) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function safeTok(v) {
  // 对外返回值脱敏：去掉 token / refreshToken / apiKey 明文。
  //
  // raccoonPassword 与 raccoonPhone 同属凭据：前者是上游登录密码，后者是 PII
  // 且与密码配对即可复刻一次真实登录。两者一律不外泄——路由层只回
  // hasPasswordLogin 布尔值表达「是否已配置」。
  // 注意 safeTok 会被 update()/add() 的返回值复用，而 update() 内部是
  // safeTok(get(id))、get() 默认解密，所以「漏剥一项」等于所有写接口都泄漏。
  // version 是 update() 的乐观锁内部字段，不属于账号业务数据，不外泄。
  const { token, refreshToken, apiKey, raccoonPhone, raccoonPassword, version, ...rest } = v;
  return rest;
}

/**
 * patch 的驼峰键 → { 数据库列名, 取值函数 } 映射。
 *
 * update() 只写 patch 里真正出现的列（不再全列重写），这是修复丢失更新的前提：
 * 全列重写时，另一写入方刚写入的字段会被当前这份陈旧快照覆盖回去。
 *
 * 列名必须显式声明：token→token_enc、group→group_name 这类不是简单驼峰转换。
 */
const PATCH_COLUMNS = {
  label: { col: 'label', val: (a) => bindText(a.label) },
  edition: { col: 'edition', val: (a) => bindText(a.edition) },
  token: { col: 'token_enc', val: (a) => enc(a.token) },
  refreshToken: { col: 'refresh_token_enc', val: (a) => enc(a.refreshToken) },
  apiKey: { col: 'api_key_enc', val: (a) => enc(a.apiKey) },
  expiredAt: { col: 'expired_at', val: (a) => bindText(a.expiredAt) },
  refreshExpiredAt: { col: 'refresh_expired_at', val: (a) => bindText(a.refreshExpiredAt) },
  tokenReleaseAt: { col: 'token_release_at', val: (a) => bindText(a.tokenReleaseAt) },
  userId: { col: 'user_id', val: (a) => bindText(a.userId) },
  host: { col: 'host', val: (a) => bindText(a.host) },
  userRegion: { col: 'user_region', val: (a) => bindText(a.userRegion) },
  devices: { col: 'devices', val: (a) => (a.devices ? JSON.stringify(a.devices) : null) },
  fingerprint: {
    col: 'fingerprint',
    val: (a) => (a.fingerprint && Object.keys(a.fingerprint).length ? JSON.stringify(a.fingerprint) : null),
  },
  mode: { col: 'mode', val: (a) => bindText(a.mode) },
  source: { col: 'source', val: (a) => bindText(a.source) || 'import' },
  enabled: { col: 'enabled', val: (a) => (a.enabled ? 1 : 0) },
  balance: { col: 'balance', val: (a) => bindNum(a.balance) },
  errorCount: { col: 'error_count', val: (a) => bindInt(a.errorCount, 0) },
  coolUntil: { col: 'cool_until', val: (a) => bindText(a.coolUntil) },
  lastPickedAt: { col: 'last_picked_at', val: (a) => bindInt(a.lastPickedAt, 0) },
  lastCheckinAt: { col: 'last_checkin_at', val: (a) => bindText(a.lastCheckinAt) },
  lastCheckinResult: { col: 'last_checkin_result', val: (a) => bindText(a.lastCheckinResult) },
  lastKeepaliveAt: { col: 'last_keepalive_at', val: (a) => bindText(a.lastKeepaliveAt) },
  lastKeepaliveResult: { col: 'last_keepalive_result', val: (a) => bindText(a.lastKeepaliveResult) },
  // 最近一次**成功**续期的时刻（判据位）。与 lastKeepaliveAt（最近一次保活
  // **尝试**，展示位）刻意分开：共用一个字段会让每日保活盖章重置周期续期窗口，
  // 也会让失败把重试压满整个周期。见 db.js 的同名列注释。
  lastRefreshAt: { col: 'last_refresh_at', val: (a) => bindText(a.lastRefreshAt) },
  entitlementSnapshot: { col: 'entitlement_snapshot', val: (a) => bindText(a.entitlementSnapshot) },
  priority: { col: 'priority', val: (a) => bindInt(a.priority, 0) },
  tags: { col: 'tags', val: (a) => (a.tags ? JSON.stringify(a.tags) : null) },
  group: { col: 'group_name', val: (a) => bindText(a.group) },
  deviceGen: { col: 'device_gen', val: (a) => bindInt(a.deviceGen, 0) },
  authClientId: { col: 'auth_client_id', val: (a) => bindText(a.authClientId) },
  authHost: { col: 'auth_host', val: (a) => bindText(a.authHost) },
  costTier: { col: 'cost_tier', val: (a) => bindInt(a.costTier, 1) },
  modelCooldowns: {
    col: 'model_cooldowns',
    val: (a) =>
      a.modelCooldowns && Object.keys(a.modelCooldowns).length ? JSON.stringify(a.modelCooldowns) : null,
  },
  rateStreak: { col: 'rate_streak', val: (a) => bindInt(a.rateStreak, 0) },
  modelCoolStreak: { col: 'model_cool_streak', val: (a) => bindInt(a.modelCoolStreak, 0) },
  // Qoder 区域（仅 qoder 账号）。导入时按扫到的客户端目录确定，之后不再变。
  qoderRealm: { col: 'qoder_realm', val: (a) => bindText(a.qoderRealm) },
  // Raccoon 组织码（仅 raccoon 账号）。个人账号为空串，企业账号是组织码；
  // 每次业务请求都要放进 `X-Org-Code` 头，故必须持久化。
  raccoonOrg: { col: 'raccoon_org', val: (a) => bindText(a.raccoonOrg) },
  // Raccoon 密码登录凭据（仅 raccoon 账号，可选）。每日积分由**真实登录**触发
  // 发放，login_with_password 是网关侧唯一可编程复刻的真实登录入口，故持久化
  // 加密后的手机号与密码供每日保活代登。与 token 同级用统一密钥加密存储。
  raccoonPhone: { col: 'raccoon_phone_enc', val: (a) => enc(a.raccoonPhone) },
  raccoonPassword: { col: 'raccoon_password_enc', val: (a) => enc(a.raccoonPassword) },
  raccoonNationCode: { col: 'raccoon_nation_code', val: (a) => bindText(a.raccoonNationCode) },
};

/** 写入冲突时的错误标记，供调用方与测试识别（不当作普通异常吞掉）。 */
const WRITE_CONFLICT = 'WRITE_CONFLICT';

function acctToRow(acct) {
  return {
    id: bindText(acct.id),
    label: bindText(acct.label),
    edition: bindText(acct.edition),
    token_enc: enc(acct.token),
    refresh_token_enc: enc(acct.refreshToken),
    // ZCode 回退通道凭据（api.z.ai / open.bigmodel 的 key），列级加密
    api_key_enc: enc(acct.apiKey),
    expired_at: bindText(acct.expiredAt),
    refresh_expired_at: bindText(acct.refreshExpiredAt),
    token_release_at: bindText(acct.tokenReleaseAt),
    user_id: bindText(acct.userId),
    host: bindText(acct.host),
    user_region: bindText(acct.userRegion),
    devices: acct.devices ? JSON.stringify(acct.devices) : null,
    // ZCode 账号的设备档案（zcode/fingerprint.js 的成套桌面 SKU + device_mid）
    fingerprint: acct.fingerprint && Object.keys(acct.fingerprint).length ? JSON.stringify(acct.fingerprint) : null,
    // ZCode 账号类型：jwt（Coding/Start Plan 额度）| apiKey（回退通道）
    mode: bindText(acct.mode),
    source: bindText(acct.source) || 'import',
    enabled: acct.enabled ? 1 : 0,
    balance: bindNum(acct.balance),
    error_count: bindInt(acct.errorCount, 0),
    cool_until: bindText(acct.coolUntil),
    last_picked_at: bindInt(acct.lastPickedAt, 0),
    last_checkin_at: bindText(acct.lastCheckinAt),
    last_checkin_result: bindText(acct.lastCheckinResult),
    last_keepalive_at: bindText(acct.lastKeepaliveAt),
    last_keepalive_result: bindText(acct.lastKeepaliveResult),
    last_refresh_at: bindText(acct.lastRefreshAt),
    qoder_realm: bindText(acct.qoderRealm),
    raccoon_org: bindText(acct.raccoonOrg),
    raccoon_phone_enc: enc(acct.raccoonPhone),
    raccoon_password_enc: enc(acct.raccoonPassword),
    raccoon_nation_code: bindText(acct.raccoonNationCode),
    entitlement_snapshot: bindText(acct.entitlementSnapshot),
    priority: bindInt(acct.priority, 0),
    tags: acct.tags ? JSON.stringify(acct.tags) : null,
    group_name: bindText(acct.group),
    device_gen: bindInt(acct.deviceGen, 0),
    auth_client_id: bindText(acct.authClientId),
    auth_host: bindText(acct.authHost),
    cost_tier: bindInt(acct.costTier, 1),
    model_cooldowns: acct.modelCooldowns && Object.keys(acct.modelCooldowns).length ? JSON.stringify(acct.modelCooldowns) : null,
    rate_streak: bindInt(acct.rateStreak, 0),
    model_cool_streak: bindInt(acct.modelCoolStreak, 0),
  };
}

/**
 * 列表查询不解密：list() 的返回值会被 safeTok 剥掉 token/refreshToken，
 * 所有调用方都拿不到明文，解密纯属浪费（实测 1000 账号约 27ms/次）。
 * 需要明文的路径（get / update / 上游调用）单独走 get()。
 */
function list() {
  const rows = db().prepare('SELECT * FROM accounts').all();
  return rows.map((r) => {
    const acct = safeTok(rowToDecrypted(r, false));
    // 密码凭据不解密，但「是否已配置」是安全的布尔值，供面板显示按钮态。
    // 只判密文列是否非空，绝不解密回明文。
    acct.hasPasswordLogin = !!(r.raccoon_password_enc);
    return acct;
  });
}

function rowToDecrypted(r, withSecrets = true) {
  return {
    id: r.id,
    label: r.label,
    edition: r.edition,
    token: withSecrets && r.token_enc ? crypto.decrypt(r.token_enc) : null,
    refreshToken: withSecrets && r.refresh_token_enc ? crypto.decrypt(r.refresh_token_enc) : null,
    // ZCode 回退通道凭据
    apiKey: withSecrets && r.api_key_enc ? crypto.decrypt(r.api_key_enc) : null,
    expiredAt: r.expired_at,
    refreshExpiredAt: r.refresh_expired_at,
    tokenReleaseAt: r.token_release_at,
    userId: r.user_id,
    host: r.host,
    userRegion: r.user_region,
    devices: r.devices ? JSON.parse(r.devices) : null,
    // ZCode 设备档案与账号类型（其它平台为 null，不影响既有读取方）
    fingerprint: parseSnapshotJson(r.fingerprint),
    mode: r.mode || null,
    source: r.source,
    enabled: !!r.enabled,
    balance: r.balance,
    errorCount: r.error_count,
    coolUntil: r.cool_until,
    lastPickedAt: r.last_picked_at,
    lastCheckinAt: r.last_checkin_at,
    lastCheckinResult: r.last_checkin_result,
    lastKeepaliveAt: r.last_keepalive_at,
    lastKeepaliveResult: r.last_keepalive_result,
    lastRefreshAt: r.last_refresh_at || null,
    qoderRealm: r.qoder_realm || null,
    raccoonOrg: r.raccoon_org || null,
    // Raccoon 密码登录凭据（解密回明文供 auth.loginWithPassword 加密后发送；
    // withSecrets=false 时不给，避免泄漏到面板展示面）
    raccoonPhone: withSecrets && r.raccoon_phone_enc ? crypto.decrypt(r.raccoon_phone_enc) : null,
    raccoonPassword: withSecrets && r.raccoon_password_enc ? crypto.decrypt(r.raccoon_password_enc) : null,
    raccoonNationCode: r.raccoon_nation_code || null,
    entitlementSnapshot: parseSnapshotJson(r.entitlement_snapshot),
    priority: r.priority != null ? Number(r.priority) || 0 : 0,
    tags: parseTagsJson(r.tags),
    group: r.group_name || null,
    deviceGen: r.device_gen != null ? Number(r.device_gen) || 0 : 0,
    authClientId: r.auth_client_id || null,
    authHost: r.auth_host || null,
    costTier: r.cost_tier != null ? Number(r.cost_tier) : 1,
    modelCooldowns: parseSnapshotJson(r.model_cooldowns) || null,
    rateStreak: r.rate_streak != null ? Number(r.rate_streak) || 0 : 0,
    modelCoolStreak: r.model_cool_streak != null ? Number(r.model_cool_streak) || 0 : 0,
    // 乐观锁版本号：仅 update() 的 CAS 使用，不属于账号业务字段，
    // 因此不加入 PATCH_COLUMNS（外部无法直接写它）。
    version: r.version != null ? Number(r.version) || 0 : 0,
  };
}

function parseTagsJson(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function parseSnapshotJson(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function get(id) {
  const r = db().prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  return r ? rowToDecrypted(r) : null;
}

/** 新增账号，返回脱敏结果。 */
function add(cred, source) {
  const acct = {
    ...cred,
    id: cred.id || genId(),
    source: source || cred.source || 'import',
    enabled: cred.enabled !== false,
    balance: cred.balance || null,
    errorCount: cred.errorCount || 0,
    coolUntil: cred.coolUntil || null,
    lastPickedAt: cred.lastPickedAt || 0,
  };
  const r = acctToRow(acct);
  db().prepare(`
    INSERT INTO accounts (
      id, label, edition, token_enc, refresh_token_enc, api_key_enc, expired_at, refresh_expired_at,
      token_release_at, user_id, host, user_region, devices, fingerprint, mode, source, enabled,
      balance, error_count, cool_until, last_picked_at, last_checkin_at, last_checkin_result,
      last_keepalive_at, last_keepalive_result, last_refresh_at, qoder_realm, raccoon_org,
      raccoon_phone_enc, raccoon_password_enc, raccoon_nation_code,
      entitlement_snapshot, priority, tags, group_name, device_gen, auth_client_id, auth_host, cost_tier,
      model_cooldowns, rate_streak, model_cool_streak
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(r.id, r.label, r.edition, r.token_enc, r.refresh_token_enc, r.api_key_enc, r.expired_at,
    r.refresh_expired_at, r.token_release_at, r.user_id, r.host, r.user_region,
    r.devices, r.fingerprint, r.mode, r.source, r.enabled, r.balance, r.error_count, r.cool_until,
    r.last_picked_at, r.last_checkin_at, r.last_checkin_result,
    r.last_keepalive_at, r.last_keepalive_result, r.last_refresh_at, r.qoder_realm, r.raccoon_org,
    r.raccoon_phone_enc, r.raccoon_password_enc, r.raccoon_nation_code,
    r.entitlement_snapshot, r.priority, r.tags, r.group_name, r.device_gen, r.auth_client_id, r.auth_host, r.cost_tier,
    r.model_cooldowns, r.rate_streak, r.model_cool_streak);
  return safeTok(acct);
}

/**
 * 局部更新账号，返回脱敏结果；账号不存在返回 null。
 *
 * 实现说明（P0-001 丢失更新修复）：
 *   旧实现是 get(id) 全列读 → merge → UPDATE 全部 34 列。单进程内因为
 *   node:sqlite 同步执行没有 await 窗口，但跨进程（第二个 node 进程、
 *   运维脚本）或多客户端同时写库时，另一写入方在「读」与「写」之间落的字段
 *   会被本次陈旧快照覆盖回去，且无任何报错。
 *
 *   现在改为：
 *     1) 只写 patch 真正包含的列（buildSetClause）；
 *     2) UPDATE ... WHERE id=? AND version=? 的 CAS；
 *     3) 冲突时重读重试（上限 3 次），仍冲突则抛 WRITE_CONFLICT。
 */
function update(id, patch) {
  if (!patch || typeof patch !== 'object') return null;
  // 只保留已知列，未知键直接忽略（此前全列重写会顺带写入未知键的 undefined）
  const keys = Object.keys(patch).filter((k) => Object.prototype.hasOwnProperty.call(PATCH_COLUMNS, k));
  if (keys.length === 0) {
    // 没有任何可写列：仍要确认账号存在，保持不存在返回 null 的契约
    const cur = get(id);
    return cur ? safeTok(cur) : null;
  }

  const RETRY_MAX = 3;
  for (let attempt = 0; attempt < RETRY_MAX; attempt += 1) {
    const row = rawRow(id);
    if (!row) return null;

    const setParts = [];
    const args = [];
    for (const k of keys) {
      const spec = PATCH_COLUMNS[k];
      setParts.push(`${spec.col} = ?`);
      // 取值函数收到「当前行 + 本键新值」的合并视图，
      // 因为部分列（如 source 的默认值、modelCooldowns 的空对象判定）依赖完整语义
      args.push(spec.val({ ...rowToDecrypted(row, false), [k]: patch[k] }));
    }
    setParts.push('version = version + 1');

    const info = db()
      .prepare(`UPDATE accounts SET ${setParts.join(', ')} WHERE id = ? AND version = ?`)
      .run(...args, id, Number(row.version) || 0);

    if (info.changes > 0) {
      // 与旧实现保持同一返回契约：脱敏后的账号（不含 token/refreshToken/apiKey/version）。
      // 注意不能直接 return get(id) —— get() 按设计返回解密后的密文字段。
      return safeTok(get(id));
    }
    // changes === 0：期间被其它写入方改过（version 变了），重读重试。
    // 账号被删也会落到这里（下一轮 rawRow 返回 null，返回 null）。
  }
  const e = new Error(`账号 ${id} 并发写入冲突：连续 ${RETRY_MAX} 次 version 不匹配`);
  e.code = WRITE_CONFLICT;
  throw e;
}

/** 读原始行（含 version 与密文列），仅供 update 做 CAS 用。 */
function rawRow(id) {
  return db().prepare('SELECT * FROM accounts WHERE id = ?').get(id) || null;
}

function remove(id) {
  const info = db().prepare('DELETE FROM accounts WHERE id = ?').run(id);
  // 同步清理积分快照，避免删号后留下孤儿 credit_history 记录
  if (info.changes > 0) {
    db().prepare('DELETE FROM credit_history WHERE account_id = ?').run(id);
  }
  return info.changes > 0;
}

module.exports = { list, get, add, update, remove };