'use strict';
/**
 * scripts/probes/wb-real-11128.js — 精确统计「上游真的回了 11128」的行，按日期聚合。
 * 子串匹配会把 totalTokens=211128 这类数字误命中，这里只认 error 字段里的
 * code=11128 / unapproved channel / Illegal API invocation。
 *
 * 用法：
 *   node scripts/probes/wb-real-11128.js             # 按日期聚合（默认）
 *   node scripts/probes/wb-real-11128.js list        # 逐条明细
 *   node scripts/probes/wb-real-11128.js list 3      # 只看最近 3 天明细
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'logs');
const RE = /code["']?\s*[:=]\s*11128|unapproved channel|Illegal API invocation/i;
const mode = process.argv[2] || 'summary';
const limitDays = Number(process.argv[3] || 0);

const dates = fs.readdirSync(ROOT).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
const scope = limitDays ? dates.slice(-limitDays) : dates;

let total = 0;
const byDate = new Map();
const rows = [];
for (const d of scope) {
  const f = path.join(ROOT, d, 'traffic.jsonl');
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!RE.test(String(j.error || ''))) continue;
    total += 1;
    byDate.set(d, (byDate.get(d) || 0) + 1);
    rows.push({ d, ts: j.ts, acct: j.accountId || '-', model: j.model, routed: j.routedTo || '-', st: j.status, dur: j.durationMs, toolsIn: j.toolsIn, attempt: j.attempt });
  }
}

if (mode === 'list') {
  for (const r of rows) {
    console.log(`${r.ts} acct=${r.acct} model=${r.model} routed=${r.routed} st=${r.st} dur=${r.dur}ms toolsIn=${r.toolsIn} attempt=${r.attempt}`);
  }
} else {
  for (const [d, n] of byDate) console.log(`${d}  ${String(n).padStart(4)}`);
}
console.log(`--- 真实 11128 行数=${total}（扫描 ${scope.length} 天：${scope[0]}..${scope[scope.length - 1]}）`);
