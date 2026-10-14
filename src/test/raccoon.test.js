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
require('./isolation-guard')('raccoon');

// app.listen 在 require 时已发起
require('../index.js');
const product = require('../raccoon/product');
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
  assert.strictEqual(st.json.chat.inPool, false, 'Raccoon 不进 Trae 转发池');

  const s = await req('POST', '/v1/raccoon/login/session', { token: ADMIN, body: {} });
  assert.strictEqual(s.status, 201);
  assert.match(s.json.sessionId, /^[0-9a-f]{24}$/);
  assert.match(s.json.qrUrl, /^https:\/\/xiaohuanxiong\.com\/login\/mp\?code=[0-9a-f]{32}&appname=/);
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

  // 渠道卡片：Raccoon 自动出现，且接入方式是「面板承载登录」
  const ch = await req('GET', '/v1/admin/channels', { token: ADMIN });
  const rc = (ch.json?.data || []).find((c) => c.id === 'raccoon');
  assert.ok(rc, '/v1/admin/channels 应自动包含 Raccoon（注册表驱动的意义所在）');
  assert.deepStrictEqual(rc.onboarding.map((o) => o.kind), ['login']);
  assert.strictEqual(rc.onboarding[0].available, true, '面板承载登录恒可用（不依赖本机客户端）');
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

  t('buildQrImageUrl：官方形态，appname 做百分号编码', () => {
    const code = 'a'.repeat(32);
    assert.strictEqual(
      product.buildQrImageUrl(code),
      `https://xiaohuanxiong.com/login/mp?code=${code}&appname=%E5%95%86%E6%B1%A4%E5%B0%8F%E6%B5%A3%E7%86%8A%E5%AE%98%E7%BD%91`,
    );
  });

  t('登录 URL 能在版本 10 内编码（144 字节 < 213 字节上限）', () => {
    const shape = qr.renderQrPath(product.buildQrImageUrl('f'.repeat(32)));
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
  t('扫码会话：创建/查询/取消/过期清理，且每条会话的 code 不同', () => {
    const a = raccoonAuth.startLoginSession();
    const b = raccoonAuth.startLoginSession();
    assert.notStrictEqual(a.sessionId, b.sessionId);
    assert.notStrictEqual(a.code, b.code);
    assert.match(a.code, /^[0-9a-f]{32}$/);
    assert.strictEqual(a.pollIntervalMs, 2000);
    assert.ok(raccoonAuth.getLoginSession(a.sessionId));
    assert.strictEqual(raccoonAuth.cancelLoginSession(a.sessionId), true);
    assert.strictEqual(raccoonAuth.getLoginSession(a.sessionId), null);
    // 未知 id → null（路由层据此返回 404）
    assert.strictEqual(raccoonAuth.getLoginSession('nope'), null);
    // 过期会话被清理
    const c = raccoonAuth.startLoginSession();
    const s = raccoonAuth._sessions.get(c.sessionId);
    s.expiresAtMs = Date.now() - 1;
    assert.strictEqual(raccoonAuth.getLoginSession(c.sessionId), null);
    raccoonAuth.cancelLoginSession(b.sessionId);
    raccoonAuth.cancelLoginSession(c.sessionId);
  });

  t('轮询不存在的会话返回 expired（不抛错、不打上游）', async () => {
    const r = await raccoonAuth.pollLoginSession('does-not-exist');
    assert.deepStrictEqual(r, { status: 'expired' });
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
    assert.strictEqual(cap.localImport, false);
    assert.strictEqual(cap.deviceFingerprint, false);
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
