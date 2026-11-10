'use strict';
/**
 * test/wb-oauth-transfer.test.js —— WorkBuddy 无感登录 + 账号加密导出/导入。
 * 运行：node src/test/wb-oauth-transfer.test.js
 *
 * 覆盖两条新能力（对标 WorkDaddy）：
 *   1. credentials/transfer.js：v3 信封往返、错密码拒绝、坏 uid 跳过、
 *      空密码/超长密码拒绝（不碰真实加密密钥，WORKSPACE_DIR 指向临时目录）；
 *   2. workbuddy/oauth.js：会话状态机（startLogin → poll 未授权 → poll 授权完成 →
 *      cancel/超时），用注入的上游 fetch stub 驱动，不请求真实上游。
 */
const os = require('os');
const path = require('path');

process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `rg-transfer-${Date.now()}`);
process.env.TRAE_API_ENCRYPT_KEY = 'b'.repeat(64);
process.env.LOGS_DIR = path.join(process.env.WORKSPACE_DIR, 'logs');
require('./isolation-guard')('wb-oauth-transfer');

const assert = require('assert');
const crypto = require('crypto');
const transfer = require('../credentials/transfer');
const store = require('../credentials/store');

let pass = 0;
let fail = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }

/* ---------- transfer.js：信封与校验 ---------- */

t('密码规则：空/超长密码必须被拒绝', () => {
  assert.throws(() => transfer.requiredPassword(''), /密码不能为空/);
  assert.throws(() => transfer.requiredPassword('   '), /密码不能为空/);
  assert.throws(() => transfer.requiredPassword('x'.repeat(1025)), /1024/);
  assert.doesNotThrow(() => transfer.requiredPassword('a'.repeat(1024)));
});

t('buildExport：无账号时报错而不是导出空文件', () => {
  assert.throws(() => transfer.buildExport('pw-123'), /没有可导出的账号/);
});

t('导出往返：token 明文可被信封恢复，且不会出现在信封明文里', () => {
  store.add({
    label: 'wb-acct-a', edition: 'workbuddy',
    token: 'tok-A-' + crypto.randomBytes(8).toString('hex'),
    refreshToken: 'ref-A-' + crypto.randomBytes(8).toString('hex'),
    userId: 'uid-transfer-a', host: 'https://copilot.tencent.com',
  }, 'workbuddy');
  store.add({
    label: 'trae-acct-b', edition: 'cn',
    token: 'tok-B', refreshToken: 'ref-B', userId: 'uid-transfer-b',
  }, 'import');

  const r = transfer.buildExport('Secret-pass-9');
  assert.strictEqual(r.count, 2, '两个账号都应导出');
  assert.ok(r.filename.startsWith('RelayGate-账号导出-'), '文件名带日期');
  assert.ok(!r.content.includes('tok-A-'), '明文 token 不能出现在信封 JSON 里');
  assert.ok(!r.content.includes('ref-A-'), '明文 refreshToken 不能出现在信封 JSON 里');

  // 信封字段（对标 WorkDaddy v3：rgExport/version/exportType/kdf/compression/salt/data）
  const env = JSON.parse(r.content);
  assert.strictEqual(env.rgExport, 'RelayGate');
  assert.strictEqual(env.version, 3);
  assert.strictEqual(env.exportType, 'relaygate-accounts');
  assert.strictEqual(env.kdf, 'aes-256-gcm+scrypt');
  assert.strictEqual(env.compression, 'gzip');
  assert.ok(Buffer.from(env.salt, 'base64').length === 16, 'salt 必须 16 字节');
});

t('错密码导入必须失败且不改库', () => {
  const before = store.list().length;
  const r = transfer.buildExport('Right-pass-1');
  assert.throws(() => transfer.importAccounts(r.content, 'Wrong-pass-1'), /密码错误/);
  assert.strictEqual(store.list().length, before, '导入失败不得改动账号表');
});

