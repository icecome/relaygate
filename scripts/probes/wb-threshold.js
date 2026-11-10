'use strict';
/**
 * scripts/probes/wb-threshold.js — 找「可疑文本」的长度阈值与触发区间。
 *
 * 已知（wb-ablate-system 结论）：
 *   - 中性文本 30000 字 → ok（长度本身不触发）
 *   - 真实 system 前 6828 字 → ok
 *   - 真实 system 6828..8535（1707 字）→ BLOCKED
 *   - 该段再切 4 份（427 字）→ 都 ok
 *   ⇒ 存在「可疑密度 × 长度」累加阈值。
 *
 * 本脚本：
 *   1) 对 6828..8535 做长度梯度，定位阈值
 *   2) 对 8535..13649 做长度梯度
 *   3) 用固定窗口滑动，找所有触发区间
 *
 * 用法：node scripts/probes/wb-threshold.js [模型]
 */
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:19900';
const MODEL = process.argv[2] || 'wb/deepseek-v4.1-flash';
const apiKeys = require('../../src/credentials/api-keys');
const KEY = apiKeys.revealKeyPlain(apiKeys.listKeys().find((k) => k.label === 'dsh-workbuddy').id);
const SYS = fs.readFileSync(path.join(__dirname, '..', '..', 'logs', '_dsh-system.txt'), 'utf8');

async function blocked(text) {
  const body = {
    model: MODEL,
    stream: false,
    max_tokens: 8,
    messages: [{ role: 'system', content: text }, { role: 'user', content: 'ok' }],
  };
  try {
    const r = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify(body),
    });
    const t = await r.text();
    return /11128/.test(t);
  } catch {
    return false;
  }
}

const A0 = 6828;
const A1 = 8535;

(async () => {
  console.log('=== 1) 段 A（6828..8535）长度梯度：取前缀');
  for (const len of [200, 400, 600, 800, 1000, 1200, 1400, 1600, 1707]) {
    const b = await blocked(SYS.slice(A0, A0 + len));
    console.log(`  A 前 ${String(len).padStart(4)} 字 -> ${b ? 'BLOCKED' : 'ok'}`);
  }

  console.log('\n=== 2) 段 B（8535..13649）长度梯度：取前缀');
  for (const len of [500, 1000, 2000, 3000, 4000, 5114]) {
    const b = await blocked(SYS.slice(A1, A1 + len));
    console.log(`  B 前 ${String(len).padStart(4)} 字 -> ${b ? 'BLOCKED' : 'ok'}`);
  }

  console.log('\n=== 3) 固定 1200 字窗口滑动（步长 600）');
  const W = 1200;
  for (let s = 5000; s + W <= SYS.length; s += 600) {
    const b = await blocked(SYS.slice(s, s + W));
    console.log(`  [${String(s).padStart(5)}..${String(s + W).padStart(5)}] ${b ? 'BLOCKED' : 'ok'}  ${SYS.slice(s, s + 48).replace(/\n/g, ' ')}`);
  }
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
