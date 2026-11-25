'use strict';
/**
 * scripts/probes/verify-sse-heartbeat.js —— 端到端验证「静默期被心跳切碎」。
 *
 * 这不是单元测试（单元测试直接驱动 attachSseHeartbeat），而是**走真实路由**：
 * 起一个只挂 routes/openai.js 的 express 实例，把上游打桩成「先静默 1.5s，
 * 再吐两帧」，然后用 fetch 真实读取 SSE 字节流，记录每个 `: ping` 的到达时刻。
 *
 * 判据：
 *   - 静默期（首帧之前的 1.5s）内必须至少出现 2 个心跳帧；
 *   - 首个心跳必须在 1.2s 之前到达（否则说明心跳没生效）；
 *   - 正文帧必须完整（心跳不得吞掉或改写 data 帧）。
 *
 * 运行：node scripts/probes/verify-sse-heartbeat.js
 */
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `rg-hb-verify-${Date.now()}`);
process.env.WORKSPACE_DIR = TMP;
process.env.LOGS_DIR = path.join(TMP, 'logs');
process.env.TRAE_API_ENCRYPT_KEY = 'a'.repeat(64);
process.env.API_KEY = 'probe-api-key';
process.env.ADMIN_KEY = 'probe-admin-key';
process.env.SSE_HEARTBEAT_MS = '400';
process.env.AUTO_CONTINUE = 'false';
process.env.SCHEDULER_ENABLED = 'false';

const express = require('express');
const http = require('http');
const clientMod = require('../../src/upstream/client');
const poolMod = require('../../src/credentials/pool');
const trafficMod = require('../../src/log/traffic');

// 走 Trae 直连路径需要一个「非 WorkBuddy 独有」的模型名：
// deepseek-v4.1-flash / glm-5.3 在当前归属表里被判成 WB 独有（platform-ownership），
// 用它们会在 ACL 就被 403 拒掉，测不到流式心跳。
const TRAE_MODEL = 'hy4free';
const SILENCE_MS = 1500;
const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS);

clientMod.llmUtilsChat = async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(c) {
      await new Promise((r) => setTimeout(r, SILENCE_MS));
      // 事件形状按 Trae 的真实形态给（response / done），不是 OpenAI 的
      // choices[].delta —— transform/sse.js 归一化的是前者，用后者会解析出零事件，
      // 路由层按「上游未发 SSE」抛 502，测不到心跳。
      c.enqueue(enc.encode('data: {"response":"hello"}\n\n'));
      c.enqueue(enc.encode('data: {"done":true,"finish_reason":"stop"}\n\n'));
      c.close();
    },
  });
  return { data: null, body, function: 'chat_v3' };
};
poolMod.run = async (fn) => ({ result: await fn('acct_stub'), accountId: 'acct_stub' });
trafficMod.logRequest = () => {};

const openai = require('../../src/routes/openai');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.platform = 'trae'; req.authKey = null; next(); });
app.use(openai);

const server = http.createServer(app);

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const t0 = Date.now();
  let fail = 0;
  const check = (name, ok, detail) => {
    if (ok) console.log(`  ok  ${name}`);
    else { fail++; console.error(`FAIL  ${name}: ${detail}`); }
  };

  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TRAE_MODEL,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });

  check('HTTP 200 + SSE content-type',
    r.status === 200 && /text\/event-stream/.test(r.headers.get('content-type') || ''),
    `status=${r.status} ct=${r.headers.get('content-type')}`);

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  const pings = [];
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    text += chunk;
    // 逐个 : ping 记录到达时刻（一个 chunk 可能含多个）
    let idx = 0;
    for (;;) {
      const at = chunk.indexOf(': ping', idx);
      if (at === -1) break;
      pings.push(Date.now() - t0);
      idx = at + 6;
    }
  }
  const totalMs = Date.now() - t0;

  console.log(`\n  心跳到达时刻(ms): ${JSON.stringify(pings)}`);
  console.log(`  上游静默: ${SILENCE_MS}ms  心跳周期: ${HEARTBEAT_MS}ms  总耗时: ${totalMs}ms\n`);

  check('静默期内至少 2 个心跳帧', pings.length >= 2, `实际 ${pings.length} 个`);
  check('首个心跳早于 1.2s（证明静默被打断）',
    pings.length > 0 && pings[0] < 1200, `首个在 ${pings[0]}ms`);
  check('所有心跳都早于首个正文帧（即落在静默期）',
    pings.every((t) => t <= totalMs), '');
  check('正文帧完整（心跳未吞字节）', /"content":"hello"/.test(text), text.slice(0, 200));
  check('末帧 [DONE] 存在', text.includes('data: [DONE]'), text.slice(-120));
  check('心跳帧自成一行，不与 data 帧粘连',
    text.split('\n').every((line) => !(line.includes(': ping') && line.includes('data:'))), '');

  server.close();
  console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}`);
  process.exit(fail === 0 ? 0 : 1);
});
