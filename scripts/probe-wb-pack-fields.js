'use strict';
/**
 * scripts/probe-wb-pack-fields.js —— 只读探针：WorkBuddy 额度包响应里到底有哪些时间字段。
 *
 * 要回答的问题（报告 D11）：`workbuddy/auth.js#fetchResourcePacks` 用 `CycleEndTime`
 * 当包到期时刻，而参照项目在 **Trae** 上实测过「`CycleEndTime` 是计费周期边界，
 * 真正决定额度作废的是 `DeductionEndTime`」——取错会让 FEFO 把「周期将重置的月度包」
 * 当成「马上作废」，于是长期额度被一直压后、最终作废。
 *
 * 两点必须分清：
 *   1. 那是 Trae 的结论，WorkBuddy 是另一套接口（字段名带 Cycle 前缀），**不能直接搬**；
 *   2. 本仓库全库从未读过 DeductionEndTime，所以只能靠一次真实响应判定它是否存在、
 *      以及它与 CycleEndTime 差多少。
 *
 * 本脚本只发查询请求（与网关每 30 分钟的余额刷新同一批接口），不写任何数据、
 * 不打印任何凭据。只输出字段名与时间字段的值。
 *
 * 运行：
 *   node scripts/probe-wb-pack-fields.js                 # 自动挑一个启用的 workbuddy 账号
 *   node scripts/probe-wb-pack-fields.js --account acct_xxx
 */
const auth = require('../src/auth');
const wbAuth = require('../src/workbuddy/auth');
const store = require('../src/credentials/store');

function pickAccount() {
  const argIdx = process.argv.indexOf('--account');
  if (argIdx > -1 && process.argv[argIdx + 1]) {
    const a = store.get(process.argv[argIdx + 1]);
    if (!a) throw new Error(`找不到账号 ${process.argv[argIdx + 1]}`);
    return a;
  }
  const a = store.list().find((x) => x.enabled && x.edition === 'workbuddy');
  if (!a) throw new Error('没有启用的 workbuddy 账号');
  return a;
}

async function postJson(base, path, headers, payload) {
  const resp = await fetch(base + path, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(20000),
  });
  const text = await resp.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: resp.status, json, textLen: text.length };
}

/** 时间类字段名（含各平台常见拼写）。 */
const TIME_FIELD = /time|end|expire|deduct|deadline|valid/i;

