'use strict';
/**
 * ⚠️ 会打真实上游并**消耗真实账号积分**（每次 max_tokens=1，费用极小但非零）。
 * 仅在需要取证时手动运行，不要放进定时任务或 CI。
 *
 * scripts/e2e-wb-11128.js —— 端到端复现/验证：走网关自己的 /v1/chat/completions，
 * 用 vm/long-context + 42 工具，观察上游是否返回 11128。
 *
 * 网关跑在 127.0.0.1:19900。密钥取库里 platform=all 的通用访问密钥（明文可解）。
 *
 * 用法：node scripts/e2e-wb-11128.js [模型] [工具数]
 */
const apiKeys = require('../../src/credentials/api-keys');

const BASE = process.env.RELAY_BASE || 'http://127.0.0.1:19900';
const MODEL = process.argv[2] || 'vm/long-context';
const NTOOLS = Number(process.argv[3] || 42);

function tools(n) {
  return Array.from({ length: n }, (_, i) => ({
    type: 'function',
    function: { name: 'Tool' + i, description: 'Tool ' + i, parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } },
  }));
}

(async () => {
  const all = apiKeys.listKeys().filter((k) => k.kind === 'access' && k.platform === 'all' && k.enabled);
  if (!all.length) throw new Error('没有可用的通用访问密钥');
  const plain = apiKeys.revealKeyPlain(all[0].id);
  if (!plain) throw new Error('密钥无法解密');

  const body = {
    model: MODEL,
    stream: false,
    max_tokens: 8,
    tools: tools(NTOOLS),
    tool_choice: 'auto',
    messages: [{ role: 'user', content: 'say ok' }],
  };
  const t0 = Date.now();
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + plain },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log('http', r.status, 'in', Date.now() - t0, 'ms');
  console.log(text.slice(0, 800));
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
