'use strict';
/**
 * src/test/qoder.test.js — Qoder 接入单元测试（无网络、无真实客户端）。
 *
 * 覆盖范围：
 *   1. variant：QODER 变体能力位 / realm 域名分叉 / 归一化
 *   2. crypto：os_crypt v10 解密（自造密文）、DPAPI 边界、错误信息
 *   3. store：qoder_realm 列读写、平台隔离
 *   4. rewards：活动归一化、CLAIM 语义、blockReason
 *   5. catalog：qoderEncode 自定义 Base64、COSY 头构造、QMC 信封解析
 *   6. balance：refreshQoderBalance 的隔离口径（不写 balance / credit_history）
 *   7. pricing-calib：qoder 独立标定键
 *   8. chat：国际版对话面的可调用模型清单 / realm 拒绝 / usage 窥探
 *   9. model-access：Qoder 模型的密钥平台边界
 *
 * 真实上游与真实客户端的验证在 scripts/test-qoder-integration.js。
 */
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 必须在 require 任何项目模块之前隔离状态目录与加密密钥（否则测试会写真实账号库）。
// 本文件早先漏了这一步，是 10 个测试文件里唯一没隔离的。
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `trae-qoder-${Date.now()}`);
process.env.TRAE_API_ENCRYPT_KEY = 'a'.repeat(64);
process.env.API_KEY = 'test-api-key';
process.env.ADMIN_KEY = 'test-admin-key';
require('./isolation-guard')('qoder');

let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (e) { failed += 1; failures.push({ name, msg: e.message }); console.log(`  FAIL ${name}\n      ${e.message}`); }
}

const variant = require('../platform/variant');
const store = require('../credentials/store');

async function main() {
// ---------- variant ----------
console.log('\n[variant]');

await t('QODER 变体能力位：chat 仅国际版、checkin 关闭，balance/rewardClaim/localImport 开启', () => {
  const v = variant.variantOf(variant.QODER);
  assert.strictEqual(v.label, 'Qoder');
  assert.strictEqual(v.capability.chat, true, '国际版对话面已打通（单账号）');
  assert.strictEqual(v.capability.checkin, false);
  assert.strictEqual(v.capability.growth, false);
  assert.strictEqual(v.capability.billing, false);
  assert.strictEqual(v.capability.balance, true);
  assert.strictEqual(v.capability.rewardClaim, true);
  assert.strictEqual(v.capability.localImport, true);
  assert.strictEqual(v.capability.deviceFingerprint, true);
});

await t('关键红线：capability.chat=true 不等于两个 realm 都能转发', () => {
  // 国内版 /model/v1/* 实测 503，必须走 COSY 老协议（未实现）。
  // 这条断言锁住「不要把 chat 能力位当成 realm 无关的全局开关」。
  assert.strictEqual(variant.canChat(variant.QODER), true, '平台级 chat 能力已开启');
  assert.deepStrictEqual(variant.qoderChatRealms(), ['intl'], '但 realm 白名单只有国际版');
  assert.strictEqual(variant.qoderChatOk({ qoderRealm: 'intl', token: 'dt-x' }), true);
  assert.strictEqual(variant.qoderChatOk({ qoderRealm: 'cn', token: 'dt-x' }), false,
    '国内版账号即使有 token 也不得进转发池');
  assert.strictEqual(variant.qoderChatOk({ qoderRealm: 'intl' }), false, '无 token 不进池');
});

await t('关键红线：未指定 edition 时 qoder 绝不落入 Trae 默认池', () => {
  // routes/openai 的 Trae 直连分支、routes/anthropic、routes/responses 都有
  // 不传 edition 的 pool.run 调用（fallback Trae 池）。国内版 qoder 账号若被
  // 选进这些链路，上游必然 503，表现为「Trae 请求随机失败」。
  const pool = require('../credentials/pool');
  const cn = { id: 'a_cn', edition: 'qoder', qoderRealm: 'cn', token: 'dt-x', enabled: true };
  const intl = { id: 'a_intl', edition: 'qoder', qoderRealm: 'intl', token: 'dt-x', enabled: true };
  assert.strictEqual(pool._editionOkForTest(cn, undefined), false, '未指定平台：国内版 qoder 排除');
  assert.strictEqual(pool._editionOkForTest(intl, undefined), false, '未指定平台：国际版 qoder 也排除');
  assert.strictEqual(pool._editionOkForTest(intl, 'qoder'), true, '显式指定 qoder：国际版进池');
  assert.strictEqual(pool._editionOkForTest(cn, 'qoder'), false, '显式指定 qoder：国内版仍排除');
  assert.strictEqual(pool._editionOkForTest(cn, 'trae'), false, 'qoder 账号永不被当成 Trae');
  assert.strictEqual(pool._editionOkForTest({ edition: 'trae' }, 'trae'), true, 'Trae 池不受影响');
  assert.strictEqual(pool._editionOkForTest({ edition: 'workbuddy' }, 'workbuddy'), true, 'WorkBuddy 池不受影响');
});

await t('normalizeEdition：qoder 归一，未知值归 trae', () => {
  assert.strictEqual(variant.normalizeEdition('qoder'), 'qoder');
  assert.strictEqual(variant.normalizeEdition('QODER'), 'qoder');
  assert.strictEqual(variant.normalizeEdition('trae'), 'trae');
  assert.strictEqual(variant.normalizeEdition('cn'), 'trae');
  assert.strictEqual(variant.normalizeEdition(''), 'trae');
  assert.strictEqual(variant.normalizeEdition(null), 'trae');
});

await t('realm 域名分叉：cn 走 .com.cn，intl 走 .sh', () => {
  assert.strictEqual(variant.qoderOpenapiBase('cn'), 'https://openapi.qoder.com.cn');
  assert.strictEqual(variant.qoderOpenapiBase('intl'), 'https://openapi.qoder.sh');
  assert.strictEqual(variant.qoderGatewayBase('cn'), 'https://gateway.qoder.com.cn');
  assert.strictEqual(variant.qoderGatewayBase('intl'), 'https://api2-v2.qoder.sh');
});

await t('realm 域名分叉：客户端目录与协议形态', () => {
  assert.strictEqual(variant.qoderRealmConfig('cn').appDir, 'com.qodercn.app.stable');
  assert.strictEqual(variant.qoderRealmConfig('intl').appDir, 'com.qoder.app.stable');
  assert.strictEqual(variant.qoderRealmConfig('cn').homeDir, '.qoder-cn');
  assert.strictEqual(variant.qoderRealmConfig('intl').homeDir, '.qoder');
  assert.strictEqual(variant.qoderRealmConfig('cn').chatProtocol, 'cosy');
  assert.strictEqual(variant.qoderRealmConfig('intl').chatProtocol, 'openai');
});

await t('realm 未知值归一 intl（运营面域名双区域同构）', () => {
  assert.strictEqual(variant.qoderRealm(''), 'intl');
  assert.strictEqual(variant.qoderRealm(null), 'intl');
  assert.strictEqual(variant.qoderRealm('CN'), 'cn');
  assert.strictEqual(variant.qoderRealm('Intl'), 'intl');
  assert.strictEqual(variant.qoderRealm('us'), 'intl');
});

await t('qoderRealmOfAccount：持久字段优先，兼容下划线写法', () => {
  assert.strictEqual(variant.qoderRealmOfAccount({ qoderRealm: 'cn' }), 'cn');
  assert.strictEqual(variant.qoderRealmOfAccount({ qoder_realm: 'cn' }), 'cn');
  assert.strictEqual(variant.qoderRealmOfAccount(null), 'intl');
  assert.strictEqual(variant.qoderRealmOfAccount({}), 'intl');
});

await t('关键实证：国际版 fastEndpoint 是 .com.cn 域名，realm 不得由域名推导', () => {
  // 该断言锁死「realm 只能来自客户端目录」这条设计约束。
  // 若将来有人改成按 host 后缀判断，此用例会提醒他曾被实测推翻。
  const cfg = variant.qoderRealmConfig('intl');
  assert.ok(!cfg.openapi.includes('.com.cn'),
    'intl 的 openapi 不应是 .com.cn（否则域名推导会误判）');
  assert.ok(cfg.openapi.includes('qoder.sh'), 'intl openapi 应在 qoder.sh 域');
});

await t('rewardClaimHours 默认 [10]，对应上游 UTC+8 10:00 刷新', () => {
  const v = variant.variantOf(variant.QODER);
  assert.deepStrictEqual(v.rewardClaimHours, [10]);
  assert.strictEqual(v.rewardClaimMinute, 15);
});

// ---------- crypto ----------
console.log('\n[crypto]');
const cryptoMod = require('../qoder/crypto');

await t('自造 os_crypt v10 密文可被正确解密', () => {
  const key = crypto.randomBytes(32);
  const plain = Buffer.from(JSON.stringify({ token: 'dt-test', refreshToken: 'drt-test', user: { id: 'uid-1' } }), 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const blob = Buffer.concat([Buffer.from('v10', 'latin1'), iv, sealed]);
  const out = cryptoMod.decryptV10(blob, key);
  assert.deepStrictEqual(JSON.parse(out.toString('utf8')), { token: 'dt-test', refreshToken: 'drt-test', user: { id: 'uid-1' } });
});

await t('非 v10 前缀被拒绝', () => {
  const key = crypto.randomBytes(32);
  assert.throws(() => cryptoMod.decryptV10(Buffer.alloc(64), key), /v10/);
});

await t('密钥长度错误被拒绝', () => {
  const iv = crypto.randomBytes(12);
  const sealed = crypto.randomBytes(40);
  assert.throws(() => cryptoMod.decryptV10(Buffer.concat([Buffer.from('v10'), iv, sealed]), crypto.randomBytes(16)), /32/);
});

await t('tag 校验失败报「密钥不匹配」而非原始解密异常', () => {
  const key = crypto.randomBytes(32);
  const other = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([cipher.update(Buffer.from('secret')), cipher.final(), cipher.getAuthTag()]);
  const blob = Buffer.concat([Buffer.from('v10'), iv, sealed]);
  assert.throws(() => cryptoMod.decryptV10(blob, other), /GCM|密钥/);
});

await t('payload 过短被拒绝', () => {
  assert.throws(() => cryptoMod.decryptV10(Buffer.from('v10'), crypto.randomBytes(32)), /过短/);
});

await t('Local State 缺 encrypted_key 时报明确原因', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-ls-'));
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ os_crypt: {} }));
  assert.throws(() => cryptoMod.readOsCryptKey(path.join(dir, 'Local State')), /encrypted_key/);
  fs.rmSync(dir, { recursive: true, force: true });
});

