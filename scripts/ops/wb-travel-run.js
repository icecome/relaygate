'use strict';
/**
 * ops/wb-travel-run.js —— 手动跑一轮「派猫旅行」：领已到达的奖励 → 若今日还没派过就派一次。
 *
 * 这是 jobs/growth-auto.js 旅行段的独立版（travel 段 88-113 行），
 * 用于定时任务错过墙钟时刻（重启、停摆）时补救当天额度——旅行次数按日重置，
 * 当天不派就作废，而 arrived 的奖励不领也不会自己进账。
 *
 * 写操作：claim（领奖，纯入账）+ depart（消耗当日 1 次派猫额度）。
 * 上游对「今日已派」返回 400 daily limit reached，本脚本视作正常跳过。
 *
 * 用法：
 *   node scripts/ops/wb-travel-run.js --dry                 # 只看每个账号会做什么
 *   node scripts/ops/wb-travel-run.js                       # 默认 咖啡馆(1) / 4h，与定时任务同参
 *   node scripts/ops/wb-travel-run.js --location 4 --hours 2
 *   node scripts/ops/wb-travel-run.js --account 18232808772
 *   node scripts/ops/wb-travel-run.js --all                 # 含禁用账号
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
const LOCATION = Number(arg('--location')) || 1;   // 与 growth-auto 默认一致
const HOURS = Number(arg('--hours')) || 4;
const WANT = arg('--account');

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

function fmt(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '-';
  return new Date(n * 1000 + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + '+08';
}

(async () => {
  let accounts = store.list().filter((a) => a.edition === 'workbuddy' && (ALL || a.enabled));
  if (WANT) {
    accounts = accounts.filter((a) => a.id === WANT || a.label === WANT || String(a.userId) === WANT);
    if (!accounts.length) { console.error('账号不存在：' + WANT); process.exit(1); }
  }

  let claimed = 0; let claimedCredit = 0; let departed = 0; let skipped = 0; let failed = 0;

  for (const a of accounts) {
    const info = await toInfo(a.id, a);
    const tag = `${a.label} (${a.id})`;
    const st = await catTrip.fetchStatus(info);
    await sleep(250);
    if (!st.ok) { console.log(`${tag} | status 失败：${st.reason}`); failed += 1; continue; }

    let state = st.state;
    console.log(`${tag} | state=${state} | 今日已派=${st.dailyLimitReached ? '是' : '否'}`
      + (st.location ? ` | 行程=${st.location.name}/${st.durationHours ?? st.location.duration_hours ?? '?'}h 出发=${fmt(st.departAt)} 到达=${fmt(st.arriveAt)}` : ''));

    // 1) arrived → 领奖
    if (state === 'arrived') {
      if (DRY) { console.log('  --dry：会领奖 +' + (st.rewardCredit ?? '?')); }
      else {
        const c = await catTrip.claimTravelReward(info);
        await sleep(300);
        if (c.ok) {
          console.log(`  ✅ 领奖成功 +${c.rewardCredit ?? 0}`);
          claimed += 1; claimedCredit += Number(c.rewardCredit) || 0;
        } else if (c.result === 'no_unclaimed' || c.result === 'not_arrived') {
          console.log(`  ↷ ${c.result}（无需领奖）`);
        } else {
          console.log(`  ❌ 领奖失败：${c.reason}`);
          failed += 1;
          continue;
        }
        const st2 = await catTrip.fetchStatus(info);
        await sleep(250);
        state = st2.ok ? st2.state : state;
        if (st2.ok) console.log(`  回读：state=${st2.state} 今日已派=${st2.dailyLimitReached ? '是' : '否'}`);
      }
    }

    // 2) idle 且今日未派 → 派一次
    if (state === 'idle') {
      if (DRY) { console.log(`  --dry：会派猫 location=${LOCATION} hours=${HOURS}`); }
      else {
        const d = await catTrip.depart(info, { location_id: LOCATION, duration_hours: HOURS });
        await sleep(300);
        if (d.ok) {
          console.log(`  ✅ 已派猫出发 ${d.location ? d.location.name : ''}（${d.durationHours ?? HOURS}h，预计 +${d.rewardCredit ?? 0}，到达 ${fmt(d.arriveAt)}）`);
          departed += 1;
        } else if (d.result === 'daily_limit') {
          console.log('  ↷ 今日旅行次数已达上限');
          skipped += 1;
        } else if (d.result === 'already_traveling') {
          console.log('  ↷ 已在旅行中');
          skipped += 1;
        } else {
          console.log(`  ❌ 派猫失败：${d.reason || d.result}（code ${d.code}）`);
          failed += 1;
        }
      }
    } else if (state === 'traveling') {
      console.log('  ↷ 旅行中，等到达');
      skipped += 1;
    } else if (state === 'arrived' && !DRY) {
      console.log('  ↷ 领奖后仍是 arrived，未派猫（上游未回到 idle）');
      skipped += 1;
    }
  }

  console.log(`\n汇总：领奖 ${claimed} 个账号（合计 +${claimedCredit} 分）| 派出 ${departed} | 跳过 ${skipped} | 失败 ${failed}`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
