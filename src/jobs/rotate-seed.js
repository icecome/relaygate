'use strict';
/**
 * jobs/rotate-seed.js — 从账号库把 WorkBuddy 账号登录态写入客户端 auth 目录（备份种子）。
 *
 * 账号轮换依赖 auth 目录中的 .info 备份（客户端登录后自动写出）。若 auth 目录尚无备份，
 * 本模块把 credentials 库中 edition=workbuddy 的账号（含 token/refreshToken/uid/region）
 * 按 workbuddy-desktop.info 的 {account:{...}, auth:{...}} 结构写入 auth 目录，文件名与客户端
 * 轮转命名一致，之后 rotate-accounts.discoverAccounts() 即可发现并参与轮换。
 *
 * 仅当该 uid 在 auth 目录尚无可用备份时才生成，避免覆盖客户端最新登录态。
 * 明文 accessToken 仅落在本机 auth 目录（与客户端一致），不写入日志，也不返回前端。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('../credentials/store');
const variant = require('../platform/variant');
const { writeJsonAtomic } = require('../lib/atomic-write');
// auth 目录定位与账号发现与 rotate-accounts 共用同一实现（单向依赖，无循环）
const { AUTH_DIR, AUTH_FILE, discoverAccounts } = require('./rotate-auth-dir');

function regionOfHost(host) {
  return variant.regionOf(host, variant.WORKBUDDY);
}

function chatDomain(region) {
  return variant.hostFor(variant.variantOf(variant.WORKBUDDY).hosts.domain, variant.validRegion(region));
}

/** 该 uid 在 auth 目录是否已有可用备份（或为当前 auth 文件）。 */
function hasBackupFor(uid) {
  if (!uid) return false;
  if (fs.existsSync(AUTH_FILE)) {
    try {
      const j = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      if (j.account && j.account.uid === uid) return true;
    } catch { /* 损坏视为无备份 */ }
  }
  return discoverAccounts().some((a) => a.uid === uid);
}

/**
 * 写入一个账号的 auth 备份文件。
 * 返回 {ok, file, uid, reason?}；已有备份时跳过并说明。
 *
 * @param {object} acct 账号（含 token/refreshToken/uid/host/expiredAt）
 * @param {{force?:boolean}} [opts]
 *   force=true 时无视「已有备份」检查，强制用账号库里的**当前 token** 重写种子。
 *   场景：客户端备份里的 token 已被上游吊销（换号登录/风控回收），旧备份
 *   会让轮换切过去后是未登录态；此时必须用库里校验过的 token 重新播种——
 *   种子文件名带时间戳，discoverAccounts 按 uid 去重取最新，旧备份自动让位。
 */
function seedAccount(acct, opts = {}) {
  const uid = String(acct.userId || '');
  if (!uid) return { ok: false, reason: '账号缺少 userId' };
  if (!acct.token && !acct.refreshToken) return { ok: false, reason: '账号缺少 token/refreshToken' };
  if (!opts.force && hasBackupFor(uid)) return { ok: false, skip: true, reason: 'auth 目录已有该账号备份，跳过' };

  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
  const region = regionOfHost(acct.host);
  const expiresAtMs = acct.expiredAt ? new Date(acct.expiredAt).getTime() : Date.now() + 60 * 86400000;
  const refreshExpiresAtMs = acct.refreshExpiredAt ? new Date(acct.refreshExpiredAt).getTime() : Date.now() + 90 * 86400000;

  // 骨架优先取样自该 uid 的**现有备份**：客户端备份里的 account 段带 uin、
  // 以及加密的 nickname/phoneNumber 等字段。只把 auth 的 token 换成库内当前值，
  // 其余原样保留——客户端本来就能解开自己写出的加密字段。
  // 实测踩过：早先只写 {uid,nickname,phoneNumber:null,uin:null} 的最小骨架，
  // 客户端拉起后不认登录态（observation 无 identity），而带 uin 的完整骨架可以。
  const skeleton = pickSkeleton(uid);
  const payload = {
    account: {
      ...(skeleton && skeleton.account ? skeleton.account : {}),
      uid,
      ...(skeleton && skeleton.account && skeleton.account.uin != null ? {} : { uin: null }),
      region,
    },
    auth: {
      ...(skeleton && skeleton.auth ? skeleton.auth : {}),
      accessToken: acct.token || null,
      refreshToken: acct.refreshToken || null,
      expiresIn: Math.max(1, Math.round((expiresAtMs - Date.now()) / 1000)),
      refreshExpiresIn: Math.max(1, Math.round((refreshExpiresAtMs - Date.now()) / 1000)),
      expiresAt: expiresAtMs,
      refreshExpiresAt: refreshExpiresAtMs,
      domain: (skeleton && skeleton.auth && skeleton.auth.domain) || chatDomain(region),
    },
  };
  // 多账号注册表（客户端 5.9.x 起必需）：renderer 启动按 accounts/allAccounts
  // 校验当前会话是否在册；缺失时弹「登录已过期」→ auth:logout → 删除 auth 文件。
  // 2026-10-26 实测：restore 成功 uid=925172d2，3 秒后被此路径清空。
  // 取骨架注册表原样保留（含其它账号条目），仅确保本账号在列。
  if (skeleton && Array.isArray(skeleton.accounts) && skeleton.accounts.length) {
    payload.accounts = skeleton.accounts.some((x) => x && x.uid === uid)
      ? skeleton.accounts
      : [...skeleton.accounts, payload.account];
  } else {
    payload.accounts = [payload.account];
  }
  payload.allAccounts = payload.accounts;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(AUTH_DIR, `workbuddy-desktop.${stamp}.seed.${crypto.randomBytes(6).toString('hex')}.info`);
  writeJsonAtomic(file, payload, { newline: false });
  return { ok: true, file, uid, label: acct.label };
}

