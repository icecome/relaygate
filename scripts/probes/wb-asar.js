'use strict';
/**
 * scripts/wb-asar.js —— WorkBuddy app.asar 只读探针。
 *
 * 用途：定位「接口检测 / 渠道校验」相关代码，分析 400 code=11128
 * （Illegal API invocation from an unapproved channel）的判定依据。
 *
 * 用法：
 *   node scripts/wb-asar.js list  [子串]            # 列出 asar 内条目（可按路径子串过滤）
 *   node scripts/wb-asar.js cat   <asar内路径>      # 打印单文件内容到 stdout
 *   node scripts/wb-asar.js dump  <子串> <输出目录>  # 把路径含子串的文本文件全量导出
 *   node scripts/wb-asar.js grep  <正则> [--max N]  # 在 asar 内全部文本条目里做正则搜索
 */
const fs = require('fs');
const path = require('path');

// 安装路径探测：WB_ASAR → 注册表 DisplayIcon/UninstallString → 常见安装路径
// （不写死开发机路径，换机器也能用；见 scripts/lib/wb-install.js）。
const { discoverAsar } = require('../lib/wb-install');
const found = discoverAsar();
if (!found) {
  console.error('[wb-asar] 未探测到 WorkBuddy 安装（可设置 WB_ASAR 指向 app.asar）');
  process.exit(1);
}
const ASAR = found.asar;

const buf = fs.readFileSync(ASAR);
const jsonLen = buf.readUInt32LE(12);
const hdr = JSON.parse(buf.slice(16, 16 + jsonLen).toString('utf8'));
// asar（Chrome pickle）数据区基点 = 8 + u32@4（4 字节对齐）；用 16+jsonLen
// 会差 1~3 字节填充，读出的内容错位。
const DATA = 8 + buf.readUInt32LE(4);

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
  if (!node) throw new Error('not found in asar: ' + rel);
  if (node.unpacked) {
    const p = path.join(ASAR + '.unpacked', rel);
    return fs.readFileSync(p);
  }
  const size = Number(node.size);
  const off = Number(node.offset);
  return Buffer.from(buf.slice(DATA + off, DATA + off + size));
}

function isText(rel, node) {
  if (/\.(js|mjs|cjs|json|ts|html|css|map|txt|md|yml|yaml)$/i.test(rel)) return true;
  if (node.size && Number(node.size) > 8 * 1024 * 1024) return false;
  return false;
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'list') {
  const sub = (rest[0] || '').toLowerCase();
  let n = 0;
  for (const [rel, node] of index) {
    if (sub && !rel.toLowerCase().includes(sub)) continue;
    n++;
    console.log(String(node.size).padStart(10), rel);
  }
  console.error(`-- ${n} entries`);
} else if (cmd === 'cat') {
  process.stdout.write(extract(rest[0]));
} else if (cmd === 'dump') {
  const sub = (rest[0] || '').toLowerCase();
  const outDir = rest[1];
  fs.mkdirSync(outDir, { recursive: true });
  let n = 0;
  for (const [rel, node] of index) {
    if (sub && !rel.toLowerCase().includes(sub)) continue;
    if (!isText(rel, node)) continue;
    const dest = path.join(outDir, rel.replace(/[\\/]/g, '__'));
    try {
      fs.writeFileSync(dest, extract(rel));
      n++;
    } catch (e) {
      console.error('ERR', rel, e.message);
    }
  }
  console.log(`dumped ${n} files -> ${outDir}`);
} else if (cmd === 'grep') {
  const re = new RegExp(rest[0], 'gi');
  const maxArg = rest.indexOf('--max');
  const max = maxArg >= 0 ? Number(rest[maxArg + 1]) : 60;
  let hits = 0;
  for (const [rel, node] of index) {
    if (!isText(rel, node)) continue;
    let txt;
    try { txt = extract(rel).toString('utf8'); } catch { continue; }
    if (!re.test(txt)) continue;
    re.lastIndex = 0;
    const lines = txt.split(/\r?\n/);
    lines.forEach((ln, i) => {
      re.lastIndex = 0;
      if (re.test(ln) && hits < max) {
        hits++;
        console.log(`${rel}:${i + 1}: ${ln.trim().slice(0, 300)}`);
      }
    });
    if (hits >= max) break;
  }
  console.error(`-- ${hits} hits (max ${max})`);
} else {
  console.error('usage: node scripts/wb-asar.js list|cat|dump|grep ...');
  process.exit(1);
}
