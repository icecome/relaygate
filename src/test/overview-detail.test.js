'use strict';
/**
 * src/test/overview-detail.test.js —— 总览页三个展开指标的口径契约。
 *
 * 需求（2026-11-09）：可用额度 / 今日消耗 / 到期积分三个数字都能点开展示构成。
 * 实现落在 `web/src/shared/lib/overview-detail.ts`，本文件钉住它的口径。
 *
 * 三条最容易错、错了又最难发现的：
 *
 *   1. **不可加的额度不能相加**。Trae / WorkBuddy 是积分，ZCode 是 Token，
 *      Qoder 是配额，Raccoon 是分池日清积分。「可用额度」的合计只能含前两者，
 *      把另外三类并进去会得到一个没有意义的数（这正是 ZCode 那一亿 token
 *      曾被算进积分、把今日消耗抬高 4 个数量级的同一个坑）。
 *
 *   2. **没有数据的平台不能显示 0**。ZCode / Qoder / Raccoon 不写 credit_history，
 *      所以「今日消耗」必须标 `notTracked`（界面显示「未纳入统计」），
 *      而不是 0 —— 0 会让人以为「今天没用过」。
 *
 *   3. **到期只算还会造成损失的额度**。已用尽的包（remaining=0）过期不损失任何
 *      积分，不能计入；Raccoon 的每日积分次日清零，根本没有「N 天后到期」。
 *
 * 用 esbuild 把 TS 打包后在 Node 里跑，不依赖浏览器。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'web', 'src', 'shared', 'lib', 'overview-detail.ts');

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

function loadModule() {
  // 输出到 web/node_modules/.cache（必然可写，且被 .gitignore 覆盖）；
  // 系统临时目录在本机实测会被 esbuild 拒绝写入
  const outDir = path.join(ROOT, 'web', 'node_modules', '.cache');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `od-bundle-${process.pid}-${Date.now()}.cjs`);
  try {
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

/** 造一个「已按 slim 投影」的账号行（形状与 /v1/credentials?slim=1 一致）。 */
function row(o) {
  return {
    id: o.id,
    label: o.label ?? o.id,
    edition: o.edition,
    source: 'import',
    enabled: true,
    packCaliber: o.packCaliber,
    packDigest: o.packDigest,
    tokenRemaining: o.tokenRemaining,
    tokenBuckets: o.tokenBuckets,
    quota: o.quota,
    raccoonPoints: o.raccoonPoints,
    entitlementSnapshotUpdatedAt: new Date().toISOString(),
    ...o,
  };
}

const ZERO_DIGEST = { total: 0, usable: 0, usableAmount: 0, unlimited: 0, expiring7d: 0, soonestDays: null, soonestAmount: 0 };

