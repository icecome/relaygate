'use strict';
/**
 * jobs/rotate-auth-dir.js — WorkBuddy 客户端 auth 目录的定位与账号发现。
 *
 * 从 rotate-accounts.js 抽出：该能力被 rotate-accounts（切换/轮换）与
 * rotate-seed（写入种子备份）共同依赖，留在 rotate-accounts 里会形成
 * rotate-accounts ⇄ rotate-seed 循环依赖（两者互相 require）。
 * 抽到这一层后依赖方向变为单向：rotate-accounts → 本模块 ← rotate-seed。
 *
 * 默认目录取自 platform/variant.js（平台差异单一事实源）。
 */
const fs = require('fs');
const path = require('path');
const variant = require('../platform/variant');

/** auth 目录：rotate-settings.json 的 authDir → env WB_AUTH_DIR → 平台默认。 */
function resolveAuthDir() {
  try {
    const rs = require('./rotate-settings').getEffective();
    if (rs.authDir && String(rs.authDir).trim()) {
      const d = path.resolve(String(rs.authDir).trim());
      if (fs.existsSync(d)) return d;
      console.warn(`[rotate] configured authDir not found: ${d}, fallback to default`);
    }
  } catch { /* 配置读取失败用默认 */ }
  if (process.env.WB_AUTH_DIR) return process.env.WB_AUTH_DIR;
  return variant.clientAuthDir(variant.WORKBUDDY);
}

const AUTH_DIR = resolveAuthDir();
const AUTH_FILE = path.join(AUTH_DIR, 'workbuddy-desktop.info');

/** 当前 auth 文件对应的 uid。 */
function readUid() {
  try {
    const j = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    return j.account && j.account.uid;
  } catch { return null; }
}

/** 发现 auth 目录下所有可用的账号备份（按 uid 去重，保留最新一份）。 */
function discoverAccounts() {
  const found = [];
  try {
    for (const f of fs.readdirSync(AUTH_DIR)) {
      // 匹配 .info 备份、.bak-* 备份与 .seed.* 备份（本机写入的种子）
      const isBackup = (f.startsWith('workbuddy-desktop.') && f.endsWith('.info'))
        || (f.startsWith('workbuddy-desktop.info.bak-'))
        || (f.startsWith('workbuddy-desktop.') && f.includes('.seed.'));
      if (!isBackup || f === 'workbuddy-desktop.info') continue;
      const full = path.join(AUTH_DIR, f);
      try {
        const j = JSON.parse(fs.readFileSync(full, 'utf8'));
        const uid = j.account && j.account.uid;
        if (!uid) continue;
        const existing = found.find((a) => a.uid === uid);
        const rawNick = j.account.nickname;
        const label = typeof rawNick === 'string' && rawNick ? rawNick : uid.slice(0, 8) + '…';
        if (!existing) {
          found.push({ uid, label, backup: f, mtime: fs.statSync(full).mtimeMs });
        } else if (fs.statSync(full).mtimeMs > existing.mtime) {
          existing.backup = f;
          existing.mtime = fs.statSync(full).mtimeMs;
          existing.label = label;
        }
      } catch { /* 跳过损坏文件 */ }
    }
    // 当前 auth 文件也是账号
    const cur = readUid();
    if (cur && !found.find((a) => a.uid === cur)) {
      found.push({ uid: cur, label: 'current', backup: 'workbuddy-desktop.info', mtime: 0 });
    }
  } catch { /* 目录不存在 */ }
  return found;
}

module.exports = { AUTH_DIR, AUTH_FILE, resolveAuthDir, readUid, discoverAccounts };