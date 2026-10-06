'use strict';
/**
 * jobs/backup.js — 系统全量备份（可配存储路径 + 进度回调 + 完成通知 + 校验和）。
 *
 * 备份内容：
 *   - accounts 表全量（密文 token，AES-256-GCM，绝不含明文凭据）
 *   - api_keys 表（哈希 + 密文）
 *   - credit_history 表
 *   - 非敏感配置：.trae-api/scheduler-settings.json、notify-settings.json（渠道密钥仅密文? 否——
 *     notify-settings.json 含 webhook 密钥，按「敏感文件」处理，仅在有加密密钥时纳入备份）
 *   - model-config.json / model-fallback.json（只读配置，不含密钥）
 * 加密：密钥由环境变量 TRAE_BACKUP_PASSPHRASE 或自动生成持久化密钥（.trae-api/backup.key）；
 *       生成 sha256 校验和附于 manifest。
 *
 * 备份为单文件 JSON（含加密桶），原子写入：先写 .tmp 再 rename。
 * 进度通过 onProgress 回调（阶段 + 计数），供面板展示；完成通过 notify('backup_done'/'backup_failed')。
 */
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const config = require('../config');
const { db } = require('../credentials/db');
const { notify } = require('../notify');
const { appendTaskLog } = require('./task-log');
const { writeFileAtomic, writeJsonAtomic } = require('../lib/atomic-write');
const { stateFile, resolveStateFileForRead } = require('../lib/paths');
const { createSettingsStore } = require('../lib/settings-store');

const STATE_NAME = 'backup-state.json';
const fromEnvState = () => (process.env.BACKUP_STATE_FILE || '').trim();
const STATE_FILE = () => (fromEnvState() ? path.resolve(fromEnvState()) : stateFile(STATE_NAME));
const readStateFile = () =>
  (fromEnvState() ? path.resolve(fromEnvState()) : resolveStateFileForRead(STATE_NAME, fs.existsSync));

function defaultDir() {
  return path.join(config.ROOT, 'backups');
}

const SETTINGS_SPECS = {
  enabled: { type: 'bool', env: 'BACKUP_ENABLED', default: false },
  // dir 为路径字符串，空值不回落 env（env 已单独处理），且 keep 在 save 时接受空串
  dir: { env: 'BACKUP_DIR', default: '', saveEmpty: false, transform: (s) => path.resolve(s) },
  keep: { env: 'BACKUP_KEEP', default: 5, min: 1, max: 50 },
  intervalHours: { env: 'BACKUP_INTERVAL_HOURS', default: 24, min: 1, max: 168 },
};

const settings = createSettingsStore({
  name: STATE_NAME,
  specs: SETTINGS_SPECS,
  fileOf: STATE_FILE,
  readFileOf: readStateFile,
});

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(readStateFile(), 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeState(patch) {
  const st = { ...readState(), ...patch, updatedAt: new Date().toISOString() };
  writeJsonAtomic(STATE_FILE(), st);
  return st;
}

/** 生效配置：文件 > env > 默认。 */
function getEffective() {
  const eff = settings.getEffective();
  // dir 缺省回落到默认目录（非 env，已在 spec 内处理）；文件与 env 皆空时取默认目录
  const dir = eff.dir && String(eff.dir).trim()
    ? path.resolve(String(eff.dir).trim())
    : (process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : defaultDir());
  return { ...eff, dir };
}

function save(partial) {
  const st = settings.save(partial);
  return getEffective();
}

/** 备份加密密钥：环境变量优先，否则读取/生成持久化 backup.key。 */
function backupKey() {
  const fromEnv = process.env.TRAE_BACKUP_PASSPHRASE;
  if (fromEnv && String(fromEnv).length >= 16) return fromEnv;
  // 回退旧位置：backup.key 变更会导致历史备份无法解密，必须优先复用已存在的密钥
  const file = fs.existsSync(stateFile('backup.key'))
    ? stateFile('backup.key')
    : resolveStateFileForRead('backup.key', fs.existsSync);
  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, 'utf-8').trim();
      if (existing) {
        if (file !== stateFile('backup.key')) writeFileAtomic(stateFile('backup.key'), existing);
        return existing;
      }
    }
    const key = nodeCrypto.randomBytes(32).toString('hex');
    if (!writeFileAtomic(stateFile('backup.key'), key)) throw new Error('write failed');
    return key;
  } catch (e) {
    throw new Error(`无法获取备份密钥（建议设置 TRAE_BACKUP_PASSPHRASE，或修复 .trae-api/backup.key 可写）: ${e.message}`);
  }
}

