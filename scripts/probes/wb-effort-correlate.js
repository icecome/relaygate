'use strict';
/**
 * scripts/probes/wb-effort-correlate.js — 全量统计近 N 天 provider=wb 请求的
 * reasoningEffort 分布 × 网关结果，验证「reasoning 请求（developer role）→ 11128」假说。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(process.env.USERPROFILE || '', '.dsh', 'sessions');
const GATE = path.join(__dirname, '..', '..', 'logs');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DAYS = Number(process.argv[2]) || 11;

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

// traffic 按秒索引
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
    if (!/workbuddy/.test(String(j.routedTo || ''))) continue;
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

// 全部 provider=wb 的 request/header（不限有 SYS 的）
const files = walk(ROOT).filter((x) => x.m >= since).sort((a, b) => b.m - a.m);
const stats = new Map(); // key=effort, value={ok, fail11128, failOther, sysMax}
let matched = 0;
for (const { f } of files) {
  let t;
  try { t = dec(fs.readFileSync(f)); } catch { continue; }
  if (!t.includes('"provider":"wb"')) continue;
  for (const ln of t.split('\n')) {
    if (!ln.includes('request/header')) continue;
    let j;
    try { j = JSON.parse(ln); } catch { continue; }
    const h = (j.data && j.data.header) || {};
    const cfg = h.config || {};
    if (cfg.provider !== 'wb') continue;
    const time = new Date(j.time || 0).toISOString();
    const sec = time.slice(0, 19);
    const cands = [];
    for (const [s2, arr] of bySec) {
      const d = Math.abs(new Date(s2 + 'Z') - new Date(sec + 'Z'));
      if (d <= 3000) cands.push(...arr);
    }
    if (!cands.length) continue; // 无法对齐的（非网关路径/超窗）不计
    matched++;
    const effort = cfg.reasoningEffort || '(未设置)';
    const bad = cands.some((c) => /11128/.test(String(c.error || '')));
    const fail = cands.every((c) => c.status !== 200);
    const k = effort;
    if (!stats.has(k)) stats.set(k, { ok: 0, b11128: 0, failOther: 0 });
    const s = stats.get(k);
    if (bad) s.b11128++;
    else if (fail) s.failOther++;
    else s.ok++;
  }
}
console.log(`对齐成功 ${matched} 条 provider=wb 请求\n`);
console.log('reasoningEffort   200  11128  其他失败');
for (const [k, v] of [...stats.entries()].sort((a, b) => b.b11128 - a.b11128)) {
  console.log(`${k.padEnd(14)} ${String(v.ok).padStart(5)} ${String(v.b11128).padStart(6)} ${String(v.failOther).padStart(8)}`);
}
