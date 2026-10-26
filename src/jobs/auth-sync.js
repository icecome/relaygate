'use strict';
/**
 * jobs/auth-sync.js — WorkBuddy 客户端凭据自动同步（登录/续期 → 账号池）。
 *
 * 为什么要它：
 *   - 客户端把 token 加密成 {$wbEncrypted} 信封；refreshToken **单次使用**，
 *     每次续期换发新的、旧的立即作废。
 *   - 用户在客户端重新登录，或客户端自己续期后，池里的副本立刻变旧。
 *     拿旧 refreshToken 去轮换 → 续期 401 → 客户端强制续期失败 → 自动登出
 *     删凭据（2026-10-26 实测踩过，表现为「切过去就被登出」）。
 *   - 所以必须有人盯着 auth 文件：一变就解密、回写池子，把人工的
 *     「登出脚本 → 登录 → 解密 → 导入」四步压成零步。
 *
 * 机制（轻量）：每 N 秒只比较 auth 文件的 mtime+size；变化时才解密。
 * 解密需要本机 at-rest 密钥（config.wbAtRestKey，来自 .env 的 WB_ATREST_KEY）。
 * 明文种子/明文会话也兼容（客户端未启用字段加密时）。
 *
 * 安全：token 只在内存中过手，落库仍走 credentials/store 的加密列。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const store = require('../credentials/store');

const GE = { file: 'WBEF1', field: 'WBEV1', record: 'WBER1', stream: 'WBES1' };
const FRAMING_ID = { file: 1, field: 2, record: 3, stream: 4 };
const u32 = (n) => { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(n); return b; };
const lp = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]); };
function aad(framing, suite, keyId) {
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'), Buffer.from([1]), lp(GE[framing]), lp('sym-v1'),
    u32(suite), lp(keyId), Buffer.from([FRAMING_ID[framing]]), Buffer.from([0]), Buffer.from([0]),
  ]);
}

/** 解一个 {$wbEncrypted} 字段；非加密字段原样返回字符串。 */
function decryptValue(v, key) {
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object' || v.$wbEncrypted == null) return null;
  if (!key || key.length !== 32) return null;
  try {
    const env = JSON.parse(Buffer.from(v.envelope, 'base64').toString('utf8'));
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonce, 'base64'), { authTagLength: 16 });
    d.setAAD(aad('field', env.suite, env.keyId));
    d.setAuthTag(Buffer.from(env.authTag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(env.ciphertext, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

function authDir() {
  return process.env.WB_AUTH_DIR || path.join(process.env.LOCALAPPDATA || '', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
}

/** 已处理文件的指纹（mtimeMs:size），避免重复解密。 */
let lastFingerprint = null;

/**
 * 执行一次同步。返回 {updated, uid?, label?, reason?}。
 * 无变化、无密钥、已登出、文件不可读等情况一律安静返回，不抛错。
 */
function syncOnce(opts = {}) {
  if (!config.wbAuthSyncEnabled) return { updated: false, reason: 'disabled' };
  const dir = authDir();
  const file = path.join(dir, 'workbuddy-desktop.info');
  // 登出标记存在 → 客户端处于未登录态，别把残留文件当会话。
  if (fs.existsSync(path.join(dir, 'workbuddy-desktop.info.logged-out'))) return { updated: false, reason: 'logged_out' };
  let st;
  try { st = fs.statSync(file); } catch { return { updated: false, reason: 'no_auth_file' }; }
  const fp = `${st.mtimeMs}:${st.size}`;
  if (fp === lastFingerprint && !opts.force) return { updated: false, reason: 'unchanged' };

  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { updated: false, reason: 'parse_failed' }; }
  const uid = raw.account && raw.account.uid;
  if (!uid) return { updated: false, reason: 'no_uid' };

  const key = Buffer.from(config.wbAtRestKey || '', 'base64');
  const token = decryptValue(raw.auth && raw.auth.accessToken, key);
  const refresh = decryptValue(raw.auth && raw.auth.refreshToken, key);
  if (!token) {
    // 解不出来（多半是缺 WB_ATREST_KEY）：记指纹前先不标记，等配置补上再试
    return { updated: false, reason: 'cannot_decrypt', uid };
  }

  const acct = store.list().find((a) => a.edition === 'workbuddy' && a.userId === uid);
  if (!acct) return { updated: false, reason: 'not_in_pool', uid };

  // 与池内现值相同则跳过（避免每次 mtime 抖动都写库）
  const full = store.get(acct.id) || {};
  if (full.token === token && (!refresh || full.refreshToken === refresh)) {
    lastFingerprint = fp;
    return { updated: false, reason: 'same_as_pool', uid, label: acct.label };
  }

  const expiresIn = Number(raw.auth && raw.auth.expiresIn) || 0;
  try {
    store.update(acct.id, {
      token,
      ...(refresh ? { refreshToken: refresh } : {}),
      ...(expiresIn > 0 ? { expiredAt: new Date(Date.now() + expiresIn * 1000).toISOString() } : {}),
      lastRefreshAt: new Date().toISOString(),
      errorCount: 0,
      coolUntil: 0,
      enabled: true,
    });
  } catch (e) {
    return { updated: false, reason: 'write_failed: ' + String(e.message || e).slice(0, 60), uid };
  }
  lastFingerprint = fp;
  return { updated: true, uid, label: acct.label, tokenLen: token.length, refreshLen: refresh ? refresh.length : 0 };
}

/**
 * 启动周期任务（由 scheduler.start 调用）。只做 mtime 比较，开销可忽略。
 * @returns {boolean} 是否启用
 */
function start(intervalSec) {
  if (!config.wbAuthSyncEnabled) { console.log('[auth-sync] disabled (WB_AUTH_SYNC=false)'); return false; }
  if (!config.wbAtRestKey) { console.log('[auth-sync] 未配置 WB_ATREST_KEY，跳过（客户端凭据为加密存储时无法同步）'); return false; }
  const sec = Number(intervalSec) > 0 ? Number(intervalSec) : (config.wbAuthSyncIntervalSec || 60);
  const tick = () => {
    try {
      const r = syncOnce();
      if (r && r.updated) console.log(`[auth-sync] 已同步客户端凭据 ${r.label || r.uid || ''}（token=${r.tokenLen}B refresh=${r.refreshLen}B）`);
    } catch (e) { console.error('[auth-sync] 同步失败:', String(e.message || e).slice(0, 120)); }
  };
  // 启动后先跑一次（承接用户上次登录留下的新 token）
  setTimeout(tick, 3000).unref?.();
  const t = setInterval(tick, sec * 1000);
  t.unref?.();
  console.log(`[auth-sync] 客户端凭据自动同步已启用（每 ${sec}s 检查一次）`);
  return true;
}

module.exports = { syncOnce, start, decryptValue, authDir };
