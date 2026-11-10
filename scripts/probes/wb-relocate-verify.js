'use strict';
/**
 * scripts/probes/wb-relocate-verify.js — 验证「system 迁移到首条 user」这一修复形态。
 *
 * 已证：
 *   system 装 13.6KB -> 11128
 *   user   装 13.6KB -> 200（字节完全相同，只换 role）
 *   system 7000 字 ok / 9000 字 BLOCKED（阈值在 7k~9k 之间）
 *
 * 待验证的落地形态（保持模型所见语义最接近原样）：
 *   messages = [system 短句] + [user: 原 system 全文 + 空行 + 真实 user 问题]
 *
 * 用法：node scripts/probes/wb-relocate-verify.js
 */
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:19900';
const apiKeys = require('../../src/credentials/api-keys');
const KEY = apiKeys.revealKeyPlain(apiKeys.listKeys().find((k) => k.label === 'dsh-workbuddy').id);
const SYS = fs.readFileSync(path.join(__dirname, '..', '..', 'logs', '_dsh-system.txt'), 'utf8');
const SHORT = 'You are a coding assistant.';

async function result(label, model, messages, extra = {}) {
  const body = { model, stream: false, max_tokens: 16, messages, ...extra };
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify(body),
    });
    const t = await r.text();
    const b = /11128/.test(t);
    let snippet = t.slice(0, 60).replace(/\s+/g, ' ');
    try { snippet = (JSON.parse(t).choices?.[0]?.message?.content || '').slice(0, 40); } catch { /* 非 JSON */ }
    console.log(`  ${label.padEnd(44)} -> ${r.status} ${b ? 'BLOCKED' : 'ok'} (${Date.now() - t0}ms) ${b ? '' : snippet}`);
    return !b && r.status === 200;
  } catch (e) {
    console.log(`  ${label.padEnd(44)} EXCEPTION ${e.message}`);
    return false;
  }
}

/** 迁移：system 超阈值时，正文挪进首条 user，system 只留短句。 */
function relocate(messages, keepShort = SHORT) {
  const idx = messages.findIndex((m) => m.role === 'system' && typeof m.content === 'string');
  if (idx < 0) return messages;
  const sys = messages[idx].content;
  const out = messages.slice();
  out[idx] = { role: 'system', content: keepShort };
  const firstUser = out.findIndex((m) => m.role === 'user');
  if (firstUser < 0) {
    out.push({ role: 'user', content: sys });
  } else {
    const u = out[firstUser];
    out[firstUser] = { role: 'user', content: sys + '\n\n' + (typeof u.content === 'string' ? u.content : '') };
  }
  return out;
}

(async () => {
  const MODELS = ['wb/deepseek-v4.1-flash', 'wb/glm-5.3', 'wb/step-5-preview', 'wb/minimax-m3.1-flash', 'hy3'];
  const orig = [{ role: 'system', content: SYS }, { role: 'user', content: 'say ok in one word' }];

  for (const m of MODELS) {
    console.log(`\n=== ${m}`);
    await result('原样（system 13.6KB）', m, orig);
    await result('迁移后（system 短 + user 全文）', m, relocate(orig));
  }

  console.log('\n=== 带工具的真实形态（45 个真实 schema）');
  const zlib = require('zlib');
  const ROOT = path.join(process.env.USERPROFILE || '', '.dsh', 'sessions');
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  function decompressAll(buf) {
    const frames = [];
    let i = 0;
    while ((i = buf.indexOf(MAGIC, i)) >= 0) { frames.push(i); i += 4; }
    if (!frames.length) return zlib.zstdDecompressSync(buf).toString('utf8');
    let out = '';
    for (let k = 0; k < frames.length; k++) {
      const s = frames[k];
      const e = k + 1 < frames.length ? frames[k + 1] : buf.length;
      try { out += zlib.zstdDecompressSync(buf.slice(s, e)).toString('utf8'); } catch { /* 残帧 */ }
    }
    return out;
  }
  function walk(dir, acc = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, acc);
      else if (e.name.endsWith('.jsonl.zstd')) acc.push({ full, m: fs.statSync(full).mtimeMs });
    }
    return acc;
  }
  let tools = [];
  for (const f of walk(ROOT).sort((a, b) => b.m - a.m)) {
    let text;
    try { text = decompressAll(fs.readFileSync(f.full)); } catch { continue; }
    for (const ln of text.split('\n')) {
      if (!ln.includes('"type":"request/header"')) continue;
      try {
        const j = JSON.parse(ln);
        const t = j.data && j.data.header && j.data.header.tools;
        if (Array.isArray(t) && t.length) { tools = t; break; }
      } catch { /* 跳过 */ }
    }
    if (tools.length) break;
  }
  console.log(`（工具 ${tools.length} 个）`);
  const withTools = { tools: tools.length ? tools : undefined, tool_choice: 'auto' };
  await result('真实工具 + 原样 system', 'wb/deepseek-v4.1-flash', orig, withTools);
  await result('真实工具 + 迁移后', 'wb/deepseek-v4.1-flash', relocate(orig), withTools);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
