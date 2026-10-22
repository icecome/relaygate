'use strict';
// 抽取 Qoder CN app.asar 内指定文件（与 extract-qoder-asar.js 同构，换路径）。
const fs = require('fs');
const path = require('path');
const ASAR = 'C:\\opt\\workstations\\agents\\Qoder CN\\resources\\app.asar';
const OUT = 'C:\\opt\\workstations\\project\\web\\RelayGate\\logs\\qoder-cn-extracted';
const b = fs.readFileSync(ASAR);
const jsonLen = b.readUInt32LE(12);
const hdr = JSON.parse(b.slice(16, 16 + jsonLen).toString('utf8'));
const DATA = 16 + jsonLen;
const index = new Map();
function walk(node, dir) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const rel = dir ? `${dir}/${name}` : name;
    if (child.files) walk(child, rel);
    else index.set(rel, child);
  }
}
walk(hdr, '');
const targets = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
for (const t of targets) {
  const node = index.get(t);
  if (!node) { console.log(`ERR ${t}: not found`); continue; }
  const size = typeof node.size === 'string' ? Number(node.size) : node.size;
  const off = typeof node.offset === 'string' ? Number(node.offset) : node.offset;
  const dest = path.join(OUT, t.replace(/[\\/]/g, '__'));
  fs.writeFileSync(dest, Buffer.from(b.slice(DATA + off, DATA + off + size)));
  console.log(`OK  ${t} -> ${dest} (${size}b)`);
}
