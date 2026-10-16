'use strict';
// Raccoon (商汤小浣熊) app.asar 头解析 —— 仿 parse-qoder-asar.js，零依赖。
// 布局（electron 30+ size-prefix 形态）：
//   [0..4)   = 4
//   [4..8)   = totalHeaderSize
//   [8..12)  = strSize (= 4 + jsonLen)
//   [12..16) = jsonLen
//   [16..16+jsonLen) = JSON header
//   之后 = 文件数据区（按 header 内 offset 定位）
const fs = require('fs');
const path = require('path');

const ASAR = process.env.RACCOON_ASAR ||
  'C:\\opt\\workstations\\agents\\raccoon-ai\\resources\\app.asar';
const OUTDIR = process.env.RACCOON_OUT ||
  'C:\\opt\\workstations\\project\\web\\RelayGate\\logs\\raccoon-extracted';

const b = fs.readFileSync(ASAR);
const jsonLen = b.readUInt32LE(12);
const hdrStart = 16;
const hdr = JSON.parse(b.slice(hdrStart, hdrStart + jsonLen).toString('utf8'));
const dataStart = hdrStart + jsonLen;

const files = [];
function walk(node, dir) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const rel = dir ? `${dir}/${name}` : name;
    if (child.files) walk(child, rel);
    else files.push({ path: rel, size: Number(child.size), offset: Number(child.offset), unpacked: !!child.unpacked });
  }
}
walk(hdr, '');

fs.mkdirSync(OUTDIR, { recursive: true });

// 顶层目录归类
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
fs.writeFileSync(path.join(OUTDIR, 'raccoon-asar-summary.txt'), lines.join('\n'));

// 全量清单
const all = files.map((f) => `${f.size}\t${f.unpacked ? 'U' : ' '}\t${f.path}`).sort();
fs.writeFileSync(path.join(OUTDIR, 'raccoon-asar-files.txt'), all.join('\n'));

console.log(lines.join('\n'));
