'use strict';
// 抽取 asar 内 out/ 下的全部 .js/.json（含 renderer 的 webpack chunk），用于离线检索。
// 资源（字体/图片/cmap/wasm）跳过：体积大且与协议分析无关。
const fs = require('fs');
const path = require('path');

const ASAR = 'C:\\opt\\workstations\\agents\\Qoder\\resources\\app.asar';
const OUT = 'C:\\opt\\workstations\\project\\web\\RelayGate\\logs\\qoder-code';

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

let n = 0;
let bytes = 0;
for (const [rel, node] of index) {
  if (!rel.startsWith('out/')) continue;
  const l = rel.toLowerCase();
  if (!(l.endsWith('.js') || l.endsWith('.mjs') || l.endsWith('.cjs') || l.endsWith('.json'))) continue;
  if (l.includes('.map')) continue;
  const size = typeof node.size === 'string' ? Number(node.size) : node.size;
  const off = typeof node.offset === 'string' ? Number(node.offset) : node.offset;
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(b.slice(DATA + off, DATA + off + size)));
  n += 1;
  bytes += size;
}
console.log(`extracted ${n} files, ${(bytes / 1024 / 1024).toFixed(1)} MB -> ${OUT}`);
