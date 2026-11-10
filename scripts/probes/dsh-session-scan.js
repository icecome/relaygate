'use strict';
/**
 * scripts/probes/dsh-session-scan.js — 解压 DSH 会话日志（zstd 多帧 jsonl），
 * 找出「用户在 DSH 里真实看到的失败」，尤其是 WorkBuddy 链路的失败。
 *
 * 用法：
 *   node scripts/probes/dsh-session-scan.js                 # 扫描全部会话，列出模型调用失败
 *   node scripts/probes/dsh-session-scan.js 20 'wb/'        # 只看最近 20 个会话，含指定关键字的行
 *   node scripts/probes/dsh-session-scan.js 0 dump <文件>   # 解压单个会话到 logs/_dsh-session.txt
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(process.env.USERPROFILE || '', '.dsh', 'sessions');
const LIMIT = Number(process.argv[2] || 0);
const NEEDLE = (process.argv[3] || '').trim();
const MODE = process.argv[4] || '';
const TARGET = process.argv[5] || '';

/** zstd 是分帧追加的（DSH 每次写入一帧），要按魔数切帧逐帧解。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decompressAll(buf) {
  const frames = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) >= 0) { frames.push(i); i += 4; }
  if (!frames.length) return zlib.zstdDecompressSync(buf).toString('utf8');
  let out = '';
  for (let k = 0; k < frames.length; k++) {
    const start = frames[k];
    const end = k + 1 < frames.length ? frames[k + 1] : buf.length;
    try { out += zlib.zstdDecompressSync(buf.slice(start, end)).toString('utf8'); } catch { /* 残帧忽略 */ }
  }
  return out;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.jsonl.zstd')) out.push(full);
  }
  return out;
}

if (MODE === 'dump') {
  const text = decompressAll(fs.readFileSync(TARGET));
  const out = path.join(__dirname, '..', '..', 'logs', '_dsh-session.txt');
  fs.writeFileSync(out, text);
  console.log(`dumped ${text.length} bytes -> ${out}`);
  process.exit(0);
}

const files = walk(ROOT)
  .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);
const scope = LIMIT ? files.slice(0, LIMIT) : files;

// 失败判定：DSH 的 assistant/attempt 里 finish.reason.kind === 'error'
const FAIL_RE = /"kind":"error"/;
const ROUTE_RE = /"provider":"([^"]+)","model":"([^"]+)"/;

let nFail = 0;
const routes = new Map();
for (const { f, mtime } of scope) {
  let text;
  try { text = decompressAll(fs.readFileSync(f)); } catch { continue; }
  const sid = path.basename(path.dirname(f));
  const lines = text.split('\n');
  let currentRoute = null;
  const fails = [];
  for (const ln of lines) {
    if (!ln.trim()) continue;
    if (NEEDLE) {
      if (ln.includes(NEEDLE)) fails.push({ kind: 'match', ln });
      continue;
    }
    // 记录本会话用过的 provider/model
    const rm = ROUTE_RE.exec(ln);
    if (rm && ln.includes('"type":"request/header"')) currentRoute = rm[1] + '/' + rm[2];
    if (FAIL_RE.test(ln)) {
      // 抽 failure.message
      const msg = /"message":"((?:[^"\\]|\\.){0,400})"/.exec(ln);
      fails.push({ kind: 'fail', route: currentRoute, msg: msg ? msg[1] : '(no message)' });
    }
  }
  for (const r of fails) {
    if (r.kind === 'match') {
      console.log(`${sid} :: ${r.ln.slice(0, 300)}`);
      continue;
    }
    nFail += 1;
    const route = r.route || '?';
    routes.set(route, (routes.get(route) || 0) + 1);
    console.log(`${new Date(mtime).toISOString().slice(0, 10)} ${sid.slice(0, 26)} route=${route} :: ${r.msg.slice(0, 240)}`);
  }
}

if (!NEEDLE) {
  console.log('\n--- 失败按 route 聚合');
  for (const [k, v] of [...routes.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
  console.log(`--- 共 ${nFail} 次模型调用失败（扫描 ${scope.length} 个会话）`);
}
