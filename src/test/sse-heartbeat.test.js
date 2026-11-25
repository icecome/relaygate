'use strict';
/**
 * test/sse-heartbeat.test.js —— 流式静默心跳与 server 空闲超时。
 * 运行：node src/test/sse-heartbeat.test.js
 *
 * 背景（2026-11-25）：TraeWork 调自定义模型时报 `4054 CUSTOM_MODEL_INTERNAL_ERROR`
 * （客户端文案「Custom model internal error occurred. Please check the proxy response
 * for details.」）。取证结论是**网关侧没有失败请求**——6 次 4054 的当时网关都没有
 * Trae 请求在飞，当轮全部 200。真正的放大器有两个，都属网关可控范围：
 *
 *   1. 直连 Trae 路径 `flushHeaders()` 之后到首个上游事件之间**零字节静默**，
 *      实测该段 p90 = 19.1s、p99 = 45.5s、max = 110s（3146 条样本）；
 *   2. Node 默认 `keepAliveTimeout = 5000ms`，而客户端相邻请求间隔
 *      p50 = 11.5s / p90 = 35.3s，57.6% 超过 5s —— 一半以上的复用发生在
 *      服务端已 FIN 的 socket 上。
 *
 * 本文件锁住这两项修复的**不变量**：
 *   H-1 正常有字节流动时一个心跳帧都不发（不得给正常路径增加任何帧）；
 *   H-2 静默超过一个周期才补帧，且补的是 SSE 注释行（客户端一律忽略）；
 *   H-3 `end()` 之后不再写（否则 ERR_STREAM_WRITE_AFTER_END）；
 *   H-4 间隔 ≤ 0 时是空实现，调用方无需分支；
 *   H-5 headersTimeout 必须严格大于 keepAliveTimeout（否则设置失效）。
 */
const os = require('os');
const path = require('path');
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `hb-test-${Date.now()}`);
process.env.TRAE_API_ENCRYPT_KEY = 'a'.repeat(64);
process.env.API_KEY = 'test-api-key';
process.env.ADMIN_KEY = 'test-admin-key';
require('./isolation-guard')('sse-heartbeat');

const assert = require('assert');
const {
  attachSseHeartbeat,
  DEFAULT_HEARTBEAT_MS,
  HEARTBEAT_FRAME,
} = require('../lib/sse-heartbeat');
const {
  tuneServerTimeouts,
  HEADERS_MARGIN_MS,
} = require('../lib/server-timeouts');

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
  console.log(`\n${pass} passed, ${fail} failed`);
}

/** 最小 res 替身：记录下发的字节与 end 状态。 */
function fakeRes() {
  return {
    chunks: [],
    writableEnded: false,
    write(s) { this.chunks.push(String(s)); return true; },
    end() { this.writableEnded = true; },
    text() { return this.chunks.join(''); },
  };
}

/** 可手动推进的时钟，避免测试真的等 15 秒。 */
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 常量

console.log('lib/sse-heartbeat — 常量与默认值');

t('默认心跳周期是 15s，与 stream-gate 同口径', () => {
  assert.strictEqual(DEFAULT_HEARTBEAT_MS, 15_000);
  // 两条路径的心跳周期必须一致：同仓两套口径会让「静默多久算异常」失去参照。
  const gate = require('../model-router/stream-gate');
  assert.strictEqual(gate.DEFAULT_KEEPALIVE_MS, DEFAULT_HEARTBEAT_MS,
    'stream-gate 与 sse-heartbeat 的心跳周期必须相同');
});

t('心跳帧是 SSE 注释行（客户端一律忽略）', () => {
  assert.strictEqual(HEARTBEAT_FRAME, ': ping\n\n');
  assert.ok(HEARTBEAT_FRAME.startsWith(':'), 'SSE 注释行必须以冒号开头');
  assert.ok(HEARTBEAT_FRAME.endsWith('\n\n'), '注释帧必须以空行结束');
});

// H-4：关闭态

console.log('lib/sse-heartbeat — 关闭态');

t('intervalMs=0 时是空实现，不写任何字节', async () => {
  const res = fakeRes();
  const hb = attachSseHeartbeat(res, { intervalMs: 0 });
  assert.strictEqual(hb.stopped, true);
  hb.touch();
  hb.stop();
  res.write('data: x\n\n');
  await sleep(30);
  assert.strictEqual(res.text(), 'data: x\n\n', '关闭态不得插入任何帧');
});

t('intervalMs 为负数或 NaN 时同样关闭', async () => {
  for (const v of [-1, NaN, 'abc', {}]) {
    const res = fakeRes();
    const hb = attachSseHeartbeat(res, { intervalMs: v });
    assert.strictEqual(hb.stopped, true, `intervalMs=${String(v)} 应关闭`);
  }
});

t('未传 intervalMs（undefined/null）时按默认开启，不是关闭', async () => {
  // 三态语义：没表态 → 用默认；明确给坏值 → 关闭。两者不能混为一谈，
  // 否则「配置漏填」会静默退化成「保护被关掉」。
  for (const v of [undefined, null]) {
    const res = fakeRes();
    const hb = attachSseHeartbeat(res, { intervalMs: v });
    assert.strictEqual(hb.stopped, false, `intervalMs=${v} 应使用默认 15s`);
    hb.stop();
  }
});

// H-1：有流量时不发

console.log('lib/sse-heartbeat — 有字节流动时零额外帧');

