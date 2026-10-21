'use strict';
/**
 * src/test/raccoon.test.js —— Raccoon（商汤小浣熊）接入单元测试（无真实上游调用）。
 *
 * 覆盖范围：
 *   1. product：手机号 AES-128-CFB 加密、JWT 过期解析、展示名、请求头形态、
 *      模型目录解析、兜底表
 *   2. chat：思考档位翻译（只有 `extra_body.thinking` 有效）、请求体透传
 *   3. client：信封归一化与解包
 *   4. auth：扫码会话生命周期（进程内，不落库）
 *   5. 平台接线：variant 注册、**不进 Trae 转发池**、模型密钥边界、资源路径
 *   6. store：raccoon_org 列往返
 *   7. HTTP：/v1/raccoon/* 与 /v1/admin/channels 的渠道卡片
 *
 * ## 保真证据（为什么这些黄金值可信）
 *
 * `encryptPhone` / `decodeJwtExpMs` / `displayName` 的黄金值由**参考实现**产出：
 * 把 `dsh-our-free-model` 的 `vendor/channel-pack/src/raccoon.ts`（MIT）用 tsc
 * 转译成 CommonJS 后调用，与本仓库实现逐字节比对（12 组固定 IV 的加密 + 7 个
 * 展示名分支）。转译产物不提交，只作对拍工具。
 *
 * ⚠️ 手机号加密错一个字节，`send_sms` 就会回 `100003 params_encryted_error`，
 * 而错误信息完全不指向「密钥长度写成了 aes-256」这种根因，故必须有黄金值钉住。
 */
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// 必须在 require 任何项目模块之前隔离状态目录与加密密钥（否则会写真实账号库）
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `trae-raccoon-${Date.now()}`);
// ⚠️ 必须是**十六进制**字符串：lib/crypto.js 用 Buffer.from(key,'hex') 派生 32 字节密钥，
// 非 hex 字符（如 'r'.repeat(64)）会静默变成短密钥并在写入时报 "Invalid key length"。
process.env.TRAE_API_ENCRYPT_KEY = 'd'.repeat(64);
process.env.API_KEY = 'raccoon-test-api-key';
process.env.ADMIN_KEY = 'raccoon-test-admin-key';
process.env.PORT = String(17000 + (process.pid % 1000));
process.env.HOST = '127.0.0.1';
process.env.SCHEDULER_ENABLED = 'false';
// 2026-10-16 起 .env 里有 RACCOON_KEEPALIVE_ENABLED=true（真机已开启），
// dotenv 会把它带进测试进程 → 「默认必须关闭」的用例失败。测试显式关掉。
process.env.RACCOON_KEEPALIVE_ENABLED = 'false';
require('./isolation-guard')('raccoon');

// app.listen 在 require 时已发起
require('../index.js');
const product = require('../raccoon/product');
const credits = require('../raccoon/credits');
const raccoonClient = require('../raccoon/client');
const raccoonAuth = require('../raccoon/auth');
const raccoonChat = require('../raccoon/chat');
const client = require('../raccoon/client');
const variant = require('../platform/variant');
const store = require('../credentials/store');
const pool = require('../credentials/pool');
const modelAccess = require('../middleware/model-access');
const scope = require('../auth/scope');
const qr = require('../lib/qr');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const ADMIN = process.env.ADMIN_KEY;

let pass = 0;
let fail = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }

