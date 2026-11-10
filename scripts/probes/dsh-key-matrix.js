'use strict';
/**
 * scripts/probes/dsh-key-matrix.js — 用指定密钥直调网关，验证「DSH 内调 WB 报错」是不是
 * 平台绑定（scope/platform）问题，而不是上游 11128。
 *
 * 用法：
 *   node scripts/probes/dsh-key-matrix.js                 # 用库里所有密钥跑一遍
 *   node scripts/probes/dsh-key-matrix.js <plainKey> <model>
 */
const apiKeys = require('../../src/credentials/api-keys');

const BASE = process.env.RELAY_BASE || 'http://127.0.0.1:19900';
const MODELS = ['wb/glm-5.3', 'wb/deepseek-v4.1-flash', 'glm-5.3', 'vm/long-context'];

function tools(n) {
  return Array.from({ length: n }, (_, i) => ({
    type: 'function',
    function: { name: 'Tool' + i, description: 'Tool ' + i, parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } },
  }));
}

async function call(key, model, nTools) {
  const body = {
    model,
    stream: false,
    max_tokens: 16,
    tools: tools(nTools),
    tool_choice: 'auto',
    messages: [{ role: 'system', content: 'You are a coding assistant.' }, { role: 'user', content: 'say ok' }],
  };
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let detail = text.slice(0, 160).replace(/\s+/g, ' ');
    try {
      const j = JSON.parse(text);
      detail = (j.error && (j.error.message || j.error)) || (j.choices && j.choices[0].message.content) || detail;
    } catch { /* 非 JSON */ }
    return { status: r.status, ms: Date.now() - t0, detail: String(detail) };
  } catch (e) {
    return { status: 'ERR', ms: Date.now() - t0, detail: e.message };
  }
}

(async () => {
  const explicit = process.argv[2];
  const keys = [];
  if (explicit) {
    keys.push({ label: 'explicit', platform: '?', plain: explicit });
  } else {
    for (const k of apiKeys.listKeys()) {
      if (k.kind !== 'access') continue;
      const plain = apiKeys.revealKeyPlain(k.id);
      if (!plain) continue;
      keys.push({ label: `${k.label || k.id} [${k.platform}]`, platform: k.platform, plain });
    }
  }
  const models = process.argv[3] ? [process.argv[3]] : MODELS;
  for (const k of keys) {
    console.log(`\n=== key ${k.label}`);
    for (const m of models) {
      const r = await call(k.plain, m, 5);
      console.log(`  ${m.padEnd(24)} -> ${r.status} (${r.ms}ms) ${r.detail}`);
    }
  }
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
