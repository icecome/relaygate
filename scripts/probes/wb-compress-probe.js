'use strict';
/**
 * scripts/probes/wb-compress-probe.js — 验证「把 system 压到安全长度」能否放行真实请求。
 *
 * 背景：上游是「可疑特征密度 × 文本长度」双条件，逐词替换改不干净（wb-scrub-verify 已证）。
 * 那么可控杠杆只剩长度：既然真实 system 前 6828 字是 ok 的，就把超长部分压缩。
 *
 * 用法：node scripts/probes/wb-compress-probe.js [模型]
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

/** 按行截断：保留前 n 字，且不切断行。 */
function cutLines(text, n) {
  const lines = text.split('\n');
  let out = '';
  for (const ln of lines) {
    if (out.length + ln.length + 1 > n) break;
    out += ln + '\n';
  }
  return out;
}

(async () => {
  console.log('=== 1) 按长度截断（保留前缀）');
  for (const n of [4000, 5000, 6000, 6500, 6828, 7000, 8000]) {
    const t = cutLines(SYS, n);
    const b = await blocked(t);
    console.log(`  截到 ${String(t.length).padStart(5)} 字 -> ${b ? 'BLOCKED' : 'ok'}`);
  }

  console.log('\n=== 2) 头尾各留一半（去掉中段）');
  for (const n of [3000, 4000, 5000]) {
    const half = Math.floor(n / 2);
    const t = SYS.slice(0, half) + '\n' + SYS.slice(SYS.length - half);
    const b = await blocked(t);
    console.log(`  头 ${half} + 尾 ${half} = ${t.length} 字 -> ${b ? 'BLOCKED' : 'ok'}`);
  }

  console.log('\n=== 3) 段落级摘要（只保留以 - 开头的短行 + 标题）');
  const lines = SYS.split('\n');
  const summarized = lines.filter((l) => /^#|^$|^[-*]\s/.test(l)).join('\n');
  console.log(`  摘要 ${summarized.length} 字 -> ${(await blocked(summarized)) ? 'BLOCKED' : 'ok'}`);

  console.log('\n=== 4) 去重压缩（重复词/短语合并，含可疑词的行整行删除）');
  const SUS = /DeepSeek|Harness|\bDSH\b|runtime context|Web GUI|dsh web|dsh |armor/i;
  const clean = lines.filter((l) => !SUS.test(l)).join('\n');
  console.log(`  删可疑行后 ${clean.length} 字 -> ${(await blocked(clean)) ? 'BLOCKED' : 'ok'}`);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
