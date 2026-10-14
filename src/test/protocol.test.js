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
require('./isolation-guard')('protocol');

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

// Anthropic 出口：count_tokens 与非流式分支

console.log('routes/anthropic — count_tokens 与非流式分支');

/*
 * 路由级测试，必须装配真实 express 并打桩上游。
 *
 * 打桩顺序有硬要求：anthropic.js 在**加载期**解构 llmUtilsChat 与 logRequest，
 * 加载之后再改模块导出对它无效。因此所有打桩必须在 require 路由之前完成。
 *
 * logRequest 也必须打桩：它写的是 <ROOT>/logs/<date>/traffic.jsonl（不是
 * workspaceDir，见 src/log/traffic.js#todayDir），不打桩会把测试请求写进真实日志目录。
 */
const httpMod = require('http');
const expressMod = require('express');
const clientMod = require('../upstream/client');
const poolMod = require('../credentials/pool');
const trafficMod = require('../log/traffic');

const upstreamStub = { data: null, calls: [], impl: null, error: null };
const logged = [];

const origLlmUtilsChat = clientMod.llmUtilsChat;
const origPoolRun = poolMod.run;
const origLogRequest = trafficMod.logRequest;

// impl 可替换：路由在加载期就解构了 llmUtilsChat，加载后换模块导出对它无效，
// 所以「按用例换上游行为」只能通过这个可变 impl 完成。
clientMod.llmUtilsChat = async (messages, model, stream, opts) => {
  upstreamStub.calls.push({ messages, model, stream, opts });
  if (upstreamStub.error) throw upstreamStub.error;
  if (upstreamStub.impl) return upstreamStub.impl({ messages, model, stream, opts });
  return { data: upstreamStub.data, function: 'chat_v3' };
};
poolMod.run = async (fn) => ({ result: await fn('acct_stub'), accountId: 'acct_stub' });
trafficMod.logRequest = (entry) => logged.push(entry);

// 上面三处打桩生效后才可以加载路由
const anthropicRouter = require('../routes/anthropic');

let baseUrl = null;
let httpServer = null;

async function ensureServer() {
  if (baseUrl) return baseUrl;
  const app = expressMod();
  app.use(expressMod.json({ limit: '10mb' }));
  // 生产链路由 index.js 的 authenticate 中间件注入；这里直接注入等价字段，
  // 保持 ACL 分支（canUseModel 的 platform 参数）与线上一致。
  app.use((req, res, next) => { req.platform = 'trae'; req.authKey = null; next(); });
  app.use(anthropicRouter);
  httpServer = httpMod.createServer(app);
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  return baseUrl;
}

async function post(path, body) {
  const r = await fetch((await ensureServer()) + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, contentType: r.headers.get('content-type') || '', text };
}

/** 组装一份最小的 Anthropic 请求体。 */
function msgBody(extra) {
  return Object.assign({
    model: 'glm-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好，请介绍一下你自己。' }] }],
  }, extra);
}

t('count_tokens：本地估算并返回 input_tokens，不请求上游', async () => {
  upstreamStub.calls.length = 0;
  const r = await post('/v1/messages/count_tokens', msgBody());
  assert.strictEqual(r.status, 200, `HTTP ${r.status}: ${r.text}`);
  const body = JSON.parse(r.text);
  assert.deepStrictEqual(Object.keys(body), ['input_tokens'], '响应体只应有 input_tokens 一个字段');
  assert.ok(Number.isInteger(body.input_tokens) && body.input_tokens > 0, `input_tokens 应为正整数，实际 ${body.input_tokens}`);
  assert.strictEqual(upstreamStub.calls.length, 0, 'count_tokens 不得请求上游（每次请求前都调它，转发会白烧额度）');
});

