'use strict';
// 从 Qoder app.asar 里抽取指定文件内容（用于阅读，不做修改）。
const fs = require('fs');
const path = require('path');

const ASAR = 'C:\\opt\\workstations\\agents\\Qoder\\resources\\app.asar';
const OUT = 'C:\\opt\\workstations\\project\\web\\RelayGate\\logs\\qoder-extracted';

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

function extract(relPath) {
  const node = index.get(relPath);
  if (!node) throw new Error(`not found in asar: ${relPath}`);
  const size = typeof node.size === 'string' ? Number(node.size) : node.size;
  const off = typeof node.offset === 'string' ? Number(node.offset) : node.offset;
  const slice = b.slice(DATA + off, DATA + off + size);
  return Buffer.from(slice);
}

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('usage: node extract-qoder-asar.js <path-in-asar> [...]');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
for (const t of targets) {
  const dest = path.join(OUT, t.replace(/[\\/]/g, '__'));
  try {
    fs.writeFileSync(dest, extract(t));
    console.log(`OK  ${t}  -> ${dest}`);
  } catch (e) {
    console.log(`ERR ${t}: ${e.message}`);
  }
}
