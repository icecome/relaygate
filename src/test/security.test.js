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

function req(method, p, { token, origin, ctype, body, limit } = {}) {
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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf.slice(0, limit || 200) }));
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

  // ---- M-S3：CSP 与安全响应头 ----
  r = await req('GET', '/health', {});
  check('M-S3 X-Content-Type-Options', r.headers['x-content-type-options'] === 'nosniff', r.headers['x-content-type-options']);
  check('M-S3 X-Frame-Options', r.headers['x-frame-options'] === 'DENY', r.headers['x-frame-options']);

  r = await req('GET', '/', {});
  check('M-S3 面板响应带 CSP', /default-src 'self'/.test(String(r.headers['content-security-policy'])), String(r.headers['content-security-policy']).slice(0, 60));

  r = await req('GET', '/v1/models/status', { token: login.key });
  check('M-S3 /v1 响应不带 CSP（避免干扰客户端）', r.headers['content-security-policy'] === undefined, String(r.headers['content-security-policy']));

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

  // ---- M-S5：平台密钥 resources ACL（此前 trae/workbuddy 分支不校验 resources） ----
  // 纯函数层：trae 密钥 + 受限 resources，命中放行 / 越界拒绝
  // 选型说明：拒绝用例必须用 Trae 专属模型（model-config.json 内、且不在 WB_MODELS
  // 中），否则先被 isWorkBuddyOnlyModel 的 platform_mismatch 拒绝，测不到资源 ACL。
  const traeRestricted = { platform: 'trae', scopes: ['models:invoke'], resources: ['model:trae/glm-*'] };
  check('M-S5 trae 密钥 resources 命中', canUseModel('trae', 'glm-5', traeRestricted).ok === true, JSON.stringify(canUseModel('trae', 'glm-5', traeRestricted)));
  check('M-S5 trae 密钥 resources 拒绝（doubao-1-6 非 WB 专属）', canUseModel('trae', 'doubao-1-6', traeRestricted).ok === false, JSON.stringify(canUseModel('trae', 'doubao-1-6', traeRestricted)));
  // workbuddy 密钥调裸模型 ID：资源路径必须映射为 model:workbuddy/<id>（而非 model:trae/<id>）
  const wbRestricted = { platform: 'workbuddy', scopes: ['models:invoke'], resources: ['model:workbuddy/glm-5.3'] };
  check('M-S5 wb 密钥 resources 命中（裸 ID 映射 workbuddy 平台）', canUseModel('workbuddy', 'glm-5.3', wbRestricted).ok === true, JSON.stringify(canUseModel('workbuddy', 'glm-5.3', wbRestricted)));
  check('M-S5 wb 密钥 resources 拒绝', canUseModel('workbuddy', 'other-wb-model', wbRestricted).ok === false, JSON.stringify(canUseModel('workbuddy', 'other-wb-model', wbRestricted)));
  // 默认 resources（平台通配）不受影响：存量密钥行为不变
  const traeDefault = { platform: 'trae', scopes: ['models:invoke'], resources: ['model:trae/*'] };
  check('M-S5 trae 默认通配 resources 放行', canUseModel('trae', 'doubao-1-6', traeDefault).ok === true, JSON.stringify(canUseModel('trae', 'doubao-1-6', traeDefault)));
  // HTTP 层：创建受限 trae 密钥走真实端点验证 403（模型选型同上）
  const traeRestrictedKey = apiKeys.createKey({ label: 'sec-trae-restricted', kind: 'access', platform: 'trae', resources: ['model:trae/glm-*'], scopes: ['models:invoke'] });
  r = await req('POST', '/v1/chat/completions', { token: traeRestrictedKey.key, ctype: 'application/json', body: { model: 'doubao-1-6', messages: [{ role: 'user', content: 'hi' }] } });
  check('M-S5 /v1/chat/completions trae 受限模型被 403', r.status === 403, `-> ${r.status} ${r.body.slice(0, 90)}`);
  // 不传 authKey 的对照：说明 ACL 依赖路由层补参（与 M-S4 对照用例同口径）
  check('M-S5 不传 authKey 时平台 ACL 被跳过（对照）', canUseModel('trae', 'doubao-1-6').ok === true, '');

  // ---- K-1：管理/转发权限分离 ----
  // env API_KEY 在启动时已被 bootstrapFromEnv 种成库内 access key（引导种子的设计角色），
  // 因此转发面 /v1/models 200 是正确行为；权限分离的判定点是管理面被拒。
  r = await req('GET', '/v1/models', { token: process.env.API_KEY });
  check('K-1 env API_KEY（已引导为 access key）转发面可用', r.status === 200, `-> ${r.status}`);

  r = await req('GET', '/v1/credentials', { token: process.env.API_KEY });
  check('K-1 env API_KEY 访问管理面被拒（不再跨界）', r.status === 401, `-> ${r.status}`);

  r = await req('GET', '/v1/credentials', { token: process.env.ADMIN_KEY });
  check('K-1 env ADMIN_KEY 管理面可用', r.status === 200, `-> ${r.status}`);

  r = await req('GET', '/v1/models', { token: process.env.ADMIN_KEY });
  check('K-1 env ADMIN_KEY 管理视图 /v1/models 可用', r.status === 200, `-> ${r.status}`);

  // ---- K-2：/v1/models 对访问密钥强制 models:read scope ----
  // 库内密钥在启动迁移后均含 models:read；直接改库构造一个显式剔除的密钥验证 403。
  const noRead = apiKeys.createKey({ label: 'sec-no-read', kind: 'access', platform: 'trae', scopes: ['models:invoke'] });
  const { db } = require('../credentials/db');
  db().prepare("UPDATE api_keys SET scopes = ? WHERE id = ?").run(JSON.stringify(['models:invoke']), noRead.id);
  r = await req('GET', '/v1/models', { token: noRead.key });
  check('K-2 缺 models:read 的访问密钥被 403', r.status === 403, `-> ${r.status} ${r.body.slice(0, 80)}`);

  // 迁移函数幂等补齐
  const patched = apiKeys.ensureModelsReadScope();
  check('K-2 ensureModelsReadScope 补齐缺失密钥', patched.includes(noRead.id), JSON.stringify(patched));
  r = await req('GET', '/v1/models', { token: noRead.key });
  check('K-2 迁移后同一密钥恢复 200', r.status === 200, `-> ${r.status}`);

  // K-4：reveal 高危操作落审计（M-S1 已删除库内 login key，此处补建管理凭据）
  const loginK4 = apiKeys.createKey({ label: 'sec-login-k4', kind: 'login' });
  r = await req('GET', `/v1/api-keys/${noRead.id}/reveal`, { token: loginK4.key });
  check('K-4 reveal 返回明文', r.status === 200, `-> ${r.status}`);
  const auditRows = require('../log/audit').query({ action: 'key.reveal', limit: 5 });
  check('K-4 reveal 审计已记录', auditRows.some((x) => x.resource === `key:${noRead.id}`), '');
  apiKeys.deleteKey(loginK4.id);
  apiKeys.deleteKey(noRead.id);

  // ---- E1：虚拟模型守门 400 透传 error.code=context_length_exceeded ----
  // E2E 验证客户端可按 .env.example 承诺的结构化 code 识别超限，
  // 而非匹配错误文案（后端改文案即失效的脆弱契约）。
  // M-S1 段落已删除库内 login key，此处用 trae 平台 access key：
  // 虚拟模型对平台密钥不整单拒绝（model-access.js:48-59），守门在候选排序前触发。
  const mrStore = require('../model-router/store');
  mrStore.upsertVirtual('vm/sec-guard', {
    strategy: 'priority',
    contextWindow: 1000,
    candidates: [{ id: 'g', provider: 'trae', model: 'glm-5.3', priority: 1 }],
  });
  r = await req('POST', '/v1/chat/completions', {
    token: access.key,
    ctype: 'application/json',
    body: { model: 'vm/sec-guard', stream: false, messages: [{ role: 'user', content: 'x'.repeat(12000) }] },
    limit: 2000,
  });
  let guardCode = null;
  try { guardCode = JSON.parse(r.body).error.code; } catch { /* 非 JSON 忽略 */ }
  check('E1 守门超限返回 400', r.status === 400, `-> ${r.status} ${r.body.slice(0, 90)}`);
  check('E1 守门 400 带 error.code=context_length_exceeded', guardCode === 'context_length_exceeded', `-> ${guardCode}`);
  mrStore.removeVirtual('vm/sec-guard');

  // ---- E3：候选开关端点不得因候选 id 含斜杠而落到转发面鉴权 ----
  // 候选 id 形如 `workbuddy/wb/hy3`。若放进路径段，即便 encodeURIComponent 编成
  // %2F，Express 解码后仍按分隔符切分 → 管理面路由未命中 → 落到转发面
  // authenticate → 401「Invalid access key」→ 面板误判为登录失效并退出登录。
  // 这里锁定：走查询参数的端点对含斜杠 id 返回 2xx，旧形态返回可读 404（非 401）。
  // 复用本文件已注入的 env ADMIN_KEY（等同管理面登录密钥）。
  const adminToken = process.env.ADMIN_KEY;
  mrStore.upsertVirtual('vm/sec-slash', {
    auto: true,
    sort: 'rate',
    rotateTopN: 2,
    candidates: [
      { id: 'workbuddy/wb/hy3', provider: 'workbuddy', model: 'wb/hy3', priority: 1, rate: 0 },
      { id: 'trae/glm-5.3', provider: 'trae', model: 'glm-5.3', priority: 2, rate: 0.78 },
    ],
  });
  const vmSeg = encodeURIComponent('vm/sec-slash');
  const candQ = encodeURIComponent('workbuddy/wb/hy3');
  r = await req('PATCH', `/v1/admin/model-router/virtual/${vmSeg}/candidate?candidateId=${candQ}`, {
    token: adminToken,
    ctype: 'application/json',
    body: { enabled: false },
  });
  check('E3 含斜杠候选 id 的开关请求不返回 401', r.status !== 401, `-> ${r.status} ${r.body.slice(0, 90)}`);
  check('E3 含斜杠候选 id 的开关请求成功', r.status === 200, `-> ${r.status} ${r.body.slice(0, 90)}`);
  const afterSlash = mrStore.getVirtual('vm/sec-slash').candidates[0];
  check('E3 候选 enabled 已真实落库', afterSlash.enabled === false, `-> enabled=${afterSlash.enabled}`);

  // 旧路径形态：必须返回可读的 404，而不是掉进转发面变成 401
  r = await req('PATCH', `/v1/admin/model-router/virtual/${vmSeg}/candidates/${candQ}`, {
    token: adminToken,
    ctype: 'application/json',
    body: { enabled: true },
  });
  check('E3 旧候选路径返回 404 而非 401', r.status === 404, `-> ${r.status} ${r.body.slice(0, 90)}`);
  mrStore.removeVirtual('vm/sec-slash');
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
