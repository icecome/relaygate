'use strict';
/**
 * scripts/probes/verify-continue-streaming.js —— 验证「续写不再整轮缓冲」。
 *
 * 背景（2026-11-25）：原实现在 `AUTO_CONTINUE=true` 时把
 * `emitDuringRound = !continueEnabled` 设为 false，于是**整轮**都缓冲到结束才
 * 下发第一帧，首字节延迟 = 整轮耗时（实测 p90 19.1s / p99 45.5s）。而它换来的
 * 收益接近于零：全库 Trae 通道 6315 条请求里 truncated 只有 1 条（0.02%）。
 *
 * 现改为「首轮边收边发 + 仅 length 时追加」，只把末帧 `done` 挪到最后。
 *
 * 判据（这是本探针唯一要证明的事）：
 *   1. 首轮正文帧**在第二轮上游被调用之前**就已经到达客户端
 *      （旧实现下两者必然同时到达，因为都在 done 之后一次性下发）；
 *   2. 两轮正文按顺序拼成一段连续文本；
 *   3. 只有一个 `finish_reason` 帧，且只出现在最后（客户端不会以为中途结束了）；
 *   4. 只有一个 `[DONE]`。
 *
 * 运行：node scripts/probes/verify-continue-streaming.js
 */
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `rg-cont-verify-${Date.now()}`);
process.env.WORKSPACE_DIR = TMP;
process.env.LOGS_DIR = path.join(TMP, 'logs');
process.env.TRAE_API_ENCRYPT_KEY = 'a'.repeat(64);
process.env.API_KEY = 'probe-api-key';
process.env.ADMIN_KEY = 'probe-admin-key';
process.env.AUTO_CONTINUE = 'true';
process.env.MAX_CONTINUES = '5';
process.env.SSE_HEARTBEAT_MS = '0';
process.env.SCHEDULER_ENABLED = 'false';

const express = require('express');
const http = require('http');
const clientMod = require('../../src/upstream/client');
const poolMod = require('../../src/credentials/pool');
const trafficMod = require('../../src/log/traffic');

const TRAE_MODEL = 'hy4free';
const ROUND1_SILENCE_MS = 300;
const ROUND2_SILENCE_MS = 600;

/** 每次上游调用记录一次「第几轮开始/结束」，供判定「首轮正文是否早于第二轮」。 */
const callLog = [];

let round = 0;
clientMod.llmUtilsChat = async () => {
  round += 1;
  const myRound = round;
  const enc = new TextEncoder();
  const isLast = myRound > 1;
  callLog.push({ round: myRound, event: 'start', at: Date.now() });
  const body = new ReadableStream({
    async start(c) {
      await new Promise((r) => setTimeout(r, myRound === 1 ? ROUND1_SILENCE_MS : ROUND2_SILENCE_MS));
      // 事件形状按 Trae 的真实形态给：`event: done` 行 + 带 finish_reason 的 data 行。
      // 注意不能用 `{"done":true,...}` 这个形状——transform/sse.js:225 对它硬编码
      // finish_reason='stop'（那是「上游明确收尾」的标记），传 length 会被丢掉，
      // 续写永远不触发，探针就测不到真正要测的东西。
      c.enqueue(enc.encode(`data: {"response":"ROUND${myRound}"}\n\n`));
      c.enqueue(enc.encode(isLast
        ? 'event:done\ndata:{"finish_reason":"stop"}\n\n'
        : 'event:done\ndata:{"finish_reason":"length"}\n\n'));
      c.close();
      callLog.push({ round: myRound, event: 'end', at: Date.now() });
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

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  const frames = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    for (const line of chunk.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') { frames.push({ kind: 'done', at: Date.now() - t0 }); continue; }
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      const ch = (ev.choices && ev.choices[0]) || {};
      const delta = ch.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        frames.push({ kind: 'text', content: delta.content, at: Date.now() - t0 });
      }
      if (ch.finish_reason) frames.push({ kind: 'finish', value: ch.finish_reason, at: Date.now() - t0 });
    }
  }

  console.log('\n  帧序列：');
  for (const f of frames) {
    console.log(`    +${String(f.at).padStart(4)}ms  ${f.kind}${f.content ? `="${f.content}"` : ''}${f.value ? `=${f.value}` : ''}`);
  }
  console.log('\n  上游调用：');
  for (const c of callLog) console.log(`    round${c.round} ${c.event} @ +${c.at - t0}ms`);
  console.log('');

  const texts = frames.filter((f) => f.kind === 'text');
  const finishAt = (frames.find((f) => f.kind === 'finish') || {}).at;

  check('发生了一次续写（上游被调用 2 次）', round === 2, `实际 ${round} 次`);
  check('首轮正文在两轮拼接中按序到达',
    texts.length === 2 && texts[0].content === 'ROUND1' && texts[1].content === 'ROUND2',
    JSON.stringify(texts.map((t) => t.content)));
  /*
   * 判别「有没有整轮缓冲」的关键指标：首轮正文帧与末帧的时间差。
   *
   * 旧实现（emitDuringRound=false）把两轮正文攒到全部结束才一次性下发，
   * 所有帧的时间戳必然几乎相同（差值 < 50ms）。
   * 新实现首轮边收边发，首轮正文与末帧之间隔着第二轮的整个静默期（这里 600ms）。
   *
   * 不用「早于 round2 start」是因为 stub 的 round2 是同步紧跟 round1 结束发起的，
   * 客户端读到的时刻与 round2 起点相差 1ms 级，那是读取延迟不是缓冲。
   */
  check('首轮正文显著早于末帧（证明没有整轮缓冲）',
    texts.length > 0 && finishAt != null && (finishAt - texts[0].at) > 200,
    `首轮正文 @+${texts[0] && texts[0].at}ms，末帧 @+${finishAt}ms，差 ${finishAt - (texts[0] && texts[0].at)}ms（阈值 200ms）`);
  check('只有一个 finish_reason 帧，且值为 stop 出现在最后',
    frames.filter((f) => f.kind === 'finish').length === 1
      && frames.filter((f) => f.kind === 'finish')[0].value === 'stop',
    JSON.stringify(frames.filter((f) => f.kind === 'finish')));
  check('finish 帧在所有正文帧之后',
    frames.findIndex((f) => f.kind === 'finish') > frames.map((f) => f.kind).lastIndexOf('text'), '');
  check('只有一个 [DONE]', frames.filter((f) => f.kind === 'done').length === 1, '');
  check('正文按序拼成 ROUND1ROUND2',
    texts.map((t) => t.content).join('') === 'ROUND1ROUND2',
    texts.map((t) => t.content).join(''));

  server.close();
  console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}`);
  process.exit(fail === 0 ? 0 : 1);
});