t('正确密码导入：同 uid 更新、非库内 uid 新建、新账号默认停用', () => {
  const r = transfer.buildExport('Right-pass-1');
  const out = transfer.importAccounts(r.content, 'Right-pass-1');
  assert.strictEqual(out.total, 2);
  assert.strictEqual(out.skipped, 0);
  // 两个 uid 都已在库（上一步 add 过）→ 全部是 updated，无新建
  assert.strictEqual(out.updated.length, 2);
  assert.strictEqual(out.imported.length, 0);

  // 更新后的账号仍是停用态且凭据保持原值（导入不覆盖 enabled）
  const a = store.list().find((x) => x.userId === 'uid-transfer-a');
  assert.ok(a, 'uid-transfer-a 应存在');
  assert.strictEqual(a.enabled, false, '导入账号必须默认停用');
  const full = store.get(a.id);
  assert.ok(full.token && full.token.startsWith('tok-A-'), 'token 应保持原值');
  assert.ok(full.refreshToken && full.refreshToken.startsWith('ref-A-'));
});

t('uid 形态闸：路径分隔符 / 空串 / 特殊目录名一律跳过', () => {
  const payload = {
    exportType: 'RelayGate-relaygate-accounts', version: 3,
    accounts: [
      { userId: '../evil', token: 'x' },
      { userId: '', token: 'x' },
      { userId: 'a/b', token: 'x' },
      { userId: '..', token: 'x' },
      { userId: 'uid-fine-7', token: 'tok-fine' },
    ],
  };
  const content = transfer.createEncryptedExport(transfer.EXPORT_KIND, payload, 'pass');
  const out = transfer.importAccounts(content, 'pass');
  assert.strictEqual(out.skipped, 4, '四条非法 uid 都要被跳过');
  assert.strictEqual(out.imported.length, 1, '合法 uid 建库');
  const fine = store.list().find((x) => x.userId === 'uid-fine-7');
  assert.ok(fine, '合法 uid 应入库');
});

t('坏信封：非 JSON / 非 RelayGate 信封 / 版本不符 各自报可读错误', () => {
  assert.throws(() => transfer.importAccounts('not-json', 'pass'), /不是有效的导出 JSON/);
  assert.throws(() => transfer.importAccounts('{"wbsExport":"WorkDaddy"}', 'pass'), /不是 RelayGate 的账号导出文件/);
  const r = transfer.buildExport('Right-pass-1');
  const tampered = JSON.parse(r.content);
  tampered.version = 99;
  assert.throws(
    () => transfer.importAccounts(JSON.stringify(tampered), 'Right-pass-1'),
    /版本不受支持/,
  );
});

t('信封被篡改（data 改一字节）：GCM 认证失败 → 密码错误或损坏', () => {
  const r = transfer.buildExport('Right-pass-1');
  const env = JSON.parse(r.content);
  const buf = Buffer.from(env.data, 'base64');
  buf[buf.length - 1] ^= 0xff; // 翻转最后一字节
  env.data = buf.toString('base64');
  assert.throws(
    () => transfer.importAccounts(JSON.stringify(env), 'Right-pass-1'),
    /密码错误或导出文件已损坏/,
  );
});

t('uids 选择性导出：不在名单里的账号不出现在信封里', () => {
  const only = store.list().find((x) => x.userId === 'uid-transfer-b');
  const r = transfer.buildExport('Sel-pass-1', [only.id]);
  assert.strictEqual(r.count, 1, '只导选中的账号');
  const out = transfer.importAccounts(r.content, 'Sel-pass-1');
  assert.strictEqual(out.total, 1);
  assert.strictEqual(out.updated.length, 1);
});

/* ---------- workbuddy/oauth.js：状态机（stub fetch，不打上游） ---------- */

/**
 * 上游 stub：三段端点固定脚本。
 *   auth/state   → {code:0, data:{state, authUrl}}
 *   auth/token   → pending（code:-1）两次后发放 accessToken
 *   login/account→ {code:0, data:{uid, nickname, phoneNumber}}
 */