function encryptPayload(obj, key) {
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', nodeCrypto.createHash('sha256').update(key, 'utf8').digest(), iv);
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64'),
  };
}

function checksumOf(text) {
  return nodeCrypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 收集备份内容（纯数据，不触碰文件系统副作用）。 */
function collectBackupPayload() {
  const accounts = db().prepare('SELECT * FROM accounts').all();
  const apiKeys = db().prepare('SELECT * FROM api_keys').all();
  const creditHistory = db().prepare('SELECT * FROM credit_history').all();

  const readJsonIfExists = (p) => {
    try {
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
      return null;
    }
  };

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    accounts: accounts.map((r) => ({
      id: r.id, label: r.label, edition: r.edition,
      token_enc: r.token_enc, refresh_token_enc: r.refresh_token_enc,
      expired_at: r.expired_at, refresh_expired_at: r.refresh_expired_at,
      token_release_at: r.token_release_at, user_id: r.user_id, host: r.host,
      user_region: r.user_region, devices: r.devices, source: r.source,
      enabled: r.enabled, balance: r.balance, error_count: r.error_count,
      cool_until: r.cool_until, last_picked_at: r.last_picked_at,
      last_checkin_at: r.last_checkin_at, last_checkin_result: r.last_checkin_result,
      entitlement_snapshot: r.entitlement_snapshot, priority: r.priority,
      tags: r.tags, group_name: r.group_name, device_gen: r.device_gen,
      auth_client_id: r.auth_client_id, auth_host: r.auth_host, cost_tier: r.cost_tier,
    })),
    api_keys: apiKeys.map((r) => ({
      id: r.id, label: r.label, kind: r.kind, platform: r.platform,
      key_hash: r.key_hash, key_enc: r.key_enc, enabled: r.enabled,
      created_at: r.created_at, last_used_at: r.last_used_at,
    })),
    credit_history: creditHistory.map((r) => ({
      id: r.id, account_id: r.account_id, ts: r.ts,
      remaining: r.remaining, used_total: r.used_total, source: r.source,
    })),
    config: {
      scheduler: readJsonIfExists(resolveStateFileForRead('scheduler-settings.json', fs.existsSync)),
      growthLastRun: readJsonIfExists(resolveStateFileForRead('growth-last-run.json', fs.existsSync)),
      modelConfig: readJsonIfExists(path.join(config.ROOT, 'model-config.json')),
      modelFallback: readJsonIfExists(path.join(config.ROOT, 'model-fallback.json')),
    },
    // notify-settings.json 含 webhook 密钥：纳入加密桶（不单独出明文）
    notifySettings: readJsonIfExists(resolveStateFileForRead('notify-settings.json', fs.existsSync)),
    balanceRefresh: readJsonIfExists(resolveStateFileForRead('balance-refresh-settings.json', fs.existsSync)),
  };
}

let running = false;
const state = {
  lastBackupAt: null,
  lastBackupFile: null,
  lastBackupOk: null,
  lastError: null,
  running: false,
};

