'use strict';
/**
 * scripts/probes/wb-incident-replay.js — 复现 2026-11-19 09:10 的 11128 事故请求。
 *
 * 从 DSH 会话日志提取本次会话 turn1 的 system 文本（provider=wb 那条），
 * 用 dsh-workbuddy 密钥走网关重放三种形状：
 *   A system 放 messages[0]（DSH 常规形状，网关应迁位）
 *   B system 放顶层 system 字段（normalizeBody 不会碰它——假说：DSH 就这么发的）
 *   C 短 system 基线
 *
 * 用法：node scripts/probes/wb-incident-replay.js [模型]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(process.env.USERPROFILE || '', '.dsh', 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const BASE = 'http://127.0.0.1:19900';
const MODEL = process.argv[2] || 'wb/deepseek-v4.1-flash';

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

/** 找最近一个 provider=wb 的会话，取其 turn1 system 文本与真实 tools。 */
function extractIncident() {
  const files = walk(ROOT).sort((a, b) => b.m - a.m);
  for (const { f } of files) {
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
    if (sys) return { sys, tools, file: f };
  }
  return null;
}

const apiKeys = require('../../src/credentials/api-keys');
const KEY = apiKeys.revealKeyPlain(apiKeys.listKeys().find((k) => k.label === 'dsh-workbuddy').id);

async function call(label, body) {
  const t0 = Date.now();
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  const hit = /11128/.test(text) ? '  <<< 11128' : '';
  console.log(`${label.padEnd(44)} -> ${r.status} (${Date.now() - t0}ms)${hit}`);
  return hit;
}

(async () => {
  const inc = extractIncident();
  if (!inc) { console.error('未找到 provider=wb 的会话'); process.exit(1); }
  console.log(`会话: ${path.basename(path.dirname(inc.file))}`);
  console.log(`system ${inc.sys.length} 字，tools ${inc.tools.length} 个\n`);

  const user = [{ role: 'user', content: 'say ok' }];
  const base = { model: MODEL, stream: false, max_tokens: 16 };

  await call('A 真实system→messages[0] + 真实tools49', { ...base, messages: [{ role: 'system', content: inc.sys }, ...user], tools: inc.tools });
  // 2026-11-19 事故形状：DSH reasoning 请求把指令发成 role:"developer"
  await call('F 真实system→role:developer + 真实tools49', { ...base, messages: [{ role: 'developer', content: inc.sys }, ...user], tools: inc.tools });
  await call('B 真实system→顶层system字段 + 真实tools49', { ...base, system: inc.sys, messages: user, tools: inc.tools });
  await call('C 短system基线 + 真实tools49', { ...base, messages: [{ role: 'system', content: 'You are a coding assistant.' }, ...user], tools: inc.tools });
  await call('D 真实system→messages[0] 无tools', { ...base, messages: [{ role: 'system', content: inc.sys }, ...user] });
  await call('E 真实system→user消息 + 真实tools49', { ...base, messages: [{ role: 'user', content: inc.sys + '\n\nsay ok' }], tools: inc.tools });
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
