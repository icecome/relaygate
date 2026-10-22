'use strict';
// Qoder asar 头解析（不依赖 @electron/asar，避免联网安装）。
// 布局（electron 30+ 的 size-prefix 形态）：
//   [0..4)   = 4                  → 后续长度字段占 4 字节
//   [4..8)   = totalHeaderSize    = 4 + strSize
//   [8..12)  = strSize            = 4 + jsonLen
//   [12..16) = jsonLen
//   [16..16+jsonLen) = JSON header
//   [16+jsonLen..) = 文件数据区（按 header 内 offset 定位）
const fs = require('fs');
const p = 'C:\\opt\\workstations\\agents\\Qoder\\resources\\app.asar';
const b = fs.readFileSync(p);
const jsonLen = b.readUInt32LE(12);
const hdrStart = 16;
const hdr = JSON.parse(b.slice(hdrStart, hdrStart + jsonLen).toString('utf8'));
const dataStart = hdrStart + jsonLen;

const files = [];
function walk(node, dir) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const rel = dir ? `${dir}/${name}` : name;
    if (child.files) walk(child, rel);
    else files.push({ path: rel, size: child.size, offset: child.offset });
  }
}
walk(hdr, '');

// 按目录归类输出，便于定位业务代码
const byTop = {};
for (const f of files) {
  const top = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : '(root)';
  (byTop[top] = byTop[top] || []).push(f);
}
const lines = [];
lines.push(`total files: ${files.length}`);
lines.push(`jsonLen: ${jsonLen}  dataStart: ${dataStart}  asarSize: ${b.length}`);
lines.push('');
lines.push('=== top-level dirs ===');
for (const k of Object.keys(byTop).sort()) {
  const arr = byTop[k];
  const bytes = arr.reduce((s, x) => s + (x.size || 0), 0);
  lines.push(`${k}  (${arr.length} files, ${(bytes / 1024).toFixed(0)} KB)`);
}
fs.writeFileSync('C:\\opt\\workstations\\project\\web\\RelayGate\\logs\\qoder-asar-summary.txt', lines.join('\n'));

// 全量文件清单（js/ts/json 优先）
const all = files.map((f) => `${f.size}\t${f.path}`).sort();
fs.writeFileSync('C:\\opt\\workstations\\project\\web\\RelayGate\\logs\\qoder-asar-files.txt', all.join('\n'));
console.log(lines.join('\n'));