/** 立即执行一次备份。@param {object} [opts] {trigger:'manual'|'timer', onProgress?:Function, skipNotify?:boolean} */
async function runBackup(opts = {}) {
  if (running) return { skipped: true, running: true };
  running = true;
  state.running = true;
  const trigger = opts.trigger || 'manual';
  const onProgress = opts.onProgress || (() => {});
  const startedAt = new Date().toISOString();
  let result = null;
  try {
    const eff = getEffective();
    onProgress({ stage: 'collect', detail: '收集账号与配置' });
    const payload = collectBackupPayload();
    const key = backupKey();
    onProgress({ stage: 'encrypt', detail: `加密 ${payload.accounts.length} 账号 / ${payload.api_keys.length} 密钥` });
    const enc = encryptPayload(payload, key);

    const dir = eff.dir;
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `relay-backup-${stamp}.json`);
    const manifest = {
      object: 'relay_gate_backup',
      version: 1,
      createdAt: payload.createdAt,
      engine: 'node:' + process.version,
      checksum: checksumOf(enc.data),
      encrypted: enc,
    };
    const tmp = file + '.tmp';
    writeJsonAtomic(tmp, manifest);
    fs.renameSync(tmp, file);
    onProgress({ stage: 'prune', detail: `清理旧备份（保留 ${eff.keep} 份）` });
    pruneBackups(eff.dir, eff.keep);
    onProgress({ stage: 'done', detail: file });

    result = { ok: true, file, sizeBytes: fs.statSync(file).size, checksum: manifest.checksum, accounts: payload.accounts.length, ranAt: startedAt };
    state.lastBackupAt = new Date().toISOString();
    state.lastBackupFile = file;
    state.lastBackupOk = true;
    state.lastError = null;
    writeState({ lastBackupAt: state.lastBackupAt, lastBackupFile: file, lastBackupOk: true });
    try {
      appendTaskLog({ task: 'backup', trigger, ok: 1, failed: 0, file, sizeBytes: result.sizeBytes, checksum: manifest.checksum, startedAt, finishedAt: new Date().toISOString() });
    } catch { /* ignore */ }
    if (!opts.skipNotify) {
      notify('backup_done', { message: `备份完成：${result.sizeBytes} 字节 · ${result.accounts} 个账号 · 校验和 ${manifest.checksum.slice(0, 12)}…` }, '系统备份完成').catch(() => {});
    }
    console.log(`[backup] done ${file} (${result.sizeBytes}B)`);
    return result;
  } catch (e) {
    result = { ok: false, error: e.message, ranAt: startedAt };
    state.lastError = e.message;
    state.lastBackupOk = false;
    writeState({ lastBackupAt: new Date().toISOString(), lastBackupOk: false, lastError: e.message });
    try {
      appendTaskLog({ task: 'backup', trigger, ok: 0, failed: 1, error: e.message, startedAt, finishedAt: new Date().toISOString() });
    } catch { /* ignore */ }
    if (!opts.skipNotify) {
      notify('backup_failed', { message: `备份失败：${e.message}` }, '系统备份失败').catch(() => {});
    }
    console.error(`[backup] failed: ${e.message}`);
    return result;
  } finally {
    state.lastRunAt = new Date().toISOString();
    running = false;
    state.running = false;
  }
}

function decryptPayload(enc, key) {
  const alg = (enc && enc.alg) || 'aes-256-gcm';
  if (alg !== 'aes-256-gcm') throw new Error(`不支持的加密算法: ${alg}`);
  const decipher = nodeCrypto.createDecipheriv(
    'aes-256-gcm',
    nodeCrypto.createHash('sha256').update(key, 'utf8').digest(),
    Buffer.from(String(enc.iv || ''), 'base64'),
  );
  decipher.setAuthTag(Buffer.from(String(enc.tag || ''), 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(String(enc.data || ''), 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString('utf8'));
}

/** 清理目录内旧备份，仅保留最近 keep 份（按文件名时间戳排序）。 */
function pruneBackups(dir, keep) {
  try {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir)
      .filter((f) => /^relay-backup-.*\.json$/.test(f))
      .sort()
      .reverse();
    for (const f of files.slice(keep)) {
      fs.unlinkSync(path.join(dir, f));
    }
  } catch { /* 清理失败不阻断 */ }
}

function listBackups() {
  try {
    const dir = getEffective().dir;
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => /^relay-backup-.*\.json$/.test(f))
      .map((f) => {
        const full = path.join(dir, f);
        let meta = {};
        try {
          const j = JSON.parse(fs.readFileSync(full, 'utf-8'));
          meta = { sizeBytes: j.sizeBytes, checksum: j.checksum, createdAt: j.createdAt };
        } catch { /* 读不到元数据仅显示文件级信息 */ }
        return { file: f, path: full, sizeBytes: fs.statSync(full).size, ...meta };
      })
      .sort((a, b) => String(b.createdAt || b.file).localeCompare(String(a.createdAt || a.file)));
  } catch {
    return [];
  }
}

/** 校验某备份文件的完整性（比对 manifest 内校验和与内容重算值）。 */
function verifyBackup(filePath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!manifest || !manifest.encrypted || !manifest.checksum) {
      return { ok: false, reason: '文件缺少 encrypted/checksum 字段' };
    }
    const actual = checksumOf(manifest.encrypted.data);
    return { ok: actual === manifest.checksum, reason: actual === manifest.checksum ? '校验和一致' : `校验和不一致（期望 ${manifest.checksum.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）` };
  } catch (e) {
    return { ok: false, reason: '解析失败: ' + e.message };
  }
}

/**
 * 解析并校验备份文件路径。
 * 恢复接口接收来自前端的文件路径，必须限制在配置的备份目录内，
 * 否则会成为任意文件读取入口。
 */
