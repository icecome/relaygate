'use strict';
// 解析 Qoder CN app.asar 头（与 parse-qoder-asar.js 同构，换路径）。
const fs = require('fs');
const p = 'C:\\opt\\workstations\\agents\\Qoder CN\\resources\\app.asar';
const b = fs.readFileSync(p);
const jsonLen = b.readUInt32LE(12);
const hdr = JSON.parse(b.slice(16, 16 + jsonLen).toString('utf8'));
const dataStart = 16 + jsonLen;
const files = [];
function walk(node, dir) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const rel = dir ? `${dir}/${name}` : name;
    if (child.files) walk(child, rel);
    else files.push({ path: rel, size: child.size, offset: child.offset });
  }
}
walk(hdr, '');
const byTop = {};
for (const f of files) {
  const top = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : '(root)';
  (byTop[top] = byTop[top] || []).push(f);
}
const lines = [`CN asar total files: ${files.length}`, `jsonLen: ${jsonLen} dataStart: ${dataStart} asarSize: ${b.length}`, ''];
for (const k of Object.keys(byTop).sort()) {
  lines.push(`${k}  (${byTop[k].length} files, ${(byTop[k].reduce((s, x) => s + (x.size || 0), 0) / 1024).toFixed(0)} KB)`);
}
fs.writeFileSync('C:\\opt\\workstations\\project\\web\\RelayGate\\logs\\qoder-cn-asar-summary.txt', lines.join('\n'));
console.log(lines.join('\n'));
module.exports = { hdr, dataStart, files };
