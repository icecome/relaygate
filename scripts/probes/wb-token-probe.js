'use strict';
/**
 * scripts/probes/wb-token-probe.js — 单 token 级探测：哪个词本身是触发项。
 *
 * 已知最小触发段含 DeepSeek Harness / DSH / harness 等词。逐个替换成等长中性词，
 * 看哪一处替换后放行 —— 那就是上游真正在查的词。
 *
 * 用法：node scripts/probes/wb-token-probe.js [模型]
 */
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:19900';
const MODEL = process.argv[2] || 'wb/deepseek-v4.1-flash';
const apiKeys = require('../../src/credentials/api-keys');
const KEY = apiKeys.revealKeyPlain(apiKeys.listKeys().find((k) => k.label === 'dsh-workbuddy').id);
const SYS = fs.readFileSync(path.join(__dirname, '..', '..', 'logs', '_dsh-system.txt'), 'utf8');

// 最小触发段（wb-trim 结论）
const SEG = SYS.slice(12399, 12747);

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
  console.log(`最小段 ${SEG.length} 字，基线：${(await blocked(SEG)) ? 'BLOCKED' : 'ok'}\n`);
  // 单点替换：把某个词换成等长占位（保持长度不变，排除长度因素）
  const subs = [
    ['DeepSeek Harness', 'Aurora Toolkit'],
    ['DeepSeek', 'Aurora'],
    ['Harness', 'Toolkit'],
    ['DSH', 'XYZ'],
    ['runtime context', 'environment info'],
    ['this GUI', 'this page'],
    ['Web GUI', 'Web App'],
  ];
  for (const [from, to] of subs) {
    if (!SEG.includes(from)) { console.log(`  (跳过 ${from}：段内不存在)`); continue; }
    const t = SEG.split(from).join(to);
    const b = await blocked(t);
    console.log(`  替换 "${from}" -> "${to}"  (${t.length}字) => ${b ? 'BLOCKED' : 'ok  <<< 这一处是关键'}`);
  }

  // 反向：单句注入（把可疑词塞进一句中性话）
  console.log('\n=== 反向注入（中性句 + 可疑词）');
  const injects = [
    'The runtime context names the DeepSeek Harness implementation checkout.',
    'You are interacting with the user through the DeepSeek Harness Web GUI.',
    'DeepSeek Harness',
    'DSH',
    'Use this checkout only to inspect or extend DSH itself.',
    'The client-plugin HMR receiver is active.',
    'The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__.',
  ];
  for (const s of injects) {
    const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(8);
    const b = await blocked(s + ' ' + filler);
    console.log(`  ${b ? 'BLOCKED' : 'ok     '} len=${String((s + filler).length).padStart(4)}  ${s.slice(0, 70)}`);
  }
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
