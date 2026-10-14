'use strict';
/**
 * test/protocol.test.js——三个转发协议出口的行为基线。
 * 运行：node src/test/protocol.test.js
 *
 * routes/openai.js、anthropic.js、responses.js 此前未被任何测试 require，而它们是产品对外契约。
 * 已知后果：OpenAI 出口的流内错误被渲染成 delta.content 里的「[Error …]」文本
 * （HTTP 仍是 200，无 finish_reason、无 [DONE]），agent 客户端会把错误文案并入上下文。
 * 断言按「应该是什么样」写：与当前错误行为不符的用例会失败，这是有意的红灯。
 */
const os = require('os');
const path = require('path');
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `trae-proto-${Date.now()}`);
process.env.TRAE_API_ENCRYPT_KEY = 'a'.repeat(64);
process.env.API_KEY = 'test-api-key';
process.env.ADMIN_KEY = 'test-admin-key';

const assert = require('assert');
const { exportOpenAI, exportAnthropic } = require('../transform/emitters');
const { createStreamHandler } = require('../transform/sse');

let pass = 0;
let fail = 0;
const queue = [];
function t(name, fn) {
  queue.push({ name, fn });
}

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

/** 把 emitter 产出的字节块拼成完整 SSE 文本，便于断言。 */
function join(chunks) {
  return (Array.isArray(chunks) ? chunks : [chunks]).join('');
}

/** 解析 SSE 文本里的 data 行（忽略 [DONE]）。 */
function dataLines(text) {
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6))
    .filter((d) => d !== '[DONE]')
    .map((d) => {
      try {
        return JSON.parse(d);
      } catch {
        return { __unparsable: d };
      }
    });
}

// OpenAI 出口

console.log('emitters.exportOpenAI — 正常路径');

t('text 事件产出 delta.content 且无 finish_reason', () => {
  const out = exportOpenAI();
  const obj = dataLines(join(out.text('c1', 'm', 'hello', null)))[0];
  assert.strictEqual(obj.choices[0].delta.content, 'hello');
  assert.strictEqual(obj.choices[0].finish_reason, null);
});

t('done 事件产出 finish_reason 并以 [DONE] 收尾', () => {
  const out = exportOpenAI();
  const text = join(out.done('c1', 'm', 'stop'));
  const obj = dataLines(text)[0];
  assert.strictEqual(obj.choices[0].finish_reason, 'stop');
  assert.ok(text.endsWith('data: [DONE]\n\n'), '必须以 [DONE] 收尾');
});

t('截断时 finish_reason 如实为 length', () => {
  const out = exportOpenAI();
  const obj = dataLines(join(out.done('c1', 'm', 'length')))[0];
  assert.strictEqual(obj.choices[0].finish_reason, 'length');
});

console.log('emitters.exportOpenAI — 流内错误（产品核心契约）');

t('error 事件不得把错误文本塞进 delta.content', () => {
  const out = exportOpenAI();
  const text = join(out.error('c1', 'm', 3004, 'upstream rate limited'));
  const objs = dataLines(text);
  for (const o of objs) {
    const content = o?.choices?.[0]?.delta?.content;
    assert.ok(
      content === undefined || !String(content).includes('[Error'),
      `delta.content 不得承载错误文本，实际：${JSON.stringify(content)}`,
    );
  }
});

t('error 事件必须以 [DONE] 收尾（客户端不能永远等下去）', () => {
  const out = exportOpenAI();
  const text = join(out.error('c1', 'm', 3004, 'boom'));
  assert.ok(text.endsWith('data: [DONE]\n\n'), `错误帧后必须以 [DONE] 收尾，实际结尾：${JSON.stringify(text.slice(-40))}`);
});

t('error 事件必须带可识别的错误信号（顶层 error 或 finish_reason=error）', () => {
  const out = exportOpenAI();
  const objs = dataLines(join(out.error('c1', 'm', 3004, 'boom')));
  const hasSignal = objs.some(
    (o) => o && (o.error || o?.choices?.[0]?.finish_reason === 'error' || o?.choices?.[0]?.finish_reason === 'stop'),
  );
  assert.ok(hasSignal, '必须给出 error 对象或明确的 finish_reason，否则客户端无从判断失败');
});

// Anthropic 出口

console.log('emitters.exportAnthropic — 正常路径');

t('text 事件产出 content_block_delta', () => {
  const out = exportAnthropic();
  const obj = dataLines(join(out.text('m', 'm', 'hi')))[0];
  assert.strictEqual(obj.type, 'content_block_delta');
  assert.strictEqual(obj.delta.text, 'hi');
});