async function main() {
  const a = pickAccount();
  console.log(`账号: ${a.label || a.id}（${a.edition}）`);
  const ensured = await auth.ensureAuth(a.id);
  const info = {
    accessToken: ensured.token || a.token,
    refreshToken: ensured.refreshToken || a.refreshToken,
    uid: ensured.userId || a.userId,
    region: wbAuth.regionOf(ensured.host || a.host),
  };
  const base = wbAuth.billingBase(wbAuth.validRegion(info.region));
  const headers = wbAuth.authHeaders(info, { Origin: base, Referer: base + '/profile/plans-usage' });
  console.log(`region=${info.region} base=${base}\n`);

  const summary = await postJson(base, '/billing/meter/get-user-resource-summary', headers, {});
  console.log('get-user-resource-summary HTTP', summary.status, 'body', summary.textLen, 'B');
  if (!summary.json) { console.error('无 JSON 响应，无法继续'); process.exitCode = 1; return; }
  const sdata = summary.json.data || summary.json.Data || {};
  const codes = (sdata.Packages || sdata.packages || []).map((p) => p.PackageCode || p.packageCode).filter(Boolean);
  console.log('PackageCodes:', codes.join(', ') || '(空)');
  if (!codes.length) return;

  const now = new Date();
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(now); dayEnd.setHours(23, 59, 59, 999);

  const slices = [
    ['free', '/billing/meter/get-user-resource-free-packages', {
      PageNumber: 1, PageSize: 200, PackageCodes: codes, Status: [0, 3],
      SlicePeriodStartTime: fmt(dayStart), SlicePeriodEndTime: fmt(dayEnd),
    }],
    ['paid', '/billing/meter/get-user-resource-paid-packages', {
      PageNumber: 1, PageSize: 200, PackageCodes: codes, Status: [0, 3], NeedRenewInfo: true,
    }],
  ];

  const allKeys = new Set();
  let printed = 0;
  /** 逐条对比 CycleEndTime 与 DeductionEndTime：多周期包才会显出差异。 */
  const cmp = [];
  for (const [label, path, payload] of slices) {
    const r = await postJson(base, path, headers, payload);
    console.log(`\n=== ${label} ${path} → HTTP ${r.status}, body ${r.textLen} B`);
    if (!r.json) continue;
    const d = r.json.data || r.json.Data || {};
    const accounts = d.Accounts || d.accounts || [];
    console.log(`Accounts 条数: ${accounts.length}`);
    for (const acc of accounts) for (const k of Object.keys(acc || {})) allKeys.add(k);
    for (const acc of accounts) {
      const cycle = wbAuth.parseCycleTime(acc.CycleEndTime);
      const deduct = wbAuth.parseCycleTime(acc.DeductionEndTime);
      if (cycle == null && deduct == null) continue;
      cmp.push({
        label: acc.PackageName || acc.PackageCode,
        cycle, deduct,
        diffDays: (cycle != null && deduct != null) ? (deduct - cycle) / 86400000 : null,
        remainCycles: acc.RemainCycles,
        totalCycles: acc.TotalCycles,
        status: acc.Status,
        remain: Number(acc.CycleCapacityRemain) || 0,
        raw: acc,
      });
    }
    for (const acc of accounts.slice(0, printed < 2 ? 2 : 0)) {
      printed += 1;
      console.log('  --- 条目（前两条全字段） ---');
      for (const [k, v] of Object.entries(acc)) {
        const shown = typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v;
        console.log(`    ${k} = ${JSON.stringify(shown)}`);
      }
    }
  }

  console.log('\n=== CycleEndTime vs DeductionEndTime 逐条对比（多周期包才会不同）===');
  console.log('条目数:', cmp.length);
  const withBoth = cmp.filter((c) => c.cycle != null && c.deduct != null);
  const differ = withBoth.filter((c) => Math.abs(c.diffDays) >= 1);
  console.log('两者都可解析:', withBoth.length, '| 相差 >=1 天的:', differ.length);
  const ds = withBoth.map((c) => c.diffDays).sort((a, b) => a - b);
  if (ds.length) console.log('差值(天) min/p50/max:', ds[0].toFixed(2), ds[Math.floor(ds.length / 2)].toFixed(2), ds[ds.length - 1].toFixed(2));
  const multi = cmp.filter((c) => Number(c.totalCycles) > 1 || Number(c.remainCycles) > 0);
  console.log('多周期/有剩余周期的条目:', multi.length);
  for (const c of multi.slice(0, 8)) {
    console.log(`   ${c.label} cycle=${c.cycle && new Date(c.cycle).toISOString().slice(0, 10)} deduct=${c.deduct && new Date(c.deduct).toISOString().slice(0, 10)} 差${c.diffDays == null ? '?' : c.diffDays.toFixed(1)}天 remainCycles=${c.remainCycles} totalCycles=${c.totalCycles} status=${c.status} remain=${c.remain}`);
  }
  for (const c of withBoth.filter((x) => Math.abs(x.diffDays) >= 1)) {
    console.log(`   差异: ${c.label} cycle=${new Date(c.cycle).toISOString().slice(0, 10)} deduct=${new Date(c.deduct).toISOString().slice(0, 10)} 差${c.diffDays.toFixed(1)}天`);
    console.log('   该条目关键字段:');
    for (const k of ['PackageName', 'PackageCode', 'Status', 'CapacityRemain', 'CapacitySize', 'CycleCapacityRemain', 'CycleCapacitySize', 'RemainCycles', 'TotalCycles', 'ExpiredTime', 'CycleEndTime', 'DeductionEndTime']) {
      console.log(`     ${k} = ${JSON.stringify(c.raw[k])}`);
    }
    // 关键判据：这条包是否还有可用额度。remaining<=0 的包会被 fetchResourcePacks 直接丢弃，
    // 只有 remaining>0 时 CycleEndTime/DeductionEndTime 取错才会真的影响 FEFO 选号。
    console.log(`     → 是否进入快照：remaining=${c.remain} ${c.remain > 0 ? '**会进入**，取错字段将影响 FEFO 选号' : '为 0，会被丢弃，暂不影响选号'}`);
  }

  console.log('\n=== 全部出现过的字段名 ===');
  console.log([...allKeys].sort().join(', '));
  const timeKeys = [...allKeys].filter((k) => TIME_FIELD.test(k)).sort();
  console.log('\n=== 时间类字段名 ===');
  console.log(timeKeys.join(', ') || '(无)');
  const hasDeduction = timeKeys.some((k) => /deduct/i.test(k));
  console.log(`\n结论线索：响应中${hasDeduction ? '存在' : '不存在'} Deduction* 时间字段。`);
  if (hasDeduction) {
    console.log('→ 需要把 Deduction* 的值与 CycleEndTime 逐个对比：若前者远晚于后者，');
    console.log('  说明 CycleEndTime 是周期边界、真正作废时刻在 Deduction*，FEFO 取错了键。');
  } else {
    console.log('→ Trae 的 DeductionEndTime 结论不适用于 WorkBuddy；CycleEndTime 是唯一可得口径，');
    console.log('  D11 在 WorkBuddy 侧应判定为「无更优字段可选」，维持现状。');
  }

  // 用生产代码路径复核修复效果：归一化后的 expireTime 是否已取扣费截止。
  if (process.argv.includes('--normalized')) {
    console.log('\n=== fetchResourcePacks 归一化结果（生产路径）===');
    const norm = await wbAuth.fetchResourcePacks(info);
    console.log('包数:', norm.packs.length, '| totalRemaining:', norm.totalRemaining);
    const long = norm.packs.filter((p) => p.expireTime && (p.expireTime * 1000 - Date.now()) / 86400000 > 365);
    console.log('到期时刻在 1 年以上的包:', long.length);
    for (const p of long.slice(0, 8)) {
      console.log(`   ${p.name || p.packId} 到期 ${new Date(p.expireTime * 1000).toISOString().slice(0, 10)}（${((p.expireTime * 1000 - Date.now()) / 86400000 / 365).toFixed(1)} 年后）剩 ${p.remaining}`);
    }
    if (!long.length) console.log('   （无：说明扣费截止未被采用，需检查 packExpireMs 是否生效）');
  }
}

main().catch((e) => { console.error('探针失败:', e.message); process.exitCode = 1; });