function resolveBackupPath(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw) throw new Error('path required');
  const dir = path.resolve(getEffective().dir);
  const full = path.resolve(raw);
  const rel = path.relative(dir, full);
  // 目录外、目录本身或非备份文件一律拒绝
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('备份文件必须位于备份目录内');
  }
  if (!/^relay-backup-.*\.json$/.test(path.basename(full))) {
    throw new Error('不是有效的备份文件名');
  }
  if (!fs.existsSync(full)) throw new Error('备份文件不存在');
  return full;
}

/** 读取并解密备份，返回 manifest 与载荷摘要（不写库）。 */
function inspectBackup(filePath) {
  const full = resolveBackupPath(filePath);
  const manifest = JSON.parse(fs.readFileSync(full, 'utf-8'));
  // 先比对校验和：密文被篡改时 GCM 解密会先抛认证失败，
  // 直接透出解密异常会掩盖「文件已损坏」这一真实结论。
  const verify = verifyBackup(full);
  let payload = null;
  let decryptError = null;
  try {
    payload = decryptPayload(manifest.encrypted, backupKey());
  } catch (e) {
    decryptError = e.message;
  }
  return {
    file: path.basename(full),
    path: full,
    createdAt: manifest.createdAt || (payload && payload.createdAt) || null,
    checksumOk: verify.ok,
    checksumReason: verify.reason,
    decryptError,
    summary: {
      accounts: ((payload && payload.accounts) || []).length,
      apiKeys: ((payload && payload.api_keys) || []).length,
      creditHistory: ((payload && payload.credit_history) || []).length,
      configKeys: Object.keys((payload && payload.config) || {}).filter(
        (k) => payload.config[k],
      ).length,
      hasNotifySettings: !!(payload && payload.notifySettings),
      hasBalanceRefresh: !!(payload && payload.balanceRefresh),
    },
  };
}

// accounts 表可恢复列白名单：与 collectBackupPayload 的输出键一致，
// 避免把任意 JSON 键拼进 SQL 列名
const ACCOUNT_COLUMNS = [
  'id', 'label', 'edition', 'token_enc', 'refresh_token_enc', 'expired_at',
  'refresh_expired_at', 'token_release_at', 'user_id', 'host', 'user_region',
  'devices', 'source', 'enabled', 'balance', 'error_count', 'cool_until',
  'last_picked_at', 'last_checkin_at', 'last_checkin_result',
  'entitlement_snapshot', 'priority', 'tags', 'group_name', 'device_gen',
  'auth_client_id', 'auth_host', 'cost_tier',
];
const API_KEY_COLUMNS = [
  'id', 'label', 'kind', 'platform', 'key_hash', 'key_enc',
  'enabled', 'created_at', 'last_used_at',
];
const CREDIT_COLUMNS = ['id', 'account_id', 'ts', 'remaining', 'used_total', 'source'];

/**
 * 从备份文件恢复数据。
 *
 * 语义：按 id 覆盖同 id 的账号与密钥（备份是全量快照），
 * credit_history 按 id 覆盖，配置文件按备份内容覆盖。
 * 默认先对当前状态做一次快照备份，便于回退。
 *
 * @param {string} filePath 备份文件路径（须位于备份目录内）
 * @param {object} [opts] {safetyBackup?:boolean}
 */
