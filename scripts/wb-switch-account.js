'use strict';
/**
 * scripts/wb-switch-account.js — 让 WorkBuddy 桌面端切换到指定已登录账号。
 *
 * 背景：客户端 UI 里「切换账号」会走一次完整 SSO 登录（短信/扫码），
 * 家人名下的号每次都要找人配合。本脚本绕开登录流程：把账号池里该账号
 * 的有效 token 以**明文 legacy 形态**写回客户端的 auth 文件，清掉
 * logged-out 标记，再重启客户端——客户端启动时按 legacy 明文恢复登录态。
 *
 * 依据（客户端 app.asar 代码）：
 *   - classifyWholeFileBytes 把无 WBEF1 前缀的文件判为 legacy 明文并直接读取；
 *   - 启动时若存在 .logged-out 标记会清空身份（observation.json 的 identity 为空）。
 *
 * 用法：
 *   node scripts/wb-switch-account.js --phone 18630893389
 *   node scripts/wb-switch-account.js --uid 925172d2-2975-49e4-b20a-97ca5d8834a1
 *   node scripts/wb-switch-account.js --list          # 列出可切换账号
 * 步骤：备份当前 auth → 写入明文凭据 → 删 logged-out 标记 → 通过 Explorer 重启客户端。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const store = require('../src/credentials/store');
const wbAuth = require('../src/workbuddy/auth');

const AUTH_DIR = path.join(process.env.LOCALAPPDATA || '', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
const PLAIN_DIR = path.join(__dirname, '..', 'logs', '_wb-plain');
const AUTH_FILE = path.join(AUTH_DIR, 'workbuddy-desktop.info');
const LOGGED_OUT = path.join(AUTH_DIR, 'workbuddy-desktop.info.logged-out');
const APP = 'C:\\opt\\software\\Tencent\\WorkBuddy\\WorkBuddy.exe';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function listAccounts() {
  const accts = store.list().filter((a) => a.edition === 'workbuddy');
  for (const a of accts) console.log(`${a.label || '(no phone)'}  uid=${a.userId || '?'}  enabled=${a.enabled}  id=${a.id}`);
}

function pickAccount() {
  const accts = store.list().filter((a) => a.edition === 'workbuddy');
  const phone = arg('--phone');
  const uid = arg('--uid');
  if (!phone && !uid) return null;
  return accts.find((a) => (phone && a.label === phone) || (uid && a.userId === uid)) || null;
}

function basePlain(uid) {
  // 用最近一次解密出的明文文件作骨架（含 account/uin 等字段），其 token 会被覆盖
  if (fs.existsSync(PLAIN_DIR)) {
    const hit = fs.readdirSync(PLAIN_DIR).find((f) => f.includes(uid));
    if (hit) return JSON.parse(fs.readFileSync(path.join(PLAIN_DIR, hit), 'utf8'));
  }
  // 兜底：最小骨架（客户端 legacy 读取所需字段）
  return { account: { uid }, auth: {} };
}

function backupCurrent() {
  if (!fs.existsSync(AUTH_FILE)) return null;
  const dir = path.join(__dirname, '..', 'logs', `_wb-switch-backup-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(AUTH_FILE, path.join(dir, 'workbuddy-desktop.info'));
  return dir;
}

function main() {
  if (process.argv.includes('--list')) { listAccounts(); return; }
  const acct = pickAccount();
  if (!acct) {
    console.error('用法：--phone <手机号> 或 --uid <uid>（先用 --list 查看）');
    process.exit(2);
  }
  const full = store.get(acct.id);
  if (!full || !full.token) { console.error(`账号 ${acct.label} 无 token`); process.exit(1); }

  const plain = basePlain(acct.userId);
  plain.account = { ...plain.account, uid: acct.userId };
  plain.auth = {
    ...(plain.auth || {}),
    accessToken: full.token,
    refreshToken: full.refreshToken || (plain.auth && plain.auth.refreshToken) || '',
  };
  // expiresAt 毫秒时间戳（客户端用它判断是否过期）
  const exp = acct.expiredAt ? Date.parse(acct.expiredAt) : NaN;
  if (Number.isFinite(exp)) plain.auth.expiresAt = exp;

  const backupDir = backupCurrent();
  fs.writeFileSync(AUTH_FILE, JSON.stringify(plain, null, 2), 'utf8');
  if (fs.existsSync(LOGGED_OUT)) fs.unlinkSync(LOGGED_OUT);

  // 先彻底退出客户端：taskkill 返回后子进程可能还活着，若紧接着启动，
  // 单实例锁会让新进程只把旧窗口拉到前台、沿用旧账号（实测踩过）。
  try { execFileSync('taskkill', ['/T', '/F', '/IM', 'WorkBuddy.exe'], { stdio: 'ignore' }); } catch { /* 本就没在跑 */ }
  const killDeadline = Date.now() + 20_000;
  while (Date.now() < killDeadline && countWorkBuddy() > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  if (countWorkBuddy() > 0) { console.error('✗ 客户端进程仍在运行，放弃（避免切号无效）'); process.exit(1); }

  const startMs = Date.now();
  const { spawn } = require('child_process');
  spawn('explorer.exe', [APP], { detached: true, stdio: 'ignore' }).unref();

  console.log(`已切换到 ${acct.label}（uid=${acct.userId}）`);
  console.log(`  token=${full.token.length}B  exp=${acct.expiredAt || '?'}`);
  if (backupDir) console.log(`  原凭据已备份到 ${backupDir}`);

  // 自校验：客户端冷启动约 15-20s。只认「启动之后新写入」的 observation
  // （旧文件里还留着上一个账号的身份，mtime 早于 startMs 一律不算）。
  const deadline = Date.now() + 90_000;
  let last = null;
  while (Date.now() < deadline) {
    const obs = findObservation();
    if (obs) {
      try {
        const st = fs.statSync(obs);
        if (st.mtimeMs >= startMs) {
          const j = JSON.parse(fs.readFileSync(obs, 'utf8'));
          const id = j.identity && j.identity.userId;
          if (id && j.active === true) {
            last = id;
            if (id === acct.userId) { console.log(`✓ 客户端已登录 ${acct.label}`); return; }
          }
        }
      } catch { /* 文件可能正在写 */ }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  console.error(`✗ 等待超时：客户端未恢复为该账号（最后观测到 ${last || '无身份'}）`);
  console.error('  排查：客户端是否被安全软件拦住启动；token 是否已被上游吊销（跑 scripts/import-wb-auth.js 复核）。');
  process.exit(1);
}

function countWorkBuddy() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq WorkBuddy.exe', '/NH'], { encoding: 'utf8' });
    return out.split(/\r?\n/).filter((l) => /WorkBuddy\.exe/i.test(l)).length;
  } catch { return 0; }
}

function findObservation() {
  try {
    const f = fs.readdirSync(AUTH_DIR).find((x) => /^workbuddy-desktop\.info\..*\.observation\.json$/.test(x));
    return f ? path.join(AUTH_DIR, f) : null;
  } catch { return null; }
}

main();