t('toolCall 产出 content_block_start + stop', () => {
  const out = exportAnthropic();
  const objs = dataLines(join(out.toolCall('m', 'm', { id: 't1', name: 'read_file', arguments: '{"x":1}' })));
  assert.strictEqual(objs[0].type, 'content_block_start');
  assert.strictEqual(objs[0].content_block.name, 'read_file');
  assert.deepStrictEqual(objs[0].content_block.input, { x: 1 });
});

t('done 事件产出 message_delta.stop_reason', () => {
  const out = exportAnthropic();
  const obj = dataLines(join(out.done('m', 'm', 'end_turn')))[0];
  assert.strictEqual(obj.type, 'message_delta');
  assert.strictEqual(obj.delta.stop_reason, 'end_turn');
});

console.log('emitters.exportAnthropic — 流内错误');

t('error 事件使用标准 {type:error} 形状', () => {
  const out = exportAnthropic();
  const obj = dataLines(join(out.error('m', 'm', 3004, 'boom')))[0];
  assert.strictEqual(obj.type, 'error');
  assert.ok(obj.error && typeof obj.error.message === 'string');
});

t('error 事件不得写进 text_delta', () => {
  const out = exportAnthropic();
  const objs = dataLines(join(out.error('m', 'm', 3004, 'boom')));
  for (const o of objs) {
    assert.ok(o.type !== 'content_block_delta', 'Anthropic 错误不应伪装成正文增量');
  }
});

// 流式处理器基础行为

console.log('sse.createStreamHandler — 工具调用累积');

t('原生 tool_calls 分片能累积成完整 JSON', () => {
  const calls = [];
  const h = createStreamHandler((e) => {
    if (e.type === 'tool_call') calls.push(e.call);
  });
  // 上游分片：首片带 id 与 name，后续片只追加 arguments 片段
  h.ingest({ tool_calls: [{ index: 0, id: 't1', function: { name: 'fn', arguments: '{"a"' } }] });
  h.ingest({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] });
  h.flushToolAccum();
  assert.strictEqual(calls.length, 1, `应只上报一个完整工具调用，实际 ${calls.length}`);
  assert.deepStrictEqual(JSON.parse(calls[0].arguments), { a: 1 });
});

t('流内错误事件能被归一化为 error（上游 event:error 形态）', () => {
  const events = [];
  const h = createStreamHandler((e) => events.push(e));
  // 上游是先发 `event: error` 行、再发 data 载荷；ingest 只处理载荷
  h.feedLine('event:error');
  h.ingest({ code: 3004, message: 'rate limited' });
  const err = events.find((e) => e.type === 'error');
  assert.ok(err, '错误事件必须被归一化上报，否则路由层无从回灌账号池');
  assert.strictEqual(err.code, 3004);
});

console.log('upstream/client.consumeStream — 资源释放');

t('异常退出时必须 cancel reader（否则连接与 inFlight 租约不归还）', async () => {
  const { consumeStream } = require('../upstream/client');
  let cancelled = false;
  const fakeStream = {
    getReader() {
      return {
        async read() {
          throw new Error('upstream blew up');
        },
        async cancel() {
          cancelled = true;
        },
      };
    },
  };
  let threw = false;
  try {
    await consumeStream(fakeStream, () => {});
  } catch {
    threw = true;
  }
  assert.ok(threw, '原始错误必须继续向上抛，不能被清理逻辑吞掉');
  assert.ok(cancelled, 'reader.cancel() 未被调用 → 连接与 pool inFlight 租约会泄漏');
});

t('正常读完也会 cancel（幂等释放）', async () => {
  const { consumeStream } = require('../upstream/client');
  let cancelled = false;
  const fakeStream = {
    getReader() {
      let done = false;
      return {
        async read() {
          if (done) return { done: true };
          done = true;
          return { done: false, value: new Uint8Array([104, 105]) };
        },
        async cancel() {
          cancelled = true;
        },
      };
    },
  };
  const seen = [];
  await consumeStream(fakeStream, (c) => seen.push(c));
  assert.strictEqual(seen.join(''), 'hi');
  assert.ok(cancelled);
});

// 汇总

async function main() {
  await runAll();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error(
      '\n注意：上述失败项中若有「error 不得写进 delta.content」与「error 必须收尾」，' +
        '那是已知缺陷（见 docs/audits 的 P2-003），修复前持续为红灯。\n' +
        '其余失败项说明协议出口行为与契约不符，必须修。',
    );
  }
  if (process.exitCode) process.exit(process.exitCode);
}

main();
