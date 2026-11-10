'use strict';
/**
 * scripts/probes/dsh-wb-history.js — 专门找 DSH 历史里「workbuddy 路由」的失败与报错原文。
 * 区别：上次 scan 只认 finish.reason kind=error，workbuddy 的失败可能被 DSH 归类成别的形态；
 * 这里直接把所有含 workbuddy 路由 / workbuddy 上游错误文案的行捞出来。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(process.env.USERPROFILE || '', '.dsh', 'sessions');
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
    try { out += zlib.zstdDecompressSync(buf.slice(start, end)).toString('utf8'); } catch { /* 残帧 */ }
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

const files = walk(ROOT).map((f) => ({ f, mtime: fs.statSync(f).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
const WB_ROUTE = /"provider":"workbuddy"|"provider":"wb"/;
const WB_ERR = /workbuddy upstream|11128|11140|unapproved channel|is workbuddy-only|workbuddy.*(403|401|400|error|fail)/i;

let n = 0;
for (const { f, mtime } of files) {
  let text;
  try { text = decompressAll(fs.readFileSync(f)); } catch { continue; }
  const sid = path.basename(path.dirname(f));
  const lines = text.split('\n');
  // 记录 provider=workbuddy 的请求，找其后的失败
  let wbActive = false;
  let wbModel = '';
  for (const ln of lines) {
    if (!ln.trim()) continue;
    if (WB_ROUTE.test(ln)) {
      wbActive = true;
      const m = /"model":"([^"]+)"/.exec(ln);
      if (m) wbModel = m[1];
    }
    if (wbActive && (/"kind":"error"/.test(ln) || WB_ERR.test(ln))) {
      n += 1;
      const msg = /"message":"((?:[^"\\]|\\.){0,300})"/.exec(ln);
      console.log(`${new Date(mtime).toISOString().slice(0, 10)} ${sid.slice(0, 24)} wbModel=${wbModel || '?'} :: ${msg ? msg[1].slice(0, 240) : ln.slice(0, 200)}`);
      wbActive = false;
    }
  }
}
console.log(`--- workbuddy 相关失败 ${n} 条`);