function stubUpstream({ stateValue = 'upstream-state-xyz', pendingPolls = 0 } = {}) {
  let pollCount = 0;
  return async (url) => {
    if (url.includes('/v2/plugin/auth/state')) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ code: 0, data: { state: stateValue, authUrl: 'https://www.codebuddy.cn/login/started?x=1' } }),
      };
    }
    if (url.includes('/v2/plugin/auth/token')) {
      pollCount += 1;
      if (pollCount <= pendingPolls) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: -1 }) };
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ code: 0, data: { accessToken: 'oauth-tok-1', refreshToken: 'oauth-ref-1', expiresIn: 3600, domain: 'https://www.codebuddy.cn' } }),
      };
    }
    if (url.includes('/v2/plugin/login/account')) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ code: 0, data: { uid: 'uid-wb-oauth-1', nickname: '无感登录测试号', phoneNumber: '13800000000' } }),
      };
    }
    throw new Error('unexpected url: ' + url);
  };
}

async function withStubbedFetch(stub, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

t('无感登录：start → 未授权 poll(done:false) → 授权后 poll(done:true) 落库', async () => {
  const wbOauth = require('../workbuddy/oauth');
  const base = store.list().length;

  const r = await withStubbedFetch(stubUpstream({ pendingPolls: 2 }), async () => {
    const start = await wbOauth.startLogin('cn');
    assert.ok(start.loginId, '应返回 loginId');
    assert.ok(start.verificationUri.includes('codebuddy.cn'), '国内版授权页应在 codebuddy.cn');
    assert.ok(start.state, '应带上上游 state');

    const p1 = await wbOauth.poll(start.loginId);
    assert.strictEqual(p1.done, false, '第一次 poll：上游还没授权完成');
    const p2 = await wbOauth.poll(start.loginId);
    assert.strictEqual(p2.done, false, '第二次 poll：上游还没授权完成');
    const p3 = await wbOauth.poll(start.loginId);
    assert.strictEqual(p3.done, true, '第三次 poll：已授权');
    assert.ok(p3.result, '应带入库结果');
    assert.strictEqual(p3.result.action, 'created');
    assert.strictEqual(p3.result.uid, 'uid-wb-oauth-1');
    return { start, p3 };
  });

  // 库里多了一个 workbuddy 账号；token 已密文存储且可解回
  const after = store.list();
  assert.strictEqual(after.length, base + 1, '应新建一个账号');
  const acct = after.find((a) => a.userId === 'uid-wb-oauth-1');
  assert.ok(acct, 'uid-wb-oauth-1 应落库');
  assert.strictEqual(acct.edition, 'workbuddy');
  assert.strictEqual(acct.enabled, false, '无感登录的新账号默认停用');
  const full = store.get(acct.id);
  assert.strictEqual(full.token, 'oauth-tok-1');
  assert.strictEqual(full.refreshToken, 'oauth-ref-1');

  // 会话消费后：再 poll 返回缓存结果；cancel 幂等
  const again = await wbOauth.poll(r.start.loginId);
  assert.strictEqual(again.done, true, '完成后的 poll 应返回完成态');
  assert.ok(wbOauth.cancel(r.start.loginId));
  assert.strictEqual(wbOauth.pendingCount(), 0, 'cancel 后无在途会话');
});

t('无感登录重复授权同一 uid：第二次走 updated 而不是再建新账号', async () => {
  const wbOauth = require('../workbuddy/oauth');
  const base = store.list().length;
  await withStubbedFetch(stubUpstream({}), async () => {
    const s1 = await wbOauth.startLogin('cn');
    const p1 = await wbOauth.poll(s1.loginId);
    assert.ok(p1.result, '第一次授权应成功入库');
  });
  assert.strictEqual(store.list().length, base, '第一次授权在该测试内不应改变账号总数（uid 已在上一用例入库）');
  await withStubbedFetch(stubUpstream({}), async () => {
    const s2 = await wbOauth.startLogin('cn');
    const p2 = await wbOauth.poll(s2.loginId);
    assert.strictEqual(p2.result.action, 'updated', '同 uid 应更新既有账号');
    assert.strictEqual(store.list().length, base, '重复授权不新增账号');
  });
});

t('auth/token 网络抖动：poll 返回 done:false + transient，不推进状态', async () => {
  const wbOauth = require('../workbuddy/oauth');
  // state 成功、token 第一次网络失败、第二次成功、account 成功
  let tokenCalls = 0;
  const mixed = async (url) => {
    if (url.includes('/auth/state')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { state: 'st' } }) };
    }
    tokenCalls += 1;
    if (tokenCalls === 1) throw new Error('ECONNRESET');
    if (url.includes('/auth/token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { accessToken: 'oauth-tok-2', refreshToken: 'oauth-ref-2', expiresIn: 3600 } }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { uid: 'uid-wb-oauth-2', nickname: '二号' } }) };
  };
  await withStubbedFetch(mixed, async () => {
    const s = await wbOauth.startLogin('cn');
    const p1 = await wbOauth.poll(s.loginId);
    assert.strictEqual(p1.done, false, '抖动那次不算完成');
    assert.strictEqual(p1.transient, true, '抖动要标记 transient');
    const p2 = await wbOauth.poll(s.loginId);
    assert.strictEqual(p2.done, true, '重试后完成');
    assert.ok(p2.result, '重试后应入库');
  });
});

