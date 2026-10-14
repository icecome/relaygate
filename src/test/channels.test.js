'use strict';
/**
 * src/test/channels.test.js — 渠道接入聚合端点（/v1/admin/channels）测试。
 *
 * 核心不变式（这条是本次修复的靶心）：
 *   **每个渠道都必须声明至少一条接入方式，且前端必须有对应的接入向导。**
 * 否则该渠道的账号永远进不来，而后端接口可能是全就绪的——ZCode 正是如此：
 * `/v1/zcode/local/preview` 与 `/local/import` 一直都在，前端却一个按钮都没有，
 * 且没有任何地方提示过。所以这里不只测「接口返回 200」，而是把
 * 「后端渠道集合 ⟷ 前端向导注册表」的一致性钉成会失败的断言。
 *
 * 其余覆盖：
 *   - 渠道身份与能力位直接来自 variant.js（不复制、不硬编码名单）
 *   - 账号计数与归一口径（历史 edition cn/sg/us/manual/wb* 折回平台）
 *   - connected 用 total 而非 enabled：WorkBuddy 导入后显式停用，
 *     按 enabled 判定会把刚导入完的渠道显示成「待接入」
 *   - 本机客户端未安装时给出可行动的原因（路径），不是空串
 *   - 单平台探测抛错时降级为「不可用 + 原因」，不让一个平台挡住另外三个
 *   - 前端读的一律是可核实的字段，不写死平台名单
 */
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// 必须在 require 任何项目模块之前隔离状态目录与加密密钥（否则会写真实账号库）
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `trae-channels-${Date.now()}`);
process.env.TRAE_API_ENCRYPT_KEY = 'c'.repeat(64);
process.env.API_KEY = 'channels-test-api-key';
process.env.ADMIN_KEY = 'channels-test-admin-key';
process.env.PORT = String(18000 + (process.pid % 1000));
process.env.HOST = '127.0.0.1';
process.env.SCHEDULER_ENABLED = 'false';
require('./isolation-guard')('channels');

// app.listen 在 require 时已发起
require('../index.js');
const variant = require('../platform/variant');
const store = require('../credentials/store');
const zcodeLocal = require('../zcode/local');

