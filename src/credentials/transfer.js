'use strict';
/**
 * credentials/transfer.js —— 账号加密导出 / 导入（跨机迁移）。
 *
 * 对标 WorkDaddy 的 `/api/accounts/export` / `/api/accounts/import`（v3 信封），
 * 适配 RelayGate 的存储形态（SQLite accounts 表 + AES-256-GCM 列级密文）。
 *
 * 关键设计：**密文不可跨机**。
 *   本机库里的 token_enc 是用本机 TRAE_API_ENCRYPT_KEY 加密的；把它原样导出，
 *   换一台机器（密钥不同）必然解不开。因此导出时先用本机密钥解密成明文，
 *   再装进「用户密码 + 随机 salt 派生」的 AES-256-GCM 信封里；导入时再用
 *   目标机器自己的密钥重新加密落库。
 *   → 导出文件只被用户密码保护，不依赖任何一台机器的本地密钥。
 *
 * 信封格式（v3）：
 *   { rgExport:'RelayGate', version:3, exportType:'relaygate-accounts',
 *     createdAt, kdf:'aes-256-gcm+scrypt', compression:'gzip',
 *     salt(base64 16B), data(base64: iv12 | tag16 | gzip(明文 JSON)) }
 *   密码永不写入文件；每次导出随机 salt；gzip 在加密之前做（密文可压缩）。
 *
 * 范围：默认全部账号，可用 uids 选择；**只导账号，不导访问密钥**
 *   （访问密钥绑定本机密钥与审计，跨机搬等于搬走门禁，刻意排除）。
 *
 * 导入去重：按 user_id（上游账号 uid）。已有同 uid 账号则更新凭据与元数据，
 *   不存在则新建；导入一律 enabled=false，待目标机 verify 通过后再启用
 *   （与「粘贴导入」的既有口径一致）。
 */
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const store = require('./store');

const EXPORT_VERSION = 3;
const EXPORT_KIND = 'relaygate-accounts';
const EXPORT_KDF = 'aes-256-gcm+scrypt';
const EXPORT_COMPRESSION = 'gzip';
const MAX_PASSWORD_LENGTH = 1024;
/** 密码下限：与前端口径一致（前端拦 <4），避免「UI 过不了、直连 API 能过」。 */
const MIN_PASSWORD_LENGTH = 4;
const MAX_ITEMS = 2000;

/**
 * 用户输入类错误：路由据此回 400，其余（SQLite 写失败等）回 500。
 * 用 `err.code` 而不是消息文本正则分类——文本是活文案，改一个字分类就错。
 */
class TransferInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransferInputError';
    this.code = 'TRANSFER_INPUT_INVALID';
    this.status = 400;
  }
}

function requiredPassword(value) {
  const password = typeof value === 'string' ? value : '';
  if (!password.trim()) throw new TransferInputError('密码不能为空');
  if (password.length > MAX_PASSWORD_LENGTH) throw new TransferInputError(`密码不能超过 ${MAX_PASSWORD_LENGTH} 个字符`);
  if (password.length < MIN_PASSWORD_LENGTH) throw new TransferInputError(`密码至少 ${MIN_PASSWORD_LENGTH} 个字符`);
  return password;
}

function scryptKey(password, salt) {
  return crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
}