function req(method, p, { token, body } = {}) {
  return new Promise((resolve) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = http.request(BASE + p, { method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* 非 JSON 保留原文 */ }
        resolve({ status: res.statusCode, json, text: buf });
      });
    });
    r.on('error', (e) => resolve({ status: 0, json: null, text: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

/* ---------- 1. product ---------- */

// 由参考实现产出（4 个手机号 × 3 个固定 IV = 12 组）
const PHONE_GOLDENS = [
{ phone: '13800138000', iv: '00000000000000000000000000000000', enc: 'AAAAAAAAAAAAAAAAAAAAAES/BRAHeG7+06J1' },
  { phone: '13800138000', iv: '0102030405060708090a0b0c0d0e0f10', enc: 'AQIDBAUGBwgJCgsMDQ4PEB+iKDWUjra+hcPa' },
  { phone: '13800138000', iv: 'ffffffffffffffffffffffffffffffff', enc: '/////////////////////1zhu2zCHfTQSYkx' },
  { phone: '18612345678', iv: '00000000000000000000000000000000', enc: 'AAAAAAAAAAAAAAAAAAAAAES0CxEFemnz1aV9' },
  { phone: '18612345678', iv: '0102030405060708090a0b0c0d0e0f10', enc: 'AQIDBAUGBwgJCgsMDQ4PEB+pJjSWjLGzg8TS' },
  { phone: '18612345678', iv: 'ffffffffffffffffffffffffffffffff', enc: '/////////////////////1zqtW3AH/PdT445' },
  { phone: '19999999999', iv: '00000000000000000000000000000000', enc: 'AAAAAAAAAAAAAAAAAAAAAES1BBkOcGT/2qt8' },
  { phone: '19999999999', iv: '0102030405060708090a0b0c0d0e0f10', enc: 'AQIDBAUGBwgJCgsMDQ4PEB+oKTydhry/jMrT' },
  { phone: '19999999999', iv: 'ffffffffffffffffffffffffffffffff', enc: '/////////////////////1zrumXLFf7RQIA4' },
  { phone: '10000000000', iv: '00000000000000000000000000000000', enc: 'AAAAAAAAAAAAAAAAAAAAAES8DRAHeW3206J1' },
  { phone: '10000000000', iv: '0102030405060708090a0b0c0d0e0f10', enc: 'AQIDBAUGBwgJCgsMDQ4PEB+hIDWUj7W2hcPa' },
  { phone: '10000000000', iv: 'ffffffffffffffffffffffffffffffff', enc: '/////////////////////1zis2zCHPfYSYkx' },
];

/* ---------- 2. HTTP ---------- */

async function httpTests() {
  const noAuth = await req('GET', '/v1/raccoon/status');
  assert.strictEqual(noAuth.status, 401, '管理端点必须鉴权');

  const st = await req('GET', '/v1/raccoon/status', { token: ADMIN });
  assert.strictEqual(st.status, 200);
  assert.strictEqual(st.json.platform.id, 'raccoon');
  // 能力位如实声明：没有签到端点
  assert.strictEqual(st.json.platform.capability.checkin, false, 'Raccoon 没有签到端点，不能声明为 true');
  assert.strictEqual(st.json.platform.capability.chat, true);
  assert.strictEqual(st.json.platform.capability.tokenRefresh, true);
  assert.strictEqual(st.json.platform.capability.loginReward, true);
  assert.strictEqual(st.json.platform.capability.localImport, true);
  assert.strictEqual(st.json.platform.capability.dailyKeepalive, true);
  assert.strictEqual(st.json.chat.inPool, false, 'Raccoon 不进 Trae 转发池');

  const s = await req('POST', '/v1/raccoon/login/session', { token: ADMIN, body: {} });
  assert.strictEqual(s.status, 201);
  assert.match(s.json.sessionId, /^[0-9a-f]{24}$/);
  // 2026-10-18 起 code 由服务端签发（qr-<uuid> 形态），不再自造 32 hex
  assert.match(
    s.json.qrUrl,
    /^https:\/\/xiaohuanxiong\.com\/login\/mp\?code=qr-.+&appname=.+&source=platform$/,
    '二维码 URL 必须用服务端签发码 + source=platform',
  );
  // 二维码尺寸必须是合法版本（17 + 4k），且 path 非空
  assert.strictEqual((s.json.qr.size - 17) % 4, 0, '二维码尺寸必须是 17+4k');
  assert.ok(s.json.qr.path.length > 0 && s.json.qr.path.startsWith('M'), 'path 应是非空的 SVG path');
  assert.strictEqual(s.json.pollIntervalMs, 2000);

  // 取消会话
  const cancel = await req('DELETE', `/v1/raccoon/login/session/${s.json.sessionId}`, { token: ADMIN });
  assert.strictEqual(cancel.status, 200);
  assert.strictEqual(cancel.json.ok, true);

  // 已取消的会话再轮询 → 404（而不是继续打上游）
  const after = await req('GET', `/v1/raccoon/login/session/${s.json.sessionId}`, { token: ADMIN });
  assert.strictEqual(after.status, 404);

  // 无账号时模型目录回退兜底表，并如实给出原因
  const m = await req('GET', '/v1/raccoon/models', { token: ADMIN });
  assert.strictEqual(m.status, 200);
  assert.strictEqual(m.json.source, 'fallback');
  assert.strictEqual(m.json.data.length, 6);
  assert.ok(m.json.reason, '回退时必须说明原因，不能静默');
  assert.ok(m.json.data.every((x) => x.maxTokens > 0 && x.contextWindow > 0), '兜底表必须带真实窗口与上限');
  assert.ok(!m.json.data.some((x) => /raccoon-auto/i.test(x.id)), 'Raccoon-Auto 不是远端模型，绝不能出现在列表里');

  // ---- 本机客户端预检 ----
  // ⚠️ 必须把 BOX_AGENT_CONFIG_DIR 指到临时目录：否则这里读的是**真实**
  // ~/.box-agent/config/auth.json（真机上装了客户端就会 installed:true），
  // 测试既不确定、又碰了开发者的真实凭据文件。
  const fsLocal = require('node:fs');
  const localDir = path.join(os.tmpdir(), `raccoon-http-local-${Date.now()}`);
  fsLocal.mkdirSync(localDir, { recursive: true });
  const prevLocalDir = process.env.BOX_AGENT_CONFIG_DIR;
  process.env.BOX_AGENT_CONFIG_DIR = localDir;
  try {
    // 未安装 → 仍然 200 + installed:false（面板要能正常渲染这张卡）
    const lp0 = await req('GET', '/v1/raccoon/local/preview', { token: ADMIN });
    assert.strictEqual(lp0.status, 200);
    assert.strictEqual(lp0.json.installed, false);
    assert.ok(lp0.json.path, '要告诉用户「从哪读的」');
    assert.strictEqual(lp0.json.error, null);
    assert.strictEqual(lp0.json.userId, undefined, '没装就没有账号信息');

    // 写入真实形态的凭据 → preview 如实回显（且不回显 token 本身）
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${
      Buffer.from(JSON.stringify({ sub: 'pu-http-1', exp: 1794619246 })).toString('base64url')
    }.sig`;
    fsLocal.writeFileSync(path.join(localDir, 'auth.json'), JSON.stringify({
      access_token: jwt, refresh_token: jwt, office_identity: 'personal',
    }), 'utf8');
    const lp1 = await req('GET', '/v1/raccoon/local/preview', { token: ADMIN });
    assert.strictEqual(lp1.status, 200);
    assert.strictEqual(lp1.json.installed, true);
    assert.strictEqual(lp1.json.account.userId, 'pu-http-1');
    assert.strictEqual(lp1.json.account.hasRefreshToken, true);
    assert.strictEqual(lp1.json.account.officeIdentity, '', 'personal 不出现在 preview 里');
    assert.ok(!/eyJ/.test(JSON.stringify(lp1.json)), 'token 一律不出网');

    // 导入会打真实上游拉 user_info，测试环境没有网络隔离保证 → 只断言
    // 端点存在且鉴权正确（401），不实际触发导入
    const impNoAuth = await req('POST', '/v1/raccoon/local/import', { body: {} });
    assert.strictEqual(impNoAuth.status, 401, '导入端点必须鉴权');
  } finally {
    if (prevLocalDir === undefined) delete process.env.BOX_AGENT_CONFIG_DIR;
    else process.env.BOX_AGENT_CONFIG_DIR = prevLocalDir;
    fsLocal.rmSync(localDir, { recursive: true, force: true });
  }

  // ---- 每日积分看板：非 Raccoon 账号一律 400，不误打别家上游 ----
  const foreignAcct = store.add({ label: 'rr-daily-foreign', edition: 'cn', token: 't'.repeat(40), enabled: true }, 'login');
  try {
    const dailyForeign = await req('GET', `/v1/raccoon/accounts/${foreignAcct.id}/daily-usage`, { token: ADMIN });
    assert.strictEqual(dailyForeign.status, 400, '非 Raccoon 账号不能查 Raccoon 的每日积分');
    const dailyNoAuth = await req('GET', `/v1/raccoon/accounts/${foreignAcct.id}/daily-usage`);
    assert.strictEqual(dailyNoAuth.status, 401, '每日积分端点必须鉴权');
    // 保活端点同样要收口平台与鉴权（keepalive 是写操作，更要防误打别家上游）
    const kaForeign = await req('POST', `/v1/raccoon/accounts/${foreignAcct.id}/keepalive`, { token: ADMIN, body: {} });
    assert.strictEqual(kaForeign.status, 400, '非 Raccoon 账号不能做保活');
    const kaNoAuth = await req('POST', `/v1/raccoon/accounts/${foreignAcct.id}/keepalive`, { body: {} });
    assert.strictEqual(kaNoAuth.status, 401, '保活端点必须鉴权');
  } finally {
    store.remove(foreignAcct.id);
  }

  // ---- 保活任务快照：默认关闭 + 配置面完整（面板据此渲染）----
  const ka = await req('GET', '/v1/raccoon/keepalive', { token: ADMIN });
  assert.strictEqual(ka.status, 200);
  assert.strictEqual(ka.json.enabled, false, '默认必须关闭：这是写操作，须用户显式开启');
  assert.strictEqual(ka.json.hour, 9);
  assert.strictEqual(ka.json.minute, 5);
  assert.strictEqual(ka.json.retries, 1);
  assert.ok('nextRunAt' in ka.json && 'lastRunAt' in ka.json, '快照要带排程与结果位');

  // 开启后定时器必须排程（曾出现「开关打开但永不执行」的缺口：save() 只判
  // started，而 started 在启动时 disabled 的分支下恒为 false → 面板首次开启
  // 后 nextRunAt 一直为 null）。PUT 必须返回完整快照，让前端立即拿到排程。
  const kaOn = await req('PUT', '/v1/raccoon/keepalive', { token: ADMIN, body: { enabled: true } });
  assert.strictEqual(kaOn.status, 200);
  assert.strictEqual(kaOn.json.enabled, true);
  assert.ok(kaOn.json.nextRunAt, '开启后必须立即排程（nextRunAt 非空）');
  const kaBack = await req('GET', '/v1/raccoon/keepalive', { token: ADMIN });
  assert.strictEqual(kaBack.json.nextRunAt, kaOn.json.nextRunAt, 'GET 与 PUT 返回的排程一致');
  // 关闭后清空排程（不留幽灵定时器）
  const kaOff = await req('PUT', '/v1/raccoon/keepalive', { token: ADMIN, body: { enabled: false } });
  assert.strictEqual(kaOff.json.enabled, false);
  assert.strictEqual(kaOff.json.nextRunAt, null, '关闭后必须清空排程');
  // 配置夹紧：非法值不落库
  const kaClamp = await req('PUT', '/v1/raccoon/keepalive', { token: ADMIN, body: { hour: 99, minute: -5 } });
  assert.ok(kaClamp.json.hour >= 0 && kaClamp.json.hour <= 23, `hour 应被夹紧，实际 ${kaClamp.json.hour}`);
  assert.ok(kaClamp.json.minute >= 0 && kaClamp.json.minute <= 59, `minute 应被夹紧，实际 ${kaClamp.json.minute}`);

  // 渠道卡片：Raccoon 自动出现，且接入方式是「扫码 + 本机导入」双入口
  const ch = await req('GET', '/v1/admin/channels', { token: ADMIN });
  const rc = (ch.json?.data || []).find((c) => c.id === 'raccoon');
  assert.ok(rc, '/v1/admin/channels 应自动包含 Raccoon（注册表驱动的意义所在）');
  assert.deepStrictEqual(rc.onboarding.map((o) => o.kind), ['login', 'local'],
    '2026-10-15 起本机客户端凭据（明文 auth.json）也可导入');
  assert.strictEqual(rc.onboarding[0].available, true, '面板承载登录恒可用（不依赖本机客户端）');
  assert.strictEqual(rc.onboarding[1].label, '读取本机客户端');
  assert.ok(rc.note && rc.note.length > 0);

  // ---- 对话面的三道闸门（端点 → 平台 → 模型归属） ----
  const traeKey = (await req('POST', '/v1/api-keys', {
    token: ADMIN, body: { label: 'rr-trae', kind: 'access', platform: 'trae' },
  })).json.key;
  const allKey = (await req('POST', '/v1/api-keys', {
    token: ADMIN, body: { label: 'rr-all', kind: 'access', platform: 'all' },
  })).json.key;
  const chat = (token, body) => req('POST', '/v1/raccoon/chat/completions', { token, body });

  const noKey = await chat(undefined, { model: 'sn-glm-5-3', messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(noKey.status, 401, '无密钥必须 401');

  const traeCall = await chat(traeKey, { model: 'sn-glm-5-3', messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(traeCall.status, 403, 'trae 平台密钥不能越界消耗 Raccoon 积分');
  assert.strictEqual(traeCall.json.error.code, 'MODEL_ACCESS_DENIED');

  // 调错端点必须给 400，而不是走到「没有账号」的 503 —— 后者会把「调错端点」
  // 说成「缺账号」，让用户去装一个他并不需要的东西
  const wrongModel = await chat(allKey, { model: 'doubao-1-6', messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(wrongModel.status, 400);
  assert.strictEqual(wrongModel.json.error.code, 'INVALID_MODEL');

  const noMessages = await chat(allKey, { model: 'sn-glm-5-3' });
  assert.strictEqual(noMessages.status, 400);
  assert.strictEqual(noMessages.json.error.code, 'invalid_request_error');

  // 通用密钥 + Raccoon 模型：鉴权与模型归属都过，因无账号而 503，且指引必须可行动
  const noAccount = await chat(allKey, { model: 'sn-glm-5-3', messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(noAccount.status, 503);
  assert.strictEqual(noAccount.json.error.code, 'NO_RACCOON_ACCOUNT');
  assert.match(noAccount.json.error.message, /扫码/, '503 文案必须告诉用户下一步做什么');
}

/* ---------- 执行 ---------- */

async function run() {
  // ===== product：手机号加密与参考实现逐字节一致 =====
  t('encryptPhone 与参考实现逐字节一致（12 组固定 IV）', () => {
    for (const g of PHONE_GOLDENS) {
      const got = product.encryptPhone(g.phone, Buffer.from(g.iv, 'hex'));
      assert.strictEqual(got, g.enc, `phone=${g.phone} iv=${g.iv}`);
    }
  });

  t('encryptPhone：密文 = Base64(iv ‖ 密文)，长度随手机号增长，密钥是 16 字节（AES-128）', () => {
    const iv = Buffer.alloc(16, 7);
    const out = Buffer.from(product.encryptPhone('13800138000', iv), 'base64');
    assert.strictEqual(out.length, 16 + 11, 'CFB 是流密码，密文长度等于明文长度');
    assert.deepStrictEqual(out.subarray(0, 16), iv, '前 16 字节必须是 IV');
    // 密钥 16 字节 ⇒ 用 aes-256-cfb 会因长度不足抛错；这里反证密钥长度正确
    assert.strictEqual(Buffer.byteLength(product.PHONE_CIPHER_SECRET, 'utf8'), 16);
  });

  t('encryptPhone 随机 IV：同号两次密文不同，但都能解回（IV 不固定）', () => {
    const a = product.encryptPhone('13800138000');
    const b = product.encryptPhone('13800138000');
    assert.notStrictEqual(a, b);
    assert.strictEqual(Buffer.from(a, 'base64').length, 16 + 11);
  });

  // encryptSecret 与 encryptPhone 同一算法（2026-10-20：login_with_password /
  // reset_password 的 password 字段实测也用这套 AES-128-CFB）。
  t('encryptSecret：与 encryptPhone 同算法（密码字段实测同一加密）', () => {
    const iv = Buffer.alloc(16, 3);
    assert.strictEqual(
      product.encryptSecret('My-Passw0rd!', iv),
      product.encryptPhone('My-Passw0rd!', iv),
      'password 与 phone 必须走同一加密（固定 IV 下密文逐字节相同）',
    );
    // 密码比手机号长：CFB 是流密码，密文长度必须等于明文长度
    const out = Buffer.from(product.encryptSecret('0123456789abcdefghij', iv), 'base64');
    assert.strictEqual(out.length, 16 + 20);
  });

  // ===== product：JWT 过期 =====
  t('decodeJwtExpMs：解析 exp（毫秒）；非 JWT 返回 undefined 且不抛错', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1800000000 })).toString('base64url');
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    assert.strictEqual(product.decodeJwtExpMs(jwt), 1800000000000);
    assert.strictEqual(product.decodeJwtExpMs('not-a-jwt'), undefined);
    assert.strictEqual(product.decodeJwtExpMs(''), undefined);
    assert.strictEqual(product.decodeJwtExpMs(null), undefined);
    // 非对象 payload / 非数字 exp / 非正 exp 都返回 undefined
    const p2 = Buffer.from(JSON.stringify({ exp: 'x' })).toString('base64url');
    assert.strictEqual(product.decodeJwtExpMs(`a.${p2}.c`), undefined);
    const p3 = Buffer.from(JSON.stringify({ exp: -1 })).toString('base64url');
    assert.strictEqual(product.decodeJwtExpMs(`a.${p3}.c`), undefined);
    const p4 = Buffer.from(JSON.stringify({ x: 1 })).toString('base64url');
    assert.strictEqual(product.decodeJwtExpMs(`a.${p4}.c`), undefined);
  });

  t('credentialExpiresAtMs：优先 expires_at，缺失时**必须**回退到 JWT 的 exp', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1800000000 })).toString('base64url');
    const jwt = `a.${payload}.c`;
    // 显式字段优先
    assert.strictEqual(product.credentialExpiresAtMs({ access_token: jwt, expires_at: '123' }), 123);
    // 回退到 JWT：不这么做的话过期判定恒为 false，续期永远不触发（静默失效）
    assert.strictEqual(product.credentialExpiresAtMs({ access_token: jwt }), 1800000000000);
    // 两处都没有 → undefined（视为不过期，而不是 0/NaN）
    assert.strictEqual(product.credentialExpiresAtMs({ access_token: 'opaque' }), undefined);
    // 非数字的 expires_at 不应污染结果
    assert.strictEqual(product.credentialExpiresAtMs({ access_token: jwt, expires_at: 'abc' }), 1800000000000);
  });

  t('isExpired / needsRefresh / isRefreshable 语义', () => {
    const now = 1_000_000_000_000;
    // 无过期信息 → 视为不过期（宁可用可能过期的凭据去试，也不凭猜测拦住用户）
    assert.strictEqual(product.isExpired({ access_token: 'opaque' }, now), false);
    assert.strictEqual(product.isExpired({ expires_at: String(now - 1) }, now), true);
    assert.strictEqual(product.isExpired({ expires_at: String(now + 60_000) }, now), false);
    // 提前 5 分钟窗口
    assert.strictEqual(product.needsRefresh({ expires_at: String(now + 60_000) }, now), true);
    assert.strictEqual(product.needsRefresh({ expires_at: String(now + 10 * 60_000) }, now), false);
    assert.strictEqual(product.needsRefresh({ access_token: 'opaque' }, now), false);
    assert.strictEqual(product.isRefreshable({ refresh_token: 'r' }), true);
    assert.strictEqual(product.isRefreshable({ refresh_token: '  ' }), false);
    assert.strictEqual(product.isRefreshable({}), false);
  });

  // ===== product：登录码与二维码 URL =====
  t('generateQrCode：32 位小写 hex，且每次不同', () => {
    const a = product.generateQrCode();
    const b = product.generateQrCode();
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.match(b, /^[0-9a-f]{32}$/);
    assert.notStrictEqual(a, b);
  });

  t('buildQrUrl：官方形态，code/appname/source 三参数齐且 appname 做百分号编码', () => {
    const u = product.buildQrUrl({
      origin: 'https://xiaohuanxiong.com/',
      scanPath: '/login/mp',
      code: 'a'.repeat(32),
      brand: '商汤小浣熊',
      source: 'platform',
    });
    assert.strictEqual(
      u,
      `https://xiaohuanxiong.com/login/mp?code=${'a'.repeat(32)}&appname=%E5%95%86%E6%B1%A4%E5%B0%8F%E6%B5%A3%E7%86%8A&source=platform`,
    );
    // 新体系比旧的多一个 source=platform（官网 2026-10 起）
    assert.ok(u.includes('source=platform'), '必须带 source=platform');
    assert.ok(!u.includes('appname=' + encodeURIComponent('商汤小浣熊官网')), 'appname 已改为品牌名（旧值已废弃）');
  });

  t('登录 URL 能在版本 10 内编码（签发码 + 品牌名仍 < 213 字节上限）', () => {
    // 签发码形如 qr-01a14f9e-f95a-7953-bb4e-ae4ada3847c7（46 字符）
    const url = product.buildQrUrl({
      origin: 'https://xiaohuanxiong.com/',
      scanPath: '/login/mp',
      code: 'qr-01a14f9e-f95a-7953-bb4e-ae4ada3847c7',
      brand: '商汤小浣熊',
      source: 'platform',
    });
    const shape = qr.renderQrPath(url);
    assert.strictEqual((shape.size - 17) % 4, 0);
    assert.ok(shape.size <= 57, `尺寸 ${shape.size} 超出支持的版本 10`);
  });

  // ===== product：展示名（倍率必须进 name） =====
  t('displayName 与参考实现一致（含「1 倍也要显示」这条用户报障结论）', () => {
    const cases = [
      [{ id: 'm1', description: 'GLM-5-3', effectiveMultiplier: 0, baseMultiplier: 1 }, 'GLM-5-3 · 免费'],
      [{ id: 'm2', description: 'GLM-5-3-Flash', effectiveMultiplier: 0.1, baseMultiplier: 0.2 }, 'GLM-5-3-Flash · x0.2→x0.1'],
      [{ id: 'm3', description: 'Kimi-K3', effectiveMultiplier: 1, baseMultiplier: 1 }, 'Kimi-K3 · x1'],
      [{ id: 'm4', description: 'X', effectiveMultiplier: Number.NaN, baseMultiplier: 1 }, 'X'],
      [{ id: 'm5', description: 'Y', effectiveMultiplier: -1, baseMultiplier: 1 }, 'Y'],
      [{ id: 'm6', description: '', effectiveMultiplier: 0.75, baseMultiplier: Number.NaN }, 'm6 · x0.75'],
      [{ id: 'm7', description: 'Z', effectiveMultiplier: 0.33333, baseMultiplier: 1 }, 'Z · x1→x0.3333'],
    ];
    for (const [model, want] of cases) {
      assert.strictEqual(product.displayName(model), want, JSON.stringify(model));
    }
    // 取不到倍率时不能产出孤立的「 · 」分隔符
    assert.ok(!product.displayName({ id: 'x', description: 'X', effectiveMultiplier: Number.NaN }).includes(' · '));
  });

  // ===== product：请求头（四个调用点形态不同，逐点钉住） =====
  t('headers()：默认形态不含 platform/version，且**不发 User-Agent**', () => {
    const h = product.headers({ access_token: 'T', office_identity: 'org1' });
    assert.deepStrictEqual(h, {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'Bearer T',
      'X-Org-Code': 'org1',
      'X-Raccoon-Language': 'zh',
    });
    // 个人账号组织码为空串（客户端总是发该头，不是省略）
    assert.strictEqual(product.headers({ access_token: 'T' })['X-Org-Code'], '');
  });

  // P0 回归（2026-10-15 抓包实证）：个人账号的 office_identity 字面值是
  // "personal"，原样塞进 X-Org-Code 会被上游当真组织码查并回
  // 400 org_not_found_error，打掉余额 / 目录 / 登录奖励 / 对话转发。
  // 客户端自己的 createHeaders() 显式排除 personal，这里必须照抄。
  t('orgCodeOf()：personal 必须归空串（P0：X-Org-Code 不能填 personal）', () => {
    assert.strictEqual(product.orgCodeOf({ office_identity: 'personal' }), '', 'personal 是身份标记，不是组织码');
    assert.strictEqual(product.orgCodeOf({ office_identity: 'Personal' }), '', '大小写不敏感');
    assert.strictEqual(product.orgCodeOf({ office_identity: ' personal ' }), '', '前后空白也要归一');
    assert.strictEqual(product.orgCodeOf({}), '', '缺失即空串');
    assert.strictEqual(product.orgCodeOf({ office_identity: '' }), '', '空串保持空串');
    // 真实企业组织码必须照发（不能简化成恒空串，否则企业账号跨组织会失败）
    assert.strictEqual(product.orgCodeOf({ office_identity: 'ORG-123' }), 'ORG-123', '真组织码要透传');
    // 三处头构造都必须经过 orgCodeOf：personal 绝不能出现在任何一处的 X-Org-Code
    for (const h of [
      product.headers({ access_token: 'T', office_identity: 'personal' }),
      product.desktopHeaders({ access_token: 'T', office_identity: 'personal' }),
      product.catalogHeaders({ access_token: 'T', office_identity: 'personal' }),
    ]) {
      assert.strictEqual(h['X-Org-Code'], '', `personal 不得出现在业务头：${JSON.stringify(h)}`);
    }
  });

  t('desktopHeaders()：含 platform + version（登录奖励端点必需）', () => {
    const h = product.desktopHeaders({ access_token: 'T' });
    assert.strictEqual(h['X-Client-Platform'], 'desktop-windows');
    assert.strictEqual(h['X-Client-Version'], 'v1.0.35');
  });

  t('catalogHeaders()：手写四头，**不含 Content-Type**', () => {
    const h = product.catalogHeaders({ access_token: 'T', office_identity: 'o' });
    assert.strictEqual(h['Content-Type'], undefined, '目录端点实测不接受/不需要 Content-Type');
    assert.strictEqual(h.Authorization, 'Bearer T');
    assert.strictEqual(h['X-Raccoon-Language'], 'zh');
    assert.strictEqual(h['X-Client-Platform'], undefined, '目录端点不带 platform');
  });

  t('三处都不发 User-Agent / X-Client-Device-ID（没有证据的头不加）', () => {
    for (const h of [
      product.headers({ access_token: 'T' }),
      product.desktopHeaders({ access_token: 'T' }),
      product.catalogHeaders({ access_token: 'T' }),
    ]) {
      assert.strictEqual(h['User-Agent'], undefined);
      assert.strictEqual(h['X-Client-Device-ID'], undefined);
    }
  });

  // ===== product：模型目录解析 =====
  t('parseModelCatalog：只取 type=chat，模型 id 取远端的 name 字段', () => {
    const payload = {
      code: 0,
      data: {
        categories: [
          { type: 'embedding', models: [{ name: 'should-not-appear' }] },
          {
            type: 'chat',
            models: [
              {
                name: 'sn-glm-5-3',
                description: 'GLM-5-3',
                params: { context_window: 1000000, max_tokens: 100000 },
                billing_effective_multiplier: 0.75,
                billing_multiplier: 1,
                billing_status: 'discount',
                billing_status_note: '限时折扣',
                tags: ['General', 'Vision'],
              },
              // visible:false 必须跳过
              { name: 'raccoon-internal-a', visible: false },
              // 重名去重
              { name: 'sn-glm-5-3', description: 'dup' },
              // 缺 name → 跳过
              { description: 'no-id' },
            ],
          },
        ],
      },
    };
    const models = product.parseModelCatalog(payload);
    assert.deepStrictEqual(models.map((m) => m.id), ['sn-glm-5-3']);
    const m = models[0];
    assert.strictEqual(m.name, 'GLM-5-3 · x1→x0.75', '生效价 < 原价时应显示箭头');
    assert.strictEqual(m.contextWindow, 1000000);
    assert.strictEqual(m.maxTokens, 100000);
    assert.strictEqual(m.supportsImage, true, 'tags 含 vision（已小写化）');
    assert.strictEqual(m.status, 'discount');
    assert.strictEqual(m.statusNote, '限时折扣');
    assert.strictEqual(m.multiplier, 0.75);
  });

  t('parseModelCatalog：异常输入一律返回空数组，不抛错', () => {
    for (const bad of [null, undefined, [], 'x', 42, {}, { code: 1, data: {} }, { code: 0 }, { code: 0, data: {} },
      { code: 0, data: { categories: [] } }, { code: 0, data: { categories: [{ type: 'chat' }] } }]) {
      assert.deepStrictEqual(product.parseModelCatalog(bad), []);
    }
  });

  t('supportsImage：白名单覆盖 + tags 三种写法', () => {
    // tags 里没有 vision、但实测能看图的模型必须在白名单里
    assert.strictEqual(product.supportsImage('sn-deepseek-v4-1-flash', []), true);
    assert.strictEqual(product.supportsImage('sn-glm-5-3-flash', []), true);
    assert.strictEqual(product.supportsImage('sn-glm-5-3', ['vision']), true);
    assert.strictEqual(product.supportsImage('sn-x', ['image']), true);
    assert.strictEqual(product.supportsImage('sn-x', ['image-understanding']), true);
    assert.strictEqual(product.supportsImage('sn-x', ['general']), false);
    assert.strictEqual(product.supportsImage('sn-x', null), false);
  });

  t('兜底表：6 个模型、都带真实窗口与上限、不含 Raccoon-Auto、1 倍也显示倍率', () => {
    const fb = product.fallbackCatalog();
    assert.strictEqual(fb.length, 6);
    assert.ok(fb.every((m) => m.contextWindow > 0 && m.maxTokens > 0));
    assert.ok(fb.every((m) => m.name.length > 0));
    assert.ok(!fb.some((m) => /auto/i.test(m.id)));
    assert.ok(fb.find((m) => m.id === 'sn-kimi-k3').name.includes('x1'), '1 倍也要显示倍率（用户报障）');
  });

  // ===== product：每日积分运营视图（2026-10-15 抓包新增）=====
  // 输入即本机账号 2026-10-15 的真实抓包样本（balance/income/expense 三页）。
  t('summarizeDailyPoints：真实账单样本 → 每日池剩余 + 最早到期 + 历史作废', () => {
    const balance = { available_points: 3993, daily_points: 294, monthly_points: 0, reward_points: 3699 };
    const income = [
      // 今天发放的 300，7 天后作废
      { bill_id: 'b1', event_name: '每日积分发放', biz_type: 'daily_grant', points: 300, created_at: '2026-10-15T09:14:46+08:00', grant_at: '2026-10-15T00:00:00+08:00', expire_at: '2026-10-21T23:59:59+08:00' },
      // 昨天的补发（daily_makeup），已随当日作废
      { bill_id: 'b2', event_name: '每日积分发放', biz_type: 'daily_grant', points: 300, created_at: '2026-10-14T00:00:00+08:00', grant_at: '2026-10-14T00:00:00+08:00', expire_at: '2026-10-14T23:59:59+08:00' },
      // 非每日类的正向账单必须被排除
      { bill_id: 'b3', event_name: '新人注册礼包', biz_type: 'reward_grant', points: 3000, created_at: '2026-10-14T09:51:15+08:00' },
      { bill_id: 'b4', event_name: '桌面端登录奖励', biz_type: 'reward_grant', points: 3000, created_at: '2026-10-14T09:51:15+08:00' },
    ];
    const expense = [
      // 昨天整额作废（一分没花）—— 这正是要做这个视图的原因
      { bill_id: 'e1', event_name: '每日积分到期清零', biz_type: 'daily_expire', points: -300, created_at: '2026-10-14T23:59:59+08:00', grant_at: '2026-10-14T00:00:00+08:00', expire_at: '2026-10-14T23:59:59+08:00' },
      // 普通消耗不参与
      { bill_id: 'e2', event_name: '桌面端 LLM 对话消耗', biz_type: 'desktop', points: -4 },
    ];
    const nowMs = Date.parse('2026-10-15T05:00:00Z');
    const s = product.summarizeDailyPoints({ balance, incomeItems: income, expenseItems: expense, nowMs });
    assert.strictEqual(s.claimable, false, '恒为 false：没有领取端点');
    assert.strictEqual(s.grantPoints, 300);
    assert.strictEqual(s.dailyRemaining, 294, '每日池剩余直接来自 balance.daily_points');
    assert.strictEqual(s.grantedBatches, 2, '只数 daily_grant，reward_grant 不算');
    assert.strictEqual(s.expiredTotal, 300, 'daily_expire 绝对值累加，desktop 消耗不算');
    // 最早到期 = 今天发放那批（昨天那批已过期，不进未来窗口）
    assert.strictEqual(s.nextExpiryAt, '2026-10-21T15:59:59.000Z');
    assert.strictEqual(s.nextExpiryHoursLeft, 155);
  });

  t('summarizeDailyPoints：空输入全空、1971 哨兵时间戳不参与到期判定', () => {
    const s = product.summarizeDailyPoints({});
    assert.strictEqual(s.claimable, false);
    assert.strictEqual(s.dailyRemaining, null);
    assert.strictEqual(s.nextExpiryAt, null);
    assert.strictEqual(s.nextExpiryHoursLeft, null);
    assert.strictEqual(s.expiredTotal, 0);
    assert.strictEqual(s.billsAvailable, undefined, 'billsAvailable 由 credits 层补，纯函数不管');

    // 客户端模块 34917 的判据：1971-01-01 之前的时间戳视为「无意义」，
    // 这样的批次绝不能出现在 nextExpiryAt（否则面板会显示「54 年后作废」）
    const s2 = product.summarizeDailyPoints({
      balance: { daily_points: 300 },
      incomeItems: [{ biz_type: 'daily_grant', points: 300, grant_at: '1970-01-01T00:00:00Z', expire_at: '1970-01-01T00:00:00Z' }],
      nowMs: Date.parse('2026-10-15T05:00:00Z'),
    });
    assert.strictEqual(s2.grantedBatches, 1);
    assert.strictEqual(s2.nextExpiryAt, null);
    assert.strictEqual(s2.nextExpiryHoursLeft, null);
  });

  // ===== 每日保活：「当日登录」延长有效期（2026-10-16 新增）=====
  // 官方口径（i18n dailyGrantRule 三语原文）：当天 24:00 清零 = 1 天；延长 = 7 天。
  t('validityDaysOf：官方口径（含发放当日）—— 当天=1、延长=7、非法=null', () => {
    // 账单真实形态：grant 00:00 / expire 当日 23:59:59 → 官方叫「1 天」
    assert.strictEqual(credits.validityDaysOf({
      grant_at: '2026-10-16T00:00:00+08:00', expire_at: '2026-10-16T23:59:59+08:00',
    }), 1, '当天清零应判 1 天（不是 0）');
    // 延长形态：grant 10-16 00:00 / expire 10-22 23:59:59 → 官方叫「7 天」
    assert.strictEqual(credits.validityDaysOf({
      grant_at: '2026-10-16T00:00:00+08:00', expire_at: '2026-10-22T23:59:59+08:00',
    }), 7, '日历差 6 但官方口径是 7（含发放当日）');
    // 非法/缺失时间戳
    assert.strictEqual(credits.validityDaysOf({ grant_at: 'x', expire_at: 'y' }), null);
    assert.strictEqual(credits.validityDaysOf({}), null);
    assert.strictEqual(credits.validityDaysOf(null), null);
    // expire < grant 视为非法（防倒挂数据误判为已延长）
    assert.strictEqual(credits.validityDaysOf({
      grant_at: '2026-10-22T00:00:00+08:00', expire_at: '2026-10-16T23:59:59+08:00',
    }), null);
  });

  // ===== grantedToday：如实标出「上游今日是否已发放」（2026-10-20 实证）=====
  // 2026-10-19/10-20 上游连续两天未产生当日 daily_grant，此时保活应报
  // upstream_not_granted（无可延长对象）而非「签到失败」。
  t('summarizeDailyPoints.grantedToday：只有 grant_at 落在今天才算今日已发', () => {
    const now = Date.parse('2026-10-20T09:00:00+08:00');
    // 只有历史批次（最近一笔 10-18）→ grantedToday=false
    const hist = product.summarizeDailyPoints({
      balance: { daily_points: 300 },
      incomeItems: [
        { biz_type: 'daily_grant', points: 300, grant_at: '2026-10-18T00:00:00+08:00', expire_at: '2026-10-24T23:59:59+08:00' },
        { biz_type: 'daily_grant', points: 300, grant_at: '2026-10-17T00:00:00+08:00', expire_at: '2026-10-23T23:59:59+08:00' },
      ],
      nowMs: now,
    });
    assert.strictEqual(hist.grantedToday, false, '无今日批次时 grantedToday 必须为 false');

    // 含今日批次 → grantedToday=true
    const today = product.summarizeDailyPoints({
      balance: { daily_points: 300 },
      incomeItems: [
        { biz_type: 'daily_grant', points: 300, grant_at: '2026-10-20T00:00:00+08:00', expire_at: '2026-10-26T23:59:59+08:00' },
      ],
      nowMs: now,
    });
    assert.strictEqual(today.grantedToday, true, '有今日批次时 grantedToday 必须为 true');

    // 空输入 → grantedToday=false（不是抛错）
    assert.strictEqual(product.summarizeDailyPoints({ nowMs: now }).grantedToday, false);
  });

  // ===== chat：思考档位与请求体 =====
  t('resolveThinking：只有 extra_body.thinking 是有效载波，且需要明确意图', () => {
    // 客户端什么都不说 → 一个字节都不改
    assert.strictEqual(raccoonChat.resolveThinking({}), undefined);
    assert.strictEqual(raccoonChat.resolveThinking({ reasoning_effort: '' }), undefined);
    assert.strictEqual(raccoonChat.resolveThinking({ reasoning_effort: 'unknown-level' }), undefined);
    // none 是真关闭
    assert.deepStrictEqual(raccoonChat.resolveThinking({ reasoning_effort: 'none' }), { type: 'disabled' });
    assert.deepStrictEqual(raccoonChat.resolveThinking({ thinking: { type: 'disabled' } }), { type: 'disabled' });
    // 其余档位只有「开」这一档，显式发 enabled（与默认等价但语义明确）
    assert.deepStrictEqual(raccoonChat.resolveThinking({ reasoning_effort: 'low' }), { type: 'enabled' });
    assert.deepStrictEqual(raccoonChat.resolveThinking({ reasoning_effort: 'high' }), { type: 'enabled' });
    // 已经是上游方言时原样透传（不猜测、不改写）
    assert.deepStrictEqual(
      raccoonChat.resolveThinking({ extra_body: { thinking: { type: 'adaptive' } } }),
      { type: 'adaptive' },
    );
  });

  t('buildUpstreamBody：tools 留在顶层，thinking 只进 extra_body，其余字段逐字透传', () => {
    const tools = [{ type: 'function', function: { name: 'f', parameters: {} } }];
    const out = raccoonChat.buildUpstreamBody({
      model: 'sn-glm-5-3', messages: [{ role: 'user', content: 'hi' }], stream: true,
      tools, temperature: 0.5, reasoning_effort: 'none', customField: { a: 1 },
    });
    assert.deepStrictEqual(out.tools, tools, 'tools 必须在请求体顶层（漏发会让模型在正文里臆造调用）');
    assert.deepStrictEqual(out.extra_body, { thinking: { type: 'disabled' } });
    assert.strictEqual(out.thinking, undefined, 'thinking 放顶层会被上游忽略，不能留在顶层');
    assert.strictEqual(out.reasoning_effort, 'none', '不透传无效方言不代表要删掉调用方字段');
    assert.strictEqual(out.temperature, 0.5);
    assert.deepStrictEqual(out.customField, { a: 1 }, '不裁剪未知字段');
    assert.deepStrictEqual(out.messages, [{ role: 'user', content: 'hi' }]);
  });

  t('buildUpstreamBody：未表达思考意图时不写 extra_body；已有 extra_body 其它键要保留', () => {
    const a = raccoonChat.buildUpstreamBody({ model: 'm', messages: [] });
    assert.strictEqual(a.extra_body, undefined, '不提就一个字节都不改');
    const b = raccoonChat.buildUpstreamBody({ model: 'm', messages: [], extra_body: { other: 1 }, reasoning_effort: 'low' });
    assert.deepStrictEqual(b.extra_body, { other: 1, thinking: { type: 'enabled' } });
  });

  t('对话面请求头：带 platform 但**不带** version，Accept 是事件流', () => {
    const h = raccoonChat.chatHeaders({ token: 'T', raccoonOrg: 'o' });
    assert.strictEqual(h['X-Client-Platform'], 'desktop-windows');
    assert.strictEqual(h['X-Client-Version'], undefined, '对话面与积分面的头不同，别统一');
    assert.strictEqual(h.Accept, 'text/event-stream');
    assert.strictEqual(h['X-Org-Code'], 'o');
    // P0 同样适用于对话面：本机账号的 raccoonOrg 就是 "personal"，
    // 带上它上游会回 400 org_not_found_error，整条转发链路直接不可用。
    const personal = raccoonChat.chatHeaders({ token: 'T', raccoonOrg: 'personal' });
    assert.strictEqual(personal['X-Org-Code'], '', '对话面也必须把 personal 归空串');
  });

  // ===== local：本机客户端凭据导入（2026-10-15 解包新增）=====
  // 用临时目录注入凭据文件，绝不读真实 ~/.box-agent（CI 与真机行为一致）。
  await t('local：凭据路径随 BOX_AGENT_CONFIG_DIR，且 personal 入库前被归空串', () => {
    const fs = require('node:fs');
    const dir = path.join(os.tmpdir(), `raccoon-local-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'auth.json');
    const prevDir = process.env.BOX_AGENT_CONFIG_DIR;
    process.env.BOX_AGENT_CONFIG_DIR = dir;
    // 重新加载模块，让 credentialsPath() 读到新的 env
    delete require.cache[require.resolve('../raccoon/local')];
    const local = require('../raccoon/local');
    try {
      // 未安装：preview 不抛错，如实报 false（面板要能正常渲染这张卡）
      assert.strictEqual(local.isClientInstalled(), false);
      const p0 = local.preview();
      assert.strictEqual(p0.installed, false);
      assert.strictEqual(p0.error, null);
      assert.strictEqual(p0.userId, null);

      // 写入真实形态的凭据（本机客户端实测字段：access_token/refresh_token/office_identity）
      const jwt = `eyJhbGciOiJIUzI1NiJ9.${
        Buffer.from(JSON.stringify({ sub: 'pu-test-1', exp: 1794619246 })).toString('base64url')
      }.sig`;
      fs.writeFileSync(file, JSON.stringify({
        access_token: jwt,
        refresh_token: jwt,
        office_identity: 'personal',
      }), 'utf8');

      assert.strictEqual(local.isClientInstalled(), true);
      const cred = local.readLocalCredential();
      assert.strictEqual(cred.access_token, jwt);
      assert.strictEqual(cred.refresh_token, jwt, '客户端把 refresh 与 access 写成同一个值');
      assert.strictEqual(cred.office_identity, '', 'personal 必须在入库前归空串（P0）');
      assert.strictEqual(cred.expires_at, String(1794619246 * 1000), 'auth.json 无过期时间，须从 JWT exp 解出');

      const p1 = local.preview();
      assert.strictEqual(p1.installed, true);
      assert.strictEqual(p1.hasRefreshToken, true);
      assert.strictEqual(p1.userId, 'pu-test-1', 'userId 从 JWT sub 取，仅作展示');
      assert.strictEqual(p1.officeIdentity, '');
      assert.strictEqual(p1.error, null);

      // 已过期的本地凭据必须拒绝导入（不能静默导入成「可用账号」）
      const expiredJwt = `eyJhbGciOiJIUzI1NiJ9.${
        Buffer.from(JSON.stringify({ sub: 'pu-test-2', exp: 1000000 })).toString('base64url')
      }.sig`;
      fs.writeFileSync(file, JSON.stringify({ access_token: expiredJwt, refresh_token: expiredJwt }), 'utf8');
      const credExpired = local.readLocalCredential();
      assert.strictEqual(product.isExpired(credExpired), true, '过期凭据应被判为过期');

      // 缺 access_token → preview 把原因放进 error，不抛
      fs.writeFileSync(file, JSON.stringify({ refresh_token: 'x' }), 'utf8');
      const p2 = local.preview();
      assert.strictEqual(p2.installed, true);
      assert.ok(p2.error && /access_token/.test(p2.error), `error 应说明缺 token，实际：${p2.error}`);
    } finally {
      if (prevDir === undefined) delete process.env.BOX_AGENT_CONFIG_DIR;
      else process.env.BOX_AGENT_CONFIG_DIR = prevDir;
      delete require.cache[require.resolve('../raccoon/local')];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ===== client：信封 =====
  t('normalizeEnvelope：code 缺失时用 HTTP 状态兜底（不能把失败读成成功）', () => {
    assert.strictEqual(client.normalizeEnvelope({ code: 0, data: {} }, 200).code, 0);
    assert.strictEqual(client.normalizeEnvelope({ code: 100003 }, 200).code, 100003);
    // 字符串 code 也要认
    assert.strictEqual(client.normalizeEnvelope({ code: '1003' }, 200).code, 1003);
    // 无 code 字段：HTTP 200 → 0；HTTP 500 → 500
    assert.strictEqual(client.normalizeEnvelope({}, 200).code, 0);
    assert.strictEqual(client.normalizeEnvelope({}, 500).code, 500);
    assert.strictEqual(client.normalizeEnvelope({}, 401).code, 401);
    // 非对象体不崩
    assert.strictEqual(client.normalizeEnvelope(null, 502).code, 502);
    assert.strictEqual(client.normalizeEnvelope('oops', 200).code, 0);
  });

  t('unwrap：code 0 返回 data；非 0 抛 RaccoonApiError 且带上游文案与 code', () => {
    const data = client.unwrap(client.normalizeEnvelope({ code: 0, data: { a: 1 } }, 200));
    assert.deepStrictEqual(data, { a: 1 });
    let err = null;
    try {
      client.unwrap(client.normalizeEnvelope({ code: 100006, message: 'captcha_verify_error', details: '滑块' }, 200));
    } catch (e) { err = e; }
    assert.ok(err instanceof client.RaccoonApiError);
    assert.strictEqual(err.code, 100006);
    assert.strictEqual(err.upstreamCode, 100006, '供 pool.classifyError 读取');
    assert.match(err.message, /captcha_verify_error/);
    assert.match(err.message, /滑块/);
    assert.throws(() => client.unwrap(null), /信封为空/);
  });

  t('credentialOf：只映射真实存在的字段，不发明设备标识', () => {
    const c = client.credentialOf({ token: 'T', refreshToken: 'R', raccoonOrg: 'o', userId: 'u' });
    assert.deepStrictEqual(c, { access_token: 'T', refresh_token: 'R', office_identity: 'o', user_id: 'u' });
    assert.strictEqual(c.device_id, undefined);
  });

  // ===== auth：登录会话 =====
  // 2026-10-18 起扫码走新 IAM：startLoginSession 是**异步**且要打上游拿签发码，
  // 故这里只测「本地会话生命周期」与「buildQrUrl 白名单」；真链路走 mock HTTP（见下）。
  t('buildQrUrl：复刻官方白名单 —— 挡跳域 / 协议相对 / hash / 双编码', () => {
    const ok = product.buildQrUrl({
      origin: 'https://xiaohuanxiong.com/',
      scanPath: '/login/mp',
      code: 'qr-abc',
      brand: '商汤小浣熊',
      source: 'platform',
    });
    // 官方形态：origin + scan_path + ?code&appname&source
    assert.strictEqual(
      ok,
      'https://xiaohuanxiong.com/login/mp?code=qr-abc&appname=%E5%95%86%E6%B1%A4%E5%B0%8F%E6%B5%A3%E7%86%8A&source=platform',
    );

    const bad = [
      { origin: 'http://xiaohuanxiong.com/', scanPath: '/login/mp', why: 'origin 必须 https' },
      { origin: 'https://user:pass@xiaohuanxiong.com/', scanPath: '/login/mp', why: 'origin 不得带凭据' },
      { origin: 'https://xiaohuanxiong.com/', scanPath: 'login/mp', why: 'scanPath 必须以 / 开头' },
      { origin: 'https://xiaohuanxiong.com/', scanPath: '//evil.com/x', why: '协议相对地址' },
      { origin: 'https://xiaohuanxiong.com/', scanPath: '/login/mp#x', why: 'hash 注入' },
      { origin: 'https://xiaohuanxiong.com/', scanPath: '/login/mp\\x', why: '反斜杠' },
      { origin: 'https://xiaohuanxiong.com/', scanPath: '/login/mp %20', why: '空格' },
      { origin: 'https://xiaohuanxiong.com/', scanPath: '/login/%2e%2e/x', why: '双编码（%xx）' },
      { origin: 'https://xiaohuanxiong.com/', scanPath: '//x.com/y', why: '跳域' },
    ];
    for (const c of bad) {
      assert.throws(() => product.buildQrUrl({
        origin: c.origin, scanPath: c.scanPath, code: 'qr-abc', brand: 'B', source: 'platform',
      }), /INVALID_QR_PATH/, `应拒绝：${c.why}（${c.scanPath}）`);
    }
  });

  t('扫码会话：本地生命周期（创建走上游，故直接注入会话验证查询/取消/过期）', () => {
    // startLoginSession 现在要打上游；本地语义用 _sessions 直接验证，
    // 真链路（qrCreate→qrPoll→落库）由 mock 上游的用例覆盖。
    const id = 'sess-local-test';
    raccoonAuth._sessions.set(id, {
      sessionId: id, code: 'qr-x', qrUrl: 'https://x/login/mp?code=qr-x',
      createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
      pollIntervalMs: 2000, status: 'pending', expiredAt: null, inflight: null, accountId: null,
    });
    assert.ok(raccoonAuth.getLoginSession(id));
    // 过期会话被清理（sweep 在 getLoginSession 内顺带跑）
    raccoonAuth._sessions.get(id).expiresAtMs = Date.now() - 1;
    assert.strictEqual(raccoonAuth.getLoginSession(id), null);
    // 未知 id → null（路由层据此返回 404）
    assert.strictEqual(raccoonAuth.getLoginSession('nope'), null);
    // 取消不存在的会话返回 false（不再谎报 true）
    assert.strictEqual(raccoonAuth.cancelLoginSession('nope'), false);
  });

  t('轮询不存在的会话返回 expired（不抛错、不打上游）', async () => {
    const r = await raccoonAuth.pollLoginSession('does-not-exist');
    assert.deepStrictEqual(r, { status: 'expired' });
  });

  // ===== 扫码新 IAM 链路（mock 上游，不打真实接口）=====
  // 2026-10-18：官方已不接受「客户端自造 code」，扫码改为
  //   创建 → 服务端签发 qrcode_code → 轮询 → success 落库。
  // 用本地 HTTP mock 把整条链路钉住，重点验三件事：
  //   1) 创建拿的是**服务端码**（qr- 前缀），且用它拼 URL
  //   2) 轮询 pending→success 的完整状态机
  //   3) 过期码（AUTH_QRCODE_EXPIRED）必须如实回 expired 让前端换新码
  await t('扫码新 IAM 链路（mock）：签发码 → 轮询 → success 落库 → 过期', async () => {
    const net = require('node:net');
    const mock = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const p = req.url.split('?')[0];
        const reply = (code, data) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 0, message: 'success', data }));
        };
        if (p === '/api/iam/v1/auth/mp/qrcode' && req.method === 'POST') {
          return reply(0, {
            qrcode_code: 'qr-mock-0001',
            scan_path: '/login/mp',
            expires_in: 300,
            poll_interval: 2,
            status: 'pending',
          });
        }
        if (p === '/api/iam/v1/auth/mp/qrcode/login' && req.method === 'POST') {
          const { qrcode_code } = JSON.parse(body || '{}');
          if (qrcode_code === 'qr-expired') {
            // 过期：官方回**字符串业务码**（normalizeEnvelope 会把它折成 400，
            // 故 auth.js 读 raw.code 原文识别）
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ code: 'AUTH_QRCODE_EXPIRED', message: 'qrcode expired', data: null }));
          }
          if (qrcode_code === 'qr-mock-0001') {
            const jwt = [
              'eyJhbGciOiJIUzI1NiJ9',
              Buffer.from(JSON.stringify({ sub: 'mock-user', exp: 1794619246 })).toString('base64url'),
              'sig',
            ].join('.');
            return reply(0, {
              status: 'success',
              access_token: jwt,
              refresh_token: jwt,
            });
          }
          return reply(0, { status: 'pending' });
        }
        res.writeHead(404).end('{}');
      });
    });

    // 把网关的 openapi host 指到 mock：client.urlFor 用的是 V.hosts.openapi，
    // 而 paths 里的 iamBase 是绝对路径 /api/iam/v1，故 new URL(path, HOST)
    // 会让 host 变成 mock 的地址。
    const prevHost = variant.VARIANTS[variant.RACCOON].hosts.openapi;
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
    const port = mock.address().port;
    variant.VARIANTS[variant.RACCOON].hosts.openapi = `http://127.0.0.1:${port}`;
    // ⚠️ 落库的账号必须在 finally 里清理：mock 用例会往真实 store 写一条 raccoon 账号，
    // 若断言中途失败就跳过清理，后续「无账号 → 回退兜底表」的用例会连带失败
    // （实测踩到：`回退时必须说明原因` 报错）。故 saveId 在 try 外声明。
    let savedId = null;
    try {
      const s = await raccoonAuth.startLoginSession();
      // 1) 服务端签发的码（不是自造 hex）
      assert.strictEqual(s.code, 'qr-mock-0001', '必须用服务端签发的 qrcode_code');
      assert.match(s.code, /^qr-/, '新 IAM 的码形如 qr-<uuid>');
      // 2) URL 用签发码拼，且带 source=platform。
      //    ⚠️ origin 用的是 V.identity.qrOrigin（真实站点），不是被 mock 替换的
      //    api host —— 二维码必须指向用户手机能打开的真实页面，这与上游 API
      //    走哪台机器无关。故这里断言真实 origin。
      assert.strictEqual(
        s.qrUrl,
        'https://xiaohuanxiong.com/login/mp?code=qr-mock-0001'
        + '&appname=%E5%95%86%E6%B1%A4%E5%B0%8F%E6%B5%A3%E7%86%8A&source=platform',
      );
      // 3) 轮询到 success → 落库
      const r = await raccoonAuth.pollLoginSession(s.sessionId);
      assert.strictEqual(r.status, 'success', '轮询应拿到 success');
      assert.ok(r.account && r.account.id, 'success 后账号必须落库');
      savedId = r.account.id;
      // label 规则：mock 上游没有 user_info（会 404），persistLogin 降级为
      // `raccoon` 或 `raccoon-<userId>`；这里只断言「有 label 且非空」，
      // 不去钉具体降级形态（那是 persistLogin 的职责，另有用例覆盖）
      assert.ok(r.account.label && r.account.label.length > 0, 'label 不得为空');
      // 重复轮询直接复用已落库账号，不再打上游
      const r2 = await raccoonAuth.pollLoginSession(s.sessionId);
      assert.strictEqual(r2.status, 'success');
      assert.strictEqual(r2.accountId, r.account.id);

      // 4) 过期码必须如实回 expired（而不是 pending 卡死）
      raccoonAuth._sessions.set('sess-exp', {
        sessionId: 'sess-exp', code: 'qr-expired', qrUrl: 'https://x',
        createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
        pollIntervalMs: 2000, status: 'pending', expiredAt: null, inflight: null, accountId: null,
      });
      const re = await raccoonAuth.pollLoginSession('sess-exp');
      assert.strictEqual(re.status, 'expired', 'AUTH_QRCODE_EXPIRED 必须映射为 expired（前端据此换新码）');

      // 清理：删掉 mock 落库的账号，别污染后续用例
    } finally {
      if (savedId) {
        try { store.remove(savedId); } catch { /* 已被删除 */ }
      }
      variant.VARIANTS[variant.RACCOON].hosts.openapi = prevHost;
      mock.close();
    }
  });

  // ===== 扫码成功后必须补 refresh 完成 IAM 确认（P0，2026-10-19 线上实证）=====
  // 现象：扫码登录成功、账号落库，但查积分回
  //   `400 code=200901 iam_confirm_required`（积分/用户信息/对话全挂）。
  // 根因：新 IAM 扫码 success **不回 refresh_token**，而未确认的会话打任何
  //   `/api/web/*` 一律被 IAM 拒绝；确认手段就是**做一次 refresh**
  //   （access_token 当 refresh_token 提交，服务端补发完整令牌对并标记已确认）。
  // 对照：Olivia 的凭据来自桌面客户端本地 auth.json（客户端自己完成过确认），
  //   从未出现 200901 —— 说明这不是账号问题，而是我们登录链漏了这一步。
  await t('扫码 success 无 refresh_token 时必须自动 refresh 补全（修 iam_confirm_required）', async () => {
    const seen = [];
    const jwt = (tag) => [
      'eyJhbGciOiJIUzI1NiJ9',
      Buffer.from(JSON.stringify({ sub: 'mock-user', exp: 1794619246, tag })).toString('base64url'),
      'sig',
    ].join('.');
    const mock = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const p = req.url.split('?')[0];
        const reply = (data) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 0, message: 'success', data }));
        };
        if (p === '/api/iam/v1/auth/mp/qrcode' && req.method === 'POST') {
          return reply({ qrcode_code: 'qr-norefresh', scan_path: '/login/mp', expires_in: 300, poll_interval: 2 });
        }
        if (p === '/api/iam/v1/auth/mp/qrcode/login' && req.method === 'POST') {
          // ⚠️ 关键：只给 access_token，**不给 refresh_token**（线上实测形态）
          return reply({ status: 'success', access_token: jwt('raw') });
        }
        if (p === '/api/web/auth/v1/refresh' && req.method === 'POST') {
          seen.push(JSON.parse(body || '{}'));
          return reply({ access_token: jwt('confirmed'), refresh_token: jwt('confirmed') });
        }
        res.writeHead(404).end('{}');
      });
    });

    const prevHost = variant.VARIANTS[variant.RACCOON].hosts.openapi;
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
    variant.VARIANTS[variant.RACCOON].hosts.openapi = `http://127.0.0.1:${mock.address().port}`;
    let savedId = null;
    try {
      const s = await raccoonAuth.startLoginSession();
      const r = await raccoonAuth.pollLoginSession(s.sessionId);
      assert.strictEqual(r.status, 'success');
      savedId = r.account && r.account.id;

      // 1) 必须发出且只发一次 refresh
      assert.strictEqual(seen.length, 1, '无 refresh_token 时必须自动 refresh 一次完成 IAM 确认');
      // 2) 提交的是 access_token（以 access 当 refresh，线上实测可行）
      assert.ok(String(seen[0].refresh_token).length > 0, 'refresh 必须带上 access_token');
      // 3) 落库的凭据必须是 refresh 之后那一对，而不是原始的裸 access
      const saved = store.get(savedId);
      assert.strictEqual(saved.refreshToken, jwt('confirmed'), '必须落库 refresh 换回的完整令牌对');
      assert.ok(saved.token && saved.token !== jwt('raw'), 'access_token 应更新为 refresh 后的新值');
    } finally {
      if (savedId) { try { store.remove(savedId); } catch { /* 已被删除 */ } }
      variant.VARIANTS[variant.RACCOON].hosts.openapi = prevHost;
      mock.close();
    }
  });

  // ===== 密码登录（真实登录入口，触发每日发放的正解）=====
  await t('密码登录：AES 加密 phone+password → 换出完整令牌对并落库', async () => {
    const jwt = (tag) => [
      'eyJhbGciOiJIUzI1NiJ9',
      Buffer.from(JSON.stringify({ sub: 'mock-user', exp: 1794619246, tag })).toString('base64url'),
      'sig',
    ].join('.');
    const seenBodies = [];
    const mock = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const p = req.url.split('?')[0];
        const reply = (data) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 0, message: 'success', data }));
        };
        if (p === '/api/web/auth/v1/login_with_password' && req.method === 'POST') {
          seenBodies.push(JSON.parse(body || '{}'));
          return reply({ access_token: jwt('pwd'), refresh_token: jwt('pwd-rt'), office_identity: '' });
        }
        // user_info（persistLogin 会拉一次）
        if (p === '/api/web/auth/v1/user_info' && req.method === 'GET') {
          return reply({ id: '7651374', name: 'RaccoonAnthony', phone: '18630893389', office_identity: '' });
        }
        res.writeHead(404).end('{}');
      });
    });

    const prevHost = variant.VARIANTS[variant.RACCOON].hosts.openapi;
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
    variant.VARIANTS[variant.RACCOON].hosts.openapi = `http://127.0.0.1:${mock.address().port}`;
    let savedId = null;
    try {
      const { account, credential } = await raccoonAuth.loginWithPassword({
        nationCode: '86', phone: '18630893389', password: 'SecretPass123',
      });
      savedId = account && account.id;

      // 1) 发出的 body 里 phone 与 password 都是密文（Base64，非明文）
      assert.strictEqual(seenBodies.length, 1, '必须恰好调一次 login_with_password');
      const b = seenBodies[0];
      assert.strictEqual(b.nation_code, '86');
      assert.ok(/^[A-Za-z0-9+/=]+$/.test(b.phone) && !b.phone.includes('1863'), 'phone 必须是密文');
      assert.ok(/^[A-Za-z0-9+/=]+$/.test(b.password) && !b.password.includes('Secret'), 'password 必须是密文');
      // 2) 返回完整令牌对
      assert.strictEqual(credential.access_token, jwt('pwd'));
      assert.strictEqual(credential.refresh_token, jwt('pwd-rt'));
      // 3) 落库带 userId 与 refreshToken（persistLogin 幂等 + fetchUserInfo 成功）
      const saved = store.get(savedId);
      assert.strictEqual(saved.userId, '7651374');
      assert.strictEqual(saved.refreshToken, jwt('pwd-rt'));
      assert.strictEqual(saved.label, 'RaccoonAnthony-3389');
    } finally {
      if (savedId) { try { store.remove(savedId); } catch { /* 已被删除 */ } }
      variant.VARIANTS[variant.RACCOON].hosts.openapi = prevHost;
      mock.close();
    }
  });

  // ===== 平台接线 =====
  t('variant：RACCOON 已注册、归一化正确、能力位如实', () => {
    assert.ok(variant.VARIANTS[variant.RACCOON], 'VARIANTS 必须含 raccoon');
    assert.strictEqual(variant.normalizeEdition('raccoon'), 'raccoon');
    assert.strictEqual(variant.variantOf('raccoon').label, 'Raccoon');
    assert.strictEqual(variant.isEdition('raccoon', variant.RACCOON), true);
    assert.strictEqual(variant.canChat('raccoon'), true);
    const cap = variant.variantOf('raccoon').capability;
    assert.strictEqual(cap.checkin, false, '没有签到端点就不能声明签到能力');
    assert.strictEqual(cap.oauthLogin, false);
    assert.strictEqual(cap.tokenRefresh, true);
    // 2026-10-15 解包实证：本机桌面端把凭据明文写在 ~/.box-agent/config/auth.json，
    // 可直接导入（与 ZCode/Qoder 的加密存储不同），能力位翻转为 true。
    assert.strictEqual(cap.localImport, true);
    assert.strictEqual(cap.deviceFingerprint, false);
    // 2026-10-16：每日积分「无领取端点」与「有等价保活动作」是两件事，
    // 故 checkin=false 与 dailyKeepalive=true 并存（见 variant 里的说明）。
    assert.strictEqual(cap.dailyKeepalive, true, '有等价动作可代做，能力位应为 true');
    // 展示顺序在最后（与 CHANNEL_IDS 的约定一致）
    assert.strictEqual(variant.allVariants().map((v) => v.id).pop(), 'raccoon');
  });

  t('转发池：Raccoon 账号**不会**被选进未指定平台的 Trae 默认池', () => {
    // 这正是 pool.editionOk 改成「只取 Trae 系」要防的事：
    // 旧写法是「canChat 为真且非 workbuddy + 逐个排除 qoder」，
    // 每接入一个 chat=true 的新平台都会被静默放进 Trae 池，
    // 于是 Trae 请求会拿着别家 token 打别家上游。
    const raccoonAcct = store.add(
      { label: 'pool-raccoon', edition: 'raccoon', token: 't'.repeat(40), balance: 999999, enabled: true },
      'login',
    );
    const traeAcct = store.add(
      { label: 'pool-trae', edition: 'cn', token: 't'.repeat(40), balance: 10, enabled: true },
      'import',
    );
    try {
      const pickedDefault = pool.pick(null, {});
      assert.ok(!pickedDefault || pickedDefault.id !== raccoonAcct.id, '默认池绝不能返回 Raccoon 账号');
      // 显式指定 edition='raccoon' 时也进不了池（canChat 为真但由专属端点服务；
      // 这里断言的是「不会误进 Trae 池」这一条最小红线）
      const pickedTrae = pool.pick(null, { edition: 'trae' });
      assert.ok(!pickedTrae || pickedTrae.id !== raccoonAcct.id);
    } finally {
      store.remove(raccoonAcct.id);
      store.remove(traeAcct.id);
    }
  });

  t('模型密钥边界：Raccoon 模型只有通用密钥可调，平台密钥一律拒绝', () => {
    assert.strictEqual(modelAccess.isRaccoonOnlyModel('sn-glm-5-3'), true);
    assert.strictEqual(modelAccess.isRaccoonOnlyModel('sn-sensenova-6-8-flash'), true);
    assert.strictEqual(modelAccess.isRaccoonOnlyModel('glm-4.6'), false);
    assert.strictEqual(modelAccess.isRaccoonOnlyModel('wb/glm-4.6'), false);
    assert.strictEqual(modelAccess.platformOfModel('sn-kimi-k3'), 'raccoon');
    assert.strictEqual(modelAccess.platformOfModel('glm-4.6'), 'trae');
    assert.strictEqual(modelAccess.platformOfModel('wb/x'), 'workbuddy');

    const asTrae = modelAccess.canUseModel('trae', 'sn-glm-5-3');
    assert.strictEqual(asTrae.ok, false, 'trae 密钥不能越界消耗 Raccoon 积分');
    assert.strictEqual(asTrae.reason, 'platform_mismatch');
    const asWb = modelAccess.canUseModel('workbuddy', 'sn-glm-5-3');
    assert.strictEqual(asWb.ok, false, 'workbuddy 密钥同理');
    const asAll = modelAccess.canUseModel('all', 'sn-glm-5-3');
    assert.strictEqual(asAll.ok, true, '通用密钥可调');
    // 不误伤现有平台。
    // ⚠️ 选模型要小心：`glm-4.6` 是 **WorkBuddy 独有**模型，用 trae 密钥调它本来
    // 就该被拒 —— 拿它当「Trae 模型放行」的样本会得到一个假失败。
    assert.strictEqual(modelAccess.canUseModel('trae', 'doubao-1-6').ok, true, 'Trae 模型不受影响');
    assert.strictEqual(modelAccess.canUseModel('workbuddy', 'glm-4.6').ok, true, 'WorkBuddy 裸 id 不受影响');
    assert.strictEqual(modelAccess.canUseModel('trae', 'glm-4.6').ok, false, 'glm-4.6 是 WorkBuddy 独有，trae 密钥应被拒');
  });

  t('资源路径：Raccoon 模型走 model:raccoon/* 前缀', () => {
    assert.strictEqual(scope.modelResourcePath('sn-glm-5-3', { platform: 'raccoon' }), 'model:raccoon/sn-glm-5-3');
    assert.strictEqual(scope.modelResourcePath('sn-x'), 'model:trae/sn-x', '未给 meta 时按 trae（调用方需显式传）');
  });

  // ===== store =====
  t('store：raccoon_org 列往返（新增列不破坏既有账号）', () => {
    const a = store.add(
      { label: 'raccoon-org-test', edition: 'raccoon', token: 'x'.repeat(40), raccoonOrg: 'org-abc' },
      'login',
    );
    try {
      assert.strictEqual(store.get(a.id).raccoonOrg, 'org-abc', 'get 应返回组织码（X-Org-Code 每次请求都要用）');
      assert.strictEqual(store.list().find((x) => x.id === a.id).raccoonOrg, 'org-abc', 'list 也要带（面板展示）');
      const updated = store.update(a.id, { raccoonOrg: 'org-xyz' });
      assert.strictEqual(updated.raccoonOrg, 'org-xyz');
      // 其它平台的账号不受影响：该列为 null
      const trae = store.add({ label: 'trae-org-test', edition: 'cn', token: 'y'.repeat(40) }, 'import');
      assert.strictEqual(store.get(trae.id).raccoonOrg, null);
      store.remove(trae.id);
    } finally {
      store.remove(a.id);
    }
  });

  // ===== HTTP =====
  await t('HTTP：/v1/raccoon/* 与 /v1/admin/channels 的渠道卡片', httpTests);

  for (const { name, fn } of queue) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fn();
      pass += 1;
      console.log(`  ok  ${name}`);
    } catch (e) {
      fail += 1;
      console.log(`  FAIL ${name}\n      ${e.message}`);
    }
  }
  console.log(`\n${pass} passed${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}

setTimeout(() => {
  run().catch((e) => {
    console.error(`FAIL  用例执行异常: ${e.stack || e.message}`);
    process.exit(1);
  });
}, 1200);