t('count_tokens：把 system 与 tools 计入（否则窗口守门会系统性偏低）', async () => {
  const bare = JSON.parse((await post('/v1/messages/count_tokens', msgBody())).text).input_tokens;
  const withSys = JSON.parse((await post('/v1/messages/count_tokens', msgBody({
    system: '你是一个严谨的编码助手，回答必须给出可执行的步骤。'.repeat(20),
  }))).text).input_tokens;
  const withTools = JSON.parse((await post('/v1/messages/count_tokens', msgBody({
    tools: [{ name: 'read_file', description: '读取文件内容', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  }))).text).input_tokens;
  assert.ok(withSys > bare, `system 应计入：${withSys} 应 > ${bare}`);
  assert.ok(withTools > bare, `tools 应计入：${withTools} 应 > ${bare}`);
});

t('count_tokens：messages 为空 → 400', async () => {
  const r = await post('/v1/messages/count_tokens', { model: 'glm-5', messages: [] });
  assert.strictEqual(r.status, 400, `应 400，实际 ${r.status}`);
});

t('count_tokens：trae 密钥调 wb/ 模型 → 403（与 /v1/messages 同一套 ACL）', async () => {
  const r = await post('/v1/messages/count_tokens', msgBody({ model: 'wb/glm-5.3' }));
  assert.strictEqual(r.status, 403, `应 403，实际 ${r.status}: ${r.text}`);
  const body = JSON.parse(r.text);
  assert.strictEqual(body.error.code, 'MODEL_ACCESS_DENIED');
});

t('非流式：stream:false 返回 Anthropic Message JSON，而不是 SSE 帧', async () => {
  upstreamStub.calls.length = 0;
  upstreamStub.data = {
    id: 'x', object: 'chat.completion', model: 'glm-5',
    choices: [{ index: 0, message: { role: 'assistant', content: '你好！' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
  };
  const r = await post('/v1/messages', msgBody({ stream: false, max_tokens: 64 }));
  assert.strictEqual(r.status, 200, `HTTP ${r.status}: ${r.text}`);
  assert.ok(r.contentType.includes('application/json'), `Content-Type 应为 JSON，实际 ${r.contentType}`);
  assert.ok(!r.text.includes('data: '), '非流式响应体不得含 SSE 帧');
  const body = JSON.parse(r.text);
  assert.strictEqual(body.type, 'message');
  assert.strictEqual(body.role, 'assistant');
  assert.strictEqual(body.model, 'glm-5');
  assert.deepStrictEqual(body.content, [{ type: 'text', text: '你好！' }]);
  assert.strictEqual(body.stop_reason, 'end_turn');
  assert.deepStrictEqual(body.usage, { input_tokens: 11, output_tokens: 5 });
  assert.strictEqual(upstreamStub.calls[0].stream, false, '非流式分支必须以 stream=false 调上游');
});

t('非流式：tool_calls 折叠为 tool_use 块且 stop_reason 为 tool_use', async () => {
  upstreamStub.data = {
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 },
  };
  const body = JSON.parse((await post('/v1/messages', msgBody({ stream: false }))).text);
  assert.deepStrictEqual(body.content, [
    { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
  ], '工具调用必须折叠成 tool_use 块且 input 已解析为对象');
  assert.strictEqual(body.stop_reason, 'tool_use');
});

t('非流式：finish_reason=length → stop_reason=max_tokens（截断优先于 tool_use）', async () => {
  upstreamStub.data = {
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: '半截',
        tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{"a"' } }],
      },
      finish_reason: 'length',
    }],
    usage: null,
  };
  const body = JSON.parse((await post('/v1/messages', msgBody({ stream: false }))).text);
  assert.strictEqual(body.stop_reason, 'max_tokens', '参数残缺时不能报 tool_use，否则客户端会执行残缺调用');
  assert.deepStrictEqual(body.usage, { input_tokens: 0, output_tokens: 0 }, '无 usage 时应归零而不是 undefined');
});

t('非流式：上游失败用 HTTP 状态码表达（此时还没下发响应体）', async () => {
  upstreamStub.error = Object.assign(new Error('upstream boom'), { status: 429 });
  const r = await post('/v1/messages', msgBody({ stream: false }));
  delete upstreamStub.error;
  assert.strictEqual(r.status, 429, `应沿用上游 429，实际 ${r.status}`);
  const body = JSON.parse(r.text);
  assert.strictEqual(body.type, 'error');
  assert.strictEqual(body.error.type, 'overloaded_error');
});

t('流式：默认（未传 stream）仍是 SSE，保持既有客户端行为不变', async () => {
  // 流式分支只读 up.body；用一个最小 SSE 流喂进去。
  // 事件体形状必须与上游（Trae llm_utils_chat）一致：文本在顶层 response/content，
  // 不是 OpenAI 的 choices[0].delta（解析见 transform/sse.js:230-245）。
  upstreamStub.impl = () => ({
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"content":"hi"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      },
    }),
  });
  let r;
  try {
    r = await post('/v1/messages', msgBody());
  } finally {
    upstreamStub.impl = null;
  }
  assert.strictEqual(r.status, 200, `HTTP ${r.status}`);
  assert.ok(r.contentType.includes('text/event-stream'), `缺省应为 SSE，实际 ${r.contentType}`);
  const types = dataLines(r.text).map((d) => d.type);
  assert.ok(types.includes('message_start'), `应有 message_start，实际 ${types.join(',')}`);
  assert.ok(types.includes('message_delta'), `应有 message_delta，实际 ${types.join(',')}`);
  assert.ok(types.includes('message_stop'), `应有 message_stop，实际 ${types.join(',')}`);
  assert.ok(r.text.includes('"text":"hi"'), `应把上游 content 渲染成 text_delta；实际响应=${r.text.slice(0, 600)}`);
});

t('两分支都记账：count_tokens 不记（非上游消耗），messages 记一条', async () => {
  logged.length = 0;
  await post('/v1/messages/count_tokens', msgBody());
  assert.strictEqual(logged.length, 0, 'count_tokens 属本地计算，不该进流量统计（会污染成功率分母）');
  upstreamStub.data = { choices: [{ index: 0, message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };
  await post('/v1/messages', msgBody({ stream: false }));
  assert.strictEqual(logged.length, 1, 'messages 每次调用应记一条流量');
  assert.strictEqual(logged[0].endpoint, '/v1/messages');
  assert.strictEqual(logged[0].stream, false, '日志应能区分流式/非流式');
  assert.strictEqual(logged[0].totalTokens, 4);
});

t('D5：工具结果带 is_error 时，流量日志记录 toolErrors（is_error 全链路生效）', async () => {
  logged.length = 0;
  upstreamStub.data = {
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  };
  await post('/v1/messages', {
    model: 'glm-5',
    stream: false,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'run it' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'f', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: true, content: 'ENOENT' }] },
    ],
  });
  assert.strictEqual(logged.length, 1, '应记一条流量');
  assert.strictEqual(logged[0].toolErrors, 1, 'is_error 必须被计入 toolErrors（丢了它模型会重试同一次调用）');
  // 无错误工具结果时不该出现该字段（避免把「没测量」写成 0）
  logged.length = 0;
  await post('/v1/messages', {
    model: 'glm-5',
    stream: false,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'run it' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
    ],
  });
  assert.strictEqual(logged.length, 1);
  assert.strictEqual(logged[0].toolErrors, undefined, '无失败工具结果时不写该字段');
});

// 汇总

async function main() {
  await runAll();
  if (httpServer) await new Promise((r) => httpServer.close(r));
  // 恢复打桩，避免影响同进程内后续代码
  clientMod.llmUtilsChat = origLlmUtilsChat;
  poolMod.run = origPoolRun;
  trafficMod.logRequest = origLogRequest;
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
