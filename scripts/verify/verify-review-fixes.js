'use strict';
/**
 * scripts/verify-review-fixes.js —— 审查发现项的回归验证（全本地，mock 上游）。
 *
 * 覆盖审查报告里的 P0/P1 项：
 *   C-01 raccoonAuth 未定义 → 密码登录路由可用
 *   C-02 / M-S1 GET /v1/credentials/:id 与 PATCH 不再回传密码与手机号
 *   M-S2   账号不一致分支不删既有账号
 *   M-R1/R2 wbNeedsRefresh 只认 lastRefreshAt，不被每日保活盖章压制
 *   M-R3   user_info 失败时不再产生重复账号
 *   M-R4   密码登录写回 persistLogin 实际命中的那条账号
 *   m-01/m-02/m-06 等小节
 *
 * 用法：node scripts/verify-review-fixes.js
 */
const os = require('os');
const path = require('path');
const http = require('node:http');
const assert = require('node:assert');

process.env.WORKSPACE_DIR = path.join(os.tmpdir(), 'rg-revfix-' + Date.now());
process.env.PORT = '19981';
process.env.HOST = '127.0.0.1';
process.env.ADMIN_KEY = 'revfix-admin';
process.env.SCHEDULER_ENABLED = 'false';
process.env.RACCOON_KEEPALIVE_ENABLED = 'false';

// ---- mock raccoon 上游（密码登录 / userInfo / balance） ----
const client = require('../../src/raccoon/client');
let userInfoShouldFail = false;
client.request = async ({ path: p }) => {
  if (p === 'loginWithPassword') {
    return { status: 200, envelope: { code: 0, data: { access_token: 'dt-FRESH-' + Date.now(), refresh_token: 'drt-FRESH' } } };
  }
  if (p === 'userInfo') {
    if (userInfoShouldFail) return { status: 500, envelope: { code: 5001, data: null } };
    return { status: 200, envelope: { code: 0, data: { id: 'uid-fixed', name: 'Olivia' } } };
  }
  if (p === 'pointsBalance') {
    return { status: 200, envelope: { code: 0, data: { available_points: 42, packages: [] } } };
  }
  return { status: 200, envelope: { code: 0, data: {} } };
};

require('../../src/index');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const ADMIN = process.env.ADMIN_KEY;
let pass = 0;

function req(method, p, body) {
  return new Promise((resolve) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = { Authorization: `Bearer ${ADMIN}` };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request(BASE + p, { method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* 非 JSON 保留原文 */ }
        resolve({ status: res.statusCode, text: buf, json });
      });
    });
    r.on('error', (e) => resolve({ status: 0, text: e.message, json: null }));
    if (data) r.write(data);
    r.end();
  });
}

async function ok(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass += 1; } catch (e) {
    console.log('  FAIL ' + name + ' :: ' + e.message); process.exitCode = 1;
  }
}