await t('encrypted_key 非 DPAPI 前缀时报「加密方案可能已升级」', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-ls2-'));
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({
    os_crypt: { encrypted_key: Buffer.from('XXXX' + 'x'.repeat(40)).toString('base64') },
  }));
  assert.throws(() => cryptoMod.readOsCryptKey(path.join(dir, 'Local State')), /DPAPI/);
  fs.rmSync(dir, { recursive: true, force: true });
});

await t('normalizeAuth：缺 token 报错，字段名兼容', () => {
  assert.throws(() => cryptoMod.normalizeAuth({}), /token/);
  const a = cryptoMod.normalizeAuth({ accessToken: 'dt-x', user: { id: 'u1', name: 'n', email: 'e' } });
  assert.strictEqual(a.token, 'dt-x');
  assert.strictEqual(a.userId, 'u1');
  assert.strictEqual(a.userName, 'n');
  assert.strictEqual(a.userEmail, 'e');
  assert.strictEqual(a.refreshToken, null);
});

await t('candidateAppDirs 覆盖两个 realm', () => {
  const dirs = cryptoMod.candidateAppDirs();
  assert.strictEqual(dirs.length, 2);
  assert.ok(dirs.some((d) => d.endsWith('com.qodercn.app.stable')));
  assert.ok(dirs.some((d) => d.endsWith('com.qoder.app.stable')));
  const one = cryptoMod.candidateAppDirs('cn');
  assert.strictEqual(one.length, 1);
  assert.ok(one[0].endsWith('com.qodercn.app.stable'));
});

// ---------- store: qoder_realm ----------
console.log('\n[store]');

