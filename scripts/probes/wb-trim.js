'use strict';
/**
 * scripts/probes/wb-trim.js — 对已知 BLOCKED 窗口做边缘裁剪，找最小触发子串。
 *
 * 方法：给定一个触发区间，反复「去掉头部 10%」和「去掉尾部 10%」，
 * 只要仍 BLOCKED 就接受，直到两头都裁不动（长度稳定）。
 *
 * 用法：node scripts/probes/wb-trim.js [模型] [start] [end]
 */
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:19900';
const MODEL = process.argv[2] || 'wb/deepseek-v4.1-flash';
const START = Number(process.argv[3] || 11600);
const END = Number(process.argv[4] || 12800);
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

(async () => {
  let a = START;
  let b = END;
  console.log(`起点 [${a}..${b}]  len=${b - a}  ${(await blocked(SYS.slice(a, b))) ? 'BLOCKED' : 'ok'}`);
  let changed = true;
  while (changed) {
    changed = false;
    const step = Math.max(20, Math.floor((b - a) * 0.08));
    // 试裁头
    if (await blocked(SYS.slice(a + step, b))) {
      a += step;
      changed = true;
      console.log(`  裁头 -> [${a}..${b}] len=${b - a} BLOCKED`);
      continue;
    }
    // 试裁尾
    if (await blocked(SYS.slice(a, b - step))) {
      b -= step;
      changed = true;
      console.log(`  裁尾 -> [${a}..${b}] len=${b - a} BLOCKED`);
    }
  }
  console.log(`\n=== 最小触发区间 [${a}..${b}]  len=${b - a}\n`);
  console.log(SYS.slice(a, b));
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
