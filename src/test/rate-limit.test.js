'use strict';
/**
 * test/rate-limit.test.js — 转发面限流的默认值与边界（P1-008）。
 *
 * 背景：middleware/rate-limit.js 此前 fallback 是 0（不限），且面板从不给
 * 新密钥写 rpmLimit、.env.example 从不定义 KEY_DEFAULT_RPM —— 实际部署中
 * 每把密钥都不限流。烧的是真实账号积分，必须默认收紧。
 *
 * 运行：node src/test/rate-limit.test.js
 */
const os = require('os');
const path = require('path');
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `trae-rl-${Date.now()}`);
process.env.TRAE_API_ENCRYPT_KEY = 'a'.repeat(64);
process.env.API_KEY = 'test-api-key';
process.env.ADMIN_KEY = 'test-admin-key';

// 注意：maxRpmFor 读 process.env，必须在 require 之前固化默认场景
delete process.env.KEY_DEFAULT_RPM;

const assert = require('assert');
const { maxRpmFor, keyRateLimit, DEFAULT_RPM } = require('../middleware/rate-limit');

let pass = 0;
let fail = 0;
const queue = [];
function t(name, fn) {
  queue.push({ name, fn });
}

/** 构造带可重置 env 的用例执行器（env 改动只在用例内生效）。 */
function withEnv(value, fn) {
  const old = process.env.KEY_DEFAULT_RPM;
  try {
    if (value === undefined) delete process.env.KEY_DEFAULT_RPM;
    else process.env.KEY_DEFAULT_RPM = String(value);
    fn();
  } finally {
    if (old === undefined) delete process.env.KEY_DEFAULT_RPM;
    else process.env.KEY_DEFAULT_RPM = old;
  }
}

/** 构造 Express 风格的 req/res 以驱动中间件。 */
function makeRes() {
  const headers = {};
  return {
    statusCode: null,
    body: null,
    setHeader(k, v) {
      headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    headers,
  };
}

/** 跑一次中间件，返回 { status, body }；next 被调用则返回 { next:true }。 */
function attempt(mw, keyId, rpmLimit) {
  const req = { apiKeyId: keyId, authKey: rpmLimit == null ? null : { rpmLimit } };
  let nexted = false;
  const res = makeRes();
  mw(req, res, () => {
    nexted = true;
  });
  return nexted ? { next: true } : { status: res.statusCode, body: res.body };
}

// ------------------------------------------------------------ 默认值

console.log('middleware/rate-limit — 默认值收紧');

t('未配置 KEY_DEFAULT_RPM 时，无 rpmLimit 的密钥适用安全默认（60）', () => {
  withEnv(undefined, () => {
    assert.strictEqual(maxRpmFor(null), DEFAULT_RPM, '无密钥记录（anon 兜底）也不应不限流');
    assert.strictEqual(maxRpmFor({}), DEFAULT_RPM, 'rpmLimit=null 的密钥不应不限流');
    assert.strictEqual(DEFAULT_RPM, 60, '安全默认应是 60');
  });
});

t('显式 KEY_DEFAULT_RPM=0 恢复不限流（尊重用户选择，向后兼容）', () => {
  withEnv(0, () => {
    assert.strictEqual(maxRpmFor({}), 0);
  });
});

t('密钥自身的 rpmLimit 优先于默认值', () => {
  withEnv(undefined, () => {
    assert.strictEqual(maxRpmFor({ rpmLimit: 5 }), 5);
    assert.strictEqual(maxRpmFor({ rpmLimit: 1000 }), 1000);
    assert.strictEqual(maxRpmFor({ rpmLimit: 0 }), 1, 'rpmLimit=0 视为配置错误，夹到最低 1（历史行为）');
  });
});

// ------------------------------------------------------------ 中间件行为

console.log('middleware/rate-limit — 中间件边界');

t('默认配置下第 61 次请求被 429，且带 Retry-After', () => {
  withEnv(undefined, () => {
    const mw = keyRateLimit();
    const id = `test-key-${Date.now()}`;
    let last;
    for (let i = 0; i < 60; i += 1) {
      last = attempt(mw, id);
      assert.ok(last.next, `第 ${i + 1} 次不应被限流`);
    }
    last = attempt(mw, id);
    assert.strictEqual(last.status, 429, '第 61 次应 429');
    assert.strictEqual(last.body?.error?.code, 'KEY_RPM_LIMIT');
  });
});

t('不同密钥互相独立（不共享窗口）', () => {
  withEnv(undefined, () => {
    const mw = keyRateLimit();
    const a = `ka-${Date.now()}`;
    const b = `kb-${Date.now()}`;
    for (let i = 0; i < 60; i += 1) assert.ok(attempt(mw, a).next);
    assert.ok(attempt(mw, b).next, '密钥 B 不应受密钥 A 计数影响');
  });
});

t('显式 KEY_DEFAULT_RPM=0 时同 key 高频请求不被限', () => {
  withEnv(0, () => {
    const mw = keyRateLimit();
    const id = `unlim-${Date.now()}`;
    for (let i = 0; i < 200; i += 1) {
      const r = attempt(mw, id);
      assert.ok(r.next, `KEY_DEFAULT_RPM=0 时第 ${i + 1} 次不应被限流`);
    }
  });
});

t('密钥 rpmLimit=5 时第 6 次被限（优先于默认值）', () => {
  withEnv(undefined, () => {
    const mw = keyRateLimit();
    const id = `low-${Date.now()}`;
    for (let i = 0; i < 5; i += 1) assert.ok(attempt(mw, id, 5).next);
    const r = attempt(mw, id, 5);
    assert.strictEqual(r.status, 429);
  });
});

// ---------------------------------------------------------------- 汇总

async function main() {
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
  if (process.exitCode) process.exit(process.exitCode);
}

main();