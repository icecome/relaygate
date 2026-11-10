'use strict';
/**
 * scripts/probes/wb-stream-repro.js — 用 DSH 的真实调用形态（stream:true + 工具 + 长 system）
 * 打 WorkBuddy 模型，复现「DSH 里调 WB 就报错」。
 *
 * 为什么必须 stream:true：DSH 走流式；此前所有探针都是 stream:false，
 * 而流式路径是另一段代码（dispatchWorkBuddyStream），失败面完全不同。
 *
 * 用法：
 *   node scripts/probes/wb-stream-repro.js [模型] [工具数] [轮次]
 */
const apiKeys = require('../../src/credentials/api-keys');

const BASE = process.env.RELAY_BASE || 'http://127.0.0.1:19900';
const MODEL = process.argv[2] || 'wb/deepseek-v4.1-flash';
const NTOOLS = Number(process.argv[3] || 45);
const ROUNDS = Number(process.argv[4] || 3);

const SYSTEM = [
  'You are a coding agent powered by the vm/long-context model.',
  'You are interacting with the user through the DeepSeek Harness Web GUI.',
  'The runtime context names the DeepSeek Harness implementation checkout.',
  'Use the tools to inspect and modify files. Prefer read over cat.',
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
  if (!plain) throw new Error('没有通用密钥');

  for (let r = 1; r <= ROUNDS; r++) {
    const body = {
      model: MODEL,
      stream: true,
      max_tokens: 256,
      tools: tools(NTOOLS),
      tool_choice: 'auto',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: 'say ok in one word' },
      ],
    };
    const t0 = Date.now();
    let status = 0;
    let firstByte = 0;
    let text = '';
    try {
      const resp = await fetch(BASE + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + plain },
        body: JSON.stringify(body),
      });
      status = resp.status;
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!firstByte) firstByte = Date.now() - t0;
        text += dec.decode(value, { stream: true });
        if (text.length > 4000) break;
      }
    } catch (e) {
      console.log(`round ${r}: EXCEPTION ${e.message}`);
      continue;
    }
    const errLine = text.split('\n').find((l) => /"error"|error:|"code"/.test(l));
    const sawDone = text.includes('[DONE]');
    const sawContent = /"content":"[^"]+/.test(text);
    console.log(`round ${r}: http ${status} firstByte=${firstByte}ms total=${Date.now() - t0}ms done=${sawDone} content=${sawContent}`);
    if (status !== 200 || !sawDone || !sawContent) {
      console.log('  head:', text.slice(0, 700).replace(/\n/g, ' | '));
      if (errLine) console.log('  errline:', errLine.slice(0, 400));
    }
  }
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
