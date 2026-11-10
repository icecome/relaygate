'use strict';
/**
 * toolcall-index.test.js — 回归：多工具调用不得共享 wire index。
 *
 * 事故（2026-11-06，session-6ee1fa1a）：dispatchOpenAIStream 的 tool_call 出口
 * 漏传 index，emitters 默认补 0 —— 同一响应里每个调用的 delta 都带
 * tool_calls[].index=0，客户端（DSH）按 index 聚合，把 read 与 pwsh 两个调用
 * 的 arguments 拼成 `}{...}` 一条流，JSON.parse 在第二个对象处报
 * "Unexpected non-whitespace character after JSON at position N"。
 *
 * 本文件锁死：
 *  1) OpenAI 出口：多调用 index 递增，客户端聚合后各自可解析；
 *  2) 旧形态（index 全 0）聚合必拼接 —— 反向锚，防回退；
 *  3) Anthropic 出口：文本块与每个工具块占独立 content_block 序号。
 */
const assert = require('node:assert');
const { exportOpenAI, exportAnthropic } = require('../transform/emitters');
const { createStreamHandler } = require('../transform/sse');

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${label}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL  ${label}`);
    console.error(`       ${e && e.message}`);
  }
}

/** 从 SSE 字节块里解析出 data JSON 对象列表。 */
function dataLines(bytes) {
  return bytes
    .join('')
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5).trim()));
}

/** DSH 侧的聚合方式：按 tool_calls[].index 分桶累加 arguments。 */
function aggregateLikeDsh(frames) {
  const buckets = new Map();
  for (const f of frames) {
    for (const tc of f.choices?.[0]?.delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const b = buckets.get(idx) || { index: idx, id: tc.id || '', name: tc.function?.name || '', args: '' };
      if (tc.id) b.id = tc.id;
      if (tc.function?.name) b.name = tc.function.name;
      b.args += tc.function?.arguments || '';
      buckets.set(idx, b);
    }
  }
  return [...buckets.values()].sort((a, b) => a.index - b.index);
}

const callA = { id: 'call_a', name: 'read', arguments: JSON.stringify({ file_path: 'C:\\opt\\a.mjs' }) };
const callB = { id: 'call_b', name: 'pwsh', arguments: JSON.stringify({ command: 'Get-ChildItem', description: 'list' }) };

console.log('toolcall-index — OpenAI 出口 index 语义');
check('两个 toolCall 显式传 0/1 → 帧内 index 分别为 0/1', () => {
  const out = exportOpenAI();
  const [fa] = dataLines(out.toolCall('m', 'vm/long-context', callA, 0));
  const [fb] = dataLines(out.toolCall('m', 'vm/long-context', callB, 1));
  assert.strictEqual(fa.choices[0].delta.tool_calls[0].index, 0);
  assert.strictEqual(fb.choices[0].delta.tool_calls[0].index, 1);
  assert.strictEqual(fa.choices[0].delta.tool_calls[0].function.name, 'read');
  assert.strictEqual(fb.choices[0].delta.tool_calls[0].function.name, 'pwsh');
});
check('不传 index → 默认 0（兼容旧行为）', () => {
  const out = exportOpenAI();
  const [f] = dataLines(out.toolCall('m', 'm', callA));
  assert.strictEqual(f.choices[0].delta.tool_calls[0].index, 0);
});

console.log('toolcall-index — dispatch 形态（计数器递增，修复后）');
check('两个调用分桶独立，各自 arguments 可解析', () => {
  const out = exportOpenAI();
  // dispatch.js 修复后的发射模式：计数器递增传参
  const frames = [
    ...dataLines(out.toolCall('m', 'vm/long-context', callA, 0)),
    ...dataLines(out.toolCall('m', 'vm/long-context', callB, 1)),
  ];
  const calls = aggregateLikeDsh(frames);
  assert.strictEqual(calls.length, 2, '应聚合出两个独立调用');
  assert.deepStrictEqual(JSON.parse(calls[0].args), { file_path: 'C:\\opt\\a.mjs' });
  assert.deepStrictEqual(JSON.parse(calls[1].args), { command: 'Get-ChildItem', description: 'list' });
});

console.log('toolcall-index — 旧形态反向锚（index 全 0，锁死事故认知）');
check('index 全 0 时聚合必拼接，JSON.parse 报 non-whitespace 错误', () => {
  const out = exportOpenAI();
  const frames = [
    ...dataLines(out.toolCall('m', 'vm/long-context', callA)),
    ...dataLines(out.toolCall('m', 'vm/long-context', callB)),
  ];
  const calls = aggregateLikeDsh(frames);
  assert.strictEqual(calls.length, 1, '两个调用被拼进同一个桶');
  assert.throws(
    () => JSON.parse(calls[0].args),
    /Unexpected non-whitespace character after JSON/,
    '拼接流必须在第二个对象处解析失败',
  );
});

console.log('toolcall-index — createStreamHandler + 计数器端到端（TRAE 分片形态）');
check('上游两个原生 tool_calls → 出口两帧不同 index、参数独立', () => {
  const out = exportOpenAI();
  const frames = [];
  let toolCallIndex = 0; // dispatch.js 的修复模式
  const handler = createStreamHandler((evt) => {
    if (evt.type === 'tool_call') {
      frames.push(...dataLines(out.toolCall('m', 'vm/long-context', evt.call, toolCallIndex)));
      toolCallIndex += 1;
    }
  });
  handler.feedLine(`data: ${JSON.stringify({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: callA.arguments } }] })}`);
  handler.feedLine(`data: ${JSON.stringify({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'pwsh', arguments: callB.arguments } }] })}`);
  handler.flushToolAccum();
  const calls = aggregateLikeDsh(frames);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].name, 'read');
  assert.strictEqual(calls[1].name, 'pwsh');
  assert.deepStrictEqual(JSON.parse(calls[0].args), { file_path: 'C:\\opt\\a.mjs' });
  assert.deepStrictEqual(JSON.parse(calls[1].args), { command: 'Get-ChildItem', description: 'list' });
});

console.log('toolcall-index — Anthropic 出口 content_block 序号');
check('text 用 0，两个 toolCall 用 1/2 → 块序号互不冲突', () => {
  const out = exportAnthropic();
  const textFrames = dataLines(out.text('m', 'm', '答案文本', undefined, 0));
  const tool1 = dataLines(out.toolCall('m', 'm', callA, 1));
  const tool2 = dataLines(out.toolCall('m', 'm', callB, 2));
  assert.strictEqual(textFrames[0].index, 0);
  assert.strictEqual(textFrames[0].delta.type, 'text_delta');
  for (const f of tool1) assert.strictEqual(f.index, 1, 'tool1 的 start/stop 都应为 1');
  for (const f of tool2) assert.strictEqual(f.index, 2, 'tool2 的 start/stop 都应为 2');
  assert.strictEqual(tool1[0].content_block.type, 'tool_use');
  assert.deepStrictEqual(tool1[0].content_block.input, { file_path: 'C:\\opt\\a.mjs' });
});
check('toolCall 不传 blockIndex → 默认 0（兼容旧行为）', () => {
  const out = exportAnthropic();
  const frames = dataLines(out.toolCall('m', 'm', callA));
  for (const f of frames) assert.strictEqual(f.index, 0);
});

/*
 * 路由层必须为文本块补 content_block_start：exportAnthropic.text 只发 delta，
 * 严格客户端在收到 index=N 的 text_delta 前需要看到同 index 的 start 帧。
 * 这里用源码约束而非端到端（起服务成本高），与 request-cancel-isolation 同风格。
 */
check('anthropic 路由：首个 text 事件补 start 帧，stop 用实际文本块序号', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'anthropic.js'), 'utf-8');
  assert.match(src, /content_block_start[\s\S]{0,200}content_block:\s*\{\s*type:\s*'text'/,
    '必须为文本块发 content_block_start');
  assert.match(src, /anthropicTextBlock\s*=\s*anthropicNextBlock\+\+/,
    '文本块序号必须来自同一递增分配器');
  assert.match(src, /const textBlockIndex = anthropicTextBlock < 0 \? 0 : anthropicTextBlock/,
    'content_block_stop 必须用实际文本块序号，不能硬编码 0');
  // 本地应答分支（单文本块）硬编码 0 是正确的，只约束流式分支不残留：
  // 以 textBlockIndex 定义为锚，取它之后的收尾段。
  const streamTail = src.slice(src.indexOf('const textBlockIndex'), src.indexOf('message_stop', src.indexOf('const textBlockIndex')) + 20);
  assert.ok(!/content_block_stop', index: 0/.test(streamTail),
    '流式分支不得残留硬编码 index:0 的 stop 帧');
});

console.log(`\ntoolcall-index: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
