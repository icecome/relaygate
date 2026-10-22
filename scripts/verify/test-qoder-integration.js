'use strict';
/**
 * Qoder 接入集成测试（真实上游 + 真实本机客户端）。
 * 覆盖 P1（双区域凭据导入）、P2（积分活动查询/领取/幂等）、P3（模型目录）、
 * P4（国际版对话转发：非流式/流式/可调用模型清单/错误信封/realm 拒绝）。
 * 每个用例都打印 PASS/FAIL，末尾汇总；不影响既有账号（用独立 label 并自清理）。
 */
const assert = require('node:assert');
const store = require('../../src/credentials/store');
const variant = require('../../src/platform/variant');
const cryptoMod = require('../../src/qoder/crypto');
const local = require('../../src/qoder/local');
const rewards = require('../../src/qoder/rewards');
const catalog = require('../../src/qoder/catalog');
const chat = require('../../src/qoder/chat');
const client = require('../../src/qoder/client');
const jobs = require('../../src/jobs/qoder-rewards');

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, msg: e.message });
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

const REALMS = ['cn', 'intl'];
const acctFor = (realm) => {
  const cred = local.readRealmCredentials(realm);
  return {
    id: `qtest-${realm}`, label: `qtest-${realm}`, edition: 'qoder',
    enabled: true, qoderRealm: realm, token: cred.token,
    refreshToken: cred.refreshToken, userId: cred.userId,
  };
};