await t('qoder_realm 列：add / get / update / list 全链路', () => {
  const a = store.add({ label: 'qtest-unit', edition: 'qoder', token: 'dt-u', qoderRealm: 'cn' }, 'local');
  try {
    assert.strictEqual(a.qoderRealm, 'cn');
    assert.strictEqual(store.get(a.id).qoderRealm, 'cn');
    assert.strictEqual(store.list().find((x) => x.id === a.id).qoderRealm, 'cn');
    assert.strictEqual(store.update(a.id, { qoderRealm: 'intl' }).qoderRealm, 'intl');
    assert.strictEqual(store.get(a.id).qoderRealm, 'intl');
  } finally { store.remove(a.id); }
});

await t('qoder_realm 列：非 qoder 账号为 null（不污染既有平台）', () => {
  const a = store.add({ label: 'trae-unit', edition: 'trae', token: 'tk' }, 'import');
  try {
    // SQLite 无该列值时 node:sqlite 返回 undefined（不是 null）；
    // 前端与所有读取方都按 falsy 处理，故断言「无值」而不强求 null。
    const v = store.get(a.id).qoderRealm;
    assert.ok(v == null, `非 qoder 账号不应有 realm，实际 ${v}`);
  } finally { store.remove(a.id); }
});

await t('update 局部更新不产生丢失更新（realm 保留）', () => {
  const a = store.add({ label: 'qtest-lost', edition: 'qoder', token: 'dt-u', qoderRealm: 'cn', userId: 'uid-x' }, 'local');
  try {
    store.update(a.id, { priority: 5 });
    const got = store.get(a.id);
    assert.strictEqual(got.qoderRealm, 'cn', '更新其它字段不应抹掉 realm');
    assert.strictEqual(got.userId, 'uid-x', '更新其它字段不应抹掉 userId');
    assert.strictEqual(got.priority, 5);
  } finally { store.remove(a.id); }
});

// ---------- rewards ----------
console.log('\n[rewards]');
const rewards = require('../qoder/rewards');

await t('CLAIM_RESULT 四态语义', () => {
  assert.strictEqual(rewards.CLAIM_RESULT.CLAIMED, 'claimed');
  assert.strictEqual(rewards.CLAIM_RESULT.ALREADY, 'already');
  assert.strictEqual(rewards.CLAIM_RESULT.FAILED, 'failed');
  assert.strictEqual(rewards.CLAIM_RESULT.SKIPPED, 'skipped');
});

await t('isQoder 显式判定，不做默认推断', () => {
  assert.strictEqual(rewards.isQoder({ edition: 'qoder' }), true);
  assert.strictEqual(rewards.isQoder({ edition: 'trae' }), false);
  assert.strictEqual(rewards.isQoder(null), false);
  assert.strictEqual(rewards.isQoder({ edition: 'zcode' }), false);
});

await t('blockReason：四类不可执行原因', () => {
  assert.strictEqual(rewards.blockReason({ edition: 'trae', enabled: true, token: 'x' }), '非 Qoder 账号，已跳过操作');
  assert.strictEqual(rewards.blockReason({ edition: 'qoder', enabled: false, token: 'x' }), '账号已停用，已跳过操作');
  assert.strictEqual(rewards.blockReason({ edition: 'qoder', enabled: true }), '账号缺少访问凭据，已跳过操作');
  assert.strictEqual(rewards.blockReason({ edition: 'qoder', enabled: true, token: 'dt-x' }), null);
});

await t('parseCampaign：官方字段全量归一', () => {
  const c = rewards.parseCampaign({
    campaignId: 'act-20261013-250',
    campaignKey: 'act-20261013-250',
    actionType: 'CLAIM_BENEFIT',
    claimStatus: 'CLAIMABLE',
    benefit: { kind: 'CREDITS', amount: 100, validity: { mode: 'RELATIVE_DAYS', days: 30 } },
    startAt: 1760000000, endAt: 1760300000,
    placements: [{ content: { zh: { title: '每天领 100 Credits', description: '每日 10:00（UTC+8）刷新' } } }],
  });
  assert.strictEqual(c.campaignId, 'act-20261013-250');
  assert.strictEqual(c.kind, 'CREDITS');
  assert.strictEqual(c.amount, 100);
  assert.strictEqual(c.validityMode, 'RELATIVE_DAYS');
  assert.strictEqual(c.validityDays, 30);
  assert.strictEqual(c.startAt, new Date(1760000000 * 1000).toISOString());
  assert.strictEqual(c.title, '每天领 100 Credits');
});

await t('isClaimableCredits：只认 CLAIM_BENEFIT + CREDITS + CLAIMABLE', () => {
  const base = { actionType: 'CLAIM_BENEFIT', kind: 'CREDITS', claimStatus: 'CLAIMABLE' };
  assert.strictEqual(rewards.isClaimableCredits(base), true);
  assert.strictEqual(rewards.isClaimableCredits({ ...base, claimStatus: 'CLAIMED' }), false);
  assert.strictEqual(rewards.isClaimableCredits({ ...base, kind: 'POINTS' }), false);
  assert.strictEqual(rewards.isClaimableCredits({ ...base, actionType: 'VIEW_DETAILS' }), false);
  assert.strictEqual(rewards.isClaimableCredits(null), false);
});

await t('campaignText：中→英→空 三级回退', () => {
  assert.strictEqual(rewards.campaignText({ placements: [{ content: { zh: { title: '中' } } }] }).title, '中');
  assert.strictEqual(rewards.campaignText({ placements: [{ content: { title: 'EN' } }] }).title, 'EN');
  assert.strictEqual(rewards.campaignText({ placements: [] }).title, '');
  assert.strictEqual(rewards.campaignText({}).title, '');
  assert.strictEqual(rewards.campaignText(null).title, '');
  assert.strictEqual(rewards.campaignText(undefined).title, '');
});

// ---------- catalog ----------
console.log('\n[catalog]');
const catalog = require('../qoder/catalog');

await t('qoderEncode：与官方客户端逐字节一致（交叉验证）', () => {
  // 官方 qoder_encode：std base64 按 a = n//3 切尾/中/首三段重排，
  // 再过自定义字母表翻译，'=' → '$'。
  // 参考向量取自官方 Python 实现的实际输出（上游已接受这些签名，故必然一致）。
  assert.strictEqual(catalog.qoderEncode(Buffer.from('{"x":1}')), 'ep$$BMn%mYKI');
  assert.strictEqual(catalog.qoderEncode(Buffer.from('{}')), '$kwm');
  assert.strictEqual(catalog.qoderEncode(Buffer.from('abc')), 'MSK#');
  assert.strictEqual(catalog.qoderEncode(Buffer.from('hello world')), 'YuHp$Hq&J(WPHFru');
  // 幂等
  assert.strictEqual(catalog.qoderEncode(Buffer.from('{"x":1}')), catalog.qoderEncode(Buffer.from('{"x":1}')));
});