t('登录超时：会话过期后 poll 返回超时错误，不再请求上游', async () => {
  const wbOauth = require('../workbuddy/oauth');
  let hit = 0;
  const stub = async () => {
    hit += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { state: 'st' } }) };
  };
  const prev = process.env.WB_OAUTH_TIMEOUT_SECONDS;
  process.env.WB_OAUTH_TIMEOUT_SECONDS = '-1'; // 让会话立即过期
  try {
    await withStubbedFetch(stub, async () => {
      const s = await wbOauth.startLogin('cn');
      const peek = wbOauth.peekSession(s.loginId);
      assert.ok(peek, '会话应存在');
      assert.ok(peek.expiresAt <= Date.now(), '会话应已过期');
      const hitsBefore = hit;
      const p = await wbOauth.poll(s.loginId);
      assert.strictEqual(p.done, true);
      assert.ok(/超时/.test(p.error || ''), '应报超时');
      assert.strictEqual(hit, hitsBefore, '过期后不得再打上游');
    });
  } finally {
    if (prev === undefined) delete process.env.WB_OAUTH_TIMEOUT_SECONDS;
    else process.env.WB_OAUTH_TIMEOUT_SECONDS = prev;
  }
});

/* ---------- 回归：2026-11-06 审查发现的三处功能缺陷 ---------- */

t('[M-R1] 同 uid 重新授权不得停用正在服务的账号（existing 保留 enabled）', async () => {
  const wbOauth = require('../workbuddy/oauth');
  // 造一个「已启用、正在服务流量」的账号
  const live = store.add({
    label: 'serving', edition: 'workbuddy', token: 'tok-old', refreshToken: 'ref-old',
    userId: 'uid-serve-live', host: 'https://copilot.tencent.com', enabled: true,
  }, 'workbuddy');
  assert.strictEqual(store.get(live.id).enabled, true, '前置条件：账号应为启用态');

  const r = wbOauth._importAccount(
    { accessToken: 'tok-new', refreshToken: 'ref-new', expiresIn: 3600 },
    { uid: 'uid-serve-live', nickname: 'serving' },
    'cn',
  );
  assert.strictEqual(r.action, 'updated');
  assert.strictEqual(r.enabled, true, '返回值应如实反映仍是启用态');
  const after = store.get(live.id);
  assert.strictEqual(after.enabled, true, '重新授权后必须保持启用（此前会被静默停用）');
  assert.strictEqual(after.token, 'tok-new', '凭据仍应更新为新授权的值');

  // 新建账号仍默认停用
  const created = wbOauth._importAccount(
    { accessToken: 'tok-fresh', refreshToken: 'ref-fresh', expiresIn: 3600 },
    { uid: 'uid-serve-new', nickname: 'newcomer' },
    'cn',
  );
  assert.strictEqual(created.action, 'created');
  assert.strictEqual(store.get(created.id).enabled, false, '新建账号默认停用');
});