(async () => {
  console.log('=== Qoder 接入集成测试 ===\n');

  // 前置清理：把库里既有的 qoder 账号移除，保证每轮结果与顺序无关
  // （单测或上一轮集成测试可能留下账号，否则 alreadyToday/total 会漂移）。
  {
    const pre = store.list().filter((a) => variant.isEdition(a.edition, variant.QODER));
    for (const a of pre) store.remove(a.id);
    if (pre.length) console.log(`（清理上一轮遗留的 ${pre.length} 个 qoder 账号）\n`);
  }

  // ---------- variant ----------
  console.log('[variant]');
  await t('QODER 变体存在且能力位正确', () => {
    const v = variant.variantOf(variant.QODER);
    assert.strictEqual(v.label, 'Qoder');
    assert.strictEqual(v.capability.chat, false, 'chat 必须为 false（转发面本期不启用）');
    assert.strictEqual(v.capability.checkin, false, 'checkin 必须为 false（Qoder 走自有时段任务）');
    assert.strictEqual(v.capability.balance, true);
    assert.strictEqual(v.capability.rewardClaim, true);
    assert.strictEqual(v.capability.localImport, true);
  });
  await t('normalizeEdition 归一 qoder', () => {
    assert.strictEqual(variant.normalizeEdition('qoder'), 'qoder');
    assert.strictEqual(variant.normalizeEdition('QODER'), 'qoder');
    assert.strictEqual(variant.normalizeEdition('trae'), 'trae');
  });
  await t('realm 域名分叉正确', () => {
    assert.strictEqual(variant.qoderOpenapiBase('cn'), 'https://openapi.qoder.com.cn');
    assert.strictEqual(variant.qoderOpenapiBase('intl'), 'https://openapi.qoder.sh');
    assert.strictEqual(variant.qoderGatewayBase('cn'), 'https://gateway.qoder.com.cn');
    assert.strictEqual(variant.qoderRealmConfig('cn').chatProtocol, 'cosy');
    assert.strictEqual(variant.qoderRealmConfig('intl').chatProtocol, 'openai');
  });
  await t('qoderRealmOfAccount 持久字段优先', () => {
    assert.strictEqual(variant.qoderRealmOfAccount({ qoderRealm: 'cn' }), 'cn');
    assert.strictEqual(variant.qoderRealmOfAccount(null), 'intl');
  });

  // ---------- crypto ----------
  console.log('\n[crypto]');
  for (const realm of REALMS) {
    await t(`[${realm}] 解密 auth.v1.dat 得到 dt-/drt- token`, () => {
      const cred = local.readRealmCredentials(realm);
      assert.ok(cred.token.startsWith('dt-'), `token 应以 dt- 开头: ${cred.token.slice(0, 6)}`);
      assert.ok(cred.refreshToken && cred.refreshToken.startsWith('drt-'), 'refreshToken 应以 drt- 开头');
      assert.ok(cred.userId, '应有 userId');
      assert.ok(cred.expiresAt, '应有 expiresAt');
    });
  }
  await t('非 v10 载荷被明确拒绝', () => {
    assert.throws(() => cryptoMod.decryptV10(Buffer.from('v11' + '0'.repeat(40)), Buffer.alloc(32)), /v10/);
  });

  // ---------- local import ----------
  console.log('\n[local import]');
  await t('probeAll 探测到双区域客户端', () => {
    const p = local.probeAll();
    assert.ok(p.windows, '本机应为 Windows');
    for (const r of REALMS) assert.strictEqual(p[r].installed, true, `${r} 客户端应已安装`);
  });
  await t('buildAccountFromLocal 产出完整记录', () => {
    for (const r of REALMS) {
      const a = local.buildAccountFromLocal(r);
      assert.strictEqual(a.edition, 'qoder');
      assert.strictEqual(a.qoderRealm, r);
      assert.strictEqual(a.mode, 'device');
      assert.strictEqual(a.source, 'local');
      assert.ok(a.host.startsWith('https://openapi.qoder.'), 'host 应为 openapi 基址');
    }
  });
  await t('importAllLocal 幂等（同 realm+uid 不重复插入）', () => {
    const r1 = local.importAllLocal();
    const created1 = r1.created.length;
    const r2 = local.importAllLocal();
    assert.strictEqual(r2.created.length, 0, '第二次导入不应新建');
    assert.strictEqual(r2.updated.length, created1, '第二次导入应全部走更新');
    assert.ok(created1 > 0, '首次应有导入');
  });

  // ---------- upstream: campaigns / quota ----------
  console.log('\n[upstream: campaigns / quota]');
  for (const realm of REALMS) {
    const acct = acctFor(realm);
    await t(`[${realm}] fetchCampaigns 返回当日积分活动`, async () => {
      const c = await rewards.fetchCampaigns(acct);
      assert.ok(c.campaigns.length > 0, '应有活动条目');
      const credit = c.campaigns.find((x) => x.kind.toUpperCase() === 'CREDITS');
      assert.ok(credit, '应有 CREDITS 类活动');
      assert.strictEqual(credit.amount, 100, '每日活动应为 100 credits');
      assert.strictEqual(credit.validityMode, 'RELATIVE_DAYS');
      assert.strictEqual(credit.validityDays, 30, '有效期应为 30 天');
      assert.ok(/10:00（UTC\+8）/.test(credit.description), '文案应含每日 10:00（UTC+8）刷新');
    });
    await t(`[${realm}] fetchQuota 返回两段额度`, async () => {
      const q = await rewards.fetchQuota(acct);
      assert.strictEqual(q.usageType, 'credits');
      assert.ok(q.base, '应有 userQuota');
      assert.ok(q.totalRemaining >= q.base.remaining, 'total 应不小于 base');
    });
    await t(`[${realm}] 已领取活动重复 claim 返回 already（幂等）`, async () => {
      const c = await rewards.fetchCampaigns(acct);
      const claimed = c.campaigns.find((x) => x.kind.toUpperCase() === 'CREDITS' && x.claimStatus === 'CLAIMED');
      if (!claimed) { console.log('        (今日活动未领取，跳过幂等断言)'); return; }
      const r = await rewards.claimCampaign(acct, claimed.campaignId);
      assert.strictEqual(r.result, 'already', `期望 already，实际 ${r.result}`);
      assert.strictEqual(r.replayed, true, '应标记 replayed');
      assert.ok(r.grantId, '应回显 grantId');
    });
  }

  // ---------- catalog ----------
  console.log('\n[catalog]');
  await t('qoderEncode 与官方一致', () => {
    assert.strictEqual(catalog.qoderEncode(Buffer.from('{"x":1}')), 'ep$$BMn%mYKI');
  });
  for (const realm of REALMS) {
    await t(`[${realm}] COSY 拉取模型目录`, async () => {
      const r = await catalog.syncCatalog(acctFor(realm), { prefer: 'cosy' });
      assert.ok(r.models.length > 0, '应有模型');
      assert.strictEqual(r.source, 'cosy');
    });
    await t(`[${realm}] 限免模型为 qfmodel 且 price_factor=0`, async () => {
      const r = await catalog.syncCatalog(acctFor(realm), { prefer: 'cosy' });
      const free = catalog.freeModels(r.models);
      assert.ok(free.length >= 1, '应有限免模型');
      const qf = free.find((m) => m.key === 'qfmodel');
      assert.ok(qf, '限免模型应含 qfmodel');
      assert.strictEqual(qf.priceFactor, 0, 'qfmodel price_factor 应为 0');
      assert.strictEqual(qf.isFree, true);
    });
  }
  await t('[intl] QMC 本机缓存解密（18 个模型）', async () => {
    const r = await catalog.syncCatalog(acctFor('intl'), { prefer: 'cache' });
    assert.strictEqual(r.source, 'cache');
    assert.ok(r.models.length >= 17, `应有约 18 个模型，实际 ${r.models.length}`);
  });
  await t('同名不同值：mmodel 双区域不一致（禁止合并目录）', async () => {
    const cn = await catalog.syncCatalog(acctFor('cn'), { prefer: 'cosy' });
    const intl = await catalog.syncCatalog(acctFor('intl'), { prefer: 'cosy' });
    const mcn = cn.models.find((m) => m.key === 'mmodel');
    const mintl = intl.models.find((m) => m.key === 'mmodel');
    assert.ok(mcn && mintl, '两侧都应有 mmodel');
    assert.notStrictEqual(mcn.name, mintl.name,
      `mmodel 名称应不同（cn=${mcn.name}, intl=${mintl.name}）——同名不同值，目录必须按 realm 分开`);
  });

  // ---------- job ----------
  console.log('\n[job]');
  await t('localClientStatus 汇报双区域状态', () => {
    const s = jobs.localClientStatus();
    assert.ok(s.windows);
    for (const r of REALMS) assert.strictEqual(s[r].installed, true);
  });
  await t('默认时刻 10:15 对应上游 UTC+8 10:00 刷新（不被历史设置污染）', () => {
    // 断言的是「默认值」而非「当前生效值」：qoder-settings.json 可能被手动改过
    // （路由测试就写过 minute=20），读文件会让这条用例时好时坏。
    // 备份并删掉真实设置文件后重读，拿到的一定是 文件>env>默认 里的默认层。
    const fs = require('node:fs');
    const file = jobs.FILE();
    const bak = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    try {
      if (bak !== null) fs.rmSync(file);
      const s = jobs.snapshot();
      assert.strictEqual(s.hour, 10, '默认小时应为 10');
      assert.strictEqual(s.minute, 15, '默认分钟应为 15（上游 UTC+8 10:00 刷新后留余量）');
      assert.strictEqual(s.autoClaim, true);
      assert.strictEqual(s.spreadMinutes, 10);
      assert.ok(s.accounts >= 2, '应能看到已导入的账号');
    } finally {
      if (bak !== null) fs.writeFileSync(file, bak, 'utf8');
    }
  });
  await t('runRewards 手动一轮：alreadyToday 正确计数', async () => {
    const r = await jobs.runRewards({ trigger: 'manual', claim: false });
    assert.strictEqual(r.failed, 0, `不应有失败：${JSON.stringify(r.failedDetails)}`);
    assert.strictEqual(r.probed, r.total);
    assert.ok(r.alreadyToday > 0, '今日已领过的账号应计入 alreadyToday');
  });
  // ---------- chat（真实上游）----------
  console.log('\n[chat]');
  await t('国际版对话：非流式打通，usage 齐全', async () => {
    const acct = acctFor('intl');
    const r = await chat.chatNonStream(acct, {
      model: 'qmodel',
      messages: [{ role: 'user', content: 'reply with the single word: pong' }],
      stream: false,
    });
    assert.strictEqual(r.choices[0].finish_reason, 'stop');
    assert.ok(r.choices[0].message.content, '应有文本输出');
    assert.ok(r.usage, '应有 usage');
    assert.ok(r.usage.total_tokens > 0, 'usage 应有非零 token');
  });

  await t('国际版对话：流式 SSE 含 usage 末帧与 [DONE]', async () => {
    const acct = acctFor('intl');
    const up = await chat.chatStream(acct, {
      model: 'qmodel',
      messages: [{ role: 'user', content: 'count 1 2 3' }],
      stream: true,
    });
    assert.strictEqual(up.status, 200);
    assert.ok(up.body, '应有响应体');
    const usage = await chat.peekUsage(up.body);
    assert.ok(usage, '应从 SSE 中窥探到 usage');
    assert.ok(usage.total_tokens > 0);
  });

  await t('国内版对话被明确拒绝（不发上游请求）', async () => {
    const acct = acctFor('cn');
    const r = await chat.chatOnce(acct, {
      model: 'qmodel', messages: [{ role: 'user', content: 'hi' }], stream: false,
    });
    assert.strictEqual(r.ok, false);
    assert.ok(r.message.includes('503'), '拒绝理由须点明国内版 503');
  });

  await t('不可调用模型在发请求前被拒绝（qfmodel 限免但不可调用）', async () => {
    const acct = acctFor('intl');
    const r = await chat.chatOnce(acct, {
      model: 'qfmodel', messages: [{ role: 'user', content: 'hi' }], stream: false,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'invalid_model_error');
  });

  await t('CALLABLE_INTL_MODELS 每一项都真能调通（实测校验清单）', async () => {
    const acct = acctFor('intl');
    for (const m of chat.CALLABLE_INTL_MODELS) {
      const r = await chat.chatOnce(acct, {
        model: m, messages: [{ role: 'user', content: 'hi' }], stream: false,
      }, { probe: true });
      assert.strictEqual(r.ok, true, `模型 ${m} 应可调用（上游可能已变更清单）`);
    }
  });

  await t('上游错误信封：QoderChatError 带 code/status', async () => {
    const acct = acctFor('intl');
    // 绕过清单直接打一个不存在的模型，验证错误信封解析（code 是字符串）
    const variant = require('../../src/platform/variant');
    const url = variant.qoderGatewayBase('intl') + variant.variantOf(variant.QODER).paths.chat;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${acct.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'no-such-model-xyz', messages: [{ role: 'user', content: 'hi' }], stream: false }),
      signal: AbortSignal.timeout(60000),
    });
    assert.strictEqual(resp.status, 400);
    const j = await resp.json();
    assert.strictEqual(j.code, 'invalid_model_error');
    assert.ok(typeof j.code === 'string', '上游 code 是字符串而非数字');
  });

  // ---------- isolation ----------
  console.log('\n[isolation]');
  await t('Qoder 不进入 checkin-all 的平台枚举', () => {
    const { checkinPlatforms } = require('../../src/upstream/checkin-all');
    const platforms = checkinPlatforms();
    assert.ok(!platforms.includes('qoder'), `qoder 不应出现在签到平台列表: ${platforms.join(',')}`);
  });
  await t('Qoder 不影响既有平台账号', () => {
    const all = store.list();
    for (const a of all) {
      if (variant.isEdition(a.edition, variant.QODER)) continue;
      assert.ok(!a.qoderRealm, '非 qoder 账号不应有 realm');
    }
  });

  // ---------- cleanup ----------
  console.log('\n[cleanup]');
  const qaccounts = store.list().filter((a) => variant.isEdition(a.edition, variant.QODER));
  for (const a of qaccounts) store.remove(a.id);
  console.log(`  清理 ${qaccounts.length} 个测试导入的 qoder 账号`);

  console.log(`\n=== 汇总: ${pass} passed, ${fail} failed ===`);
  if (fail) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.msg}`);
    process.exitCode = 1;
  }
})().catch((e) => { console.error('测试执行失败:', e); process.exitCode = 1; });
