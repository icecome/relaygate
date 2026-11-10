'use strict';
/**
 * scripts/probes/wb-fail-scan.js — 扫描 traffic.jsonl，列出非 200 的上游调用与错误分类。
 * 用法：node scripts/probes/wb-fail-scan.js [天数=3] [平台过滤=workbuddy|trae|all]
 */
const fs = require('fs');
const path = require('path');

const DAYS = Number(process.argv[2] || 3);
const PLAT = process.argv[3] || 'all';
const ROOT = path.join(__dirname, '..', '..', 'logs');

const dates = fs.readdirSync(ROOT).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse().slice(0, DAYS);
let n = 0;
for (const d of dates) {
  const f = path.join(ROOT, d, 'traffic.jsonl');
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.status === 200) continue;
    if (PLAT !== 'all' && j.platform !== PLAT) continue;
    n += 1;
    const err = String(j.error || '').replace(/\s+/g, ' ').slice(0, 260);
    console.log(`${j.ts} ${j.endpoint} model=${j.model} routed=${j.routedTo || '-'} acct=${j.accountId || '-'} st=${j.status} dur=${j.durationMs}ms attempt=${j.attempt} toolsIn=${j.toolsIn} :: ${err}`);
  }
}
console.log(`--- 非200 行数=${n}（近 ${DAYS} 天，平台=${PLAT}）`);