async function restoreBackup(filePath, opts = {}) {
  const info = inspectBackup(filePath);
  if (!info.checksumOk) {
    throw new Error(`备份校验不通过，已中止恢复：${info.checksumReason}`);
  }
  if (info.decryptError) {
    throw new Error(`备份解密失败，已中止恢复：${info.decryptError}`);
  }
  const manifest = JSON.parse(fs.readFileSync(info.path, 'utf-8'));
  const payload = decryptPayload(manifest.encrypted, backupKey());

  // 恢复前先快照当前状态：恢复是覆盖写，误选文件时需要回退路径
  let safetyBackup = null;
  if (opts.safetyBackup !== false) {
    safetyBackup = await runBackup({ trigger: 'restore-guard', skipNotify: true });
  }

  const database = db();
  /**
   * node:sqlite 的 DatabaseSync 没有 better-sqlite3 的 transaction()，
   * 项目内事务统一用 exec('BEGIN'/'COMMIT'/'ROLLBACK') 手写（见 credentials/db.js）。
   */
  const runInTransaction = (fn) => {
    database.exec('BEGIN');
    try {
      const out = fn();
      database.exec('COMMIT');
      return out;
    } catch (e) {
      try { database.exec('ROLLBACK'); } catch { /* 回滚失败保留原始错误 */ }
      throw e;
    }
  };

  /** 按 id 覆盖写入；columns 为可写列白名单。 */
  const upsertById = (table, columns, rows) => {
    const updatable = columns.filter((c) => c !== 'id');
    const sql = `INSERT INTO ${table} (${columns.join(',')})
      VALUES (${columns.map(() => '?').join(',')})
      ON CONFLICT(id) DO UPDATE SET ${updatable.map((c) => `${c}=excluded.${c}`).join(',')}`;
    const stmt = database.prepare(sql);
    let n = 0;
    for (const row of rows) {
      stmt.run(...columns.map((c) => (row[c] === undefined ? null : row[c])));
      n += 1;
    }
    return n;
  };

  const restoreCounts = runInTransaction(() => ({
    accounts: upsertById('accounts', ACCOUNT_COLUMNS, (payload.accounts || []).filter((r) => r && r.id)),
    apiKeys: upsertById('api_keys', API_KEY_COLUMNS, (payload.api_keys || []).filter((r) => r && r.id)),
    creditHistory: upsertById(
      'credit_history',
      CREDIT_COLUMNS,
      (payload.credit_history || []).filter((r) => r && r.id),
    ),
  }));

  const accounts = restoreCounts.accounts;
  const apiKeys = restoreCounts.apiKeys;
  const credits = restoreCounts.creditHistory;

  // 配置文件按备份内容覆盖（文件名固定，不接受外部输入）
  let configs = 0;
  const cfg = payload.config || {};
  const writeIfPresent = (name, value) => {
    if (!value || typeof value !== 'object') return;
    writeJsonAtomic(stateFile(name), value);
    configs += 1;
  };
  writeIfPresent('scheduler-settings.json', cfg.scheduler);
  writeIfPresent('growth-last-run.json', cfg.growthLastRun);
  if (cfg.modelConfig && typeof cfg.modelConfig === 'object') {
    writeJsonAtomic(path.join(config.ROOT, 'model-config.json'), cfg.modelConfig);
    configs += 1;
  }
  if (cfg.modelFallback && typeof cfg.modelFallback === 'object') {
    writeJsonAtomic(path.join(config.ROOT, 'model-fallback.json'), cfg.modelFallback);
    configs += 1;
  }
  if (payload.notifySettings && typeof payload.notifySettings === 'object') {
    writeJsonAtomic(stateFile('notify-settings.json'), payload.notifySettings);
    configs += 1;
  }
  if (payload.balanceRefresh && typeof payload.balanceRefresh === 'object') {
    writeJsonAtomic(stateFile('balance-refresh-settings.json'), payload.balanceRefresh);
    configs += 1;
  }

  const result = {
    ok: true,
    file: info.file,
    createdAt: info.createdAt,
    accounts,
    apiKeys,
    creditHistory: credits,
    configs,
    safetyBackupFile: safetyBackup && safetyBackup.ok ? safetyBackup.file : null,
  };
  try {
    appendTaskLog({
      task: 'restore', trigger: 'manual', ok: 1, failed: 0,
      file: info.file, accounts, apiKeys, startedAt: new Date().toISOString(),
    });
  } catch { /* ignore */ }
  console.log(`[backup] restored ${info.file}: accounts=${accounts} keys=${apiKeys} credits=${credits} configs=${configs}`);
  return result;
}

/** 定时器（由 index.js 驱动 start/stop）。 */
let timer = null;
function start() {
  stop();
  const eff = getEffective();
  if (!eff.enabled) {
    console.log('[backup] auto backup disabled');
    return;
  }
  const ms = Math.max(1, eff.intervalHours) * 3600 * 1000;
  // 启动后 3 分钟首跑（避开冷启动高峰）
  const first = setTimeout(async () => {
    await runBackup({ trigger: 'timer' }).catch(() => {});
    if (getEffective().enabled) {
      timer = setInterval(() => runBackup({ trigger: 'timer' }).catch(() => {}), ms);
      timer.unref?.();
    }
  }, 3 * 60 * 1000);
  first.unref?.();
  state.timer = { intervalHours: eff.intervalHours, nextRunAt: new Date(Date.now() + 3 * 60 * 1000).toISOString() };
  console.log(`[backup] auto backup every ${eff.intervalHours}h to ${eff.dir} (keep ${eff.keep}, first in 3min)`);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  state.timer = null;
}

function restart() {
  stop();
  start();
  return snapshot();
}

function snapshot() {
  return { ...getEffective(), ...state, timer: state.timer };
}

module.exports = {
  getEffective,
  save,
  runBackup,
  listBackups,
  verifyBackup,
  inspectBackup,
  restoreBackup,
  pruneBackups,
  backupKey,
  start,
  stop,
  restart,
  snapshot,
  STATE_FILE,
};