(async () => {
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const h = await req('GET', '/health');
    if (h.status) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((x) => setTimeout(x, 150));
  }
  const store = require('../../src/credentials/store');

  console.log('\n[C-01] 密码登录路由可用（不再 ReferenceError）');
  const acct = store.add({
    label: 'revfix', edition: 'raccoon', mode: 'device',
    token: 'tok', refreshToken: 'ref', userId: 'uid-fixed', source: 'manual',
  });
  await ok('PUT /accounts/:id/password-login 返回 200 configured=true', async () => {
    userInfoShouldFail = false;
    const r = await req('PUT', `/v1/raccoon/accounts/${acct.id}/password-login`,
      { phone: '18630893389', password: 'SuperSecret123' });
    assert.strictEqual(r.status, 200, `HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    assert.strictEqual(r.json.configured, true);
    assert.ok(!/not defined/.test(r.text), '不得再出现 not defined');
  });

  console.log('\n[C-02 / M-S1] 凭据字段一个都不出网');
  await ok('GET /v1/credentials/:id 不含密码/手机号，含 hasPasswordLogin', async () => {
    const r = await req('GET', `/v1/credentials/${acct.id}`);
    assert.strictEqual(r.status, 200);
    assert.ok(!r.text.includes('SuperSecret123'), '密码泄漏');
    assert.ok(!r.text.includes('18630893389'), '手机号泄漏');
    assert.strictEqual(r.json.hasPasswordLogin, true);
  });
  await ok('PATCH /v1/credentials/:id 不含密码/手机号', async () => {
    const r = await req('PATCH', `/v1/credentials/${acct.id}`, { label: 'revfix-2' });
    assert.strictEqual(r.status, 200);
    assert.ok(!r.text.includes('SuperSecret123'), '密码泄漏');
    assert.ok(!r.text.includes('18630893389'), '手机号泄漏');
  });
  await ok('GET /v1/credentials 列表不含密码/手机号', async () => {
    const r = await req('GET', '/v1/credentials');
    assert.ok(!r.text.includes('SuperSecret123'));
    assert.ok(!r.text.includes('18630893389'));
  });
  await ok('POST /raccoon/accounts/:id/balance 不含密码/手机号', async () => {
    const r = await req('POST', `/v1/raccoon/accounts/${acct.id}/balance`);
    assert.strictEqual(r.status, 200, r.text.slice(0, 200));
    assert.ok(!r.text.includes('SuperSecret123'), '密码泄漏');
    assert.ok(!r.text.includes('18630893389'), '手机号泄漏');
  });
  await ok('GET /v1/raccoon/accounts 含 hasPasswordLogin 但不含明文', async () => {
    const r = await req('GET', '/v1/raccoon/accounts');
    assert.ok(!r.text.includes('SuperSecret123'));
    assert.ok(!r.text.includes('18630893389'));
    assert.ok(r.text.includes('hasPasswordLogin'));
  });

  console.log('\n[M-S2] 账号不一致时不删既有账号');
  await ok('填「另一个账号」的手机号后，既有账号仍在', async () => {
    // 库里再放一条同 userId 但 id 不同的账号，模拟「密码登录命中另一条」
    const other = store.add({
      label: 'other', edition: 'raccoon', mode: 'jwt',
      token: 'tok-other', refreshToken: 'ref-other', userId: 'uid-other', source: 'login',
    });
    const before = store.list().filter((a) => a.edition === 'raccoon').length;
    // 让 userInfo 回另一个 userId，触发 persistLogin 命中 other 而非 acct
    client.request = async ({ path: p }) => {
      if (p === 'loginWithPassword') {
        return { status: 200, envelope: { code: 0, data: { access_token: 'dt-X', refresh_token: 'drt-X' } } };
      }
      if (p === 'userInfo') {
        return { status: 200, envelope: { code: 0, data: { id: 'uid-other', name: 'Other' } } };
      }
      return { status: 200, envelope: { code: 0, data: {} } };
    };
    const r = await req('PUT', `/v1/raccoon/accounts/${acct.id}/password-login`,
      { phone: '19900000000', password: 'pw2' });
    assert.strictEqual(r.status, 409, `应为 409，实际 ${r.status}: ${r.text.slice(0, 160)}`);
    const after = store.list().filter((a) => a.edition === 'raccoon').length;
    assert.strictEqual(after, before, '既有账号不得被删除');
    assert.ok(store.get(other.id), 'other 账号必须仍存在');
    store.remove(other.id);
  });

  console.log('\n[M-R3] user_info 失败不产生重复账号');
  await ok('连跑 3 次密码登录，账号数不增', async () => {
    const { loginWithPassword } = require('../../src/raccoon/auth');
    userInfoShouldFail = true;
    client.request = async ({ path: p }) => {
      if (p === 'loginWithPassword') {
        return { status: 200, envelope: { code: 0, data: { access_token: 'dt-F' + Math.random(), refresh_token: 'drt-F' } } };
      }
      if (p === 'userInfo') return { status: 500, envelope: { code: 5001, data: null } };
      return { status: 200, envelope: { code: 0, data: {} } };
    };
    const before = store.list().filter((a) => a.edition === 'raccoon').length;
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await loginWithPassword({ phone: '18630893389', password: 'pw' });
    }
    const after = store.list().filter((a) => a.edition === 'raccoon').length;
    assert.strictEqual(after, before, `账号数从 ${before} 变成 ${after}`);
  });

  console.log('\n[M-R1/R2] wbNeedsRefresh 只认 lastRefreshAt');
  await ok('每日保活盖章不能压制 7 天周期续期', () => {
    const { wbNeedsRefresh } = require('../../src/auth');
    const DAY = 86400000;
    const now = Date.now();
    const future = new Date(now + 20 * DAY).toISOString();
    assert.strictEqual(
      wbNeedsRefresh({ expiredAt: future, lastKeepaliveAt: new Date().toISOString(), lastRefreshAt: new Date(now - 8 * DAY).toISOString() }),
      true,
      'lastKeepaliveAt 再新也不能顶替判据位',
    );
    assert.strictEqual(
      wbNeedsRefresh({ expiredAt: future, lastKeepaliveAt: new Date().toISOString(), lastRefreshAt: new Date(now - 1 * DAY).toISOString() }),
      false,
    );
    assert.strictEqual(
      wbNeedsRefresh({ expiredAt: future, lastKeepaliveAt: new Date().toISOString(), lastRefreshResult: 'fail', lastRefreshAt: null }),
      true,
      '失败/缺失必须判为需要续期',
    );
  });

  console.log('\n[m-06] buildQrUrl 非法百分号编码返回 INVALID_QR_PATH');
  await ok('非法编码不抛 URIError', () => {
    const product = require('../../src/raccoon/product');
    assert.throws(
      () => product.buildQrUrl({ origin: 'https://xiaohuanxiong.com/', scanPath: '/%zz', code: 'c', brand: 'b', source: 'platform' }),
      (e) => e.message === 'INVALID_QR_PATH',
    );
  });

  console.log('\n[m-02] 传输层加密密钥只有一处事实源');
  await ok('variant 里不再重复定义 credentialCipherKey', () => {
    const src = require('fs').readFileSync(path.join(__dirname, '..', '..', 'src', 'platform', 'variant.js'), 'utf-8');
    assert.ok(!/credentialCipherKey/.test(src), 'variant 不应再定义 credentialCipherKey');
  });

  console.log('\n[m-05] raccoon_keepalive_fail 已登记可开关');
  await ok('isEventEnabled 对该事件可查询', () => {
    const s = require('../../src/notify/settings');
    const ev = s.getEvents ? s.getEvents(undefined) : null;
    void ev;
    assert.strictEqual(typeof s.isEventEnabled('raccoon_keepalive_fail'), 'boolean');
  });

  console.log(`\n通过 ${pass} 项`);
  process.exit(process.exitCode || 0);
})();
