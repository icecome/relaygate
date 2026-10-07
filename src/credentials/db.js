'use strict';
/**
 * credentials/db.js — SQLite 底座（Node 原生 node:sqlite）。
 *
 * 承载多账号凭据 + 账号路由统计（余额/失败/冷却/设备头）。
 * 敏感字段（token/refreshToken）以 AES-256-GCM 密文落库，密钥见 src/lib/crypto.js（持久化）。
 *
 * 数据库文件：{WORKSPACE_DIR}/.trae-api/trae-relay.db
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const DB_FILE = () => path.join(config.workspaceDir, '.trae-api', 'trae-relay.db');

let _db = null;

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id                 TEXT PRIMARY KEY,
      label              TEXT,
      edition            TEXT,
      token_enc          TEXT,
      refresh_token_enc  TEXT,
      expired_at         TEXT,
      refresh_expired_at TEXT,
      token_release_at   TEXT,
      user_id            TEXT,
      host               TEXT,
      user_region        TEXT,
      devices            TEXT,
      source             TEXT DEFAULT 'import',
      enabled            INTEGER DEFAULT 1,
      balance            REAL,
      error_count        INTEGER DEFAULT 0,
      cool_until         TEXT,
      last_picked_at     INTEGER DEFAULT 0,
      last_checkin_at    TEXT,
      last_checkin_result TEXT,
      entitlement_snapshot TEXT
    );
  `);
  const cols = db.prepare('PRAGMA table_info(accounts)').all();
  const names = new Set(cols.map((c) => c.name));
  // 全部为静态 DDL 字面量（列名固定，无外部输入参与拼接）
  if (!names.has('last_checkin_at')) db.exec('ALTER TABLE accounts ADD COLUMN last_checkin_at TEXT');
  if (!names.has('last_checkin_result')) db.exec('ALTER TABLE accounts ADD COLUMN last_checkin_result TEXT');
  if (!names.has('entitlement_snapshot')) db.exec('ALTER TABLE accounts ADD COLUMN entitlement_snapshot TEXT');
  if (!names.has('priority')) db.exec('ALTER TABLE accounts ADD COLUMN priority INTEGER DEFAULT 0');
  if (!names.has('tags')) db.exec('ALTER TABLE accounts ADD COLUMN tags TEXT');
  if (!names.has('group_name')) db.exec('ALTER TABLE accounts ADD COLUMN group_name TEXT');
  if (!names.has('device_gen')) db.exec('ALTER TABLE accounts ADD COLUMN device_gen INTEGER DEFAULT 0');
  if (!names.has('auth_client_id')) db.exec('ALTER TABLE accounts ADD COLUMN auth_client_id TEXT');
  if (!names.has('auth_host')) db.exec('ALTER TABLE accounts ADD COLUMN auth_host TEXT');
  if (!names.has('cost_tier')) db.exec('ALTER TABLE accounts ADD COLUMN cost_tier INTEGER DEFAULT 1');
  // 模型级冷却（P0：6004 类模型限流只冷 (账号,模型)；rateStreak/modelCoolStreak 供指数退避计数）
  if (!names.has('model_cooldowns')) db.exec('ALTER TABLE accounts ADD COLUMN model_cooldowns TEXT');
  if (!names.has('rate_streak')) db.exec('ALTER TABLE accounts ADD COLUMN rate_streak INTEGER DEFAULT 0');
  if (!names.has('model_cool_streak')) db.exec('ALTER TABLE accounts ADD COLUMN model_cool_streak INTEGER DEFAULT 0');
  // 积分快照历史（差分计算消耗；上游不提供单次调用积分粒度）
  db.exec('CREATE TABLE IF NOT EXISTS credit_history (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, ts TEXT NOT NULL, remaining REAL, used_total REAL, source TEXT)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_credit_history_acct_ts ON credit_history(account_id, ts)');
  // ZCode 运营面（仅 zcode 账号使用，其它平台为 NULL，零影响）：
  //   api_key_enc   — 回退通道凭据（api.z.ai / open.bigmodel 的 key）
  //   fingerprint   — 成套桌面设备档案 JSON（zcode/fingerprint.js）
  //   mode          — 账号类型：jwt（Coding/Start Plan）| apiKey
  if (!names.has('api_key_enc')) db.exec('ALTER TABLE accounts ADD COLUMN api_key_enc TEXT');
  if (!names.has('fingerprint')) db.exec('ALTER TABLE accounts ADD COLUMN fingerprint TEXT');
  if (!names.has('mode')) db.exec("ALTER TABLE accounts ADD COLUMN mode TEXT");
  // 转发面 API Key：必须绑定平台（trae|workbuddy），废弃无平台语义
  // kind: 'access'（转发访问密钥）| 'login'（管理面板登录密钥）
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id         TEXT PRIMARY KEY,
      label      TEXT,
      kind       TEXT NOT NULL DEFAULT 'access',
      platform   TEXT,
      key_hash   TEXT NOT NULL UNIQUE,
      key_enc    TEXT,
      enabled    INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)');
  // 兼容旧库：先补 kind 列，再建 kind 索引
  const keyCols = db.prepare('PRAGMA table_info(api_keys)').all();
  const keyNames = new Set(keyCols.map((c) => c.name));
  if (!keyNames.has('kind')) db.exec("ALTER TABLE api_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'access'");
  if (!keyNames.has('key_enc')) db.exec('ALTER TABLE api_keys ADD COLUMN key_enc TEXT');
  // 旧库 platform 为 NOT NULL：重建为可空（login key 无平台）
  const platformCol = keyCols.find((c) => c.name === 'platform');
  if (platformCol && platformCol.notnull) {
    // 整段包事务：中途失败则回滚，避免停在「api_keys_old 存在、api_keys 缺失」的半迁移坏库状态
    db.exec('BEGIN');
    try {
      // 索引随 rename 指向旧表，先删除，重建后再统一恢复
      db.exec('DROP INDEX IF EXISTS idx_api_keys_hash');
      db.exec('DROP INDEX IF EXISTS idx_api_keys_kind');
      db.exec(`
        ALTER TABLE api_keys RENAME TO api_keys_old;
        CREATE TABLE api_keys (
          id         TEXT PRIMARY KEY,
          label      TEXT,
          kind       TEXT NOT NULL DEFAULT 'access',
          platform   TEXT,
          key_hash   TEXT NOT NULL UNIQUE,
          key_enc    TEXT,
          enabled    INTEGER DEFAULT 1,
          created_at TEXT NOT NULL,
          last_used_at TEXT
        );
        INSERT INTO api_keys (id, label, kind, platform, key_hash, key_enc, enabled, created_at, last_used_at)
          SELECT id, label, COALESCE(kind, 'access'), platform, key_hash, key_enc, enabled, created_at, last_used_at FROM api_keys_old;
        DROP TABLE api_keys_old;
      `);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 回滚失败交由上层记录 */ }
      throw new Error(`api_keys 重建迁移失败，已回滚：${e.message}`);
    }
  }
  // 重建后重读 schema，确保索引建在迁移后的最新表结构上
  const finalCols = new Set(db.prepare('PRAGMA table_info(api_keys)').all().map((c) => c.name));
  db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)');
  if (finalCols.has('kind')) db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_kind ON api_keys(kind)');
  // 密钥生命周期 / scope ACL（P1）：可选列，旧库平滑 ALTER
  if (!finalCols.has('scopes')) db.exec('ALTER TABLE api_keys ADD COLUMN scopes TEXT');
  if (!finalCols.has('resources')) db.exec('ALTER TABLE api_keys ADD COLUMN resources TEXT');
  if (!finalCols.has('expires_at')) db.exec('ALTER TABLE api_keys ADD COLUMN expires_at TEXT');
  if (!finalCols.has('revoked_at')) db.exec('ALTER TABLE api_keys ADD COLUMN revoked_at TEXT');
  if (!finalCols.has('rotated_from')) db.exec('ALTER TABLE api_keys ADD COLUMN rotated_from TEXT');
  if (!finalCols.has('rpm_limit')) db.exec('ALTER TABLE api_keys ADD COLUMN rpm_limit INTEGER');
  if (!finalCols.has('key_type')) db.exec("ALTER TABLE api_keys ADD COLUMN key_type TEXT DEFAULT 'dedicated'");
  // 审计日志表（P1）
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      request_id TEXT,
      action TEXT NOT NULL,
      actor_key_id TEXT,
      resource TEXT,
      result TEXT NOT NULL,
      reason TEXT,
      client_ip TEXT,
      user_agent TEXT,
      meta TEXT
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_key_id)');
  // 模型目录元数据（P0）
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_models (
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT,
      version TEXT,
      fingerprint TEXT,
      capabilities TEXT,
      limits TEXT,
      rate REAL,
      lifecycle TEXT DEFAULT 'available',
      source TEXT DEFAULT 'remote',
      discovered_at TEXT,
      updated_at TEXT,
      last_verified_at TEXT,
      PRIMARY KEY (provider_id, model_id)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_sync_state (
      provider_id TEXT PRIMARY KEY,
      cursor TEXT,
      etag TEXT,
      upstream_version TEXT,
      last_sync_at TEXT,
      last_ok_at TEXT,
      last_error TEXT,
      status TEXT DEFAULT 'idle',
      partial INTEGER DEFAULT 0
    );
  `);
}

function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_FILE()), { recursive: true });
  _db = new DatabaseSync(DB_FILE());
  // n-14：单连接架构下管理面长查询与转发写入并发时可能偶发 SQLITE_BUSY，
  // 显式设置 busy_timeout（5s）让短锁等待而非直接抛错。
  try { _db.exec('PRAGMA busy_timeout = 5000'); } catch { /* 老版本不支持时忽略 */ }
  ensureSchema(_db);
  return _db;
}

/** 将数据库密文行还原为账号对象（解密敏感字段）。 */
function rowToAcct(r) {
  return {
    id: r.id,
    label: r.label,
    edition: r.edition,
    expiredAt: r.expired_at,
    refreshExpiredAt: r.refresh_expired_at,
    tokenReleaseAt: r.token_release_at,
    userId: r.user_id,
    host: r.host,
    userRegion: r.user_region,
    devices: r.devices ? JSON.parse(r.devices) : null,
    fingerprint: parseSnapshot(r.fingerprint),
    mode: r.mode || null,
    source: r.source,
    enabled: !!r.enabled,
    balance: r.balance,
    errorCount: r.error_count,
    coolUntil: r.cool_until,
    lastPickedAt: r.last_picked_at,
    lastCheckinAt: r.last_checkin_at,
    lastCheckinResult: r.last_checkin_result,
    entitlementSnapshot: parseSnapshot(r.entitlement_snapshot),
  };
}

function parseSnapshot(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

module.exports = { db, rowToAcct, DB_FILE };