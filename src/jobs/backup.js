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

const STATE_FILE = () => process.env.BACKUP_STATE_FILE
  ? path.resolve(process.env.BACKUP_STATE_FILE)
  : stateFile('backup-state.json');
const readStateFile = () => (process.env.BACKUP_STATE_FILE
  ? path.resolve(process.env.BACKUP_STATE_FILE)
  : resolveStateFileForRead('backup-state.json', fs.existsSync));
const DEFAULT_DIR = () => path.join(config.ROOT, 'backups');

const DEFAULTS = {
  enabled: false,
  dir: null,
  keep: 5,
  intervalHours: 24,
};

function defaultDir() {
  return path.join(config.ROOT, 'backups');
}

function clampKeep(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.min(Math.max(Math.round(v), 1), 50);
}

function clampHours(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.min(Math.max(Math.round(v), 1), 168);
}

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
  const st = readState();
  const envEnabled = process.env.BACKUP_ENABLED != null
    ? process.env.BACKUP_ENABLED !== 'false' && process.env.BACKUP_ENABLED !== '0'
    : null;
  let enabled = st.enabled;
  if (enabled == null) enabled = envEnabled != null ? envEnabled : DEFAULTS.enabled;
  const dir = st.dir && String(st.dir).trim() ? path.resolve(String(st.dir).trim()) : (process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : defaultDir());
  let keep = st.keep != null && st.keep !== '' ? st.keep : process.env.BACKUP_KEEP;
  let keepN = keep != null && keep !== '' ? clampKeep(keep) : null;
  if (keepN == null) keepN = DEFAULTS.keep;
  let hours = st.intervalHours != null && st.intervalHours !== '' ? st.intervalHours : process.env.BACKUP_INTERVAL_HOURS;
  let hoursN = hours != null && hours !== '' ? clampHours(hours) : null;
  if (hoursN == null) hoursN = DEFAULTS.intervalHours;
  return { enabled: !!enabled, dir, keep: keepN, intervalHours: hoursN };
}

function save(partial) {
  const st = readState();
  if (typeof partial.enabled === 'boolean') st.enabled = partial.enabled;
  if (partial.dir != null && String(partial.dir).trim() !== '') st.dir = String(partial.dir).trim();
  if (partial.keep != null && partial.keep !== '') {
    const n = clampKeep(partial.keep);
    if (n != null) st.keep = n;
  }
  if (partial.intervalHours != null && partial.intervalHours !== '') {
    const n = clampHours(partial.intervalHours);
    if (n != null) st.intervalHours = n;
  }
  writeState(st);
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
  pruneBackups,
  backupKey,
  start,
  stop,
  restart,
  snapshot,
  STATE_FILE,
};
