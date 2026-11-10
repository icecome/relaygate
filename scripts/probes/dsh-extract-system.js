'use strict';
/**
 * scripts/probes/dsh-extract-system.js — 从 DSH 会话日志里提取真实 system prompt 全文，
 * 落盘成 logs/_dsh-system.txt，供内容层二分复现使用。
 *
 * 用法：node scripts/probes/dsh-extract-system.js [会话 id 前缀]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(process.env.USERPROFILE || '', '.dsh', 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const WANT = process.argv[2] || '';

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

const files = walk(ROOT).sort((a, b) => b.m - a.m);
const target = WANT ? files.find((f) => f.full.includes(WANT)) : files[0];
if (!target) { console.error('未找到会话:', WANT); process.exit(1); }

const text = decompressAll(fs.readFileSync(target.full));
let best = '';
for (const ln of text.split('\n')) {
  if (!ln.includes('"type":"system/message"')) continue;
  let j;
  try { j = JSON.parse(ln); } catch { continue; }
  const content = j.data && j.data.message && j.data.message.content;
  if (!Array.isArray(content)) continue;
  const s = content.map((c) => (c && c.type === 'text' ? c.text : '')).join('\n');
  if (s.length > best.length) best = s;
}
if (!best) { console.error('会话里没有 system/message'); process.exit(1); }

const out = path.join(__dirname, '..', '..', 'logs', '_dsh-system.txt');
fs.writeFileSync(out, best);
console.log(`session ${path.basename(path.dirname(target.full))}`);
console.log(`system prompt ${best.length} chars -> ${out}`);
console.log('首行:', best.split('\n')[0]);