await t('qoderEncode：与独立参考实现交叉一致（防自定义字母表转录错）', () => {
  // 独立重写一遍官方算法。若 catalog.js 的字母表抄错一个字符，
  // 上游会返回 Signature invalid，而本用例能在不发请求的前提下抓住它。
  const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const ALPHA = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
  const ref = (buf) => {
    const std = buf.toString('base64');
    const n = std.length;
    const a = Math.floor(n / 3);
    const arr = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
    let out = '';
    for (const ch of arr) out += ch === '=' ? '$' : ALPHA[STD.indexOf(ch)];
    return out;
  };
  for (const s of ['{}', '{"x":1}', 'abc', 'a', 'ab', 'abcd', 'hello world', 'x'.repeat(100),
    JSON.stringify({ a: 1, b: [1, 2, 3] }), JSON.stringify({ token: 'dt-abc' })]) {
    assert.strictEqual(catalog.qoderEncode(Buffer.from(s)), ref(Buffer.from(s)), `输入 ${JSON.stringify(s).slice(0, 30)}`);
  }
});

await t('COSY 头：16 项齐全 + Authorization 形态 COSY.payload.sig', () => {
  const bodyEnc = catalog.qoderEncode(Buffer.from('{}'));
  const h = catalog.cosyHeaders(bodyEnc, 'https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1', {
    token: 'dt-x', refreshToken: 'drt-x', uid: 'uid-1', nickname: 'n',
  });
  const keys = ['cosy-data-policy', 'content-type', 'cosy-machinetype', 'cosy-clienttype',
    'cosy-date', 'cosy-user', 'cosy-key', 'accept', 'cosy-clientip', 'authorization',
    'accept-encoding', 'cosy-version', 'cosy-machineid', 'cosy-machinetoken', 'login-version', 'user-agent'];
  for (const k of keys) assert.ok(h[k], `缺少头 ${k}`);
  assert.strictEqual(keys.length, 16);
  assert.ok(h.authorization.startsWith('Bearer COSY.'), `Authorization 形态错误: ${h.authorization.slice(0, 20)}`);
  const parts = h.authorization.slice('Bearer COSY.'.length).split('.');
  assert.strictEqual(parts.length, 2, '应是 payload.sig 两段');
  assert.strictEqual(h['cosy-version'], '1.1.64');
  assert.strictEqual(h['cosy-clienttype'], '5');
  assert.strictEqual(h['cosy-user'], 'uid-1');
});

await t('COSY 头：x-model-key 仅在有值时附带', () => {
  const bodyEnc = catalog.qoderEncode(Buffer.from('{}'));
  const url = 'https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1';
  const without = catalog.cosyHeaders(bodyEnc, url, { token: 't', refreshToken: 'r', uid: 'u' });
  assert.ok(!('x-model-key' in without));
  const with_ = catalog.cosyHeaders(bodyEnc, url, { token: 't', refreshToken: 'r', uid: 'u' }, 'qmodel');
  assert.strictEqual(with_['x-model-key'], 'qmodel');
  assert.strictEqual(with_['x-model-source'], 'system');
});

await t('COSY 签名：requestId 每次不同（重放保护），结构稳定', () => {
  const bodyEnc = catalog.qoderEncode(Buffer.from('{}'));
  const url = 'https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1';
  const a = catalog.cosyHeaders(bodyEnc, url, { token: 't', refreshToken: 'r', uid: 'u' });
  const b = catalog.cosyHeaders(bodyEnc, url, { token: 't', refreshToken: 'r', uid: 'u' });
  // requestId 每请求唯一 → payload 与 sig 必然不同。这是重放保护，不是缺陷。
  assert.notStrictEqual(a.authorization, b.authorization, 'requestId 应每次唯一');
  // 结构必须稳定：Bearer COSY.<base64 payload>.<32位hex sig>
  assert.match(a.authorization, /^Bearer COSY\.[A-Za-z0-9+/=]+\.[a-f0-9]{32}$/);
  assert.match(b.authorization, /^Bearer COSY\.[A-Za-z0-9+/=]+\.[a-f0-9]{32}$/);
  // payload 解出来应是那 5 个键
  const payload = JSON.parse(Buffer.from(a.authorization.slice('Bearer COSY.'.length).split('.')[0], 'base64').toString('utf8'));
  assert.deepStrictEqual(Object.keys(payload).sort(), ['cosyVersion', 'ideVersion', 'info', 'requestId', 'version']);
  assert.strictEqual(payload.cosyVersion, '1.1.64');
  assert.strictEqual(payload.ideVersion, '');
  assert.strictEqual(payload.version, 'v1');
});

await t('COSY identity：9 键齐全且 user_type 是 personal_profession_trial', () => {
  // 这 9 个键错一个就是 Signature invalid（实测踩过：用了 machine* 字段）
  const bodyEnc = catalog.qoderEncode(Buffer.from('{}'));
  const h = catalog.cosyHeaders(bodyEnc, 'https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1', {
    token: 'dt-x', refreshToken: 'drt-x', uid: 'uid-1', nickname: 'nick',
  });
  const payload = JSON.parse(Buffer.from(h.authorization.slice('Bearer COSY.'.length).split('.')[0], 'base64').toString('utf8'));
  // info 是 AES-128-CBC(tempKey, tempKey) 加密的 identity JSON，此处只能验证它非空
  assert.ok(payload.info && payload.info.length > 20, 'info 应含加密后的 identity');
  // tempKey 即 cosy-key（RSA 包裹后的 base64）
  assert.ok(h['cosy-key'] && h['cosy-key'].length > 100, 'cosy-key 应为 RSA 密文');
  // 实测：user_type 必须是 personal_profession_trial（profession，非 professional）
  const V = variant.variantOf(variant.QODER);
  assert.strictEqual(V.identity.defaultUserType, 'personal_profession_trial');
});

