'use strict';
/**
 * scripts/probes/wb-repro-split.js — 用「真实 system + 真实工具 schema」二分复现 11128。
 *
 * 变量只有四个，逐个组合打真实上游（每次 max_tokens 很小）：
 *   A 真实 system（logs/_dsh-system.txt，13.6KB）
 *   B 真实工具 schema（从 DSH 会话 request/header 原样导出）
 *   C 工具数（45 vs 0）
 *   D 消息长度（单轮 vs 带历史）
 *
 * 用法：node scripts/probes/wb-repro-split.js [模型]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(process.env.USERPROFILE || '', '.dsh', 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const BASE = 'http://127.0.0.1:19900';
const MODEL = process.argv[2] || 'wb/deepseek-v4.1-flash';

const apiKeys = require('../../src/credentials/api-keys');
const KEY = apiKeys.revealKeyPlain(apiKeys.listKeys().find((k) => k.label === 'dsh-workbuddy').id);

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

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.jsonl.zstd')) out.push({ full, m: fs.statSync(full).mtimeMs });
  }
  return out;
}

/** 从最新会话取真实工具 schema（request/header.tools）。 */
function realTools() {
  const files = walk(ROOT).sort((a, b) => b.m - a.m);
  for (const f of files) {
    let text;
    try { text = decompressAll(fs.readFileSync(f.full)); } catch { continue; }
    for (const ln of text.split('\n')) {
      if (!ln.includes('"type":"request/header"')) continue;
      let j;
      try { j = JSON.parse(ln); } catch { continue; }
      const tools = j.data && j.data.header && j.data.header.tools;
      if (Array.isArray(tools) && tools.length) return tools;
    }
  }
  return [];
}

function fakeTools(n) {
  return Array.from({ length: n }, (_, i) => ({
    type: 'function',
    function: { name: 'Tool' + i, description: 'Tool ' + i, parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } },
  }));
}

const REAL_SYS = fs.existsSync(path.join(__dirname, '..', '..', 'logs', '_dsh-system.txt'))
  ? fs.readFileSync(path.join(__dirname, '..', '..', 'logs', '_dsh-system.txt'), 'utf8')
  : 'You are a coding assistant.';
const SHORT_SYS = 'You are a coding assistant.';

async function call(label, body) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let detail = text.slice(0, 150).replace(/\s+/g, ' ');
    try {
      const j = JSON.parse(text);
      detail = (j.error && (j.error.message || JSON.stringify(j.error))) || (j.choices && j.choices[0].message.content) || detail;
    } catch { /* 非 JSON */ }
    const ms = Date.now() - t0;
    const hit = /11128/.test(text) ? ' <<< 11128' : '';
    console.log(`${label.padEnd(38)} -> ${r.status} (${ms}ms)${hit} ${hit ? '' : String(detail).slice(0, 70)}`);
    return /11128/.test(text);
  } catch (e) {
    console.log(`${label.padEnd(38)} -> EXCEPTION ${e.message}`);
    return false;
  }
}

(async () => {
  const rt = realTools();
  console.log(`真实工具 ${rt.length} 个；真实 system ${REAL_SYS.length} 字\n`);

  const msg = [{ role: 'user', content: 'say ok' }];
  const base = { model: MODEL, stream: false, max_tokens: 16, messages: msg };

  const combos = [
    ['① 短 system + 假工具45', { ...base, messages: [{ role: 'system', content: SHORT_SYS }, ...msg], tools: fakeTools(45) }],
    ['② 真实 system + 假工具45', { ...base, messages: [{ role: 'system', content: REAL_SYS }, ...msg], tools: fakeTools(45) }],
    ['③ 短 system + 真实工具', { ...base, messages: [{ role: 'system', content: SHORT_SYS }, ...msg], tools: rt }],
    ['④ 真实 system + 真实工具', { ...base, messages: [{ role: 'system', content: REAL_SYS }, ...msg], tools: rt }],
    ['⑤ 真实 system + 真实工具 + tools_choice', { ...base, messages: [{ role: 'system', content: REAL_SYS }, ...msg], tools: rt, tool_choice: 'auto' }],
    ['⑥ 真实 system + 无工具', { ...base, messages: [{ role: 'system', content: REAL_SYS }, ...msg] }],
  ];

  let firstHit = null;
  for (const [label, body] of combos) {
    const hit = await call(label, body);
    if (hit && !firstHit) firstHit = label;
  }
  console.log(`\n--- 首个命中 11128 的组合：${firstHit || '无'}`);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
