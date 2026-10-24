'use strict';
/**
 * scripts/import-wb-auth.js — 从 WorkBuddy 本地 auth 目录导入 / 刷新账号凭据。
 *
 * 背景（2026-10-24）：新版客户端把 token 存成 {$wbEncrypted, envelope} 加密对象，
 * 普通 Node 进程无法解密（密钥由 Electron 主进程的 protector key 持有）。官方
 * 提供了一个开关把 at-rest 加密关掉：环境变量 WORKBUDDY_AT_REST_ENCRYPTION=off
 * ——此时客户端写出的 workbuddy-desktop.info 是明文（代码证据：ProtectedWholeFile
 * Codec#encode 在 mode==='disabled' 时直接 Buffer.from(明文)）。
 *
 * 用法：
 *   1) 启用明文模式（一次性）：
 *        setx WORKBUDDY_AT_REST_ENCRYPTION off
 *      然后完全退出 WorkBuddy 并重新启动；切到目标账号登录一次
 *      （每个账号切一次登录，文件会以明文重写）。
 *   2) 检测（不写库）：
 *        node scripts/import-wb-auth.js
 *   3) 写回账号池（按 userId 匹配，手机号 label 兜底）：
 *        node scripts/import-wb-auth.js --apply
 *
 * 校验口径：先打计费接口（web 面）确认 token 有效并取余额；只有 billing OK
 * 的账号才会被写回。--chat 额外用 chat 面发一次 max_tokens=1（消耗微量积分）。
 */
const fs = require('fs');
const path = require('path');
const store = require('../src/credentials/store');
const wbAuth = require('../src/workbuddy/auth');
const wbChat = require('../src/workbuddy/chat');

const AUTH_DIR = process.env.WB_AUTH_DIR || path.join(process.env.LOCALAPPDATA || '', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
const APPLY = process.argv.includes('--apply');
const CHAT = process.argv.includes('--chat');

function plain(v) {
  return (typeof v === 'string' && v && !v.startsWith('[object')) ? v : null;
}

function isEncrypted(v) {
  return v && typeof v === 'object' && v.$wbEncrypted != null;
}

function parseFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const acc = raw.account || {};
  const auth = raw.auth || {};
  return {
    file: path.basename(file),
    phone: plain(acc.phoneNumber),
    uid: acc.uid || acc.uin || null,
    token: plain(auth.accessToken ?? auth.access_token),
    refresh: plain(auth.refreshToken ?? auth.refresh_token),
    encrypted: isEncrypted(auth.accessToken) || isEncrypted(auth.refreshToken),
    expiresIn: Number(auth.expiresIn) || null,
    refreshExpiresIn: Number(auth.refreshExpiresIn) || null,
  };
}

async function billing(p) {
  try {
    const r = await wbAuth.verify({ accessToken: p.token, uid: p.uid, region: 'cn' });
    return r.valid ? { ok: true, balance: r.balance } : { ok: false, reason: String(r.reason || '') };
  } catch (e) { return { ok: false, reason: e.message }; }
}

async function chatProbe(p) {
  try {
    const r = await wbChat.chatStream({ token: p.token, userId: p.uid, host: wbAuth.chatHost('cn'), region: 'cn' }, {
      model: 'deepseek-v4.1-flash', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }],
    });
    if (r.status === 200 && r.body) {
      const rd = r.body.getReader();
      try { for (;;) { const { done } = await rd.read(); if (done) break; } } catch { /* */ }
      return { ok: true };
    }
    let code = null;
    try { code = JSON.parse(r.text || '').code ?? null; } catch { /* html */ }
    return { ok: false, reason: `HTTP ${r.status} code=${code}` };
  } catch (e) { return { ok: false, reason: e.message }; }
}

(async () => {
  const files = fs.readdirSync(AUTH_DIR)
    .filter((f) => f.startsWith('workbuddy-desktop.info'))
    .map((f) => path.join(AUTH_DIR, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  console.log(`auth 目录: ${AUTH_DIR}`);
  console.log(`模式: ${APPLY ? 'APPLY（会写库）' : 'DRY-RUN（只检测）'}${CHAT ? ' + chat 探测' : ''}\n`);

  const accounts = store.list().filter((a) => a.edition === 'workbuddy');
  let usable = 0;
  let written = 0;

  for (const f of files) {
    let p;
    try { p = parseFile(f); } catch (e) { console.log(`${path.basename(f)} 解析失败: ${e.message}`); continue; }
    if (p.encrypted || !p.token) {
      console.log(`✗ ${p.file}  ${p.encrypted ? 'ENCRYPTED（token 是 $wbEncrypted 信封，普通进程解不开）' : 'NO TOKEN'}`);
      continue;
    }
    const b = await billing(p);
    console.log(`· ${p.file}  uid=${String(p.uid || '').slice(0, 8)}…  billing=${b.ok ? `OK 余额=${b.balance}` : `FAIL ${b.reason}`}`);
    if (!b.ok) continue;
    usable += 1;
    if (CHAT) {
      const c = await chatProbe(p);
      console.log(`    chat: ${c.ok ? 'OK 200' : `FAIL ${c.reason}`}`);
      if (!c.ok) { console.log('    → chat 面不可用，跳过写库'); continue; }
    }
    if (!APPLY) continue;
    // 匹配账号池：userId 优先，手机号 label 兜底
    const hit = accounts.find((a) => a.userId && pi(p.uid) && a.userId === p.uid)
      || accounts.find((a) => p.phone && a.label === p.phone)
      || null;
    if (!hit) { console.log(`    → 池内无匹配账号（uid=${p.uid} phone=${p.phone}），跳过`); continue; }
    const now = Date.now();
    const patch = {
      token: p.token,
      refreshToken: p.refresh || hit.refreshToken || undefined,
      expiredAt: p.expiresIn ? new Date(now + p.expiresIn * 1000).toISOString() : hit.expiredAt,
      refreshExpiredAt: p.refreshExpiresIn ? new Date(now + p.refreshExpiresIn * 1000).toISOString() : hit.refreshExpiredAt,
      errorCount: 0,
      coolUntil: 0,
      lastRefreshAt: new Date(now).toISOString(),
    };
    const upd = store.update(hit.id, patch);
    if (upd) { written += 1; console.log(`    → 已写回账号 ${hit.id}（${hit.label}），余额=${b.balance}`); }
  }

  console.log(`\n汇总：可用 ${usable} 个，写回 ${written} 个${APPLY ? '' : '（DRY-RUN 未写库，加 --apply 执行）'}`);
  if (!usable && files.some((f) => { try { return isEncrypted(JSON.parse(fs.readFileSync(f, 'utf8')).auth?.accessToken); } catch { return false; } })) {
    console.log('\n所有文件均为加密态。启用明文模式：');
    console.log('  setx WORKBUDDY_AT_REST_ENCRYPTION off');
    console.log('  然后完全退出 WorkBuddy 并重启，切到目标账号登录一次（文件将以明文重写）。');
  }
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });

function pi(v) { return v != null && v !== ''; }
