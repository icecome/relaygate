'use strict';
/**
 * jobs/rotate-seed.js — 从账号库把 WorkBuddy 账号登录态写入客户端 auth 目录（备份种子）。
 *
 * 用途：账号轮换依赖 auth 目录中的 .info 备份（客户端登录后自动写出）。
 * 若 auth 目录尚无备份，可调用本模块：把 credentials 库中 edition=workbuddy 的
 * 账号（含 token/refreshToken/uid/region）按 workbuddy-desktop.info 的
 * {account:{...}, auth:{...}} 结构写入 auth 目录，文件名与客户端轮转命名一致，
 * 之后 rotate-accounts.discoverAccounts() 即可发现并参与轮换。
 *
 * 注意：仅当该 uid 在 auth 目录尚无可用备份时才生成，避免覆盖客户端最新登录态。
 * 明文 accessToken 仅落本机 auth 目录（与客户端一致），绝不写入日志/返回前端。
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

/** 该 uid 在 auth 目录是否已有可用备份（或为当前 auth）。 */
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
 */
function seedAccount(acct) {
  const uid = String(acct.userId || '');
  if (!uid) return { ok: false, reason: '账号缺少 userId' };
  if (!acct.token && !acct.refreshToken) return { ok: false, reason: '账号缺少 token/refreshToken' };
  if (hasBackupFor(uid)) return { ok: false, skip: true, reason: 'auth 目录已有该账号备份，跳过' };

  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
  const region = regionOfHost(acct.host);
  const expiresAtMs = acct.expiredAt ? new Date(acct.expiredAt).getTime() : Date.now() + 60 * 86400000;
  const refreshExpiresAtMs = acct.refreshExpiredAt ? new Date(acct.refreshExpiredAt).getTime() : Date.now() + 90 * 86400000;
  const payload = {
    account: {
      uid,
      nickname: acct.label || uid.slice(0, 8),
      phoneNumber: null,
      uin: null,
      region,
    },
    auth: {
      accessToken: acct.token || null,
      refreshToken: acct.refreshToken || null,
      expiresIn: Math.max(1, Math.round((expiresAtMs - Date.now()) / 1000)),
      refreshExpiresIn: Math.max(1, Math.round((refreshExpiresAtMs - Date.now()) / 1000)),
      expiresAt: expiresAtMs,
      refreshExpiresAt: refreshExpiresAtMs,
      domain: chatDomain(region),
    },
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(AUTH_DIR, `workbuddy-desktop.${stamp}.seed.${crypto.randomBytes(6).toString('hex')}.info`);
  writeJsonAtomic(file, payload, { newline: false });
  return { ok: true, file, uid, label: acct.label };
}

/**
 * 为 auth 目录尚无备份的全部启用 WorkBuddy 账号生成备份种子。
 * @returns {{ok:number, skipped:number, failed:Array<{accountId:string,reason:string}>}}
 */
function seedAll() {
  const accounts = store.list().filter((a) => a.edition === 'workbuddy' && a.enabled);
  const ok = [];
  const skipped = [];
  const failed = [];
  for (const a of accounts) {
    const full = store.get(a.id) || a;
    try {
      const r = seedAccount(full);
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