'use strict';
// 从 Raccoon app.asar 抽取指定前缀/文件到磁盘（只读，不修改原包）。
// 用法: node extract-raccoon-asar.js [--all | <prefix-or-path> ...]
const fs = require('fs');
const path = require('path');

const ASAR = process.env.RACCOON_ASAR ||
  'C:\\opt\\workstations\\agents\\raccoon-ai\\resources\\app.asar';
const OUT = process.env.RACCOON_OUT ||
  'C:\\opt\\workstations\\project\\web\\RelayGate\\logs\\raccoon-extracted\\asar';

const b = fs.readFileSync(ASAR);
const jsonLen = b.readUInt32LE(12);
const hdr = JSON.parse(b.slice(16, 16 + jsonLen).toString('utf8'));
const DATA = 16 + jsonLen;

const index = new Map();
(function walk(node, dir) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const rel = dir ? `${dir}/${name}` : name;
    if (child.files) walk(child, rel);
    else index.set(rel, child);
  }
})(hdr, '');

function extract(rel) {
  const node = index.get(rel);
  const size = Number(node.size), off = Number(node.offset);
  return b.slice(DATA + off, DATA + off + size);
}

const args = process.argv.slice(2);
const prefixes = args.includes('--all') ? ['build/'] : args.length ? args : ['build/electron/main.js'];

let n = 0, bytes = 0;
for (const rel of [...index.keys()].sort()) {
  if (!prefixes.some((p) => rel === p || rel.startsWith(p))) continue;
  const node = index.get(rel);
  if (node.unpacked) continue; // 已在 app.asar.unpacked 里
  const dest = path.join(OUT, rel.replace(/[\\/]/g, path.sep));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const buf = extract(rel);
  fs.writeFileSync(dest, buf);
  n++; bytes += buf.length;
}
console.log(`extracted ${n} files (${(bytes / 1024 / 1024).toFixed(1)} MB) -> ${OUT}`);