await t('normalizeModel：保留官方全字段并补兼容键', () => {
  const m = catalog.normalizeModel({
    key: 'qfmodel', display_name: 'Qwen3.8-Flash', is_free: true, price_factor: 0,
    max_input_tokens: 180000, enable: true,
    promotion: { active: true, discount_factor: 0.6, window_start: '22:00', window_end: '08:00', rule_id: 'r1' },
  });
  assert.strictEqual(m.id, 'qfmodel');
  assert.strictEqual(m.name, 'Qwen3.8-Flash');
  assert.strictEqual(m.isFree, true);
  assert.strictEqual(m.priceFactor, 0);
  assert.strictEqual(m.maxInputTokens, 180000);
  assert.strictEqual(m.enable, true, '官方原始字段必须保留（裁剪会让限免信息静默丢失）');
  assert.strictEqual(m.promotion.active, true);
  assert.strictEqual(m.promotion.discountFactor, 0.6);
  assert.strictEqual(m.promotion.windowStart, '22:00');
});

await t('normalizeModel：无 key 返回 null', () => {
  assert.strictEqual(catalog.normalizeModel({ display_name: 'x' }), null);
  assert.strictEqual(catalog.normalizeModel(null), null);
});

await t('freeModels：只取 is_free=true', () => {
  const models = [
    catalog.normalizeModel({ key: 'a', is_free: true }),
    catalog.normalizeModel({ key: 'b', is_free: false }),
    catalog.normalizeModel({ key: 'c' }),
  ];
  assert.deepStrictEqual(catalog.freeModels(models).map((m) => m.key), ['a']);
});

await t('QMC 信封：自造密文可解密（HKDF salt/info 正确）', () => {
  const uid = 'uid-1';
  const payload = JSON.stringify([{ key: 'm1', display_name: 'M1', is_free: false, price_factor: 1 }]);
  const key = crypto.hkdfSync('sha256', Buffer.from(uid), Buffer.from('qoder-model-cache-enc'), Buffer.from('model-cache-v1'), 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  const blob = Buffer.concat([Buffer.from('QMC\x01'), iv, sealed]).toString('base64');
  const dec = catalog.qmcDecrypt(blob, uid);
  assert.strictEqual(dec.length, 1);
  assert.strictEqual(dec[0].key, 'm1');
});

await t('QMC 信封：魔数/版本校验', () => {
  const key = crypto.hkdfSync('sha256', Buffer.from('u'), Buffer.from('qoder-model-cache-enc'), Buffer.from('model-cache-v1'), 32);
  const mk = (magic) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const sealed = Buffer.concat([c.update('[]'), c.final(), c.getAuthTag()]);
    return Buffer.concat([magic, iv, sealed]).toString('base64');
  };
  assert.throws(() => catalog.qmcDecrypt(mk(Buffer.from('QMC2')), 'u'), /魔数|版本/);
  assert.throws(() => catalog.qmcDecrypt(mk(Buffer.from('ABC\x01')), 'u'), /魔数/);
  // 短信封
  assert.throws(() => catalog.qmcDecrypt(Buffer.from('QQ==').toString('base64'), 'u'), /过短/);
});

await t('catalogCachePath：国际版在 ~/.qoder/.models/<uid>/catalog-v6', () => {
  const p = catalog.catalogCachePath('intl', 'uid-1');
  assert.ok(p.endsWith(path.join('.qoder', '.models', 'uid-1', 'catalog-v6')), p);
});

await t('关键实证：is_free ≠ 可调用（文档结论，代码注释层锁定）', () => {
  // qfmodel 在目录里 is_free=true，但 chat 端点返回 invalid_model_error。
  // 本用例锁死「目录字段不能推断可调用性」这一约束：normalizeModel 不得
  // 提供任何「可调用」派生字段，可调用集合必须由实测 probeModel 得到。
  const m = catalog.normalizeModel({ key: 'qfmodel', is_free: true, price_factor: 0 });
  assert.ok(!('callable' in m), '不得从 is_free 派生可调用性');
  assert.ok(!('callable' in m), '不得提供任何可调用性字段');
  assert.strictEqual(m.isFree, true, 'is_free 只表示价格，不表示可调用');
});

// ---------- balance ----------
console.log('\n[balance]');

await t('refreshQoderBalance：两段额度隔离，balance 保持 null', async () => {
  const acct = store.add({ label: 'qtest-bal', edition: 'qoder', token: 'dt-b', qoderRealm: 'cn' }, 'local');
  try {
    const balance = require('../upstream/balance');
    // mock rewards.fetchQuota，避免真实上游
    const rewardsPath = require.resolve('../qoder/rewards');
    const orig = require.cache[rewardsPath].exports.fetchQuota;
    require.cache[rewardsPath].exports.fetchQuota = async () => ({
      userType: 'personal_professional_trial', usageType: 'credits',
      base: { total: 300, remaining: 250, used: 50, expiresAt: '2027-01-01T00:00:00Z' },
      addOn: { total: 100, remaining: 40, used: 60, expiresAt: '2026-11-12T00:00:00Z' },
      totalRemaining: 290,
    });
    try {
      const r = await balance.refreshQoderBalance(store.get(acct.id));
      assert.strictEqual(r.balance, null, 'balance 列必须保持 null（防积分口径污染）');
      assert.strictEqual(r.used, null);
      assert.strictEqual(r.limit, null);
      assert.strictEqual(r.source, 'qoder_quota');
      assert.strictEqual(r.quota.base.remaining, 250);
      assert.strictEqual(r.quota.addOn.remaining, 40);
      assert.strictEqual(r.quota.totalRemaining, 290, 'total 仅供展示');
      assert.deepStrictEqual(r.packs, [], 'packs 必须为空（否则被积分聚合吃进去）');
      assert.strictEqual(r.realm, 'cn');
      // 落库口径
      const got = store.get(acct.id);
      assert.strictEqual(got.balance, null);
      assert.strictEqual(got.entitlementSnapshot.quota.base.remaining, 250);
      assert.strictEqual(got.entitlementSnapshot.quota.addOn.remaining, 40);
      assert.ok(!got.entitlementSnapshot.packs, '不得写 packs 键');
    } finally {
      require.cache[rewardsPath].exports.fetchQuota = orig;
    }
  } finally { store.remove(acct.id); }
});

