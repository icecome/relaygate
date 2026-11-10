'use strict';
/**
 * scripts/probes/wb-blockers.js — WorkBuddy「用不了」的真实阻塞点统计。
 *
 * 不是 11128（渠道校验），而是上游的业务限流码：
 *   6020  queue.waiting.title（排队，data.queue_position / estimated_wait）
 *   14003 model busy（模型繁忙，请换模型）
 *   11102/11103 模型不可用
 *   11140 账号受限
 * 按「错误码 × 模型 × 日期」聚合，看清到底哪个模型在什么时段不可用。
 *
 * 用法：node scripts/probes/wb-blockers.js [天数=14]
 */
const fs = require('fs');
const path = require('path');

const DAYS = Number(process.argv[2] || 14);
const ROOT = path.join(__dirname, '..', '..', 'logs');
const CODES = [
  [11128, /code["']?\s*[:=]\s*11128|unapproved channel/i],
  [11140, /code["']?\s*[:=]\s*11140/],
  [11115, /code["']?\s*[:=]\s*11115/],
  [11102, /code["']?\s*[:=]\s*11102/],
  [11103, /code["']?\s*[:=]\s*11103/],
  [6020, /code["']?\s*[:=]\s*6020|queue\.waiting/],
  [14003, /code["']?\s*[:=]\s*14003|model busy/i],
];

const dates = fs.readdirSync(ROOT).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(-DAYS);
const byCode = new Map();
const byModel = new Map();
const queueSamples = [];

for (const d of dates) {
  const f = path.join(ROOT, d, 'traffic.jsonl');
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.platform !== 'workbuddy') continue;
    const err = String(j.error || '');
    if (!err) continue;
    for (const [code, re] of CODES) {
      if (!re.test(err)) continue;
      byCode.set(code, (byCode.get(code) || 0) + 1);
      const k = `${code} ${j.routedTo || j.model}`;
      byModel.set(k, (byModel.get(k) || 0) + 1);
      if (code === 6020 && queueSamples.length < 5) {
        const pos = /"queue_position":(\d+)/.exec(err);
        const wait = /"estimated_wait":(\d+)/.exec(err);
        queueSamples.push(`${j.ts} ${j.routedTo} position=${pos ? pos[1] : '?'} wait=${wait ? wait[1] : '?'}ms`);
      }
      break;
    }
  }
}

console.log(`=== WorkBuddy 阻塞码分布（近 ${dates.length} 天：${dates[0]}..${dates[dates.length - 1]}）`);
for (const [code, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
  const label = { 11128: '渠道校验', 11140: '账号受限', 11115: '上下文超限', 11102: '模型不存在', 11103: '模型后端不支持', 6020: '排队', 14003: '模型繁忙' }[code] || '';
  console.log(`  ${String(code).padEnd(6)} ${String(n).padStart(5)} 次   ${label}`);
}
console.log('\n=== 按「码 × 模型」');
for (const [k, n] of [...byModel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${String(n).padStart(5)}  ${k}`);
}
if (queueSamples.length) {
  console.log('\n=== 排队样本（6020）');
  for (const s of queueSamples) console.log('  ' + s);
}
