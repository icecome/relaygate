'use strict';
/**
 * credentials/store.js — 多账号凭据存储（SQLite 版，面向"免本机登录"）。
 *
 * 需求：不依赖本机 Trae storage.json，通过导入凭据 / OAuth 连接账号。
 * 本模块：对 SQLite accounts 表做增删改查，敏感字段（token/refreshToken）落库前加密。
 * 数据源来自 credentials/db.js；此处只做 ORM 映射与加密解密封装。
 *
 * 说明：source 取值 'import'|'oauth'|'local'；local 表示本机登录回退（无持久化账号）。
 */
const config = require('../config');
const { db } = require('./db');
const crypto = require('../lib/crypto.js');
const nodeCrypto = require('crypto');

/** 生成简短的账号 id（加密随机，避免 Math.random 可预测） */
function genId() {
  return `acct_${Date.now().toString(36)}${nodeCrypto.randomBytes(4).toString('hex')}`;
}

function enc(v) {
  return v == null ? null : crypto.encrypt(String(v));
}

/** SQLite 绑定安全：仅允许 string / number / null。对象/布尔等转字符串或 null。 */
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
  // 对外返回值脱敏：去掉 token / refreshToken 明文
  const { token, refreshToken, ...rest } = v;
  return rest;
}

function acctToRow(acct) {
  return {
    id: bindText(acct.id),
    label: bindText(acct.label),
    edition: bindText(acct.edition),
    token_enc: enc(acct.token),
    refresh_token_enc: enc(acct.refreshToken),
    expired_at: bindText(acct.expiredAt),
    refresh_expired_at: bindText(acct.refreshExpiredAt),
    token_release_at: bindText(acct.tokenReleaseAt),
    user_id: bindText(acct.userId),
    host: bindText(acct.host),
    user_region: bindText(acct.userRegion),
    devices: acct.devices ? JSON.stringify(acct.devices) : null,
    source: bindText(acct.source) || 'import',
    enabled: acct.enabled ? 1 : 0,
    balance: bindNum(acct.balance),
    error_count: bindInt(acct.errorCount, 0),
    cool_until: bindText(acct.coolUntil),
    last_picked_at: bindInt(acct.lastPickedAt, 0),
    last_checkin_at: bindText(acct.lastCheckinAt),
    last_checkin_result: bindText(acct.lastCheckinResult),
    entitlement_snapshot: bindText(acct.entitlementSnapshot),
    priority: bindInt(acct.priority, 0),
    tags: acct.tags ? JSON.stringify(acct.tags) : null,
    group_name: bindText(acct.group),
    device_gen: bindInt(acct.deviceGen, 0),
    auth_client_id: bindText(acct.authClientId),
    auth_host: bindText(acct.authHost),
    cost_tier: bindInt(acct.costTier, 1),
  };
}

/**
 * 列表查询不做密文解密：list() 的返回值会被 safeTok 剥掉 token/refreshToken，
 * 所有调用方都拿不到明文，解密纯属浪费（实测 1000 账号约 27ms/次）。
 * 需要明文的路径（get / update / 上游调用）单独走 get()。
 */
function list() {
  const rows = db().prepare('SELECT * FROM accounts').all();
  return rows.map((r) => safeTok(rowToDecrypted(r, false)));
}

function rowToDecrypted(r, withSecrets = true) {
  return {
    id: r.id,
    label: r.label,
    edition: r.edition,
    token: withSecrets && r.token_enc ? crypto.decrypt(r.token_enc) : null,
    refreshToken: withSecrets && r.refresh_token_enc ? crypto.decrypt(r.refresh_token_enc) : null,
    expiredAt: r.expired_at,
    refreshExpiredAt: r.refresh_expired_at,
    tokenReleaseAt: r.token_release_at,
    userId: r.user_id,
    host: r.host,
    userRegion: r.user_region,
    devices: r.devices ? JSON.parse(r.devices) : null,
    source: r.source,
    enabled: !!r.enabled,
    balance: r.balance,
    errorCount: r.error_count,
    coolUntil: r.cool_until,
    lastPickedAt: r.last_picked_at,
    lastCheckinAt: r.last_checkin_at,
    lastCheckinResult: r.last_checkin_result,
    entitlementSnapshot: parseSnapshotJson(r.entitlement_snapshot),
    priority: r.priority != null ? Number(r.priority) || 0 : 0,
    tags: parseTagsJson(r.tags),
    group: r.group_name || null,
    deviceGen: r.device_gen != null ? Number(r.device_gen) || 0 : 0,
    authClientId: r.auth_client_id || null,
    authHost: r.auth_host || null,
    costTier: r.cost_tier != null ? Number(r.cost_tier) : 1,
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
      id, label, edition, token_enc, refresh_token_enc, expired_at, refresh_expired_at,
      token_release_at, user_id, host, user_region, devices, source, enabled,
      balance, error_count, cool_until, last_picked_at, last_checkin_at, last_checkin_result,
      entitlement_snapshot, priority, tags, group_name, device_gen, auth_client_id, auth_host, cost_tier
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(r.id, r.label, r.edition, r.token_enc, r.refresh_token_enc, r.expired_at,
    r.refresh_expired_at, r.token_release_at, r.user_id, r.host, r.user_region,
    r.devices, r.source, r.enabled, r.balance, r.error_count, r.cool_until,
    r.last_picked_at, r.last_checkin_at, r.last_checkin_result, r.entitlement_snapshot,
    r.priority, r.tags, r.group_name, r.device_gen, r.auth_client_id, r.auth_host, r.cost_tier);
  return safeTok(acct);
}

/** 局部更新账号（自动刷新等），返回脱敏结果。 */
function update(id, patch) {
  const existing = get(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch };
  const r = acctToRow(merged);
  db().prepare(`
    UPDATE accounts SET
      label = ?, edition = ?, token_enc = ?, refresh_token_enc = ?, expired_at = ?,
      refresh_expired_at = ?, token_release_at = ?, user_id = ?, host = ?, user_region = ?,
      devices = ?, source = ?, enabled = ?, balance = ?, error_count = ?, cool_until = ?,
      last_picked_at = ?, last_checkin_at = ?, last_checkin_result = ?,
      entitlement_snapshot = ?, priority = ?, tags = ?,
      group_name = ?, device_gen = ?, auth_client_id = ?, auth_host = ?, cost_tier = ?
    WHERE id = ?
  `).run(r.label, r.edition, r.token_enc, r.refresh_token_enc, r.expired_at,
    r.refresh_expired_at, r.token_release_at, r.user_id, r.host, r.user_region,
    r.devices, r.source, r.enabled, r.balance, r.error_count, r.cool_until,
    r.last_picked_at, r.last_checkin_at, r.last_checkin_result, r.entitlement_snapshot,
    r.priority, r.tags, r.group_name, r.device_gen, r.auth_client_id, r.auth_host, r.cost_tier, id);
  return safeTok(merged);
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