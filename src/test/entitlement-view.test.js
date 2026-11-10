'use strict';
/**
 * src/test/entitlement-view.test.js —— 凭据列表「摘要投影」的契约测试。
 *
 * 背景：凭据页每 60 秒轮询一次 /v1/credentials 与 /v1/credentials/summary，
 * 实测 23 个账号 743 条权益包时单个端点 129 KB、两个合计 258 KB/分钟。
 * 现在列表走 `?slim=1`：每个账号的 packs 换成 packDigest 摘要，完整明细
 * 只在用户点开权益详情时按 GET /v1/credentials/:id 拉取（实测 WB 账号 10 KB）。
 *
 * 本文件钉住四件事，任何一条破了都会在生产上静默出错：
 *
 *   1. **摘要在场且完整 packs 不在**——否则体积没降，「详情按需拉取」也就没意义；
 *   2. **摘要口径与后端 summarizeExpiry 逐账号相等**——这是最容易漂的地方：
 *      自己写一套毫秒除法就会与 FEFO / 临期告警差一天（本项目已踩过）；
 *   3. **详情端点仍返回完整 packs**——摘要态一旦漏了这条，弹窗会永远空；
 *   4. **raccoonPoints 透出到凭据接口**——否则 Raccoon 只有总额，看不到分池，
 *      这正是「权益只显示 Trae 和 WorkBuddy」三个平台缺口里唯一需要后端补的那行。
 *
 * 另外锁定 ZCode 的旧 packs 残留不得被读进积分口径（token 与 credit 不可混算）。
 */
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// 必须在 require 任何项目模块之前隔离状态目录与加密密钥（否则会写真实账号库）
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `trae-entview-${Date.now()}`);
process.env.TRAE_API_ENCRYPT_KEY = 'e'.repeat(64);
process.env.API_KEY = 'entview-test-api-key';
process.env.ADMIN_KEY = 'entview-test-admin-key';
process.env.PORT = String(19000 + (process.pid % 900));
process.env.HOST = '127.0.0.1';
process.env.SCHEDULER_ENABLED = 'false';
require('./isolation-guard')('entitlement-view');

