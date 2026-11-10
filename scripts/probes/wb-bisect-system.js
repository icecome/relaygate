'use strict';
/**
 * scripts/probes/wb-bisect-system.js — 对真实 system prompt 做分段二分，定位触发 11128 的文本段。
 *
 * 策略：先按 chunk 等分（默认 8 段）逐段单测；命中的段再递归细分，
 * 直到段落足够小（< 300 字）后打印原文。
 *
 * 用法：
 *   node scripts/probes/wb-bisect-system.js [模型] [初始段数]
 */
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:19900';
const MODEL = process.argv[2] || 'wb/deepseek-v4.1-flash';
const PARTS = Number(process.argv[3] || 8);

const apiKeys = require('../../src/credentials/api-keys');
const KEY = apiKeys.revealKeyPlain(apiKeys.listKeys().find((k) => k.label === 'dsh-workbuddy').id);

const SYS = fs.readFileSync(path.join(__dirname, '..', '..', 'logs', '_dsh-system.txt'), 'utf8');

async function probe(text) {
  const body = {
    model: MODEL,
    stream: false,
    max_tokens: 8,
    messages: [
      { role: 'system', content: text },
      { role: 'user', content: 'ok' },
    ],
  };
  try {
    const r = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify(body),
    });
    const t = await r.text();
    return { status: r.status, blocked: /11128/.test(t), text: t };
  } catch (e) {
    return { status: 0, blocked: false, text: e.message };
  }
}

/** 把文本切成 n 个尽量等长的块（按字符）。 */
function split(text, n) {
  const size = Math.ceil(text.length / n);
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push({ start: i, text: text.slice(i, i + size) });
  return out;
}

(async () => {
  console.log(`模型 ${MODEL}；system ${SYS.length} 字，先切 ${PARTS} 段\n`);
  const chunks = split(SYS, PARTS);
  const hits = [];
  for (const c of chunks) {
    // eslint-disable-next-line no-await-in-loop
    const r = await probe(c.text);
    const flag = r.blocked ? 'BLOCKED' : 'ok';
    console.log(`  [${String(c.start).padStart(6)}..${String(c.start + c.text.length).padStart(6)}] ${flag.padEnd(7)} ${c.text.slice(0, 70).replace(/\n/g, ' ')}`);
    if (r.blocked) hits.push(c);
  }
  if (!hits.length) {
    console.log('\n--- 单段都不触发：说明是「组合特征」或需要更长上下文，需换策略（多段拼接二分）');
    return;
  }
  console.log(`\n--- 命中 ${hits.length}/${chunks.length} 段，对首段递归细分`);

  let cur = hits[0].text;
  let curStart = hits[0].start;
  for (let depth = 0; depth < 6 && cur.length > 200; depth++) {
    const sub = split(cur, 4);
    let found = null;
    for (const s of sub) {
      // eslint-disable-next-line no-await-in-loop
      const r = await probe(s.text);
      console.log(`  depth${depth + 1} [${curStart + s.start}..${curStart + s.start + s.text.length}] ${r.blocked ? 'BLOCKED' : 'ok'} ${s.text.slice(0, 60).replace(/\n/g, ' ')}`);
      if (r.blocked && !found) found = s;
    }
    if (!found) { console.log('  细分后无单段命中 → 该段是组合触发，停止'); break; }
    cur = found.text;
    curStart += found.start;
  }
  console.log(`\n=== 最小触发片段（offset ${curStart}, ${cur.length} 字）\n`);
  console.log(cur);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