await t('refreshQoderBalance：保留 rewards 写入的 lastClaim* 领取历史', async () => {
  const acct = store.add({ label: 'qtest-bal2', edition: 'qoder', token: 'dt-b', qoderRealm: 'intl' }, 'local');
  try {
    store.update(acct.id, { entitlementSnapshot: { lastClaimAt: '2026-10-13T02:15:00Z', lastClaimAmount: 100 } });
    const balance = require('../upstream/balance');
    const rewardsPath = require.resolve('../qoder/rewards');
    const orig = require.cache[rewardsPath].exports.fetchQuota;
    require.cache[rewardsPath].exports.fetchQuota = async () => ({
      userType: 'personal_professional_trial', usageType: 'credits',
      base: { total: 300, remaining: 300, used: 0 }, addOn: null,
      totalRemaining: 300,
    });
    try {
      await balance.refreshQoderBalance(store.get(acct.id));
      const got = store.get(acct.id);
      assert.strictEqual(got.entitlementSnapshot.lastClaimAt, '2026-10-13T02:15:00Z', '领取历史不应被余额刷新抹掉');
      assert.strictEqual(got.entitlementSnapshot.lastClaimAmount, 100);
      assert.strictEqual(got.entitlementSnapshot.quota.base.remaining, 300);
    } finally {
      require.cache[rewardsPath].exports.fetchQuota = orig;
    }
  } finally { store.remove(acct.id); }
});

await t('refreshBalance 分流：qoder 走 refreshQoderBalance', async () => {
  const acct = store.add({ label: 'qtest-disp', edition: 'qoder', token: 'dt-d', qoderRealm: 'cn' }, 'local');
  try {
    const balance = require('../upstream/balance');
    const rewardsPath = require.resolve('../qoder/rewards');
    const orig = require.cache[rewardsPath].exports.fetchQuota;
    require.cache[rewardsPath].exports.fetchQuota = async () => ({
      userType: 't', usageType: 'credits',
      base: { total: 1, remaining: 1, used: 0 }, addOn: null, totalRemaining: 1,
    });
    try {
      const r = await balance.refreshBalance(acct.id);
      assert.strictEqual(r.source, 'qoder_quota', '应按 edition 分流到 qoder');
      assert.strictEqual(r.realm, 'cn');
    } finally {
      require.cache[rewardsPath].exports.fetchQuota = orig;
    }
  } finally { store.remove(acct.id); }
});

await t('refreshBalanceAllEnabled 只跑 enabled 且含 qoder', async () => {
  const on = store.add({ label: 'qtest-on', edition: 'qoder', token: 'dt-1', qoderRealm: 'cn', enabled: true }, 'local');
  const off = store.add({ label: 'qtest-off', edition: 'qoder', token: 'dt-2', qoderRealm: 'cn', enabled: false }, 'local');
  try {
    const balance = require('../upstream/balance');
    const rewardsPath = require.resolve('../qoder/rewards');
    const orig = require.cache[rewardsPath].exports.fetchQuota;
    require.cache[rewardsPath].exports.fetchQuota = async () => ({
      userType: 't', usageType: 'credits',
      base: { total: 1, remaining: 1, used: 0 }, addOn: null, totalRemaining: 1,
    });
    try {
      const r = await balance.refreshBalanceAllEnabled({});
      assert.ok(r.ok.some((x) => x.accountId === on.id), '启用的 qoder 账号应被刷新');
      assert.ok(!r.ok.some((x) => x.accountId === off.id), '停用的 qoder 账号不应被刷新');
    } finally {
      require.cache[rewardsPath].exports.fetchQuota = orig;
    }
  } finally { store.remove(on.id); store.remove(off.id); }
});

// ---------- checkin-all isolation ----------
console.log('\n[checkin-all isolation]');

await t('qoder 不进入 checkin-all 平台枚举（capability.checkin=false）', () => {
  const { checkinPlatforms } = require('../upstream/checkin-all');
  const p = checkinPlatforms();
  assert.ok(!p.includes('qoder'), `qoder 不应出现: ${p.join(',')}`);
  assert.ok(Array.isArray(p));
});

// ---------- pricing-calib ----------
console.log('\n[pricing-calib]');

await t('calibKey：qoder 独立标定前缀', () => {
  const { calibKey } = require('../models/pricing-calib');
  assert.strictEqual(calibKey('qfmodel', 'qoder'), 'qoder:qfmodel');
  assert.strictEqual(calibKey('qmodel_38max', 'qoder'), 'qoder:qmodel38max');
  assert.strictEqual(calibKey('glm-5.3-flash', 'workbuddy'), 'wb:glm5.3flash');
  assert.strictEqual(calibKey('gpt-5', 'trae'), 'trae:gpt5');
  assert.strictEqual(calibKey('gpt-5', 'all'), 'trae:gpt5', '未知平台仍归 trae（既有行为）');
});

// ---------- client ----------
console.log('\n[client]');
const client = require('../qoder/client');

await t('desktopHeaders：三件套齐全（活动平台必需）', () => {
  const h = client.desktopHeaders('dt-x');
  assert.strictEqual(h.Authorization, 'Bearer dt-x');
  assert.strictEqual(h['User-Agent'], 'Qoder');
  assert.strictEqual(h['cosy-clienttype'], '10');
  assert.strictEqual(h['cosy-version'], '0.4.3');
  assert.strictEqual(h['Content-Type'], 'application/json');
});

await t('baseFor / gatewayFor 按 realm 选域', () => {
  assert.strictEqual(client.baseFor({ qoderRealm: 'cn' }), 'https://openapi.qoder.com.cn');
  assert.strictEqual(client.baseFor({ qoderRealm: 'intl' }), 'https://openapi.qoder.sh');
  assert.strictEqual(client.baseFor(null), 'https://openapi.qoder.sh');
  assert.strictEqual(client.gatewayFor({ qoderRealm: 'cn' }), 'https://gateway.qoder.com.cn');
  assert.strictEqual(client.gatewayFor({ qoderRealm: 'intl' }), 'https://api2-v2.qoder.sh');
});

