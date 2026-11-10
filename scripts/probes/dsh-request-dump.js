'use strict';
/**
 * scripts/probes/dsh-request-dump.js — 从 DSH 会话日志还原「真实发往上游的请求」：
 * system 提示全文 + 工具定义 + 消息序列，用于精确二分复现 11128。
 *
 * 用法：
 *   node scripts/probes/dsh-request-dump.js            # 最新会话的 request/context
 *   node scripts/probes/dsh-request-dump.js <会话id前缀>
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
console.log('session:', path.basename(path.dirname(target.full)));
console.log('mtime  :', new Date(target.m).toISOString());

let nHeader = 0;
let nCtx = 0;
for (const ln of text.split('\n')) {
  if (!ln.trim()) continue;
  let j;
  try { j = JSON.parse(ln); } catch { continue; }
  if (j.type === 'request/header') {
    nHeader += 1;
    const h = j.data && j.data.header;
    if (!h) continue;
    console.log(`\n=== request/header #${nHeader} time=${new Date(j.time).toISOString()}`);
    console.log('config:', JSON.stringify(h.config));
    console.log('tools:', (h.tools || []).length, (h.tools || []).map((t) => t.name).join(','));
    if (h.system) console.log('systemLen:', String(h.system).length);
    continue;
  }
  if (j.type === 'request/context') {
    nCtx += 1;
    const d = j.data || {};
    console.log(`\n=== request/context #${nCtx}`);
    const keys = Object.keys(d);
    console.log('keys:', keys.join(','));
    for (const k of keys) {
      const v = d[k];
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      console.log(`--- ${k} (len ${s ? s.length : 0})`);
      console.log(String(s).slice(0, 1200));
    }
  }
  if (j.type === 'system/message') {
    const d = j.data || {};
    const s = JSON.stringify(d);
    console.log(`\n=== system/message (len ${s.length})`);
    console.log(s.slice(0, 1200));
  }
}
console.log(`\n--- headers=${nHeader} contexts=${nCtx}`);
