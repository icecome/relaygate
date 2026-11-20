'use strict';
/**
 * scripts/probes/wb-asar-extract.js — 从本机 app.asar 提取渠道校验相关的头集代码。
 *
 * 用途：客户端升级后核对 applyGatewayHeaders / buildConversationHeaders 形状
 * 是否变化（5.8.3→5.9.3 曾新增 acp-connection-id / X-Agent-Runtime / X-Agent-Type，
 * 若 5.11.3 再变而网关不跟，就是又一次 11128 形状衰减）。
 *
 * 用法：node scripts/probes/wb-asar-extract.js [匹配正则] [输出目录]
 *   默认抓 gateway/Conversation 头相关模块，落到 logs/_asar-<版本>/
 */
const fs = require('fs');
const path = require('path');

const { discoverAsar } = require('../lib/wb-install');
const found = discoverAsar();
if (!found) { console.error('未找到 app.asar'); process.exit(1); }
const asar = found.asar;
console.log('asar:', asar, '(' + found.source + ')');

const buf = fs.readFileSync(asar);
const jsonLen = buf.readUInt32LE(12);
const hdr = JSON.parse(buf.slice(16, 16 + jsonLen).toString('utf8'));
const DATA = 8 + buf.readUInt32LE(4);

function* files(node, prefix = '') {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (child.files) yield* files(child, p);
    else if (child.size != null) yield { path: p, node: child };
  }
}

const WANT_RE = process.argv[2]
  ? new RegExp(process.argv[2])
  : /(server\.js$|codebuddy-lite|buildConversationHeaders|applyGatewayHeaders)/i;

// 先读根 package.json 拿版本号做输出目录
function readFile(rel) {
  let node = hdr;
  for (const s of rel.split('/')) { node = node && node.files ? node.files[s] : undefined; if (!node) return null; }
  if (node.files || node.size == null) return null;
  if (node.unpacked) {
    const p = asar + '.unpacked/' + rel;
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  return Buffer.from(buf.slice(DATA + Number(node.offset), DATA + Number(node.offset) + Number(node.size)));
}

const pkg = JSON.parse(readFile('package.json').toString('utf8'));
const outDir = path.join(__dirname, '..', '..', 'logs', '_asar-' + (pkg.version || 'unknown'));
fs.mkdirSync(outDir, { recursive: true });
console.log('app version:', pkg.version, '→ 输出目录', outDir);

let n = 0;
for (const f of files(hdr)) {
  if (!f.path.endsWith('.js') && !f.path.endsWith('.mjs')) continue;
  if (!WANT_RE.test(f.path)) continue;
  // 大文件先抽样搜关键字，命中再落盘
  const raw = readFile(f.path);
  if (!raw) continue;
  const text = raw.toString('utf8');
  if (!/acp-connection-id|X-Agent-Runtime|buildConversationHeaders|applyGatewayHeaders/i.test(text)) continue;
  const safe = f.path.replace(/[\\/]/g, '__');
  fs.writeFileSync(path.join(outDir, safe), text);
  console.log('  saved:', f.path, `(${(text.length / 1024).toFixed(0)}KB)`);
  n++;
  if (n >= 12) break;
}
console.log(n ? `共 ${n} 个模块` : '没有命中头集关键字的模块 —— 形状可能大改，需人工检查');