function main() {
  const od = loadModule();
  if (!od) {
    check('能用 esbuild 打包 overview-detail.ts', false, '打包失败');
    return;
  }
  check('能用 esbuild 打包 overview-detail.ts', true);

  /* ---------- ① 可用额度按平台：积分合计只含 Trae + WorkBuddy ---------- */
  const trae = row({
    id: 't1', edition: 'cn', packCaliber: 'credit',
    packDigest: { total: 5, usable: 3, usableAmount: 780, unlimited: 0, expiring7d: 280, soonestDays: 2, soonestAmount: 80 },
  });
  const wb = row({
    id: 'w1', edition: 'workbuddy', packCaliber: 'credit',
    packDigest: { total: 2, usable: 2, usableAmount: 200, unlimited: 0, expiring7d: 0, soonestDays: 9, soonestAmount: 100 },
  });
  const zcode = row({
    id: 'z1', edition: 'zcode', packCaliber: 'zcode', packDigest: ZERO_DIGEST,
    tokenRemaining: 15000000,
    tokenBuckets: [{ name: 'B', limit: 20000000, used: 5000000, remaining: 15000000, expireTime: inDays(15) }],
  });
  const qoder = row({
    id: 'q1', edition: 'qoder', packCaliber: 'qoder', packDigest: ZERO_DIGEST,
    quota: {
      base: { total: 0, remaining: 0, used: 0, expiresAt: null },
      addOn: { total: 2700, remaining: 1926, used: 774, expiresAt: null },
      totalRemaining: 1926,
    },
  });
  const raccoon = row({
    id: 'r1', edition: 'raccoon', packCaliber: 'raccoon', packDigest: ZERO_DIGEST,
    raccoonPoints: { available: 2124, packages: [{ name: '奖励积分', remaining: 1524 }, { name: '每日积分', remaining: 600 }], updatedAt: new Date().toISOString() },
  });

  const accounts = [trae, wb, zcode, qoder, raccoon];

  const amountRows = od.amountByPlatform(accounts);
  const byPlatform = Object.fromEntries(amountRows.map((r) => [r.platform, r]));

  check('可用额度覆盖全部 5 个平台', amountRows.length === 5, amountRows.map((r) => r.platform).join(','));
  check('Trae 额度 780 积分', byPlatform.trae.amount === 780 && byPlatform.trae.unit === '积分', JSON.stringify(byPlatform.trae));
  check('WorkBuddy 额度 200 积分', byPlatform.workbuddy.amount === 200 && byPlatform.workbuddy.unit === '积分', JSON.stringify(byPlatform.workbuddy));
  check('ZCode 单列 Token 单位', byPlatform.zcode.unit === 'Token' && byPlatform.zcode.amount === 15000000, JSON.stringify(byPlatform.zcode));
  check('Qoder 单列配额单位', byPlatform.qoder.unit === '配额' && byPlatform.qoder.amount === 1926, JSON.stringify(byPlatform.qoder));
  check('Raccoon 单列（分池日清，不与可累积积分合并）', byPlatform.raccoon.amount === 2124, JSON.stringify(byPlatform.raccoon));

  // 界面上的合计算法：只累加「积分」且排除 Raccoon
  const creditSum = amountRows
    .filter((r) => r.unit === '积分' && r.platform !== 'raccoon')
    .reduce((s, r) => s + (r.amount ?? 0), 0);
  check(
    '积分口径合计 = 780 + 200 = 980（不含 Token / 配额 / Raccoon）',
    creditSum === 980,
    `合计=${creditSum}`,
  );
  check(
    '积分合计不含 ZCode 的 1500 万 Token',
    creditSum < 1_000_000,
    `合计=${creditSum}`,
  );

  /* ---------- ② 今日消耗：不写 credit_history 的平台标 notTracked ---------- */
  // 后端 summary() 只回 accountId/label/usedTotal...；Trae 与 WB 有快照，
  // 另外三类根本没有记录（这是真实状态，不是测试遗漏）
  const usage = [
    { accountId: 't1', label: 't1', group: null, usedTotal: 120, remainingDelta: 130, snapshots: 3, latestRemaining: 780, covered: true },
    { accountId: 'w1', label: 'w1', group: null, usedTotal: 80, remainingDelta: 85, snapshots: 4, latestRemaining: 200, covered: true },
  ];
  const usageRows = od.usageByPlatform(accounts, usage);
  const uBy = Object.fromEntries(usageRows.map((r) => [r.platform, r]));

  check('今日消耗覆盖全部 5 个平台（无消耗的也要出现一行）', usageRows.length === 5, usageRows.map((r) => r.platform).join(','));
  check('Trae 今日消耗 120', uBy.trae.amount === 120, JSON.stringify(uBy.trae));
  check('WorkBuddy 今日消耗 80', uBy.workbuddy.amount === 80, JSON.stringify(uBy.workbuddy));
  check(
    'ZCode / Qoder / Raccoon 标记为「未纳入统计」而不是 0',
    uBy.zcode.notTracked === true && uBy.qoder.notTracked === true && uBy.raccoon.notTracked === true,
    JSON.stringify({ z: uBy.zcode.notTracked, q: uBy.qoder.notTracked, r: uBy.raccoon.notTracked }),
  );
  check(
    '积分口径的平台不标 notTracked',
    uBy.trae.notTracked === false && uBy.workbuddy.notTracked === false,
    JSON.stringify({ t: uBy.trae.notTracked, w: uBy.workbuddy.notTracked }),
  );
  check(
    '按账号明细：每平台 members 只含有记录/有快照的账号',
    uBy.trae.members.length === 1 && uBy.trae.members[0].amount === 120,
    JSON.stringify(uBy.trae.members),
  );
  check(
    '账号明细按金额降序',
    uBy.trae.members.every((m, i, arr) => i === 0 || arr[i - 1].amount >= m.amount),
    JSON.stringify(uBy.trae.members),
  );

  /* ---------- ③ 即将到期：只算会损失的额度 ---------- */
  // 完整 packs（到期明细需要 packs 明细，不是摘要）
  const traeFull = {
    ...trae,
    packs: [
      { name: 'A', expireTime: inDays(2), limit: 100, used: 20, remaining: 80 },
      { name: 'B', expireTime: inDays(5), limit: 200, used: 0, remaining: 200 },
      { name: 'C', expireTime: inDays(40), limit: 500, used: 0, remaining: 500 },
      // 已用尽但会过期：不得计入（过期不损失）
      { name: 'D', expireTime: inDays(1), limit: 100, used: 100, remaining: 0 },
      // 已过期：不得计入
      { name: 'E', expireTime: inDays(-3), limit: 100, used: 0, remaining: 100 },
      // unlimited：不计金额
      { name: 'F', expireTime: inDays(2), limit: -1, used: 0, remaining: null, unlimited: true },
    ],
  };
  const wbFull = {
    ...wb,
    packs: [{ name: 'W', expireTime: inDays(10), limit: 300, used: 100, remaining: 200 }],
  };
  const fullAccounts = [traeFull, wbFull, zcode, qoder, raccoon];

  const e3 = od.expiringAccounts(fullAccounts, 3);
  check(
    '3 天窗口：只含 Trae 的 2 项（A=80），排除已用尽 D 与 unlimited F',
    e3.length === 1 && e3[0].accountId === 't1' && e3[0].amount === 80 && e3[0].items === 1,
    JSON.stringify(e3),
  );

  const e7 = od.expiringAccounts(fullAccounts, 7);
  check(
    '7 天窗口：Trae 280（A 80 + B 200），Qoder 无到期日不计',
    e7.length === 1 && e7[0].amount === 280 && e7[0].items === 2,
    JSON.stringify(e7),
  );

  const e30 = od.expiringAccounts(fullAccounts, 30);
  const e30By = Object.fromEntries(e30.map((r) => [r.accountId, r]));
  check(
    '30 天窗口包含 WorkBuddy 的 200（10 天后）',
    e30By.w1 && e30By.w1.amount === 200,
    JSON.stringify(e30By.w1),
  );
  check(
    '30 天窗口仍排除 40 天后到期的 C',
    !e30By.t1 || e30By.t1.amount === 280,
    JSON.stringify(e30By.t1),
  );
  check(
    'Raccoon（日清，无到期日）永不出现',
    !e30By.r1,
    JSON.stringify(e30By.r1),
  );
  check(
    '到期行按天数升序（最紧迫在前）',
    e30.every((r, i, arr) => i === 0 || arr[i - 1].days <= r.days),
    JSON.stringify(e30.map((r) => r.days)),
  );

  const totals = od.expiringTotals(e7);
  check(
    '到期合计按单位分组，不跨单位相加',
    totals.length === 1 && totals[0].unit === '积分' && totals[0].amount === 280,
    JSON.stringify(totals),
  );

  /* ---------- ④ 源码级约束：到期统计不读 packs 摘要 ---------- */
  const src = fs.readFileSync(SRC, 'utf8');
  check(
    '到期统计用自然日差（与后端 naturalDayDiff 同算法），不用毫秒除法',
    /function naturalDays/.test(src) && /setHours\(0, 0, 0, 0\)/.test(src),
    '未找到自然日差实现',
  );

  console.log(`\n${pass} passed${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}

try {
  main();
} catch (e) {
  console.error(`FAIL  用例执行异常: ${e.stack || e.message}`);
  process.exit(1);
}
