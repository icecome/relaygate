'use strict';
/**
 * scripts/probes/dsh-wb-fails.js — 精确列出 DSH 历史里 provider=workbuddy 的**调用失败**。
 *
 * 判据：request/header 的 config.provider 是 workbuddy，随后同一会话里出现
 * assistant/attempt 的 finish.reason.kind === "error"，取其中的 failure.message。
 * （上一个脚本把 workbuddy 请求之后的任意含 error 字样文本都算进来，噪声太大。）
 */
const fs = require('fs');
const path = require('path');
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
    const start = frames[k];
    const end = k + 1 < frames.length ? frames[k + 1] : buf.length;
    try { out += zlib.zstdDecompressSync(buf.slice(start, end)).toString('utf8'); } catch { /* 残帧 */ }
  }
  return out;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.jsonl.zstd')) out.push(full);
  }
  return out;
}

const files = walk(ROOT).map((f) => ({ f, mtime: fs.statSync(f).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
const stats = new Map();
let total = 0;

for (const { f, mtime } of files) {
  let text;
  try { text = decompressAll(fs.readFileSync(f)); } catch { continue; }
  const sid = path.basename(path.dirname(f));
  const lines = text.split('\n').filter((l) => l.trim());

  // 逐行维护「当前请求的 provider/model」
  let route = null;
  for (const ln of lines) {
    let j;
    try { j = JSON.parse(ln); } catch { continue; }
    if (j.type === 'request/header') {
      const c = j.data && j.data.header && j.data.header.config;
      if (c) route = `${c.provider}/${c.model}`;
      continue;
    }
    if (j.type !== 'assistant/attempt') continue;
    const stream = (j.data && j.data.stream) || [];
    for (const ev of stream) {
      const ch = ev.chunk;
      if (!ch || ch.type !== 'finish') continue;
      if (!ch.reason || ch.reason.kind !== 'error') continue;
      const msg = (ch.reason.failure && (ch.reason.failure.message || ch.reason.failure)) || '(no message)';
      const key = String(route || '?');
      if (!stats.has(key)) stats.set(key, []);
      stats.get(key).push({ ts: new Date(mtime).toISOString().slice(0, 16), sid: sid.slice(0, 24), msg: String(msg).slice(0, 260) });
      total += 1;
    }
  }
}

console.log('=== provider=workbuddy 的失败原文');
let wbTotal = 0;
for (const [route, list] of [...stats.entries()].sort((a, b) => b[1].length - a[1].length)) {
  if (!/workbuddy|^re\/vm\/wb/.test(route)) continue;
  wbTotal += list.length;
  console.log(`\n--- ${route}  (${list.length} 次)`);
  for (const it of list.slice(0, 8)) console.log(`  ${it.ts} ${it.sid} :: ${it.msg}`);
}
console.log(`\n--- workbuddy 路由失败合计 ${wbTotal} 次 / 全部失败 ${total} 次 / 会话 ${files.length} 个`);

console.log('\n=== 全部路由失败次数（前 15）');
for (const [route, list] of [...stats.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 15)) {
  console.log(`  ${String(list.length).padStart(4)}  ${route}`);
}