t('持续写出时一个心跳帧都不发', async () => {
  const res = fakeRes();
  // 20ms 周期 + 每 5ms 写一次：静默永远不会达到一个周期
  const hb = attachSseHeartbeat(res, { intervalMs: 20 });
  for (let i = 0; i < 20; i++) {
    res.write(`data: ${i}\n\n`);
    await sleep(5);
  }
  hb.stop();
  assert.strictEqual(res.text().includes(': ping'), false, '有流量时不得插入心跳');
  assert.strictEqual(hb.sent(), 0);
});

t('touch() 也能刷新静默计时（调用方手动保活）', async () => {
  const res = fakeRes();
  const hb = attachSseHeartbeat(res, { intervalMs: 25 });
  for (let i = 0; i < 8; i++) {
    hb.touch();
    await sleep(10);
  }
  hb.stop();
  assert.strictEqual(hb.sent(), 0, 'touch 应推迟心跳');
});

// H-2：静默补帧

console.log('lib/sse-heartbeat — 静默超期补注释帧');

t('静默超过一个周期后补 : ping，且不改动已有字节', async () => {
  const res = fakeRes();
  res.write('data: hello\n\n');
  const hb = attachSseHeartbeat(res, { intervalMs: 20 });
  await sleep(70);
  hb.stop();
  const text = res.text();
  assert.ok(text.startsWith('data: hello\n\n'), '原有帧必须原样保留在最前');
  assert.ok(hb.sent() >= 1, `应至少发一个心跳，实际 ${hb.sent()}`);
  // 心跳帧必须自成一行，且不被拼进任何 data 帧
  for (const line of text.split('\n')) {
    if (!line) continue;
    assert.ok(!line.includes('data:') || !line.includes(': ping'),
      '心跳不得与 data 帧混在同一行');
  }
});

t('心跳计数与实际下发帧数一致（每拍最多一帧）', async () => {
  const res = fakeRes();
  const hb = attachSseHeartbeat(res, { intervalMs: 15 });
  await sleep(80);
  hb.stop();
  const frames = (res.text().match(/: ping\n\n/g) || []).length;
  assert.strictEqual(frames, hb.sent(), `帧数 ${frames} 应与计数 ${hb.sent()} 一致`);
});

// H-3：end 之后不写

console.log('lib/sse-heartbeat — 生命周期');

t('end() 之后不再写心跳（避免 ERR_STREAM_WRITE_AFTER_END）', async () => {
  const res = fakeRes();
  const hb = attachSseHeartbeat(res, { intervalMs: 15 });
  await sleep(40);
  const before = res.text().length;
  res.end();
  await sleep(60);
  assert.strictEqual(res.text().length, before, 'end 之后不得再写任何字节');
  assert.strictEqual(hb.stopped, true, 'end 应停表');
});

t('显式 stop() 之后不再写', async () => {
  const res = fakeRes();
  const hb = attachSseHeartbeat(res, { intervalMs: 15 });
  hb.stop();
  const before = res.text().length;
  await sleep(60);
  assert.strictEqual(res.text().length, before);
});

t('stop() 可重复调用（幂等）', () => {
  const res = fakeRes();
  const hb = attachSseHeartbeat(res, { intervalMs: 15 });
  hb.stop();
  hb.stop();
  hb.stop();
  assert.strictEqual(hb.stopped, true);
});

t('write 的返回值与回调被原样透传（包装不得改变契约）', (done) => {
  const res = {
    writableEnded: false,
    written: [],
    write(s, cb) {
      this.written.push(String(s));
      if (typeof cb === 'function') cb();
      return 'ORIGINAL_RETURN';
    },
    end() { this.writableEnded = true; },
  };
  const hb = attachSseHeartbeat(res, { intervalMs: 0 });
  let cbCalled = false;
  const ret = res.write('x', () => { cbCalled = true; });
  hb.stop();
  assert.strictEqual(ret, 'ORIGINAL_RETURN', 'write 返回值必须原样透传');
  assert.strictEqual(cbCalled, true, 'write 回调必须被调用');
  if (typeof done === 'function') done();
});

// H-5：server 超时

console.log('lib/server-timeouts — keep-alive 与 headers 的约束');

t('headersTimeout 严格大于 keepAliveTimeout', () => {
  const server = {};
  const r = tuneServerTimeouts(server, { keepAliveTimeoutMs: 65_000 });
  assert.strictEqual(server.keepAliveTimeout, 65_000);
  assert.ok(server.headersTimeout > server.keepAliveTimeout,
    `headersTimeout(${server.headersTimeout}) 必须 > keepAliveTimeout(${server.keepAliveTimeout})`);
  assert.strictEqual(server.headersTimeout, 65_000 + HEADERS_MARGIN_MS);
  assert.strictEqual(r.keepAliveTimeout, 65_000);
});

t('默认值覆盖客户端请求间隔 p90（35.3s）', () => {
  const config = require('../config');
  assert.ok(config.keepAliveTimeoutMs >= 35_300,
    `keepAliveTimeout=${config.keepAliveTimeoutMs} 应覆盖实测 p90=35300ms`);
});

t('keepAliveTimeoutMs ≤ 0 时不改动 server（保留 Node 默认）', () => {
  for (const v of [0, -1, NaN, null]) {
    const server = {};
    const r = tuneServerTimeouts(server, { keepAliveTimeoutMs: v });
    assert.strictEqual(r, null, `keepAliveTimeoutMs=${v} 应返回 null`);
    assert.strictEqual(server.keepAliveTimeout, undefined, '不得写入 server');
  }
});

t('server 为 null/非对象时安全返回', () => {
  assert.strictEqual(tuneServerTimeouts(null, { keepAliveTimeoutMs: 1000 }), null);
  assert.strictEqual(tuneServerTimeouts(undefined, { keepAliveTimeoutMs: 1000 }), null);
});

runAll();
