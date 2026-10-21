'use strict';
/**
 * scripts/probes/verify-wb-failover.js —— 11128 的降级行为验证（纯本地，mock fetch）。
 *
 * 断言：
 *   1. workbuddy 候选被 11128 拒绝后，同 provider 的其余候选**不再尝试**
 *      （否则就是失败现场那种「12 次撞同一堵墙」）；
 *   2. 请求继续降级到 trae 候选并成功；
 *   3. 账号健康度不被 channel 冷却污染。
 *
 * 用法：node scripts/probes/verify-wb-failover.js
 */
const assert = require('assert');

const realFetch = globalThis.fetch;
const calls = [];

// 假上游：workbuddy 一律 11128；trae 一律 200（返回一段最小 SSE）。
globalThis.fetch = async (url, init) => {
  const u = String(url);
  calls.push(u);
  if (u.includes('copilot.tencent.com')) {
    return new Response(
      JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  const sse = 'data: {"choices":[{"delta":{"content":"trae-ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  return new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

(async () => {
  const router = require('../../src/model-router');
  const store = router.store;

  // 构造一个「workbuddy 在前、trae 在后」的虚拟模型
  const VIRT = 'vm/__verify-channel-failover__';
  store.upsertVirtual(VIRT, {
    enabled: true,
    description: 'verify channel failover',
    strategy: 'priority',
    candidates: [
      { id: 'wb-a', provider: 'workbuddy', model: 'wb/space-bunny', priority: 1, weight: 1, enabled: true },
      { id: 'wb-b', provider: 'workbuddy', model: 'wb/glm-5.3-flash', priority: 2, weight: 1, enabled: true },
      { id: 'wb-c', provider: 'workbuddy', model: 'wb/deepseek-v4.1-flash', priority: 3, weight: 1, enabled: true },
      { id: 'trae-a', provider: 'trae', model: 'glm-5.3', priority: 4, weight: 1, enabled: true },
    ],
    failover: { maxAttempts: 4, switchOn: ['rate_limit', 'model', '5xx', 'network', 'channel', 'other'], cooldownMs: 20000 },
  });

  // 让 trae 分支不去碰真实上游：dispatchTraeStream 用 llmUtilsChat，
  // 这里直接把 dispatch 的 trae 流函数替换成最小实现。
  const dispatch = router.dispatch;
  const origDispatchStream = dispatch.dispatchStream;
  dispatch.dispatchStream = async (provider, model, body, res) => {
    if (provider.builtin === 'trae') {
      res.headersSent = true;
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'trae-ok' }, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return { streamed: true, finishReason: 'stop', usage: null, outputText: 'trae-ok' };
    }
    return origDispatchStream(provider, model, body, res);
  };

  // 假的 express res
  const chunks = [];
  const res = {
    headersSent: false, writableEnded: false, statusCode: 200,
    setHeader() {}, flushHeaders() { this.headersSent = true; },
    write(s) { chunks.push(String(s)); return true; },
    end() { this.writableEnded = true; },
    status(c) { this.statusCode = c; return this; },
    json(o) { chunks.push(JSON.stringify(o)); this.writableEnded = true; return this; },
  };

  const out = await router.handleChat({ body: {}, headers: {} }, res, {
    model: VIRT,
    messages: [{ role: 'user', content: 'ping' }],
    tools: null,
    stream: true,
    startedAt: Date.now(),
    keyPlatform: 'all',
    stickyKey: 'verify-session',
  });

  dispatch.dispatchStream = origDispatchStream;

  const wbHits = calls.filter((u) => u.includes('copilot.tencent.com')).length;
  console.log('workbuddy 上游命中次数:', wbHits);
  console.log('attempts:', JSON.stringify((out.attempts || []).map((a) => a.candidateId)));
  console.log('结果:', out.ok ? 'ok' : 'fail', '| 客户端收到:', chunks.join('').slice(0, 120));

  assert.strictEqual(wbHits, 1, '11128 之后不得再试同 provider 的其余候选（应只打 1 次）');
  assert.strictEqual(out.ok, true, '应降级到 trae 并成功');
  assert.ok(chunks.join('').includes('trae-ok'), '客户端应拿到 trae 的内容');

  // 账号健康度未被污染
  const snap = router.health.snapshot();
  const entries = Object.values(snap).flatMap((v) => Object.values(v));
  const cooled = entries.filter((e) => e && e.coolUntil > Date.now());
  assert.strictEqual(cooled.length, 0, 'channel 不得冷却任何候选');

  store.removeVirtual(VIRT);
  globalThis.fetch = realFetch;
  console.log('\n全部断言通过');
})().catch((e) => {
  globalThis.fetch = realFetch;
  console.error('FAILED:', e.message);
  process.exit(1);
});
