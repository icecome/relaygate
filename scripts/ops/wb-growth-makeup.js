'use strict';
/**
 * probes/wb-growth-makeup.js —— 用补登卡补签「最近一次真实漏签」。
 *
 * 写操作（POST /activity/growth/makeup-cards/use），成功才消耗 1 张卡。
 *
 * 为什么需要「逐个试」：上游 /streak 的 makeup_dates 与 /heatmap、签到活动
 * checkin_dates 不一致，常把实际已活跃的日期当成候选（cat-trip.js:344 记录的坑）。
 * 对这种假候选，上游回 400 "date is not broken, no makeup needed"，**不扣卡**。
 * 因此按日期从新到旧逐个提交，跳过 not_broken，命中第一个真的断登日期就停。
 *
 * 用法：
 *   node scripts/ops/wb-growth-makeup.js --dry                 # 只列出候选与将补哪天
 *   node scripts/ops/wb-growth-makeup.js                       # 全局补最近一次真实漏签（1 张卡）
 *   node scripts/ops/wb-growth-makeup.js --account 18232808772 # 只处理指定账号
 *   node scripts/ops/wb-growth-makeup.js --date 2026-10-24     # 指定日期
 *   node scripts/ops/wb-growth-makeup.js --each                # 每个账号各补最近一次（多张卡）
 *   node scripts/ops/wb-growth-makeup.js --all                 # 连禁用账号一起扫
 */
const store = require('../../src/credentials/store');
const auth = require('../../src/auth');
const wbAuth = require('../../src/workbuddy/auth');
const catTrip = require('../../src/workbuddy/cat-trip');
const { sleep } = require('../../src/lib/util');

const argv = process.argv.slice(2);
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const DRY = argv.includes('--dry');
const ALL = argv.includes('--all');
const EACH = argv.includes('--each');
const WANT_ACCOUNT = arg('--account');
const WANT_DATE = arg('--date');

async function toInfo(id, rec) {
  let e = {};
  try { e = (await auth.ensureAuth(id)) || {}; } catch { /* 库内 token 兜底 */ }
  return {
    accessToken: e.token || rec.token,
    refreshToken: e.refreshToken || rec.refreshToken,
    uid: e.userId || rec.userId,
    region: wbAuth.regionOf(e.host || rec.host),
  };
}

(async () => {
  let accounts = store.list().filter((a) => a.edition === 'workbuddy' && (ALL || a.enabled));
  if (WANT_ACCOUNT) {
    accounts = accounts.filter((a) => a.id === WANT_ACCOUNT || a.label === WANT_ACCOUNT || String(a.userId) === WANT_ACCOUNT);
    if (!accounts.length) { console.error('账号不存在：' + WANT_ACCOUNT); process.exit(1); }
  }

  // 1) 收集候选：每个账号 {info, streak, dates(新→旧)}
  const cands = [];
  for (const a of accounts) {
    const info = await toInfo(a.id, a);
    const s = await catTrip.fetchStreak(info);
    await sleep(250);
    if (!s.ok) { console.log(`${a.label} | streak 查询失败：${s.reason}`); continue; }
    const dates = (s.makeupDates || []).slice().sort().reverse();
    console.log(`${a.label} (${a.id}) | 连登=${s.days} 天 | 距 ${s.nextTier || '-'} 还差 ${s.nextTierRemaining ?? '-'} 天`
      + ` | 补登卡=${s.makeupCards} 张 | 上游候选=${dates.join(',') || '无'}`);
    if (WANT_DATE) {
      // 显式指定日期时不受上游候选列表限制：热力墙认定的真实缺口常常不在候选里
      cands.push({ a, info, date: WANT_DATE, cards: s.makeupCards });
      continue;
    }
    for (const d of dates) cands.push({ a, info, date: d, cards: s.makeupCards });
  }

  const usable = cands.filter((c) => c.cards > 0);
  if (!usable.length) { console.log('\n没有候选日期，或补登卡余额为 0 —— 无需操作'); return; }

  // 2) 排序：跨账号按日期倒序（「最近一次」在前）
  usable.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  console.log(`\n候选队列（新→旧）：${usable.map((c) => c.date + '@' + c.a.label).join(' → ')}`);
  if (!EACH) console.log('模式：全局只补最近一次真实漏签（假候选不扣卡，自动往更早的退）');
  else console.log('模式：--each 每个账号各补最近一次');

  if (DRY) { console.log('--dry：首个待试 = ' + usable[0].date + '@' + usable[0].a.label); return; }

  // 3) 逐个提交；not_broken 不扣卡 → 继续更早的日期 / 下一个账号
  const done = new Set();
  let success = 0;
  for (const c of usable) {
    if (EACH && done.has(c.a.id)) continue;
    console.log(`\n>>> 补登 ${c.a.label} (${c.a.id}) 目标日 ${c.date} …`);
    const r = await catTrip.useMakeupCard(c.info, c.date);
    if (r.ok) {
      console.log(`    ✅ 成功：补登 ${r.date}，剩余补登卡 ${r.cardsLeft ?? '?'} 张`);
      success += 1;
      done.add(c.a.id);
      await sleep(500);
      const after = await catTrip.fetchStreak(c.info);
      if (after.ok) {
        console.log(`    回读：连登=${after.days} 天 | 补登卡=${after.makeupCards} 张 | 还可补=${(after.makeupDates || []).join(',') || '无'}`);
      }
      if (!EACH) break;
    } else if (r.result === 'not_broken') {
      console.log('    ↷ 上游判定该日本就已签（假候选，不扣卡），退到更早的日期');
    } else {
      console.log(`    ❌ 失败：${r.reason}（code ${r.code}）`);
      done.add(c.a.id);
      if (!EACH) break;
    }
    await sleep(400);
  }

  console.log(`\n完成：成功补登 ${success} 个账号`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
