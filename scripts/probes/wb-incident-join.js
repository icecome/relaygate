'use strict';
/**
 * scripts/probes/wb-incident-join.js — 把 DSH 会话日志里 provider=wb 的请求头
 * 与网关 traffic.jsonl 的成败记录按时间对齐，输出「systemLen × 结果」数据集。
 *
 * 用途：判断 11128 是否与 system 长度/迁位相关（11-13、11-19 零星复发）。
 * 用法：node scripts/probes/wb-incident-join.js [天数，默认 10]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(process.env.USERPROFILE || '', '.dsh', 'sessions');
const GATE = path.join(__dirname, '..', '..', 'logs');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DAYS = Number(process.argv[2]) || 10;

function dec(buf) {
  const fr = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) >= 0) { fr.push(i); i += 4; }
  if (!fr.length) return zlib.zstdDecompressSync(buf).toString('utf8');
  let out = '';
  for (let k = 0; k < fr.length; k++) {
    const s = fr[k];
    const e = k + 1 < fr.length ? fr[k + 1] : buf.length;
    try { out += zlib.zstdDecompressSync(buf.slice(s, e)).toString('utf8'); } catch { /* 残帧 */ }
  }
  return out;
}
function walk(d, o = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f, o);
    else if (e.name.endsWith('.jsonl.zstd')) o.push({ f, m: fs.statSync(f).mtimeMs });
  }
  return o;
}

// 1) traffic.jsonl 全量读入（近 N 天），按秒聚合
const traffic = [];
const since = Date.now() - DAYS * 86400000;
for (const e of fs.readdirSync(GATE)) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e)) continue;
  const f = path.join(GATE, e, 'traffic.jsonl');
  if (!fs.existsSync(f)) continue;
  for (const ln of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    let j;
    try { j = JSON.parse(ln); } catch { continue; }
    if (j.tag !== 'traffic') continue;
    if (!/^wb\/|workbuddy/.test(String(j.routedTo || j.model || ''))) continue;
    traffic.push(j);
  }
}
traffic.sort((a, b) => a.ts.localeCompare(b.ts));
const bySec = new Map();
for (const t of traffic) {
  const sec = t.ts.slice(0, 19);
  if (!bySec.has(sec)) bySec.set(sec, []);
  bySec.get(sec).push(t);
}

// 2) 扫会话日志（近 N 天修改过的），取 provider=wb 的 HDR 与相邻 SYS
const files = walk(ROOT).filter((x) => x.m >= since).sort((a, b) => b.m - a.m);
console.log(`traffic ${traffic.length} 条；会话文件 ${files.length} 个\n`);
const rows = [];
for (const { f } of files) {
  let t;
  try { t = dec(fs.readFileSync(f)); } catch { continue; }
  let lastSys = null;
  for (const ln of t.split('\n')) {
    if (!ln.includes('request/header') && !ln.includes('system/message')) continue;
    let j;
    try { j = JSON.parse(ln); } catch { continue; }
    if (j.type === 'system/message') {
      const c = j.data && j.data.message && j.data.message.content;
      lastSys = { time: new Date(j.time || 0).toISOString(), turn: j.data.turn, len: typeof c === 'string' ? c.length : JSON.stringify(c || '').length };
      continue;
    }
    const cfg = (j.data && j.data.header && j.data.header.config) || {};
    if (cfg.provider !== 'wb') continue;
    const time = new Date(j.time || 0).toISOString();
    rows.push({ time, model: cfg.model, tools: ((j.data.header.tools) || []).length, sys: lastSys && Math.abs(new Date(lastSys.time) - new Date(time)) < 5000 ? lastSys : null });
  }
}
rows.sort((a, b) => a.time.localeCompare(b.time));

// 3) join：±3 秒内的 traffic 记录
console.log('time(UTC)              turn  sysLen  tools -> 结果');
for (const r of rows) {
  const sec = r.time.slice(0, 19);
  const cands = [];
  for (const [s2, arr] of bySec) {
    const d = Math.abs(new Date(s2 + 'Z') - new Date(sec + 'Z'));
    if (d <= 3000) cands.push(...arr);
  }
  const st = cands.length ? cands.map((c) => `${c.status}${/11128/.test(String(c.error || '')) ? '!!11128' : ''}`).join(',') : '无traffic';
  console.log(`${r.time} turn=${r.sys ? r.sys.turn : '?'} sysLen=${String(r.sys ? r.sys.len : '?').padEnd(6)} tools=${String(r.tools).padEnd(3)} -> ${st}`);
}
