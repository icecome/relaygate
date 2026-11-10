'use strict';
/**
 * src/test/frontend-entitlement.test.js —— 前端跨平台权益归一的契约测试。
 *
 * 为什么要测纯前端：`web/src/shared/lib/entitlement.ts` 是「权益支持多平台」
 * 的唯一落点。改造前它不存在，代码里只有一个 `packsOf()` 读 `account.packs`，
 * 于是 ZCode（tokenBuckets）/ Qoder（quota）/ Raccoon（raccoonPoints）
 * 三个平台在权益列恒为「—」——实测 7/23 有数、到期列 0/23。
 *
 * 这些断言跑在 Node 里（用 esbuild 把 TS 打成一个 CJS 文件再 require），
 * 不依赖浏览器。它们守的是**口径**，不是渲染：
 *
 *   1. 四个平台各自从正确的隔离键取数；
 *   2. ZCode 绝不读残留的 packs（那是 1e8 量级的 token）；
 *   3. Raccoon 单列 points 单位（分池 + 日清，与可累积积分不可相加）；
 *   4. 跨账号累加不出浮点尾巴；
 *   5. 快照陈旧能被识别（> 24h）；
 *   6. 「权益」列文案永不为空 / 不出现并排破折号。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'web', 'src', 'shared', 'lib', 'entitlement.ts');

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

/** 用 esbuild 把 TS 打成 CJS，返回模块。失败时返回 null 并记为失败。 */
function loadEntitlementModule() {
  // 输出到仓库内的 web/node_modules/.cache（该目录必然可写，且被 .gitignore 覆盖）；
  // 不用系统临时目录：本机实测 esbuild 往 %TEMP% 写会 Access denied。
  const outDir = path.join(ROOT, 'web', 'node_modules', '.cache');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `ent-bundle-${process.pid}-${Date.now()}.cjs`);
  try {
    // Windows 上 npx 是 .cmd 批处理，execFileSync 直接调用会 EINVAL，必须走 shell。
    execFileSync(
      `npx esbuild "${SRC}" --bundle --format=cjs --platform=node --outfile="${out}"`,
      { cwd: path.join(ROOT, 'web'), stdio: 'pipe', shell: true },
    );
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(out);
  } catch (e) {
    console.error(`  (esbuild 打包失败：${e.message})`);
    return null;
  } finally {
    try { fs.unlinkSync(out); } catch { /* 忽略 */ }
  }
}

const inDays = (n) => Math.floor((Date.now() + n * 86_400_000) / 1000);
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

/** 造一个账号行（形状与 /v1/credentials?slim=1 的返回一致）。 */
function row(overrides) {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    edition: overrides.edition,
    source: 'import',
    enabled: true,
    ...overrides,
  };
}

