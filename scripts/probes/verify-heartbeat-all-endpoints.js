'use strict';
/**
 * scripts/probes/verify-heartbeat-all-endpoints.js —— 三个流式出口的静默心跳覆盖。
 *
 * `lib/sse-heartbeat.js` 接入了三条出口，但它们的帧形状完全不同：
 *   /v1/chat/completions  → OpenAI choices[].delta
 *   /v1/messages          → Anthropic message_start / content_block_delta
 *   /v1/responses         → Responses response.created / output_text.delta
 *
 * 只要有一条漏接，那条协议的客户端就仍然会撞「长静默 → 隧道判死」。
 * 本探针逐条起真实路由、打桩上游为「静默 N 毫秒后吐一帧」，然后**直接数
 * 字节流里的 `: ping`**——不依赖任何协议的解析器，避免「解析器吞了注释行
 * 导致假通过」。
 *
 * 运行：node scripts/probes/verify-heartbeat-all-endpoints.js
 */
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `rg-hb-all-${Date.now()}`);
process.env.WORKSPACE_DIR = TMP;
process.env.LOGS_DIR = path.join(TMP, 'logs');
process.env.TRAE_API_ENCRYPT_KEY = 'a'.repeat(64);
process.env.API_KEY = 'probe-api-key';
process.env.ADMIN_KEY = 'probe-admin-key';
process.env.SSE_HEARTBEAT_MS = '300';
process.env.AUTO_CONTINUE = 'false';
process.env.SCHEDULER_ENABLED = 'false';

const express = require('express');
const http = require('http');
const clientMod = require('../../src/upstream/client');
const poolMod = require('../../src/credentials/pool');
const trafficMod = require('../../src/log/traffic');

const TRAE_MODEL = 'hy4free';
const SILENCE_MS = 1200;
const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS);

/** 上游桩：先静默，再按 Trae 的真实事件形状吐一帧正文 + 收尾。 */
clientMod.llmUtilsChat = async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(c) {
      await new Promise((r) => setTimeout(r, SILENCE_MS));
      c.enqueue(enc.encode('data: {"response":"OK"}\n\n'));
      c.enqueue(enc.encode('event:done\ndata:{"finish_reason":"stop"}\n\n'));
      c.close();
    },
  });
  return { data: null, body, function: 'chat_v3' };
};
poolMod.run = async (fn) => ({ result: await fn('acct_stub'), accountId: 'acct_stub' });
trafficMod.logRequest = () => {};

const openai = require('../../src/routes/openai');
const anthropic = require('../../src/routes/anthropic');
const responses = require('../../src/routes/responses');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, _res, next) => { req.platform = 'trae'; req.authKey = null; next(); });
app.use(openai);
app.use(anthropic);
app.use(responses);

const server = http.createServer(app);

/** 读完整条 SSE 字节流，返回 { pings: number[], text: string, totalMs }。 */
async function readStream(url, body) {
  const t0 = Date.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ct = r.headers.get('content-type') || '';
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  const pings = [];
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    text += chunk;
    let idx = 0;
    for (;;) {
      const at = chunk.indexOf(': ping', idx);
      if (at === -1) break;
      pings.push(Date.now() - t0);
      idx = at + 6;
    }
  }
  return { status: r.status, ct, pings, text, totalMs: Date.now() - t0 };
}

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  let fail = 0;
  const check = (name, ok, detail) => {
    if (ok) console.log(`  ok  ${name}`);
    else { fail++; console.error(`FAIL  ${name}: ${detail}`); }
  };

  const cases = [
    {
      name: '/v1/chat/completions',
      url: `${base}/v1/chat/completions`,
      body: { model: TRAE_MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      // 该协议的正文标记
      marker: 'OK',
    },
    {
      name: '/v1/messages',
      url: `${base}/v1/messages`,
      body: { model: TRAE_MODEL, stream: true, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
      marker: 'OK',
    },
    {
      name: '/v1/responses',
      url: `${base}/v1/responses`,
      body: { model: TRAE_MODEL, stream: true, input: 'hi' },
      marker: 'OK',
    },
  ];

  for (const c of cases) {
    console.log(`\n${c.name}  (上游静默 ${SILENCE_MS}ms，心跳 ${HEARTBEAT_MS}ms)`);
    const r = await readStream(c.url, c.body);
    console.log(`  心跳时刻(ms): ${JSON.stringify(r.pings)}  总耗时: ${r.totalMs}ms`);
    check(`${c.name} 返回 200 + SSE`,
      r.status === 200 && /text\/event-stream/.test(r.ct), `status=${r.status} ct=${r.ct}`);
    check(`${c.name} 静默期内至少 2 个心跳`, r.pings.length >= 2, `实际 ${r.pings.length}`);
    check(`${c.name} 首个心跳早于 1s`, r.pings.length > 0 && r.pings[0] < 1000, `首个 ${r.pings[0]}ms`);
    check(`${c.name} 正文未被心跳吞掉`, r.text.includes(c.marker), r.text.slice(0, 200));
    check(`${c.name} 心跳不与 data 帧粘连`,
      r.text.split('\n').every((l) => !(l.includes(': ping') && l.includes('data:'))), '');
  }

  server.close();
  console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}`);
  process.exit(fail === 0 ? 0 : 1);
});