require('../index.js');
const store = require('../credentials/store');
const { summarizeExpiry } = require('../credentials/credits');
const { digestOf, rollupOf } = require('../credentials/entitlement-view');

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
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request(
      `${BASE}${p}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* 保留原文 */ }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** 造一个带权益包的账号（packs 直接写快照，与上游落库形状一致）。 */
function makeAccount(edition, label, snapshot) {
  return store.add(
    {
      label,
      edition,
      mode: 'jwt',
      token: 'h.eyJ1c2VyX2lkIjoiMSJ9.s',
      userId: `entview-${label}`,
      source: 'import',
      enabled: true,
    },
    'test',
  );
}

function setSnapshot(id, snapshot) {
  store.update(id, { entitlementSnapshot: snapshot });
}

/** 秒级时间戳：now + N 天。 */
function inDays(n) {
  return Math.floor((Date.now() + n * 86_400_000) / 1000);
}

async function run() {
  /* ---------- 造数据 ---------- */
  const now = Date.now();

  // Trae：3 个可用包（1/3/10 天后到期）+ 1 个已用尽 + 1 个已过期
  const trae = makeAccount('cn', 'ent-trae', {});
  setSnapshot(trae.id, {
    updatedAt: new Date().toISOString(),
    packs: [
      { name: 'A', expireTime: inDays(1), limit: 100, used: 20, remaining: 80, unlimited: false },
      { name: 'B', expireTime: inDays(3), limit: 200, used: 0, remaining: 200, unlimited: false },
      { name: 'C', expireTime: inDays(10), limit: 500, used: 0, remaining: 500, unlimited: false },
      { name: 'D', expireTime: inDays(5), limit: 100, used: 100, remaining: 0, unlimited: false },
      { name: 'E', expireTime: inDays(-2), limit: 100, used: 0, remaining: 100, unlimited: false },
    ],
  });

  // WorkBuddy：一个不限量包 + 一个可用包
  const wb = makeAccount('workbuddy', 'ent-wb', {});
  setSnapshot(wb.id, {
    updatedAt: new Date().toISOString(),
    packs: [
      { name: 'Unlimited', expireTime: inDays(20), limit: -1, used: 0, remaining: null, unlimited: true },
      { name: 'Metered', expireTime: inDays(8), limit: 300, used: 100, remaining: 200, unlimited: false },
    ],
  });

  // ZCode：token 口径 + 历史遗留的 packs（必须不被计入积分）
  const zcode = makeAccount('zcode', 'ent-zcode', {});
  setSnapshot(zcode.id, {
    updatedAt: new Date().toISOString(),
    // 故意留一条 meter:'model_usage' 的 packs 残留：
    // 任何读到它的实现都会把 1e8 token 当成 1e8 积分
    packs: [{ name: 'GLM', expireTime: inDays(30), limit: 100000000, used: 0, remaining: 100000000, meter: 'model_usage' }],
    tokenBuckets: [{ name: 'GLM-5.3', time: 'x', bucketId: 'b1', limit: 20000000, used: 5000000, remaining: 15000000, expireTime: inDays(15) }],
    tokenRemaining: 15000000,
  });

  // Qoder：两段配额
  const qoder = makeAccount('qoder', 'ent-qoder', {});
  setSnapshot(qoder.id, {
    quota: {
      updatedAt: new Date().toISOString(),
      userType: 'personal_standard',
      base: { total: 0, remaining: 0, used: 0, expiresAt: null },
      addOn: { total: 2700, remaining: 1926, used: 774, expiresAt: null },
      totalRemaining: 1926,
      isQuotaExceeded: false,
    },
  });

  // Raccoon：分池积分
  const raccoon = makeAccount('raccoon', 'ent-raccoon', {});
  setSnapshot(raccoon.id, {
    raccoonPoints: {
      available: 2124,
      packages: [
        { name: '奖励积分', remaining: 1524 },
        { name: '每日积分', remaining: 600 },
      ],
      updatedAt: new Date().toISOString(),
    },
  });

  const ids = [trae, wb, zcode, qoder, raccoon].map((a) => a.id);

  /* ---------- 1) slim 列表：有摘要、无完整 packs ---------- */
  const slim = await req('GET', '/v1/credentials?slim=1', { token: ADMIN });
  check('GET /v1/credentials?slim=1 → 200', slim.status === 200, `-> ${slim.status}`);
  check('响应标记 slim: true', slim.json?.slim === true, JSON.stringify(slim.json?.slim));

  const slimTrae = (slim.json?.data || []).find((a) => a.id === trae.id);
  check(
    'slim 行带 packDigest 摘要',
    !!slimTrae?.packDigest && typeof slimTrae.packDigest.usable === 'number',
    JSON.stringify(slimTrae?.packDigest),
  );
  check(
    'slim 行**不含**完整 packs 数组',
    !Array.isArray(slimTrae?.packs),
    `packs=${JSON.stringify(slimTrae?.packs)?.slice(0, 80)}`,
  );
  check(
    'slim 行不含 devices / fingerprint（详情才需要）',
    slimTrae?.devices === undefined && slimTrae?.fingerprint === undefined,
    `devices=${typeof slimTrae?.devices} fingerprint=${typeof slimTrae?.fingerprint}`,
  );

  /* ---------- 2) 摘要口径与 summarizeExpiry 逐账号相等 ---------- */
  const full = await req('GET', '/v1/credentials', { token: ADMIN });
  const fullById = new Map((full.json?.data || []).map((a) => [a.id, a]));
  let caliberMismatch = '';
  for (const id of ids) {
    const row = fullById.get(id);
    const packs = Array.isArray(row?.packs) ? row.packs : [];
    const d = digestOf(packs, now);
    const exp = summarizeExpiry(packs, now);
    if (Math.abs(d.expiring7d - exp.d7) > 0.011) {
      caliberMismatch += `${id}: digest.d7=${d.expiring7d} summarizeExpiry.d7=${exp.d7}; `;
    }
    const slimRow = (slim.json?.data || []).find((a) => a.id === id);
    // 非积分口径的平台（ZCode）摘要被刻意清零，不能拿它跟 packs 直算结果比
    if (row?.edition === 'zcode') continue;
    if (JSON.stringify(slimRow?.packDigest) !== JSON.stringify(d)) {
      caliberMismatch += `${id}: 接口摘要 ≠ 直接计算; `;
    }
  }
  check(
    '摘要在 7 日内到期金额上与 summarizeExpiry 逐账号相等（同一套日历日判定）',
    caliberMismatch === '',
    caliberMismatch,
  );

  /* ---------- 3) rollup 口径 ---------- */
  const roll = slim.json?.rollup;
  check(
    'slim 响应带跨账号 rollup',
    !!roll && typeof roll.usableAmount === 'number',
    JSON.stringify(roll),
  );
  // Trae 可用 80+200+500=780；WB 可用 200（不限量不计金额）
  check(
    'rollup 只累加积分口径且排除不限量包金额（Trae 780 + WB 200 = 980）',
    roll && Math.abs(roll.usableAmount - 980) < 0.01,
    `usableAmount=${roll?.usableAmount}`,
  );
  check(
    'rollup 不计入 ZCode 的 token（1.5e7）与 Qoder 配额（1926）',
    roll && roll.usableAmount < 100000,
    `usableAmount=${roll?.usableAmount}`,
  );
  check(
    'rollup 的不限量包只计个数不计金额',
    roll && roll.unlimited === 1,
    `unlimited=${roll?.unlimited}`,
  );

  /* ---------- 4) 详情端点仍返回完整 packs ---------- */
  const detail = await req('GET', `/v1/credentials/${encodeURIComponent(trae.id)}`, { token: ADMIN });
  check('GET /v1/credentials/:id → 200', detail.status === 200, `-> ${detail.status}`);
  check(
    '详情端点返回**完整** packs（权益弹窗按需拉取这条路必须通）',
    Array.isArray(detail.json?.packs) && detail.json.packs.length === 5,
    `packs=${detail.json?.packs?.length}`,
  );
  check(
    '详情端点不带 packDigest（与列表语义区分开）',
    detail.json?.packDigest === undefined,
    JSON.stringify(detail.json?.packDigest),
  );

  /* ---------- 5) 四个平台各自的隔离键都透出到凭据接口 ---------- */
  const fullZ = fullById.get(zcode.id);
  const fullQ = fullById.get(qoder.id);
  const fullR = fullById.get(raccoon.id);
  check(
    'ZCode 的 tokenBuckets / tokenRemaining 透出',
    fullZ?.tokenRemaining === 15000000 && Array.isArray(fullZ?.tokenBuckets) && fullZ.tokenBuckets.length === 1,
    JSON.stringify({ t: fullZ?.tokenRemaining, b: fullZ?.tokenBuckets?.length }),
  );
  check(
    'Qoder 的 quota 两段透出',
    fullQ?.quota?.base?.remaining === 0 && fullQ?.quota?.addOn?.remaining === 1926,
    JSON.stringify(fullQ?.quota),
  );
  check(
    'Raccoon 的 raccoonPoints 分池透出（这是本次唯一新增的后端透出字段）',
    fullR?.raccoonPoints?.available === 2124
      && Array.isArray(fullR.raccoonPoints.packages)
      && fullR.raccoonPoints.packages.length === 2,
    JSON.stringify(fullR?.raccoonPoints),
  );

  /* ---------- 6) 体积：slim 必须显著小于完整 ---------- */
  // 5 个账号的样本说明不了体积问题（单个 entitlementSnapshot 的其余字段占比太高）。
  // 这里按生产实测的形态造一批「多包账号」：真实库是 23 个账号、743 条包，
  // 平均每账号 32 条；WorkBuddy 单账号 54~65 条。造 20 个 40 包的账号，
  // 让 packs 的占比与生产同量级，体积比才有意义。
  const bulkIds = [];
  for (let i = 0; i < 20; i += 1) {
    const a = makeAccount('cn', `ent-bulk-${i}`, {});
    const packs = [];
    for (let j = 0; j < 40; j += 1) {
      packs.push({
        name: null,
        packId: `pack-${i}-${j}`,
        expireTime: inDays(10 + (j % 30)),
        limit: 100,
        used: 0,
        remaining: 100,
        unlimited: false,
      });
    }
    setSnapshot(a.id, { updatedAt: new Date().toISOString(), packs });
    bulkIds.push(a.id);
  }

  const fullBulk = await req('GET', '/v1/credentials', { token: ADMIN });
  const slimBulk = await req('GET', '/v1/credentials?slim=1', { token: ADMIN });
  const fullBytes = Buffer.byteLength(fullBulk.text);
  const slimBytes = Buffer.byteLength(slimBulk.text);
  check(
    'slim 响应体积至少比完整响应小 70%（生产实测 129KB → 24.5KB）',
    slimBytes < fullBytes * 0.3,
    `full=${(fullBytes / 1024).toFixed(1)}KB slim=${(slimBytes / 1024).toFixed(1)}KB`,
  );

  /* ---------- 7) summary 端点同语义 ---------- */
  const sum = await req('GET', '/v1/credentials/summary?slim=1', { token: ADMIN });
  check('GET /v1/credentials/summary?slim=1 → 200', sum.status === 200, `-> ${sum.status}`);
  check(
    'summary 也带 slim + rollup，且 accounts 是摘要行',
    sum.json?.slim === true
      && !!sum.json?.rollup
      && Array.isArray(sum.json?.accounts)
      && !Array.isArray(sum.json.accounts.find((a) => a.id === trae.id)?.packs),
    `slim=${sum.json?.slim} rollup=${!!sum.json?.rollup}`,
  );

  /* ---------- 8) ZCode 旧 packs 残留不进积分 ---------- */
  // 该账号的快照里 packs 有一条 1e8 token；积分口径必须完全看不到它
  const zDigest = slim.json?.data?.find((a) => a.id === zcode.id)?.packDigest;
  check(
    'ZCode 行不把残留的 token packs 计入积分摘要',
    !!zDigest && zDigest.usableAmount === 0,
    JSON.stringify(zDigest),
  );
  const zRollAmount = rollupOf(
    (full.json?.data || []).filter((a) => a.edition === 'zcode'),
    now,
  ).usableAmount;
  check(
    'rollup 对 ZCode 账号的积分贡献为 0',
    zRollAmount === 0,
    `zcode rollup=${zRollAmount}`,
  );

  /* ---------- 清理 ---------- */
  for (const id of [...ids, ...bulkIds]) {
    try { store.remove(id); } catch { /* 忽略 */ }
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
}, 300);
