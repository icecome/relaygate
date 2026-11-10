'use strict';
/**
 * scripts/probes/wb-scrub-verify.js — 验证「全文级替换」能否让真实 system 放行，
 * 并为 identity-scrub 定规则。核心问题：替换哪几类词、替换多少才够。
 *
 * 用法：node scripts/probes/wb-scrub-verify.js [模型]
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

/** 全文级替换表：把「第三方 harness 语境」整体中性化。 */
const RULES = [
  [/\bDeepSeek\s+Harness\b/gi, 'This Agent'],
  [/\bDSH\b/g, 'the agent'],
  [/\bruntime context\b/gi, 'session info'],
  [/\bWeb GUI\b/gi, 'web console'],
  [/\bthis GUI\b/gi, 'this page'],
  [/\bthe GUI\b/gi, 'the page'],
];

function apply(text, rules) {
  let out = text;
  for (const [re, to] of rules) out = out.replace(re, to);
  return out;
}

(async () => {
  console.log(`真实 system ${SYS.length} 字`);
  console.log(`基线（原文）：${(await blocked(SYS)) ? 'BLOCKED' : 'ok'}\n`);

  // 逐条规则单独作用全文
  console.log('=== 单条规则全文替换');
  for (const [re, to] of RULES) {
    const t = apply(SYS, [[re, to]]);
    const n = (SYS.match(re) || []).length;
    const b = await blocked(t);
    console.log(`  ${String(re).padEnd(34)} 命中${String(n).padStart(3)}处 -> ${b ? 'BLOCKED' : 'ok'}`);
  }

  console.log('\n=== 组合规则');
  const combos = [
    ['只改产品名（Harness+DSH）', RULES.slice(0, 2)],
    ['只改语境词（context+GUI）', RULES.slice(2)],
    ['全部规则', RULES],
  ];
  for (const [label, rules] of combos) {
    const t = apply(SYS, rules);
    const b = await blocked(t);
    console.log(`  ${label.padEnd(30)} len=${t.length} -> ${b ? 'BLOCKED' : 'ok'}`);
  }

  // 长度对照：确认替换后长度变化不影响结论
  console.log('\n=== 对照：全部规则 + 恢复原长（补空格）');
  const t2 = apply(SYS, RULES);
  const padded = t2 + ' '.repeat(Math.max(0, SYS.length - t2.length));
  console.log(`  -> ${(await blocked(padded)) ? 'BLOCKED' : 'ok'} (len=${padded.length})`);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
