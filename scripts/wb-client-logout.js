'use strict';
/**
 * scripts/wb-client-logout.js — 把 WorkBuddy 客户端切到「未登录」态，切之前先把
 * 当前账号的最新 token 抓回账号池（避免登出后丢掉客户端续期过的新 refreshToken）。
 *
 * 为什么需要：refreshToken 单次使用，客户端每次续期都会换发新的。若直接登出，
 * 客户端手里那份新值随文件删除而丢失，池里的旧值已经作废——下次轮换就会
 * 「续期 401 → 客户端自动登出」。
 *
 * 流程：
 *   1. 解密当前 auth 文件，把 token/refreshToken 写回池（按 uid 匹配）；
 *   2. 备份并删除 auth 主文件、写入 logged-out 标记（与客户端自身登出行为一致）；
 *   3. 重启客户端 → 停在登录页。
 *
 * 前置：.env 里要有 WB_ATREST_KEY（本机 at-rest 保护密钥，base64）。
 * 用法：node scripts/wb-client-logout.js
 *      node scripts/wb-client-logout.js --no-restart   # 只登出，不拉客户端
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const store = require('../src/credentials/store');

const AUTH_DIR = process.env.WB_AUTH_DIR || path.join(process.env.LOCALAPPDATA || '', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
const AUTH_FILE = path.join(AUTH_DIR, 'workbuddy-desktop.info');
const MARKER = path.join(AUTH_DIR, 'workbuddy-desktop.info.logged-out');
const APP = 'C:\\opt\\software\\Tencent\\WorkBuddy\\WorkBuddy.exe';

const KEY = Buffer.from(String(process.env.WB_ATREST_KEY || '').trim(), 'base64');
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
function decryptField(v) {
  if (!v || typeof v !== 'object' || v.$wbEncrypted == null) return typeof v === 'string' ? v : null;
  if (KEY.length !== 32) return null;
  try {
    const env = JSON.parse(Buffer.from(v.envelope, 'base64').toString('utf8'));
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(env.nonce, 'base64'), { authTagLength: 16 });
    d.setAAD(aad('field', env.suite, env.keyId));
    d.setAuthTag(Buffer.from(env.authTag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(env.ciphertext, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

/** 把当前客户端账号的 token 抓回池（在登出之前调用）。 */
function captureTokens() {
  if (!fs.existsSync(AUTH_FILE)) return { ok: false, reason: '当前无 auth 文件（客户端已是未登录态）' };
  let j;
  try { j = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch (e) { return { ok: false, reason: 'auth 文件解析失败: ' + e.message }; }
  const uid = j.account && j.account.uid;
  const token = decryptField(j.auth && j.auth.accessToken);
  const refresh = decryptField(j.auth && j.auth.refreshToken);
  if (!uid || !token) return { ok: false, reason: '解不出 token（检查 WB_ATREST_KEY）' };
  const acct = store.list().find((a) => a.edition === 'workbuddy' && a.userId === uid);
  if (!acct) return { ok: false, reason: `池内无此 uid: ${uid}`, uid };
  const expiresIn = Number(j.auth && j.auth.expiresIn) || 0;
  const patch = {
    token,
    ...(refresh ? { refreshToken: refresh } : {}),
    ...(expiresIn > 0 ? { expiredAt: new Date(Date.now() + expiresIn * 1000).toISOString() } : {}),
    lastRefreshAt: new Date().toISOString(),
    errorCount: 0,
    coolUntil: 0,
  };
  const upd = store.update(acct.id, patch);
  return { ok: !!upd, uid, label: acct.label, tokenLen: token.length, refreshLen: refresh ? refresh.length : 0 };
}

function stopClient() {
  try { execFileSync('taskkill', ['/T', '/F', '/IM', 'WorkBuddy.exe'], { stdio: 'ignore' }); } catch { /* 未运行 */ }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq WorkBuddy.exe', '/NH'], { encoding: 'utf8' });
      if (!/WorkBuddy\.exe/i.test(out)) return true;
    } catch { /* ignore */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  return false;
}

function startClient() {
  spawn('explorer.exe', [APP], { detached: true, stdio: 'ignore' }).unref();
}

function main() {
  const noRestart = process.argv.includes('--no-restart');
  console.log('== 1. 抓取当前账号 token 回池 ==');
  const cap = captureTokens();
  console.log(cap.ok ? `✓ ${cap.label}（uid=${cap.uid.slice(0, 8)}）token=${cap.tokenLen}B refresh=${cap.refreshLen}B` : `✗ ${cap.reason}`);

  console.log('== 2. 停客户端并切到未登录态 ==');
  const stopped = stopClient();
  console.log(stopped ? '✓ 客户端已停止' : '⚠ 未能停止客户端（可能被保护），继续改文件');
  if (fs.existsSync(AUTH_FILE)) {
    const bak = AUTH_FILE + '.bak-before-logout-' + Date.now();
    try { fs.copyFileSync(AUTH_FILE, bak); console.log('  已备份: ' + path.basename(bak)); } catch { /* ignore */ }
    fs.unlinkSync(AUTH_FILE);
  }
  fs.writeFileSync(MARKER, new Date().toISOString(), 'utf8');
  console.log('✓ 已删除 auth 主文件并写入 logged-out 标记');

  if (noRestart) { console.log('（--no-restart，不拉起客户端）'); return; }
  console.log('== 3. 拉起客户端（应停在登录页）==');
  startClient();
  console.log('✓ 已通过 explorer 拉起；接下来请在客户端里登录要恢复的账号');
}

main();
