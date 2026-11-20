'use strict';
/**
 * scripts/probes/dsh-asar-extract.js — 从 DSH 安装包（app.asar）提取请求构造相关模块。
 *
 * 用途：核对 DSH 客户端发给网关的请求体形状（system 放 messages[0] 还是顶层
 * system 字段），判断 11128 零星复发是否来自 DSH 侧的形状。
 * 用法：node scripts/probes/dsh-asar-extract.js
 */
const fs = require('fs');
const path = require('path');

const ASAR = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar');
const buf = fs.readFileSync(ASAR);
const jsonLen = buf.readUInt32LE(12);
const hdr = JSON.parse(buf.slice(16, 16 + jsonLen).toString('utf8'));
const DATA = 8 + buf.readUInt32LE(4);

function readFile(rel) {
  let node = hdr;
  for (const s of rel.split('/')) { node = node && node.files ? node.files[s] : undefined; if (!node) return null; }
  if (!node || node.files || node.size == null) return null;
  if (node.unpacked) {
    const p = ASAR + '.unpacked/' + rel;
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  return Buffer.from(buf.slice(DATA + Number(node.offset), DATA + Number(node.offset) + Number(node.size)));
}
function* files(node, prefix = '') {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (child.files) yield* files(child, p);
    else if (child.size != null) yield { path: p, node: child };
  }
}

const OUT = path.join(__dirname, '..', '..', 'logs', '_dsh-asar');
fs.mkdirSync(OUT, { recursive: true });
const outDir = OUT;

let n = 0;
const seen = new Set();
for (const f of files(hdr)) {
  if (!/\.js$/.test(f.path)) continue;
  // 只要主进程/服务端打包产物（.webpack / dist / main），跳过 node_modules 巨型包
  if (/node_modules/.test(f.path)) continue;
  const raw = readFile(f.path);
  if (!raw) continue;
  const text = raw.toString('utf8');
  if (text.length < 2000) continue;
  if (!/role:\s*["'`]system["'`]|"role":"system"|\bsystemPrompt\b/.test(text)) continue;
  const safe = f.path.replace(/[\\/]/g, '__');
  if (seen.has(safe)) continue;
  seen.add(safe);
  fs.writeFileSync(path.join(outDir, safe), text);
  n++;
  if (n >= 30) break;
}
console.log(`提取 ${n} 个模块到 ${outDir}`);