t('[C-01] region 枚举必须经 validRegion：global 落到 workbuddy-ai / www.workbuddy.ai', () => {
  const wbAuth = require('../workbuddy/auth');
  const wbOauth = require('../workbuddy/oauth');
  // 根因回归：regionOf 是「域名推导」，会把枚举 'global' 判成 cn
  assert.strictEqual(wbAuth.regionOf('global'), 'cn', '前置：regionOf 不适合处理枚举输入');
  // 修复后路由用的是 validRegion
  assert.strictEqual(wbAuth.validRegion('global'), 'global');
  assert.strictEqual(wbAuth.validRegion('cn'), 'cn');
  assert.strictEqual(wbAuth.validRegion(undefined), 'cn', '缺省归国内版');
  assert.strictEqual(wbAuth.validRegion('intl'), 'cn', '未知值归国内版（不猜）');
  // 平台与 base 必须随之分流
  assert.strictEqual(wbOauth.platformOfRegion('global'), 'workbuddy-ai');
  assert.strictEqual(wbOauth.platformOfRegion('cn'), 'workbuddy');
  assert.ok(wbOauth.authBaseOfRegion('global').includes('workbuddy.ai'), '国际版 base 应是 workbuddy.ai');
  assert.ok(wbOauth.authBaseOfRegion('cn').includes('codebuddy.cn'), '国内版 base 应是 codebuddy.cn');
});

t('[m-04] 密码下限与前端一致：< 4 字符必须拒绝，且是结构化 TransferInputError', () => {
  transfer.requiredPassword('abcd'); // 4 字符应通过
  assert.throws(() => transfer.requiredPassword('abc'), (e) => {
    assert.ok(e instanceof transfer.TransferInputError, '应是 TransferInputError');
    assert.strictEqual(e.status, 400, '应带 status=400 供路由直接使用');
    assert.strictEqual(e.code, 'TRANSFER_INPUT_INVALID');
    return /至少 4/.test(e.message);
  });
  // 上限仍生效
  assert.throws(() => transfer.requiredPassword('x'.repeat(1025)), /1024/);
});

t('[m-03] 所有用户输入类错误都带 status=400（不靠消息文本分类）', () => {
  // 导出：不存在的 uids 形态
  assert.throws(() => transfer.buildExport('abcd', 'not-an-array'), (e) => e.status === 400);
  assert.throws(() => transfer.buildExport('abcd', []), (e) => e.status === 400);
  // 导入：坏 JSON / 非 RelayGate 信封 / 版本不符 / 错密码
  assert.throws(() => transfer.importAccounts('not-json', 'abcd'), (e) => e.status === 400 && /JSON/.test(e.message));
  assert.throws(() => transfer.importAccounts('{"wbsExport":"WorkDaddy"}', 'abcd'), (e) => e.status === 400);
  const good = (() => {
    store.add({ label: 'struct-err', edition: 'workbuddy', token: 't', refreshToken: 'r', userId: 'uid-struct-err' }, 'workbuddy');
    return transfer.buildExport('abcd');
  })();
  const tampered = JSON.parse(good.content);
  tampered.version = 99;
  assert.throws(() => transfer.importAccounts(JSON.stringify(tampered), 'abcd'), (e) => e.status === 400 && /版本/.test(e.message));
  assert.throws(() => transfer.importAccounts(good.content, 'wrong'), (e) => e.status === 400);
});