function main() {
  const ent = loadEntitlementModule();
  if (!ent) {
    check('能用 esbuild 打包 entitlement.ts（否则本文件全部断言无效）', false, '打包失败');
    return;
  }
  check('能用 esbuild 打包 entitlement.ts', true);

  /* ---------- 1) 四平台各自从正确的隔离键取数 ---------- */
  const trae = row({
    id: 't1', edition: 'cn',
    packCaliber: 'credit',
    packDigest: {
      total: 5, usable: 3, usableAmount: 780, unlimited: 0,
      expiring7d: 280, soonestDays: 1, soonestAmount: 80,
    },
    entitlementSnapshotUpdatedAt: iso(0),
  });
  const wb = row({
    id: 'w1', edition: 'workbuddy',
    packCaliber: 'credit',
    packDigest: {
      total: 2, usable: 2, usableAmount: 200, unlimited: 1,
      expiring7d: 0, soonestDays: 8, soonestAmount: 200,
    },
    entitlementSnapshotUpdatedAt: iso(0),
  });
  const zcode = row({
    id: 'z1', edition: 'zcode',
    packCaliber: 'zcode',
    // 后端对非积分口径返回全零摘要；同时故意塞一条 token 量级的 packs，
    // 任何「读 packs」的实现都会在这里立刻暴露
    packDigest: { total: 0, usable: 0, usableAmount: 0, unlimited: 0, expiring7d: 0, soonestDays: null, soonestAmount: 0 },
    packs: [{ name: 'GLM', expireTime: inDays(30), limit: 100000000, used: 0, remaining: 100000000, meter: 'model_usage' }],
    tokenBuckets: [{ name: 'GLM-5.3', limit: 20000000, used: 5000000, remaining: 15000000, expireTime: inDays(15) }],
    tokenRemaining: 15000000,
    entitlementSnapshotUpdatedAt: iso(0),
  });
  const qoder = row({
    id: 'q1', edition: 'qoder',
    packCaliber: 'qoder',
    packDigest: { total: 0, usable: 0, usableAmount: 0, unlimited: 0, expiring7d: 0, soonestDays: null, soonestAmount: 0 },
    quota: {
      userType: 'personal_standard',
      base: { total: 0, remaining: 0, used: 0, expiresAt: null },
      addOn: { total: 2700, remaining: 1926, used: 774, expiresAt: null },
      totalRemaining: 1926,
    },
    entitlementSnapshotUpdatedAt: iso(0),
  });
  const raccoon = row({
    id: 'r1', edition: 'raccoon',
    packCaliber: 'raccoon',
    packDigest: { total: 0, usable: 0, usableAmount: 0, unlimited: 0, expiring7d: 0, soonestDays: null, soonestAmount: 0 },
    raccoonPoints: {
      available: 2124,
      packages: [{ name: '奖励积分', remaining: 1524 }, { name: '每日积分', remaining: 600 }],
      updatedAt: iso(0),
    },
    balance: 2124,
    entitlementSnapshotUpdatedAt: iso(0),
  });

  const eTrae = ent.entitlementOf(trae);
  const eWb = ent.entitlementOf(wb);
  const eZ = ent.entitlementOf(zcode);
  const eQ = ent.entitlementOf(qoder);
  const eR = ent.entitlementOf(raccoon);

  check('Trae 从 packDigest 取积分', eTrae.unit === 'credit' && eTrae.amount === 780, JSON.stringify(eTrae));
  check('WorkBuddy 从 packDigest 取积分', eWb.unit === 'credit' && eWb.amount === 200, JSON.stringify(eWb));
  check(
    'ZCode 从 tokenBuckets 取 token（不是 packs）',
    eZ.unit === 'token' && eZ.amount === 15000000,
    JSON.stringify({ unit: eZ.unit, amount: eZ.amount }),
  );
  check(
    'ZCode 的 amount 远小于残留 packs 的 1e8（证明没读 packs）',
    eZ.amount != null && eZ.amount < 100000000,
    `amount=${eZ.amount}`,
  );
  check(
    'Qoder 从 quota 取配额，且主读数取非零的那段（base=0 → 报 addOn 1926）',
    eQ.unit === 'quota' && eQ.amount === 1926,
    JSON.stringify({ unit: eQ.unit, amount: eQ.amount, detail: eQ.detailText }),
  );
  check(
    'Raccoon 从 raccoonPoints 取积分',
    eR.amount === 2124,
    JSON.stringify({ amount: eR.amount, detail: eR.detailText }),
  );
  check(
    'Raccoon 单列 points 单位（分池 + 日清，不与可累积积分混算）',
    eR.unit === 'points',
    `unit=${eR.unit}`,
  );
  check(
    'Raccoon 的到期文案是「日清」而不是编造的天数',
    eR.expiryText === '日清' && eR.days == null,
    JSON.stringify({ expiryText: eR.expiryText, days: eR.days }),
  );

  /* ---------- 2) 权益列文案：23 行里不能有破折号并排 / 空串 ---------- */
  const cells = [eTrae, eWb, eZ, eQ, eR].map((e) => ent.entitlementCellText(e));
  check(
    '权益列文案全部非空',
    cells.every((c) => c && c.trim().length > 0),
    JSON.stringify(cells),
  );
  check(
    '权益列不出现「0 Token · —」这类并排破折号',
    cells.every((c) => !/·\s*—\s*$/.test(c) && !/—\s*·/.test(c)),
    JSON.stringify(cells),
  );
  check(
    '额度为 0 的账号权益列读作「额度已用尽」而不是空',
    // 无条件构造 amount=0 的实体：旧写法用三元短路（eZ.amount 已在上文断言
    // 等于 15000000），把实现换成空函数仍会通过，属自证式伪测试。
    (() => {
      const usedUp = ent.entitlementCellText({
        ...eZ, amount: 0, known: true, items: 0, detailText: '额度已用尽',
      });
      return usedUp.includes('已用尽') && usedUp.trim().length > 0;
    })(),
    ent.entitlementCellText(eZ),
  );

  /* ---------- 3) 摘要缺失时按 edition 兜底，且 ZCode 仍不读 packs ---------- */
  const noCaliber = row({
    id: 'z2', edition: 'zcode',
    packs: [{ name: 'GLM', expireTime: inDays(30), limit: 100000000, used: 0, remaining: 100000000 }],
    tokenBuckets: [{ name: 'B', limit: 100, used: 0, remaining: 100, expireTime: inDays(5) }],
    tokenRemaining: 100,
  });
  const eNoCaliber = ent.entitlementOf(noCaliber);
  check(
    '缺 packCaliber 时仍按平台分派到 token 口径（不会误读 packs）',
    eNoCaliber.unit === 'token' && eNoCaliber.amount === 100,
    JSON.stringify({ unit: eNoCaliber.unit, amount: eNoCaliber.amount }),
  );

  /* ---------- 4) 跨账号累加不出浮点尾巴 ---------- */
  const floaty = [
    row({ id: 'f1', edition: 'cn', packCaliber: 'credit', packDigest: { total: 1, usable: 1, usableAmount: 1546.6, unlimited: 0, expiring7d: 0, soonestDays: 5, soonestAmount: 1 } }),
    row({ id: 'f2', edition: 'cn', packCaliber: 'credit', packDigest: { total: 1, usable: 1, usableAmount: 1602.44, unlimited: 0, expiring7d: 0, soonestDays: 5, soonestAmount: 1 } }),
    row({ id: 'f3', edition: 'cn', packCaliber: 'credit', packDigest: { total: 1, usable: 1, usableAmount: 1771.37, unlimited: 0, expiring7d: 0, soonestDays: 5, soonestAmount: 1 } }),
  ];
  const roll = ent.rollupByPlatform(floaty).find((r) => r.platform === 'trae');
  check(
    '跨账号累加结果无浮点尾巴（round2 收口）',
    roll && String(roll.amount) === '4920.41',
    `amount=${roll?.amount}`,
  );

  /* ---------- 5) 快照陈旧识别 ---------- */
  check('快照 20 天前 → stale', ent.isStale(iso(20)) === true, iso(20));
  check('快照刚刚 → 不 stale', ent.isStale(iso(0)) === false, iso(0));
  check('无快照时间 → 不算 stale（由 known 表达）', ent.isStale(null) === false);

  /* ---------- 6) 按平台汇总：每个平台一个 unit，互不合并 ---------- */
  const all = [trae, wb, zcode, qoder, raccoon];
  const rows = ent.rollupByPlatform(all);
  check('汇总覆盖全部 5 个平台', rows.length === 5, rows.map((r) => r.platform).join(','));
  check(
    'Trae 与 WorkBuddy 同为 credit，但不合并成一行',
    rows.filter((r) => r.unit === 'credit').length === 2,
    JSON.stringify(rows.map((r) => [r.platform, r.unit])),
  );
  check(
    'ZCode / Qoder / Raccoon 各自独立 unit',
    rows.find((r) => r.platform === 'zcode')?.unit === 'token'
      && rows.find((r) => r.platform === 'qoder')?.unit === 'quota'
      && rows.find((r) => r.platform === 'raccoon')?.unit === 'points',
    JSON.stringify(rows.map((r) => [r.platform, r.unit])),
  );
  check(
    '汇总里没有任何一行把 token 与 credit 加在一起',
    rows.find((r) => r.platform === 'zcode').unit !== 'credit',
    'zcode 不得出现在 credit 汇总里',
  );

  /* ---------- 7) 没有任何 packDigest / packs 时如实说「未查询」 ---------- */
  const blank = row({ id: 'b1', edition: 'cn', packCaliber: 'credit' });
  const eBlank = ent.entitlementOf(blank);
  check(
    '无数据时 known=false 且文案为「未查询」',
    eBlank.known === false && ent.entitlementCellText(eBlank) === '未查询',
    JSON.stringify({ known: eBlank.known, text: ent.entitlementCellText(eBlank) }),
  );

  /* ---------- 8) 静态约束：源码里 ZCode 分支不得出现 packs 读取 ---------- */
  const src = fs.readFileSync(SRC, 'utf8');
  const zcodeBlock = src.slice(src.indexOf('function tokenSummary'), src.indexOf('function quotaSummary'));
  check(
    'tokenSummary 里不出现对 packs 的读取（只允许出现在注释中说明为什么不能读）',
    !/a\.packs|account\.packs|\bpacks\s*\.map|\bpacks\s*\[/.test(
      zcodeBlock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''),
    ),
    'token 口径分支读了 packs',
  );

  console.log(`\n${pass} passed${fail ? `, ${fail} failed` : ''}`);
  if (fail) process.exit(1);
}

try {
  main();
} catch (e) {
  console.error(`FAIL  用例执行异常: ${e.stack || e.message}`);
  process.exit(1);
}