await t('resolvePath：键名与字面路径都可用', () => {
  assert.strictEqual(client.resolvePath('campaigns'), '/sash/api/v1/me/campaigns');
  assert.strictEqual(client.resolvePath('quota'), '/api/v2/quota/usage');
  assert.strictEqual(client.resolvePath('/literal/path'), '/literal/path');
});

await t('fillPath：%s 模板填充', () => {
  assert.strictEqual(client.fillPath('/sash/api/v1/me/campaigns/%s/claim', 'act-1'),
    '/sash/api/v1/me/campaigns/act-1/claim');
  assert.strictEqual(client.fillPath('/a/%s/b/%s', 1, 2), '/a/1/b/2');
});

await t('request：缺 token 直接抛错（不发请求）', async () => {
  await assert.rejects(() => client.request({ method: 'GET', path: 'userinfo', token: '' }), /缺少 Qoder 访问凭据/);
  await assert.rejects(() => client.request({ method: 'GET', path: 'userinfo' }), /缺少 Qoder 访问凭据/);
});

// ---------- chat ----------
console.log('\n[chat]');
const chat = require('../qoder/chat');

await t('CALLABLE_INTL_MODELS：实测可调用集合（2026-10-13）', () => {
  // 目录 18 项中仅这 8 项在 chat 端点返回 200。is_free=true 的 qfmodel
  // 实测 400 invalid_model_error，故不在表内。
  assert.deepStrictEqual(chat.CALLABLE_INTL_MODELS,
    ['auto', 'ultimate', 'performance', 'qmodel', 'kmodel', 'gmodel', 'dmodel', 'mmodel']);
  assert.ok(!chat.CALLABLE_INTL_MODELS.includes('qfmodel'), 'qfmodel 限免但不可调用');
  assert.ok(!chat.CALLABLE_INTL_MODELS.includes('efficient'), 'efficient 实测 429 provider_error');
  assert.ok(!chat.CALLABLE_INTL_MODELS.includes('smodel'), 'smodel 实测 invalid_model_error');
});

await t('isCallableModel：大小写与空值口径', () => {
  assert.strictEqual(chat.isCallableModel('auto'), true);
  assert.strictEqual(chat.isCallableModel('qmodel'), true);
  assert.strictEqual(chat.isCallableModel('qfmodel'), false);
  assert.strictEqual(chat.isCallableModel(''), false);
  assert.strictEqual(chat.isCallableModel(null), false);
  assert.strictEqual(chat.isCallableModel(undefined), false);
  assert.strictEqual(chat.isCallableModel('  qmodel  '), true, '首尾空白需容忍');
});

await t('supportsAccount / blockReason：国内版显式拒绝', () => {
  assert.strictEqual(chat.supportsAccount({ qoderRealm: 'intl', token: 'dt-x' }), true);
  assert.strictEqual(chat.supportsAccount({ qoderRealm: 'cn', token: 'dt-x' }), false,
    '国内版 /model/v1/* 实测 503，不进转发池');
  assert.strictEqual(chat.supportsAccount({ qoderRealm: 'intl' }), false, '无 token 不支持');
  assert.strictEqual(chat.supportsAccount(null), false);
  assert.strictEqual(chat.blockReason(null), '账号不存在');
  assert.ok(chat.blockReason({ qoderRealm: 'cn', token: 'dt-x' }).includes('503'));
  assert.ok(chat.blockReason({ qoderRealm: 'cn', token: 'dt-x' }).includes('COSY'));
  assert.strictEqual(chat.blockReason({ qoderRealm: 'intl' }), '账号缺少访问凭据（token）');
  assert.strictEqual(chat.blockReason({ qoderRealm: 'intl', token: 'dt-x' }), null);
});

await t('chatOnce：不可调用模型与国内版在发请求前就被拒绝（不发上游请求）', async () => {
  const r1 = await chat.chatOnce({ qoderRealm: 'intl', token: 'dt-x' },
    { model: 'qfmodel', messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.code, 'invalid_model_error');
  assert.ok(r1.message.includes('qfmodel'));

  const r2 = await chat.chatOnce({ qoderRealm: 'cn', token: 'dt-x' },
    { model: 'qmodel', messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.message.includes('503'), '国内版拒绝理由须点明 503');

  const r3 = await chat.chatOnce({ qoderRealm: 'intl', token: 'dt-x' },
    { model: '', messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(r3.ok, false);
  assert.strictEqual(r3.code, 'invalid_request_error');
});

await t('normalizeBody：只强制布尔 stream，不改写 tools / tool_choice', () => {
  const tools = [{ type: 'function', function: { name: 'f' } }];
  const out = chat.normalizeBody({
    model: 'qmodel', messages: [], tools, tool_choice: 'auto', temperature: 0.5,
  });
  assert.strictEqual(out.stream, false, '缺省按非流式');
  assert.strictEqual(out.tools, tools, 'tools 原样保留（上游不支持结构化 tool_calls，不掩盖事实）');
  assert.strictEqual(out.tool_choice, 'auto');
  assert.strictEqual(out.temperature, 0.5);
  assert.strictEqual(chat.normalizeBody({ model: 'm', messages: [], stream: true }).stream, true);
  assert.strictEqual(chat.normalizeBody({ model: 'm', messages: [], stream: 'yes' }).stream, false,
    '非布尔真值一律归一为 false（防上游把字符串当流式开关）');
});

await t('resolveFinish：截断优先，tool_calls 兜底（与 dispatch 口径一致）', () => {
  assert.strictEqual(chat.resolveFinish({ lastFinish: 'stop' }), 'stop');
  assert.strictEqual(chat.resolveFinish({ lastFinish: 'length' }), 'length', '截断必须原样');
  assert.strictEqual(chat.resolveFinish({ lastFinish: 'max_tokens' }), 'max_tokens');
  assert.strictEqual(chat.resolveFinish({ lastFinish: 'content_filter' }), 'content_filter');
  assert.strictEqual(chat.resolveFinish({ sawToolCalls: true, lastFinish: 'stop' }), 'tool_calls');
  assert.strictEqual(chat.resolveFinish({ sawToolCalls: true, lastFinish: 'length' }), 'length',
    '截断优先于 tool_calls：参数可能半截，报 tool_calls 会让客户端执行残缺调用');
  assert.strictEqual(chat.resolveFinish({}), 'stop');
  assert.strictEqual(chat.resolveFinish(), 'stop');
});

await t('peekUsage：从 SSE 帧中抽出非空 usage，忽略 null 帧', async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"hi"},"index":0}],"usage":null}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":11,"completion_tokens":86,"total_tokens":97}}',
    'data: [DONE]',
  ].join('\n\n');
  const stream = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(frames)); c.close(); },
  });
  const u = await chat.peekUsage(stream);
  assert.ok(u, '应取到 usage');
  assert.strictEqual(u.prompt_tokens, 11);
  assert.strictEqual(u.completion_tokens, 86);
  assert.strictEqual(u.total_tokens, 97);
});

