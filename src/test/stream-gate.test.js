'use strict';
/**
 * test/stream-gate.test.js——流式答案提交闸门（降级窗口语义）。
 * 运行：node src/test/stream-gate.test.js
 *
 * 覆盖三条不可动摇的不变量：
 *   1. 完整帧原样立即下发——闸门不得给正常路径增加任何延迟（否则就是拿
 *      全部请求的 TTFT 去换一个未观测到的失败场景）；
 *   2. 未成行的残片必须被扣住，换候选时丢弃——它若拼进下一个候选的流，
 *      客户端会解析出一个坏 JSON，比「不降级」更糟；
 *   3. 只有承载答案的帧才置 `answerCommitted`——纯思考（reasoning）不算，
 *      否则「只思考过就失败」的场景永远无法降级，这正是本次修复的目标。
 */
const os = require('os');
const path = require('path');
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `gate-test-${Date.now()}`);
process.env.TRAE_API_ENCRYPT_KEY = 'a'.repeat(64);
process.env.API_KEY = 'test-api-key';
process.env.ADMIN_KEY = 'test-admin-key';
require('./isolation-guard')('stream-gate');

const assert = require('assert');
const {
  createStreamGate,
  commitsAnswerEvent,
  commitsAnswerLine,
} = require('../model-router/stream-gate');

let pass = 0;
let fail = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }

async function runAll() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      pass++;
      console.log(`  ok  ${name}`);
    } catch (e) {
      fail++;
      console.error(`FAIL  ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

/** 最小 res 替身：只实现闸门用到的那几个成员，并记录实际下发的字节。 */
function fakeRes() {
  return {
    chunks: [],
    headers: {},
    headersSent: false,
    writableEnded: false,
    setHeader(k, v) { this.headers[k] = v; },
    flushHeaders() { this.headersSent = true; },
    write(s) { this.chunks.push(String(s)); return true; },
    end() { this.writableEnded = true; },
    text() { return this.chunks.join(''); },
  };
}

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const contentFrame = (txt) => frame({ choices: [{ index: 0, delta: { content: txt } }] });
const reasoningFrame = (txt) => frame({ choices: [{ index: 0, delta: { reasoning_content: txt } }] });

// 事件级判定

console.log('commitsAnswerEvent — 什么算「承载答案」');

t('content 非空白 → 提交', () => {
  assert.strictEqual(commitsAnswerEvent({ type: 'text', content: '你好' }), true);
});

t('content 只有空白 → 不提交（空白增量不是答案）', () => {
  assert.strictEqual(commitsAnswerEvent({ type: 'text', content: '   \n ' }), false);
});

t('只有 reasoning → 不提交（本次修复的核心）', () => {
  assert.strictEqual(commitsAnswerEvent({ type: 'text', reasoning: '让我想一想…' }), false);
  assert.strictEqual(commitsAnswerEvent({ type: 'text', content: '', reasoning: '…' }), false);
});

t('tool_call → 提交', () => {
  assert.strictEqual(commitsAnswerEvent({ type: 'tool_call', call: { id: 'c1' } }), true);
});

t('done / token_usage / error → 不提交', () => {
  assert.strictEqual(commitsAnswerEvent({ type: 'done', finish_reason: 'stop' }), false);
  assert.strictEqual(commitsAnswerEvent({ type: 'token_usage', data: {} }), false);
  assert.strictEqual(commitsAnswerEvent({ type: 'error', message: 'x' }), false);
  assert.strictEqual(commitsAnswerEvent(null), false);
});

// 行级判定（原样透传的 provider 用）

console.log('commitsAnswerLine — 透传路径的行级判定');

t('OpenAI content 增量行 → 提交', () => {
  assert.strictEqual(commitsAnswerLine('data: {"choices":[{"delta":{"content":"hi"}}]}'), true);
});

t('OpenAI reasoning_content 行 → 不提交', () => {
  assert.strictEqual(commitsAnswerLine('data: {"choices":[{"delta":{"reasoning_content":"想"}}]}'), false);
});

t('tool_calls 行 → 提交', () => {
  assert.strictEqual(
    commitsAnswerLine('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a"}]}}]}'),
    true,
  );
});

t('非 data 行 / [DONE] / 坏 JSON → 不提交', () => {
  assert.strictEqual(commitsAnswerLine('event: ping'), false);
  assert.strictEqual(commitsAnswerLine('data: [DONE]'), false);
  assert.strictEqual(commitsAnswerLine('data: {断掉的'), false);
  assert.strictEqual(commitsAnswerLine(''), false);
  // 只有 role 的起始帧不是答案
  assert.strictEqual(commitsAnswerLine('data: {"choices":[{"delta":{"role":"assistant"}}]}'), false);
});

t('Anthropic text_delta / tool_use 起始块 → 提交', () => {
  assert.strictEqual(
    commitsAnswerLine('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"嗨"}}'),
    true,
  );
  assert.strictEqual(
    commitsAnswerLine('data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"f"}}'),
    true,
  );
  assert.strictEqual(
    commitsAnswerLine('data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"…"}}'),
    false,
  );
});

// 闸门行为

console.log('createStreamGate — 下发时序与残片扣留');

t('完整帧原样立即下发，且未提交（零延迟：不得拿全部请求的 TTFT 换降级窗口）', () => {
  const res = fakeRes();
  const gate = createStreamGate(res, { keepaliveMs: 0 });
  gate.write(reasoningFrame('思考中'));
  assert.strictEqual(res.text(), reasoningFrame('思考中'), '完整帧必须立即下发');
  assert.strictEqual(gate.answerCommitted, false, '只有思考时不得提交');
  assert.strictEqual(gate.peekHeld(), '', '完整帧不得被扣留');
});

t('未成行的残片被扣住，不下发', () => {
  const res = fakeRes();
  const gate = createStreamGate(res, { keepaliveMs: 0 });
  gate.write('data: {"choices":');
  assert.strictEqual(res.text(), '', '残片不得下发');
  assert.strictEqual(gate.peekHeld(), 'data: {"choices":');
});

t('核心不变量：换候选丢弃残片后，新候选的 JSON 不会被拼坏', () => {
  const res = fakeRes();
  const gate = createStreamGate(res, { keepaliveMs: 0 });
  // 候选 A：先下发一个完整思考帧，再写半行就断了
  gate.write(reasoningFrame('A 的思考'));
  gate.write(contentFrame('A 的答案').slice(0, 30));
  assert.strictEqual(gate.answerCommitted, false, 'A 没交付过答案，窗口应仍开着');
  const dropped = gate.discardHeld();
  assert.ok(dropped > 0, '应丢弃了残片');
  assert.strictEqual(gate.peekHeld(), '');
  // 候选 B：完整答案帧
  gate.commit('answer');
  gate.write(contentFrame('B 的答案'));
  const text = res.text();
  assert.ok(text.includes('A 的思考'), 'A 的完整帧已下发（本设计的已知取舍：思考会先被看到）');
  assert.ok(!text.includes('"content":"A'), 'A 的半行绝不能出现在客户端');
  const lastLine = text.trimEnd().split('\n\n').filter(Boolean).pop();
  assert.doesNotThrow(() => JSON.parse(lastLine.slice(6)), '末帧必须是可解析的完整 JSON');
  assert.ok(lastLine.includes('B 的答案'));
});

t('commit 幂等，且提交后写入仍即时下发', () => {
  const res = fakeRes();
  const gate = createStreamGate(res, { keepaliveMs: 0 });
  assert.strictEqual(gate.commit('a'), true);
  assert.strictEqual(gate.commit('b'), false, '重复提交返回 false');
  assert.strictEqual(gate.answerCommitted, true);
  gate.write(contentFrame('x'));
  assert.strictEqual(res.text(), contentFrame('x'));
});

t('end() 把残片补发出去再收尾（末行无换行符也不能丢）', () => {
  const res = fakeRes();
  const gate = createStreamGate(res, { keepaliveMs: 0 });
  gate.write('data: {"choices":[]}');
  assert.strictEqual(res.text(), '');
  gate.end();
  assert.strictEqual(res.text(), 'data: {"choices":[]}');
  assert.strictEqual(res.writableEnded, true);
  assert.strictEqual(gate.commit('late'), false, '已 end 的闸门不应再触发提交');
});

t('end() 幂等', () => {
  const res = fakeRes();
  const gate = createStreamGate(res, { keepaliveMs: 0 });
  gate.end();
  gate.end();
  assert.strictEqual(res.writableEnded, true);
});

t('writableEnded 反映真实 res，dispatch 侧据此停写', () => {
  const res = fakeRes();
  const gate = createStreamGate(res, { keepaliveMs: 0 });
  assert.strictEqual(gate.writableEnded, false);
  res.writableEnded = true;
  assert.strictEqual(gate.writableEnded, true);
  assert.strictEqual(gate.write(contentFrame('x')), false, 'res 已结束时应拒绝写入');
});

t('setHeader 在头已发出后不再透传（Node 会抛 ERR_HTTP_HEADERS_SENT）', () => {
  const res = fakeRes();
  const gate = createStreamGate(res, { keepaliveMs: 0 });
  gate.setHeader('X-A', '1');
  assert.strictEqual(res.headers['X-A'], '1');
  gate.flushHeaders();
  gate.setHeader('X-B', '2');
  assert.strictEqual(res.headers['X-B'], undefined, '头已发出后不得再 setHeader');
});

t('心跳只在静默超过一个周期时补注释帧，正常有字节流动时一个都不发', async () => {
  const res = fakeRes();
  const gate = createStreamGate(res, { keepaliveMs: 20 });
  gate.write(reasoningFrame('a'));
  assert.ok(!res.text().includes(': ping'), '刚写过字节，不应立刻发心跳');
  await new Promise((r) => setTimeout(r, 70));
  const pings = res.text().split(': ping\n\n').length - 1;
  assert.ok(pings >= 1, `静默后应至少发一次心跳，实际 ${pings}`);
  // 心跳后继续写内容，不应影响帧的完整性
  gate.write(contentFrame('b'));
  assert.ok(res.text().includes(contentFrame('b')));
  gate.end();
  const after = res.text();
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(res.text(), after, 'end() 之后必须停掉心跳定时器');
});

// 汇总

async function main() {
  await runAll();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error(
      '\n任一失败项都意味着降级窗口语义与契约不符：残片泄漏会把客户端流拼成坏 JSON，\n' +
      '误提交会让「只思考过就失败」重新变成不可降级。',
    );
  }
  if (process.exitCode) process.exit(process.exitCode);
}

main();
