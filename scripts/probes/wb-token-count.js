'use strict';
/**
 * scripts/probes/wb-token-count.js — 定位「触发所需的最少特征出现次数」。
 *
 * 已知：单句注入不触发；348 字段（含 DeepSeek Harness / DSH / runtime context / GUI）触发；
 * 改掉其中任一处 DeepSeek/Harness 即放行，但改 DSH 无效。
 * ⇒ 怀疑是「某类 token 出现 N 次」的计数阈值，而不是句式匹配。
 *
 * 本脚本用合成文本直接测计数阈值，排除长度与位置干扰。
 *
 * 用法：node scripts/probes/wb-token-count.js [模型]
 */
const BASE = 'http://127.0.0.1:19900';
const MODEL = process.argv[2] || 'wb/deepseek-v4.1-flash';
const apiKeys = require('../../src/credentials/api-keys');
const KEY = apiKeys.revealKeyPlain(apiKeys.listKeys().find((k) => k.label === 'dsh-workbuddy').id);

const FILLER = 'This paragraph describes ordinary software engineering practice in neutral language. ';

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
    return { b: /11128/.test(t), status: r.status };
  } catch (e) {
    return { b: false, status: 0, err: e.message };
  }
}

async function countTest(label, unit, n) {
  const text = (unit + ' ').repeat(n) + FILLER.repeat(3);
  const r = await blocked(text);
  console.log(`  ${label.padEnd(38)} n=${String(n).padStart(3)} len=${String(text.length).padStart(5)} -> ${r.b ? 'BLOCKED' : 'ok'}`);
  return r.b;
}

(async () => {
  const cases = [
    ['DeepSeek Harness', 'The DeepSeek Harness runs this session.'],
    ['DeepSeek', 'DeepSeek provides the model.'],
    ['Harness', 'The harness runs this session.'],
    ['Claude Code', 'Claude Code is a CLI tool.'],
    ['Codex', 'Codex is a CLI tool.'],
    ['runtime context', 'The runtime context names the checkout.'],
    ['Web GUI', 'You use the Web GUI to interact.'],
  ];
  for (const [label, unit] of cases) {
    console.log(`\n=== ${label}`);
    let firstBlock = null;
    for (const n of [1, 2, 3, 4, 6, 8, 12]) {
      // eslint-disable-next-line no-await-in-loop
      const b = await countTest(label, unit, n);
      if (b && firstBlock == null) { firstBlock = n; break; }
    }
    console.log(`  首次触发次数: ${firstBlock == null ? '未触发（12 次以内）' : firstBlock}`);
  }
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
