'use strict';
/**
 * scripts/dump-wb-request.js —— 抓「网关自己」发出的 chat 请求（头 + 体形状）。
 *
 * 不经过网络：把 globalThis.fetch 换成记录器，再走一遍真实的
 * src/model-router/dispatch.js#dispatchWorkBuddyStream 路径，
 * 于是打印出的就是线上真正发往上游的字节。
 *
 * 用法：node scripts/dump-wb-request.js
 */
const realFetch = globalThis.fetch;

let captured = null;
globalThis.fetch = async (url, init) => {
  captured = { url: String(url), init };
  // 返回一个合法的最小 SSE 流，让 dispatch 正常收尾
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'));
      c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

const TOOLS = Array.from({ length: 42 }, (_, i) => ({
  type: 'function',
  function: { name: 'Tool' + i, description: 'T' + i, parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } },
}));

(async () => {
  const dispatch = require('../../src/model-router/dispatch');
  const sink = {
    headersSent: false, writableEnded: false, committed: false,
    setHeader() {}, flushHeaders() { this.headersSent = true; },
    write() {}, end() { this.writableEnded = true; },
    commit() { this.committed = true; }, discardHeld() { return 0; },
  };
  const body = {
    model: 'wb/deepseek-v4.1-flash',
    stream: true,
    messages: [{ role: 'user', content: 'ping' }],
    tools: TOOLS,
    tool_choice: { type: 'function', function: { name: 'Tool0' } },
  };
  await dispatch.dispatchStream(
    { type: 'builtin', builtin: 'workbuddy' },
    'wb/deepseek-v4.1-flash',
    body,
    sink,
    {},
  ).catch((e) => console.error('dispatch error:', e.message));

  globalThis.fetch = realFetch;
  if (!captured) { console.error('没有捕获到请求'); process.exit(1); }

  console.log('URL:', captured.url);
  console.log('--- headers ---');
  const h = captured.init.headers;
  const entries = h instanceof Headers ? [...h.entries()] : Object.entries(h || {});
  for (const [k, v] of entries) {
    const shown = /authorization/i.test(k) ? String(v).slice(0, 24) + '…(' + String(v).length + 'B)' : String(v).slice(0, 120);
    console.log(' ', k + ':', shown);
  }
  console.log('--- body ---');
  const raw = captured.init.body;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : null;
  if (parsed) {
    console.log('  bytes:', raw.length);
    console.log('  keys:', Object.keys(parsed).join(','));
    console.log('  model:', parsed.model, '| stream:', parsed.stream, '| tools:', (parsed.tools || []).length, '| tool_choice:', JSON.stringify(parsed.tool_choice));
  } else {
    console.log('  <non-string body>', typeof raw);
  }
})().catch((e) => { globalThis.fetch = realFetch; console.error('failed:', e.message); process.exit(1); });
