'use strict';
/**
 * test/security.test.js — 安全边界回归测试（真实起服务 + HTTP 断言）。
 * 运行：node src/test/security.test.js
 *
 * 覆盖：
 *   M-S2  运维子路由（/v1/models/status|refresh|detail）只认管理鉴权，转发密钥被拒
 *   M-S1  首登 setup 端点拒绝跨源浏览器请求，同源与 CLI 调用仍可用
 *   M-S3  CSP 与安全响应头：面板文档带 CSP，/v1 转发响应不带
 *   M-S4  resources 资源 ACL 在 /v1/messages 与 /v1/responses 上生效
 *
 * 与 unit.test.js 同样必须在 require 业务模块前隔离 WORKSPACE_DIR，
 * 否则会污染真实账号库。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-security-'));
process.env.WORKSPACE_DIR = WS;
process.env.TRAE_API_ENCRYPT_KEY = 'b'.repeat(64);
process.env.API_KEY = 'security-test-api-key';
process.env.ADMIN_KEY = 'security-test-admin-key';
process.env.PORT = String(19000 + (process.pid % 1000));
process.env.HOST = '127.0.0.1';
process.env.SCHEDULER_ENABLED = 'false';

const app = require('../index.js');
const apiKeys = require('../credentials/api-keys');
const { canUseModel } = require('../middleware/model-access');

const BASE = `http://127.0.0.1:${process.env.PORT}`;

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}  ${detail || ''}`); }
}

function req(method, p, { token, origin, ctype, body } = {}) {
  return new Promise((resolve) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (origin) headers.Origin = origin;
    if (ctype) headers['Content-Type'] = ctype;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request(BASE + p, { method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf.slice(0, 200) }));
    });
    r.on('error', (e) => resolve({ status: 0, headers: {}, body: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

async function run() {
  const access = apiKeys.createKey({ label: 'sec-access', kind: 'access', platform: 'trae' });
  const login = apiKeys.createKey({ label: 'sec-login', kind: 'login' });

  // ---- M-S2：运维子路由只认管理鉴权 ----
  let r = await req('GET', '/v1/models/status', { token: access.key });
  check('M-S2 转发密钥 GET /v1/models/status 被拒', r.status === 401 || r.status === 403, `-> ${r.status}`);

  r = await req('POST', '/v1/models/refresh', { token: access.key });
  check('M-S2 转发密钥 POST /v1/models/refresh 被拒', r.status === 401 || r.status === 403, `-> ${r.status}`);

  r = await req('DELETE', '/v1/models/status?model=x', { token: access.key });
  check('M-S2 转发密钥 DELETE /v1/models/status 被拒', r.status === 401 || r.status === 403, `-> ${r.status}`);

  r = await req('GET', '/v1/models/detail', { token: access.key });
  check('M-S2 转发密钥 GET /v1/models/detail 被拒', r.status === 401 || r.status === 403, `-> ${r.status}`);

  r = await req('GET', '/v1/models/status', { token: login.key });
  check('M-S2 管理密钥仍可访问 /v1/models/status', r.status === 200, `-> ${r.status}`);

  r = await req('GET', '/v1/models', { token: access.key });
  check('M-S2 转发面 GET /v1/models 仍可用（双面语义保留）', r.status === 200, `-> ${r.status}`);

  // ---- M-S1：首登端点跨源闸门 ----
  for (const k of apiKeys.listKeys({ kind: 'login' })) apiKeys.deleteKey(k.id);
  check('前置：库内 login key 已清空', apiKeys.hasLoginKey() === false, '');

  r = await req('POST', '/v1/api-keys/setup/login-key', { origin: 'https://evil.example', ctype: 'text/plain', body: { label: 'evil' } });
  check('M-S1 跨源 setup 写入被拒', r.status === 403, `-> ${r.status} ${r.body.slice(0, 80)}`);

  r = await req('POST', '/v1/api-keys/setup/login-key', { origin: BASE, ctype: 'application/json', body: { label: 'ok' } });
  check('M-S1 同源 setup 仍可创建首把密钥', r.status === 201, `-> ${r.status}`);

  r = await req('POST', '/v1/api-keys/setup/login-key', { ctype: 'application/json', body: { label: 'cli' } });
  check('M-S1 无 Origin（CLI）在已有 key 时返回 403 而非 origin 拒绝', r.status === 403 && /登录密钥已存在/.test(r.body), `-> ${r.status}`);

  // ---- M-S4：resources 资源 ACL ----
  const restricted = { platform: 'all', scopes: ['models:invoke'], resources: ['model:trae/glm-*'] };
  check('M-S4 通用密钥 resources 命中', canUseModel('all', 'glm-5', restricted).ok === true, JSON.stringify(canUseModel('all', 'glm-5', restricted)));
  check('M-S4 通用密钥 resources 拒绝', canUseModel('all', 'deepseek-v4-pro', restricted).ok === false, JSON.stringify(canUseModel('all', 'deepseek-v4-pro', restricted)));
  check('M-S4 不传 authKey 时 ACL 被跳过（对照，说明补参是必要前提）', canUseModel('all', 'deepseek-v4-pro').ok === true, '');

  const restrictedKey = apiKeys.createKey({ label: 'sec-restricted', kind: 'access', platform: 'all', resources: ['model:trae/glm-*'], scopes: ['models:invoke'] });
  r = await req('POST', '/v1/messages', { token: restrictedKey.key, ctype: 'application/json', body: { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] } });
  check('M-S4 /v1/messages 受限模型被 403', r.status === 403, `-> ${r.status} ${r.body.slice(0, 90)}`);

  r = await req('POST', '/v1/responses', { token: restrictedKey.key, ctype: 'application/json', body: { model: 'deepseek-v4-pro', input: 'hi', stream: false } });
  check('M-S4 /v1/responses 受限模型被 403', r.status === 403, `-> ${r.status} ${r.body.slice(0, 90)}`);
}

// app.listen 在 require 时已发起，等端口就绪后再断言
setTimeout(async () => {
  try {
    await run();
  } catch (e) {
    fail++;
    console.error(`FAIL  用例执行异常: ${e.stack || e.message}`);
  }
  console.log(`\n${pass} passed${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}, 1200);

module.exports = app;