/** 取该 uid 最新的**权威骨架**。
 *
 *  优先级：解密明文缓存（logs/_wb-plain，字段最全：uin/sessionState/domain 等）
 *        → 客户端备份（排除 .seed. 与已被轮换污染的 bak-<uid8>）
 *        → null（回落到最小骨架）。
 *
 *  踩过的坑：
 *   1) 把 .seed. 当骨架 → 字段越滚越少，客户端 hasAccessToken=false；
 *   2) 轮换时把当前 AUTH_FILE（可能正是种子）回写成 bak-<uid8>，污染了原始备份。
 *  所以骨架必须来自未经轮换写过的源，明文缓存是唯一稳定来源。
 */
function pickSkeleton(uid) {
  const plainDir = path.join(__dirname, '..', '..', 'logs', '_wb-plain');
  try {
    if (fs.existsSync(plainDir)) {
      const hit = fs.readdirSync(plainDir).find((f) => f.includes(uid));
      if (hit) {
        const j = JSON.parse(fs.readFileSync(path.join(plainDir, hit), 'utf8'));
        if (j && j.account && j.account.uid === uid) return j;
      }
    }
  } catch { /* 明文缓存不可用则继续 */ }
  try {
    const candidates = [];
    for (const f of fs.readdirSync(AUTH_DIR)) {
      if (!f.startsWith('workbuddy-desktop.')) continue;
      if (f === 'workbuddy-desktop.info') continue;
      if (f.includes('.seed.')) continue;
      if (!f.endsWith('.info') && !f.includes('.bak-')) continue;
      const p = path.join(AUTH_DIR, f);
      let j;
      try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
      if (!j.account || j.account.uid !== uid) continue;
      // 只接受字段足够完整的骨架（缺 uin 的多半是被污染的种子回写）
      if (j.account.uin == null) continue;
      candidates.push({ p, mtime: fs.statSync(p).mtimeMs, j });
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates.length ? candidates[0].j : null;
  } catch { return null; }
}

/**
 * 为 auth 目录尚无备份的全部启用 WorkBuddy 账号生成备份种子。
 * force=true 时对已有备份的账号也用库内当前 token 重写（见 seedAccount 注释）。
 * @returns {{ok:{accountId:string,uid:string,file:string,label?:string}[], skipped:{accountId:string,uid:string|null,reason:string}[], failed:Array<{accountId:string,reason:string}>, total:number}}
 *          ok 与 skipped 是对象数组而非数量计数。
 */
function seedAll(opts = {}) {
  const accounts = store.list().filter((a) => a.edition === 'workbuddy' && a.enabled);
  const ok = [];
  const skipped = [];
  const failed = [];
  for (const a of accounts) {
    const full = store.get(a.id) || a;
    try {
      const r = seedAccount(full, opts);
      if (r.ok) ok.push({ accountId: a.id, uid: r.uid, file: r.file, label: r.label });
      else if (r.skip) skipped.push({ accountId: a.id, uid: r.uid, reason: r.reason });
      else failed.push({ accountId: a.id, reason: r.reason });
    } catch (e) {
      failed.push({ accountId: a.id, reason: e.message });
    }
  }
  return { ok, skipped, failed, total: accounts.length };
}

module.exports = { seedAll, seedAccount, hasBackupFor, AUTH_DIR, AUTH_FILE };