t('[P0-2] 导入新建账号保留原始 source，不得一律写成 workbuddy', () => {
  // 根因：store.add(cred, source) 的第二个参数优先级高于 cred.source
  // （source || cred.source || 'import'）。此前 transfer 固定传 'workbuddy'，
  // 于是 Trae / ZCode / Qoder 的新建账号全被标成 workbuddy，而更新分支
  // （store.update）保留 row.source —— 同一操作两条路径两种结果。
  const traeAcct = store.add({
    label: 'trae-exported', edition: 'cn',
    token: 'tok-trae-x', refreshToken: 'ref-trae-x', userId: 'uid-src-trae',
    source: 'import',
  }, 'import');
  const qoderAcct = store.add({
    label: 'qoder-exported', edition: 'qoder', qoderRealm: 'intl',
    token: 'tok-qoder-x', refreshToken: 'ref-qoder-x', userId: 'uid-src-qoder',
    source: 'manual',
  }, 'manual');

  // 只导出这两个账号（uids 传账号 id）
  const r = transfer.buildExport('Source-pass-1', [traeAcct.id, qoderAcct.id]);
  assert.strictEqual(r.count, 2, '只应导出选中的两个账号');

  const out = transfer.importAccounts(r.content, 'Source-pass-1');
  assert.strictEqual(out.updated.length, 2, '两个 uid 已在库 → 全部更新');
  assert.strictEqual(out.imported.length, 0, '不应新建');

  // 更新分支本来就保留 source，这里重点验证它没被写坏
  assert.strictEqual(store.list().find((a) => a.userId === 'uid-src-trae').source, 'import');
  assert.strictEqual(store.list().find((a) => a.userId === 'uid-src-qoder').source, 'manual');

  // 新建分支：先移除这两个账号，再走 export→import
  store.remove(traeAcct.id);
  store.remove(qoderAcct.id);
  const out2 = transfer.importAccounts(r.content, 'Source-pass-1');
  assert.strictEqual(out2.imported.length, 2, '两个账号都应新建');
  const trae = store.list().find((a) => a.userId === 'uid-src-trae');
  const qoder = store.list().find((a) => a.userId === 'uid-src-qoder');
  assert.strictEqual(trae.source, 'import', 'Trae 账号的 source 必须保持 import');
  assert.strictEqual(qoder.source, 'manual', 'Qoder 账号的 source 必须保持 manual');
  assert.strictEqual(trae.edition, 'cn', 'edition 不被改写');
  assert.strictEqual(qoder.edition, 'qoder', 'edition 不被改写');
});

t('无感登录去重按 edition 收口：同 uid 的其它平台账号不得被改写', () => {
  const wbOauth = require('../workbuddy/oauth');
  // 造一个 userId 与 WB oauth stub 完全相同、但属于 Trae 的账号
  const COLLIDE_UID = 'uid-edition-collision-1';
  const other = store.add({
    label: 'trae-same-uid', edition: 'cn', source: 'manual',
    token: 'trae-original-token', refreshToken: null,
    userId: COLLIDE_UID, enabled: true,
  }, 'cn');
  try {
    const r = wbOauth._importAccount(
      { accessToken: 'wb-oauth-token', refreshToken: 'wb-oauth-refresh' },
      { uid: COLLIDE_UID, nickname: '无感登录测试号' },
      'cn',
    );
    assert.strictEqual(r.action, 'created', 'edition 不同必须新建，不能命中 existing');
    const untouched = store.get(other.id);
    assert.strictEqual(untouched.edition, 'cn', 'Trae 账号的 edition 不得被改写');
    assert.strictEqual(untouched.token, 'trae-original-token', 'Trae 账号的 token 不得被覆盖');
    const created = store.get(r.id);
    assert.strictEqual(created.edition, 'workbuddy', '新建账号才是 workbuddy');
    store.remove(created.id);
  } finally {
    store.remove(other.id);
  }
});

// 汇总

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
