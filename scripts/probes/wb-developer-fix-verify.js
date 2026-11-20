'use strict';
/**
 * scripts/probes/wb-developer-fix-verify.js — 验证 developer→system 归一修复（真实上游）。
 *
 * 直接用工作区当前代码（normalizeBody → chatStream）打上游，不走运行中的网关：
 *   ① role:"developer" 装长指令 + 真实 DSH tools → 应 200（修复前 11128）
 *   ② 同请求走 normalizeBody 后检查消息 role（进程内断言，不花积分）
 *   ③ role:"system" 对照 → 200
 *
 * ⚠️ 会消耗少量真实积分（max_tokens=16）。
 * 用法：node scripts/probes/wb-developer-fix-verify.js [模型]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');

const ROOT = path.join(process.env.USERPROFILE || '', '.dsh', 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function dec(buf) {
  const fr = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) >= 0) { fr.push(i); i += 4; }
  if (!fr.length) return zlib.zstdDecompressSync(buf).toString('utf8');
  let out = '';
  for (let k = 0; k < fr.length; k++) {
    const s = fr[k];
    const e = k + 1 < fr.length ? fr[k + 1] : buf.length;
    try { out += zlib.zstdDecompressSync(buf.slice(s, e)).toString('utf8'); } catch { /* 残帧 */ }
  }
  return out;
}
function walk(d, o = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f, o);
    else if (e.name.endsWith('.jsonl.zstd')) o.push({ f, m: fs.statSync(f).mtimeMs });
  }
  return o;
}

/** 取最近 provider=wb 会话的真实 system 文本与 tools。 */
function extractIncident() {
  for (const { f } of walk(ROOT).sort((a, b) => b.m - a.m)) {
    let t;
    try { t = dec(fs.readFileSync(f)); } catch { continue; }
    if (!t.includes('"provider":"wb"')) continue;
    let sys = null;
    let tools = [];
    for (const ln of t.split('\n')) {
      if (!ln.includes('request/header') && !ln.includes('system/message')) continue;
      let j;
      try { j = JSON.parse(ln); } catch { continue; }
      if (j.type === 'system/message' && !sys) {
        const c = j.data && j.data.message && j.data.message.content;
        if (typeof c === 'string') sys = c;
        else if (Array.isArray(c)) sys = c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
      }
      if (j.type === 'request/header') {
        const cfg = (j.data && j.data.header && j.data.header.config) || {};
        if (cfg.provider === 'wb' && Array.isArray(j.data.header.tools) && j.data.header.tools.length) {
          tools = j.data.header.tools;
        }
      }
    }
    if (sys) return { sys, tools };
  }
  return null;
}

const store = require('../../src/credentials/store');
const wbAuth = require('../../src/workbuddy/auth');
const wbChat = require('../../src/workbuddy/chat');
const dispatch = require('../../src/model-router/dispatch');

const MODEL = process.argv[2] || 'deepseek-v4.1-flash';

(async () => {
  const inc = extractIncident();
  if (!inc) throw new Error('未找到 provider=wb 的 DSH 会话');
  console.log(`真实 system ${inc.sys.length} 字，tools ${inc.tools.length} 个\n`);

  // ② 进程内断言：normalizeBody 对 developer 的处理
  const nb = wbChat.normalizeBody({
    model: MODEL,
    messages: [{ role: 'developer', content: inc.sys }, { role: 'user', content: 'say ok' }],
    tools: inc.tools,
  });
  const roles = nb.messages.map((m) => m.role);
  assert.ok(!roles.includes('developer'), 'normalizeBody 后不得残留 developer role');
  const userMsg = nb.messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes(inc.sys.slice(0, 1000)), 'developer 正文必须迁入 user');
  console.log('[2] normalizeBody 进程内断言通过:', roles.join(','));

  // ①③ 真实上游
  const acct = store.list().find((a) => a.enabled && a.edition === 'workbuddy');
  if (!acct) throw new Error('账号库里没有启用的 WorkBuddy 账号');
  const full = store.get(acct.id);
  const resolved = {
    token: full.token,
    userId: full.userId,
    host: full.host || wbAuth.chatHost(full.region || 'cn'),
    region: wbAuth.regionOf(full.host),
  };
  const convOpts = dispatch.wbConversationOpts({ stickyKey: 'probe-devfix-' + Date.now() });

  async function hit(label, messages) {
    const body = { model: MODEL, stream: false, max_tokens: 16, tools: inc.tools, messages };
    const t0 = Date.now();
    const r = await wbChat.chatStream(resolved, body, convOpts);
    const text = r.status === 200 ? '' : String(r.text || '');
    const bad = /11128/.test(text);
    console.log(`${label.padEnd(40)} -> ${r.status} (${Date.now() - t0}ms)${bad ? '  <<< 11128' : ''}`);
    return { status: r.status, bad };
  }

  const dev = await hit('① developer 长指令 + tools49（修复目标）',
    [{ role: 'developer', content: inc.sys }, { role: 'user', content: 'say ok' }]);
  const sys = await hit('③ system 长指令 + tools49（对照）',
    [{ role: 'system', content: inc.sys }, { role: 'user', content: 'say ok' }]);

  if (dev.status !== 200 || dev.bad) {
    console.error('\n修复验证失败：developer 形状仍被拦');
    process.exit(1);
  }
  if (sys.status !== 200 || sys.bad) {
    console.error('\n对照组异常：system 形状也应 200（检查是否上游策略又变）');
    process.exit(1);
  }
  console.log('\n✓ 修复验证通过：developer 与 system 形状均 200');
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