const ROOT = path.resolve(__dirname, '..', '..');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const ADMIN = process.env.ADMIN_KEY;

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  ${name}  ${detail || ''}`);
  }
}

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
      res.on('data', (c) => {
        buf += c;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(buf);
        } catch {
          /* 非 JSON 响应保留原文供断言展示 */
        }
        resolve({ status: res.statusCode, json, text: buf });
      });
    });
    r.on('error', (e) => resolve({ status: 0, json: null, text: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

/** 往账号库塞一个账号（走 store.add，与真实导入同一条路）。 */
function addAccount(edition, { enabled = true } = {}) {
  return store.add(
    {
      label: `t-${edition}-${Math.random().toString(36).slice(2, 7)}`,
      edition,
      token: 'x'.repeat(40),
      enabled,
    },
    'import',
  );
}

async function run() {
  // ---------- 鉴权 ----------
  const noAuth = await req('GET', '/v1/admin/channels');
  check('未带管理密钥 → 401', noAuth.status === 401, `-> ${noAuth.status}`);

  const res = await req('GET', '/v1/admin/channels', { token: ADMIN });
  check('带管理密钥 → 200', res.status === 200, `-> ${res.status} ${res.text.slice(0, 120)}`);
  const data = res.json?.data;
  if (!Array.isArray(data)) {
    check('响应含 data 数组', false, `实际：${res.text.slice(0, 200)}`);
    return;
  }
  check('响应含 data 数组', true);

  // ---------- 渠道集合来自 variant，不是硬编码名单 ----------
  const expectedIds = variant.allVariants().map((v) => v.id);
  const actualIds = data.map((c) => c.id);
  check(
    '渠道集合与顺序完全等于 variant.allVariants()（新增平台自动出现）',
    JSON.stringify(actualIds) === JSON.stringify(expectedIds) && actualIds.length === Object.keys(variant.VARIANTS).length,
    `期望 ${expectedIds.join(',')}；实际 ${actualIds.join(',')}`,
  );

  check(
    '渠道 id 无重复',
    new Set(actualIds).size === actualIds.length,
    actualIds.join(','),
  );

  // ---------- 靶心不变式 ----------
  const noOnboarding = data.filter((c) => !Array.isArray(c.onboarding) || c.onboarding.length === 0);
  check(
    '每个渠道都声明了至少一条接入方式（声明为空 = 账号永远进不来）',
    noOnboarding.length === 0,
    `缺接入方式：${noOnboarding.map((c) => c.id).join(',')}`,
  );

  const noNote = data.filter((c) => !c.note || !String(c.note).trim());
  check(
    '每个渠道都有说明文案（卡片不会出现空白描述）',
    noNote.length === 0,
    `缺 note：${noNote.map((c) => c.id).join(',')}`,
  );

  // ---------- 能力位原样透出 ----------
  let capabilityMismatch = '';
  for (const c of data) {
    const v = variant.variantOf(c.id);
    if (JSON.stringify(c.capability) !== JSON.stringify(v.capability)) {
      capabilityMismatch = `${c.id}：接口 ${JSON.stringify(c.capability)} ≠ variant ${JSON.stringify(v.capability)}`;
      break;
    }
  }
  check('能力位与 variant.js 逐键一致（不被复制/改写）', capabilityMismatch === '', capabilityMismatch);

  // ---------- 逐平台接入方式（回归：ZCode 曾完全没有入口） ----------
  const byId = Object.fromEntries(data.map((c) => [c.id, c]));
  const kinds = (id) => (byId[id]?.onboarding || []).map((o) => o.kind).sort();

  check(
    'ZCode 声明的接入方式恰好是 ["local"]（客户端不发放可移植凭据，不能假装支持粘贴）',
    JSON.stringify(kinds('zcode')) === JSON.stringify(['local']),
    `实际 ${JSON.stringify(kinds('zcode'))}`,
  );
  check(
    'Trae 有 oauth + paste 两条路',
    JSON.stringify(kinds('trae')) === JSON.stringify(['oauth', 'paste']),
    `实际 ${JSON.stringify(kinds('trae'))}`,
  );
  check(
    'WorkBuddy 有 local + paste 两条路',
    JSON.stringify(kinds('workbuddy')) === JSON.stringify(['local', 'paste']),
    `实际 ${JSON.stringify(kinds('workbuddy'))}`,
  );
  check('Qoder 有 local（双区域）', JSON.stringify(kinds('qoder')) === JSON.stringify(['local']), `实际 ${JSON.stringify(kinds('qoder'))}`);

  // ---------- 本机探测：可用性 + 可行动的原因 ----------
  for (const c of data) {
    for (const o of c.onboarding) {
      check(
        `[${c.id}/${o.kind}] 带 label 与可行动的 detail（不可用时必须说清装什么）`,
        typeof o.label === 'string' && o.label.length > 0 && typeof o.detail === 'string' && (o.available || o.detail.length > 0),
        JSON.stringify(o),
      );
    }
  }

  // 本机未装 ZCode 客户端时，detail 必须是「找不到哪个文件」而不是空串
  const zLocal = byId.zcode.onboarding.find((o) => o.kind === 'local');
  check(
    'ZCode 本机探测回显凭据文件路径（未安装时用户能据此判断该装在哪）',
    zLocal.detail.includes('.zcode') || zLocal.available === true,
    `detail=${zLocal.detail}`,
  );

  // ---------- 账号计数与归一口径 ----------
  const traeOn = addAccount('trae');
  const traeHistory = addAccount('cn'); // 历史 edition，必须折回 trae
  const wbOff = addAccount('workbuddy', { enabled: false });
  const zcode1 = addAccount('zcode');
  const qoder1 = addAccount('qoder');

  const res2 = await req('GET', '/v1/admin/channels', { token: ADMIN });
  const by2 = Object.fromEntries((res2.json?.data || []).map((c) => [c.id, c]));

  check(
    'Trae 计数含历史 edition（cn/sg/us/manual 全部折回 trae）',
    by2.trae.accounts.total === 2 && by2.trae.accounts.enabled === 2,
    JSON.stringify(by2.trae.accounts),
  );
  check(
    'WorkBuddy 停用账号计入 total 但不计入 enabled',
    by2.workbuddy.accounts.total === 1 && by2.workbuddy.accounts.enabled === 0,
    JSON.stringify(by2.workbuddy.accounts),
  );
  check('ZCode 计数正确', by2.zcode.accounts.total === 1, JSON.stringify(by2.zcode.accounts));
  check('Qoder 计数正确', by2.qoder.accounts.total === 1, JSON.stringify(by2.qoder.accounts));

  const summary = res2.json?.summary;
  const sumTotal = Object.values(by2).reduce((s, c) => s + c.accounts.total, 0);
  const sumEnabled = Object.values(by2).reduce((s, c) => s + c.accounts.enabled, 0);
  check(
    'summary.connected 用 total 而非 enabled（WorkBuddy 刚导入即为停用，也应是「已接入」）',
    summary.connected === 4,
    JSON.stringify(summary),
  );
  check(
    'summary.accounts / enabled 等于各渠道之和',
    summary.accounts === sumTotal && summary.enabled === sumEnabled,
    `summary=${JSON.stringify(summary)}；逐渠道合计 total=${sumTotal} enabled=${sumEnabled}`,
  );

  // 与凭据列表同源：两边账号总数必须一致（否则渠道卡片与列表会各说各话）
  const creds = await req('GET', '/v1/credentials', { token: ADMIN });
  check(
    'summary.accounts 与 /v1/credentials 的账号总数一致（同一数据源）',
    creds.json?.data?.length === summary.accounts,
    `凭据 ${creds.json?.data?.length} vs summary ${summary.accounts}`,
  );

  // ---------- 运营面定时任务快照 ----------
  check(
    'ZCode 带定时任务快照且不含 localClient（本机探测只由 onboarding 给出一次）',
    by2.zcode.jobs && by2.zcode.jobs.localClient === undefined && typeof by2.zcode.jobs.enabled === 'boolean',
    JSON.stringify(by2.zcode.jobs),
  );
  check(
    'Qoder 带定时任务快照且不含 localClient',
    by2.qoder.jobs && by2.qoder.jobs.localClient === undefined && typeof by2.qoder.jobs.enabled === 'boolean',
    JSON.stringify(by2.qoder.jobs),
  );
  check('Trae / WorkBuddy 无运营面任务 → jobs 为 null', by2.trae.jobs === null && by2.workbuddy.jobs === null, `${by2.trae.jobs} / ${by2.workbuddy.jobs}`);

  // ---------- 单平台探测异常必须降级，不能 500 ----------
  const original = zcodeLocal.isClientInstalled;
  zcodeLocal.isClientInstalled = () => {
    throw new Error('模拟探测异常');
  };
  const res3 = await req('GET', '/v1/admin/channels', { token: ADMIN });
  zcodeLocal.isClientInstalled = original;

  check('单平台探测抛错 → 仍返回 200（一个平台不能挡住另外三个）', res3.status === 200, `-> ${res3.status} ${res3.text.slice(0, 120)}`);
  const zO = (res3.json?.data || []).find((c) => c.id === 'zcode')?.onboarding?.find((o) => o.kind === 'local');
  check(
    '探测异常降级为「不可用 + 原因」而不是崩溃或空串',
    zO && zO.available === false && /探测失败/.test(zO.detail),
    JSON.stringify(zO),
  );
  const res3Ids = (res3.json?.data || []).map((c) => c.id);
  check('探测异常时其它渠道照常返回', res3Ids.length === expectedIds.length, res3Ids.join(','));

  // ---------- 前后端注册表一致性（防「加了平台忘了加入口」复发） ----------
  const idsSrc = fs.readFileSync(path.join(ROOT, 'web', 'src', 'shared', 'lib', 'channelIds.ts'), 'utf8');
  const idsMatch = idsSrc.match(/CHANNEL_IDS\s*=\s*\[([^\]]*)\]/);
  check('能从前端 channelIds.ts 提取渠道清单', !!idsMatch, '未匹配到 CHANNEL_IDS 数组字面量');
  const frontIds = idsMatch ? [...idsMatch[1].matchAll(/'([a-z0-9_-]+)'/g)].map((m) => m[1]) : [];

  check(
    '前端渠道注册表与后端渠道集合**双向一致**',
    JSON.stringify([...frontIds].sort()) === JSON.stringify([...expectedIds].sort()),
    `前端 [${frontIds.join(',')}] vs 后端 [${expectedIds.join(',')}]`,
  );

  const entrySrc = fs.readFileSync(path.join(ROOT, 'web', 'src', 'shared', 'lib', 'channels.ts'), 'utf8');
  const wizBlocks = [...entrySrc.matchAll(/wizards:\s*\{([^}]*)\}/g)].map((m) => m[1]);
  check('能从前端 channels.ts 提取 wizards 映射', wizBlocks.length > 0, '未匹配到 wizards 块');
  const frontKinds = new Set();
  for (const b of wizBlocks) for (const k of b.matchAll(/([a-z0-9_]+)\s*:/g)) frontKinds.add(k[1]);

  const missingKinds = [];
  for (const c of data) {
    for (const o of c.onboarding) {
      if (!frontKinds.has(o.kind)) missingKinds.push(`${c.id}/${o.kind}`);
    }
  }
  check(
    '后端声明的每条接入方式在前端都有向导落点（缺一个就会显示「暂无接入向导」）',
    missingKinds.length === 0,
    `缺向导：${missingKinds.join(', ')}`,
  );

  // ---------- token 额度字段在「运营面」与「凭据列表」两处必须同名同值 ----------
  // 运营面表格读的是 /v1/zcode/accounts，凭据列表读的是 /v1/credentials；
  // 同一个「剩余额度」若在两处叫不同的名字/埋在不同的层级，前端就得写两套
  // 读取逻辑，早晚漂移（ZCode 的额度又恰好不能与积分混算，漂了很难发现）。
  store.update(zcode1.id, {
    entitlementSnapshot: {
      tokenRemaining: 12345,
      tokenBuckets: [{ name: '限时包', remaining: 12345, limit: 20000, used: 7655 }],
    },
  });
  const zAccts = await req('GET', '/v1/zcode/accounts', { token: ADMIN });
  const zOne = (zAccts.json?.data || []).find((a) => a.id === zcode1.id);
  check(
    'ZCode 运营面接口把 token 额度摊平到顶层（tokenRemaining / tokenBuckets）',
    zOne?.tokenRemaining === 12345 && zOne?.tokenBuckets?.[0]?.remaining === 12345,
    JSON.stringify(zOne && { tokenRemaining: zOne.tokenRemaining, tokenBuckets: zOne.tokenBuckets }),
  );
  check(
    'ZCode 运营面接口仍原样透出 entitlementSnapshot（既有契约与 docs 都写了它）',
    zOne?.entitlementSnapshot?.tokenRemaining === 12345,
    JSON.stringify(zOne?.entitlementSnapshot),
  );
  const creds2 = await req('GET', '/v1/credentials', { token: ADMIN });
  const cOne = (creds2.json?.data || []).find((a) => a.id === zcode1.id);
  check(
    '两个接口报的 tokenRemaining 同值（否则前端要维护两套读取逻辑）',
    cOne?.tokenRemaining === zOne?.tokenRemaining,
    `credentials=${cOne?.tokenRemaining} vs zcode/accounts=${zOne?.tokenRemaining}`,
  );

  // ---------- 清理 ----------
  for (const a of [traeOn, traeHistory, wbOff, zcode1, qoder1]) {
    try {
      store.remove(a.id);
    } catch {
      /* 清理失败不影响断言结果 */
    }
  }
}

setTimeout(async () => {
  try {
    await run();
  } catch (e) {
    fail += 1;
    console.error(`FAIL  用例执行异常: ${e.stack || e.message}`);
  }
  console.log(`\n${pass} passed${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}, 1200);