/** 打包加密导出（v3）：gzip → AES-256-GCM（随机 salt 派生密钥）→ JSON 信封字符串。 */
function createEncryptedExport(kind, payload, password) {
  if (kind !== EXPORT_KIND) throw new TransferInputError('无效的导出类型');
  if (!payload || typeof payload !== 'object' || payload.exportType !== 'RelayGate-' + kind) {
    throw new TransferInputError('导出数据类型不匹配');
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const cipher = crypto.createCipheriv('aes-256-gcm', scryptKey(password, salt), iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return JSON.stringify({
    rgExport: 'RelayGate',
    version: EXPORT_VERSION,
    exportType: kind,
    createdAt: new Date().toISOString(),
    kdf: EXPORT_KDF,
    compression: EXPORT_COMPRESSION,
    salt: salt.toString('base64'),
    data: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64'),
  });
}

/** 解开 v3 信封。错误信息区分「密码错误」与「文件损坏」，供前端直接展示。 */
function openEncryptedExport(content, expectedKind, password) {
  if (expectedKind !== EXPORT_KIND) throw new TransferInputError('无效的导出类型');
  let envelope;
  try { envelope = JSON.parse(String(content || '')); }
  catch (_) { throw new TransferInputError('文件不是有效的导出 JSON'); }
  if (!envelope || envelope.rgExport !== 'RelayGate') {
    throw new TransferInputError('不是 RelayGate 的账号导出文件');
  }
  if (Number(envelope.version) !== EXPORT_VERSION) {
    throw new TransferInputError(`导出文件版本不受支持（v${envelope.version}，本机支持 v${EXPORT_VERSION}）`);
  }
  if (envelope.exportType && envelope.exportType !== expectedKind) {
    throw new TransferInputError('导出文件类型不匹配');
  }
  const salt = Buffer.from(String(envelope.salt || ''), 'base64');
  if (salt.length !== 16) throw new TransferInputError('导出文件缺少有效的加密 salt');
  const packed = Buffer.from(String(envelope.data || ''), 'base64');
  if (packed.length <= 28) throw new TransferInputError('导出数据不完整或已损坏');
  let compressed;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', scryptKey(requiredPassword(password), salt), packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    compressed = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);
  } catch (_) {
    throw new TransferInputError('密码错误或导出文件已损坏');
  }
  let payload;
  try {
    payload = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
  } catch (_) {
    throw new TransferInputError('导出数据无法解析或已损坏');
  }
  if (!payload || payload.exportType !== 'RelayGate-' + expectedKind) throw new TransferInputError('导出文件类型不匹配');
  return payload;
}

/**
 * 收集账号导出项（明文凭据，仅存在于内存与加密信封内）。
 * store.get() 返回解密后的字段；这些明文不会落到任何磁盘明文文件。
 */
function exportAccounts(wids) {
  const wanted = wids && wids.size ? new Set([...wids].map(String)) : null;
  const items = [];
  for (const summary of store.list()) {
    if (wanted && !wanted.has(String(summary.id))) continue;
    const full = store.get(summary.id) || summary;
    if (!full.token && !full.refreshToken && !full.apiKey) continue;
    items.push({
      label: full.label || null,
      edition: full.edition || null,
      token: full.token || null,
      refreshToken: full.refreshToken || null,
      apiKey: full.apiKey || null,
      expiredAt: full.expiredAt || null,
      refreshExpiredAt: full.refreshExpiredAt || null,
      tokenReleaseAt: full.tokenReleaseAt || null,
      userId: full.userId || null,
      host: full.host || null,
      userRegion: full.userRegion || null,
      devices: full.devices || null,
      fingerprint: full.fingerprint || null,
      mode: full.mode || null,
      source: full.source || null,
      balance: full.balance == null ? null : Number(full.balance),
      group: full.group || null,
      priority: Number(full.priority) || 0,
      tags: full.tags || null,
      authClientId: full.authClientId || null,
      authHost: full.authHost || null,
      qoderRealm: full.qoderRealm || null,
      raccoonOrg: full.raccoonOrg || null,
      raccoonNationCode: full.raccoonNationCode || null,
      entitlementSnapshot: full.entitlementSnapshot || null,
    });
  }
  return items;
}

/**
 * 生成导出信封。
 * @param {string} password 用户密码（信封密钥派生材料，不写入文件）
 * @param {string[]} [accountIds] 按**账号表 id** 选择范围。
 *   参数名此前叫 uids，但它过滤的是 account id 而不是上游 userId，
 *   与导入去重用的 userId 是两个概念 —— 改名并保留旧语义注释。
 * @returns {{filename:string, content:string, count:number}}
 */
function buildExport(password, accountIds) {
  const checked = requiredPassword(password);
  let wanted = null;
  if (accountIds !== undefined && accountIds !== null) {
    if (!Array.isArray(accountIds)) throw new TransferInputError('账号选择必须是数组');
    if (accountIds.length > MAX_ITEMS) throw new TransferInputError('选择的账号过多');
    wanted = new Set(accountIds.map((u) => String(u || '').trim()).filter(Boolean));
    if (!wanted.size) throw new TransferInputError('请至少选择一个账号');
  }
  const items = exportAccounts(wanted);
  if (!items.length) throw new TransferInputError('没有可导出的账号');
  const payload = { exportType: 'RelayGate-' + EXPORT_KIND, version: EXPORT_VERSION, accounts: items };
  const content = createEncryptedExport(EXPORT_KIND, payload, checked);
  const filename = 'RelayGate-账号导出-' + new Date().toISOString().slice(0, 10) + '.json';
  return { filename, content, count: items.length };
}

const VALID_UID = /^[A-Za-z0-9_-]{1,128}$/;

/** 校验导入的账号行：uid 形态 + 至少一份凭据。uid 来自用户上传的文件，必须先过形态闸。 */
function validateImportRow(row) {
  if (!row || typeof row !== 'object') return null;
  const uid = String(row.userId || '').trim();
  if (!uid || !VALID_UID.test(uid)) return null;
  if (!row.token && !row.refreshToken && !row.apiKey) return null;
  return row;
}

/**
 * 导入账号：按 userId 去重；已有则更新凭据与元数据，不存在则新建（默认禁用）。
 * @returns {{imported:string[], updated:string[], skipped:number, total:number}}
 */
function importAccounts(content, password) {
  const payload = openEncryptedExport(content, EXPORT_KIND, requiredPassword(password));
  const list = Array.isArray(payload && payload.accounts) ? payload.accounts : [];
  if (!list.length) throw new TransferInputError('导入文件中没有账号数据');
  if (list.length > MAX_ITEMS) throw new TransferInputError('导入文件账号数超限');

  const imported = [];
  const updated = [];
  let skipped = 0;
  for (const raw of list) {
    const row = validateImportRow(raw);
    if (!row) { skipped += 1; continue; }
    const uid = row.userId;
    const patch = {
      label: row.label || ('acct-' + uid.slice(-6)),
      edition: row.edition || 'workbuddy',
      token: row.token || null,
      refreshToken: row.refreshToken || null,
      apiKey: row.apiKey || null,
      expiredAt: row.expiredAt || null,
      refreshExpiredAt: row.refreshExpiredAt || null,
      tokenReleaseAt: row.tokenReleaseAt || null,
      userId: uid,
      host: row.host || null,
      userRegion: row.userRegion || null,
      devices: row.devices || null,
      fingerprint: row.fingerprint || null,
      mode: row.mode || null,
      source: row.source || 'import',
      // 导入一律禁用，待目标机器 verify 通过后再启用（与粘贴导入口径一致）
      enabled: false,
      balance: row.balance == null ? null : Number(row.balance),
      group: row.group || null,
      priority: Number(row.priority) || 0,
      tags: row.tags || null,
      authClientId: row.authClientId || null,
      authHost: row.authHost || null,
      qoderRealm: row.qoderRealm || null,
      raccoonOrg: row.raccoonOrg || null,
      raccoonNationCode: row.raccoonNationCode || null,
      entitlementSnapshot: row.entitlementSnapshot || null,
    };
    const existing = store.list().find((a) => String(a.userId) === uid);
    if (existing) {
      store.update(existing.id, patch);
      updated.push(existing.id);
    } else {
      // 不传 source 参数：store.add(cred, source) 里 source 的优先级高于
      // cred.source（`source || cred.source || 'import'`）。此前固定传
      // 'workbuddy'，于是**任何平台**的新建账号都被标成 workbuddy —— 与
      // 更新分支保留 row.source 的行为不一致，字段被静默污染。
      // patch.source 已带 row.source（缺省 'import'），由 store 自己取。
      const acct = store.add(patch);
      imported.push(acct.id);
    }
  }
  return { imported, updated, skipped, total: list.length };
}

module.exports = {
  EXPORT_VERSION,
  EXPORT_KIND,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  MAX_ITEMS,
  TransferInputError,
  buildExport,
  importAccounts,
  openEncryptedExport,
  createEncryptedExport,
  requiredPassword,
  validateImportRow,
};
