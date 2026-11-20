'use strict';
/**
 * scripts/probes/wb-first-request.js — 每天第一条 WB chat 流量的时刻与结果。
 *
 * 用途：验证「11128 集中出现在每日首次 WB 请求 + 早间维护窗口」的假设。
 * 用法：node scripts/probes/wb-first-request.js
 */
const fs = require('fs');
const path = require('path');

const GATE = path.join(__dirname, '..', '..', 'logs');
const RE = /code["']?\s*[:=]\s*11128|unapproved channel|Illegal API invocation/i;

const days = fs.readdirSync(GATE).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
console.log('date        firstWB(UTC)        status  inWindow(00:45-02:00Z)  wbReqs  wb11128');
for (const d of days) {
  const f = path.join(GATE, d, 'traffic.jsonl');
  if (!fs.existsSync(f)) continue;
  const rows = [];
  for (const ln of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    let j;
    try { j = JSON.parse(ln); } catch { continue; }
    if (j.tag !== 'traffic') continue;
    if (!/workbuddy/.test(String(j.routedTo || ''))) continue;
    rows.push(j);
  }
  if (!rows.length) { console.log(`${d}    （无 WB 流量）`); continue; }
  const first = rows[0];
  const hit = rows.filter((r) => RE.test(String(r.error || ''))).length;
  // 早间维护窗口：checkin 00:45Z 起，trae+wb 各铺 30min → 约 00:45-02:00Z
  const t = first.ts.slice(11, 19);
  const inWin = t >= '00:45:00' && t <= '02:00:00';
  console.log(`${d}    ${first.ts.slice(11, 19)}       ${first.status}     ${inWin ? 'YES' : 'no'}                   ${String(rows.length).padEnd(5)}   ${hit}`);
}