await t('peekUsage：无 usage 或空流返回 null', async () => {
  const s1 = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}],"usage":null}\n\n'));
      c.close();
    },
  });
  assert.strictEqual(await chat.peekUsage(s1), null);
  assert.strictEqual(await chat.peekUsage(null), null);
  const s2 = new ReadableStream({ start(c) { c.close(); } });
  assert.strictEqual(await chat.peekUsage(s2), null);
});

await t('peekUsage：被切断的帧也能拼回（行缓冲语义）', async () => {
  // 一个 JSON 帧切成两块，模拟上游 chunk 边界与行边界无关
  const s = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tok'));
      c.enqueue(new TextEncoder().encode('ens":3,"completion_tokens":4,"total_tokens":7}}\n\n'));
      c.close();
    },
  });
  const u = await chat.peekUsage(s);
  assert.ok(u, '跨 chunk 的帧必须能拼回');
  assert.strictEqual(u.total_tokens, 7);
});

// ---------- model-access 边界 ----------
console.log('\n[model-access]');
const modelAccess = require('../middleware/model-access');

await t('isQoderOnlyModel：按实测可调用清单判定', () => {
  assert.strictEqual(modelAccess.isQoderOnlyModel('qmodel'), true);
  assert.strictEqual(modelAccess.isQoderOnlyModel('mmodel'), true);
  assert.strictEqual(modelAccess.isQoderOnlyModel('auto'), true);
  assert.strictEqual(modelAccess.isQoderOnlyModel('qfmodel'), false, 'qfmodel 不可调用，不算 Qoder 模型');
  assert.strictEqual(modelAccess.isQoderOnlyModel('glm-5.3'), false, 'Trae 模型不受影响');
  assert.strictEqual(modelAccess.isQoderOnlyModel('wb/glm-5.3'), false, 'WB 模型不是 Qoder 模型');
  assert.strictEqual(modelAccess.isQoderOnlyModel(''), false);
  assert.strictEqual(modelAccess.isQoderOnlyModel(null), false);
});

await t('关键红线：Qoder 模型只能由通用密钥调用（平台密钥越界必须拒绝）', () => {
  // 修的是一个真实越界：trae 平台密钥按旧口径「非 WB 独有模型就放行」，
  // 会把 qmodel 当 Trae 模型放行，等于让 trae 密钥消耗 Qoder 积分。
  const all = { platform: 'all', resources: ['*'], scopes: ['models:invoke'] };
  const trae = { platform: 'trae', resources: ['model:trae/*'], scopes: ['models:invoke'] };
  const wb = { platform: 'workbuddy', resources: ['model:workbuddy/*'], scopes: ['models:invoke'] };

  const r1 = modelAccess.canUseModel('all', 'qmodel', all);
  assert.strictEqual(r1.ok, true, '通用密钥可调 Qoder 模型');

  const r2 = modelAccess.canUseModel('trae', 'qmodel', trae);
  assert.strictEqual(r2.ok, false, 'trae 平台密钥不得调 Qoder 模型');
  assert.strictEqual(r2.reason, 'platform_mismatch');
  assert.ok(r2.message.includes('/v1/qoder/chat/completions'), '拒绝理由须点明正确端点');

  const r3 = modelAccess.canUseModel('workbuddy', 'qmodel', wb);
  assert.strictEqual(r3.ok, false, 'workbuddy 平台密钥同样不得调 Qoder 模型');

  // 回归：Trae / WorkBuddy 的原有边界不能被这次改动破坏
  // （doubao-1-6 是 model-config.json 里的 Trae 模型；glm-5.3 在 WB 静态清单里）
  assert.strictEqual(modelAccess.canUseModel('trae', 'doubao-1-6', trae).ok, true, 'trae 密钥调 Trae 模型仍放行');
  assert.strictEqual(modelAccess.canUseModel('workbuddy', 'glm-5.3', wb).ok, true, 'wb 密钥调 WB 模型仍放行');
  assert.strictEqual(modelAccess.canUseModel('trae', 'wb/glm-5.3', trae).ok, false, 'trae 密钥调 wb/ 前缀仍拒绝');
  assert.strictEqual(modelAccess.canUseModel('trae', 'glm-5.3', trae).ok, false, 'trae 密钥调 WB 独有模型仍拒绝');
  assert.strictEqual(modelAccess.canUseModel('workbuddy', 'glm-5.3', trae).ok, false,
    'trae 密钥不得调 WB 模型（资源 ACL 仍生效）');
});

await t('modelResourcePath：qoder 独立资源前缀', () => {
  const scope = require('../auth/scope');
  assert.strictEqual(scope.modelResourcePath('qmodel', { platform: 'qoder' }), 'model:qoder/qmodel');
  assert.strictEqual(scope.modelResourcePath('glm-5.3', { platform: 'trae' }), 'model:trae/glm-5.3');
  assert.strictEqual(scope.modelResourcePath('glm-5.3', { platform: 'workbuddy' }), 'model:workbuddy/glm-5.3');
  // 通用密钥 resources=['*'] 仍能匹配 qoder 前缀
  assert.strictEqual(scope.resourceMatch('*', 'model:qoder/qmodel'), true);
  assert.strictEqual(scope.resourceMatch('model:trae/*', 'model:qoder/qmodel'), false,
    'trae 资源不得匹配 qoder 资源');
});

// ---------- summary ----------
console.log(`\n=== qoder.test: ${passed} passed, ${failed} failed ===`);
if (failed) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.msg}`);
  process.exitCode = 1;
}
}

main().catch((e) => { console.error('qoder.test 执行失败:', e); process.exitCode = 1; });
