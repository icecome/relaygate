'use strict';
/**
 * scripts/probes/verify-heartbeat-wb-path.js —— 直连 WorkBuddy 路径的静默心跳。
 *
 * `/v1/chat/completions` 有两条完全独立的流式分支：
 *   - Trae 直连（经 transform/sse.js 归一化）
 *   - WorkBuddy 直连（上游即 OpenAI 格式，逐字节透传）
 *
 * `verify-heartbeat-all-endpoints.js` 覆盖的是前者与另两个端点。这条分支如果漏接，
 * 用 `wb/*` 模型的客户端（DSH 的 wb provider、以及把 WB 模型配进 TraeWork 的场景）
 * 仍然会撞「长静默 → 隧道判死」。
 *
 * 运行：node scripts/probes/verify-heartbeat-wb-path.js
 */
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TMP = path.join(os.tmpdir(), `rg-wbhb-${Date.now()}`);
process.env.WORKSPACE_DIR = TMP;
process.env.LOGS_DIR = path.join(TMP, 'logs');
process.env.TRAE_API_ENCRYPT_KEY = 'a'.repeat(64);
process.env.API_KEY = 'probe-api-key';
process.env.ADMIN_KEY = 'probe-admin-key';
process.env.SSE_HEARTBEAT_MS = '300';
process.env.SCHEDULER_ENABLED = 'false';

const express = require('express');
const http = require('http');

const wbChat = require(path.join(ROOT, 'src/workbuddy/chat'));
const authMod = require(path.join(ROOT, 'src/auth'));
const poolMod = require(path.join(ROOT, 'src/credentials/pool'));
const trafficMod = require(path.join(ROOT, 'src/log/traffic'));
const ownership = require(path.join(ROOT, 'src/models/platform-ownership'));

const SILENCE_MS = 1200;

wbChat.chatStream = async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(c) {
      await new Promise((r) => setTimeout(r, SILENCE_MS));
      c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"WBOK"}}]}\n\n'));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return { status: 200, body };
};
authMod.ensureAuth = async (id) => ({ id });
poolMod.run = async (fn) => ({ result: await fn('acct_wb'), accountId: 'acct_wb' });
trafficMod.logRequest = () => {};
// 归属表打桩：把目标模型判成 WB 服务，走直连 WB 分支
ownership.ownerPlatformOf = () => 'workbuddy';
ownership.isWorkBuddyExclusive = () => false;

const openai = require(path.join(ROOT, 'src/routes/openai'));

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.platform = 'all'; req.authKey = null; next(); });
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
      model: 'wb/deepseek-v4.1-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });

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

  console.log(`\n  WB 直连路径（上游静默 ${SILENCE_MS}ms，心跳 300ms）`);
  console.log(`  心跳时刻(ms): ${JSON.stringify(pings)}  总耗时: ${Date.now() - t0}ms\n`);

  check('返回 200 + SSE',
    r.status === 200 && /text\/event-stream/.test(r.headers.get('content-type') || ''),
    `status=${r.status}`);
  check('静默期内至少 2 个心跳', pings.length >= 2, `实际 ${pings.length}`);
  check('首个心跳早于 1s', pings.length > 0 && pings[0] < 1000, `首个 ${pings[0]}ms`);
  check('正文未被心跳吞掉', text.includes('WBOK'), text.slice(0, 200));
  check('[DONE] 存在', text.includes('data: [DONE]'), text.slice(-100));
  check('心跳不与 data 帧粘连',
    text.split('\n').every((l) => !(l.includes(': ping') && l.includes('data:'))), '');

  server.close();
  console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}`);
  process.exit(fail === 0 ? 0 : 1);
});
