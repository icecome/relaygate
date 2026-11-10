'use strict';
/**
 * scripts/probes/dsh-wb-e2e.js — 用 DSH 真实形态（身份 system prompt + 45 工具）
 * 经网关直调 WorkBuddy 模型，复现/验证「DSH 内调用 WB 报错」。
 * 用法：node scripts/probes/dsh-wb-e2e.js [模型] [工具数]
 */
const apiKeys = require('../../src/credentials/api-keys');

const BASE = process.env.RELAY_BASE || 'http://127.0.0.1:19900';
const MODEL = process.argv[2] || 'wb/glm-5.3';
const NTOOLS = Number(process.argv[3] || 45);

const DSH_SYSTEM = [
  'You are a coding agent powered by the vm/long-context model.',
  'You are interacting with the user through the DeepSeek Harness Web GUI.',
  'The runtime context names the DeepSeek Harness implementation checkout.',
  'You are an expert software engineer. Use tools to inspect and modify files.',
].join('\n');

function tools(n) {
  return Array.from({ length: n }, (_, i) => ({
    type: 'function',
    function: { name: 'Tool' + i, description: 'Tool ' + i, parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } },
  }));
}

(async () => {
  const all = apiKeys.listKeys().filter((k) => k.kind === 'access' && k.platform === 'all' && k.enabled);
  const plain = all.length ? apiKeys.revealKeyPlain(all[0].id) : null;
  if (!plain) throw new Error('没有可用通用密钥');

  const body = {
    model: MODEL,
    stream: false,
    max_tokens: 32,
    tools: tools(NTOOLS),
    tool_choice: 'auto',
    messages: [
      { role: 'system', content: DSH_SYSTEM },
      { role: 'user', content: 'say ok' },
    ],
  };
  const t0 = Date.now();
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + plain },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log('model=' + MODEL + ' tools=' + NTOOLS + ' -> http ' + r.status + ' in ' + (Date.now() - t0) + 'ms');
  console.log(text.slice(0, 1200));
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
