'use strict';
/**
 * scripts/growth-28d-check.js — 检查/补齐 WorkBuddy 成长计划「本月连登 28 天」并领奖。
 *
 * 判定口径（实测 2026-10-30）：
 *   - /streak 的 streak.days 与 month_total_days 是「本月已点亮天数」；
 *   - 28 天档位（legendary_status）需要本月满 28 天，否则 locked；
 *   - /streak 的 makeup_dates **会残留已补过的日期**（补登成功后仍列出），
 *     不能当作「还能补哪些天」的唯一来源；真正的断登日是 /heatmap 里本月
 *     score=0 的日期（今天除外——今天还能靠真实活跃点亮）。
 *
 * 默认只读；加 --apply 才执行写操作：
 *   1) 连登不足 28 天时，把补登卡逐张用在「heatmap 本月 0 分日」上，
 *      直到天数达标或卡用完（每张卡用独立幂等键，属不同日期的手动动作）。
 *      关键：28 天档位按**连续登录天数**（remaining_days = streak.days）判定，
 *      补一个孤立断登日只加本月累计、不延长连登。必须从当前连登段起点的
 *      前一天开始补（即 0 分日里**最晚**的那天），把连登段逐日向前延长。
 *      实测：连登段 10-04..10-30（27 天）时补 10-03 → 连登变 28 可领奖；
 *      先补孤立的 10-01 → 本月累计 +1 但连登仍是 27，档位依旧 locked。
 *   2) 补完后再读兑换档位，28 天档位非 locked/claimed 就领取。
 *
 * 用法：
 *   node scripts/growth-28d-check.js            # 只读检查
 *   node scripts/growth-28d-check.js --apply    # 用卡 + 领奖
 */
const path = require('path');
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || path.resolve(__dirname, '..', 'output');

const store = require('../src/credentials/store');
const auth = require('../src/auth');
const wbAuth = require('../src/workbuddy/auth');
const g = require('../src/workbuddy/cat-trip');
const { sleep, localDateKey } = require('../src/lib/util');

const APPLY = process.argv.includes('--apply');
const TARGET_DAYS = 28;

async function toInfo(accountId) {
  const stored = store.get(accountId);
  const ensured = await auth.ensureAuth(accountId);
  return {
    accessToken: ensured.token || stored.token,
    refreshToken: ensured.refreshToken || stored.refreshToken,
    uid: ensured.userId || stored.userId,
    region: wbAuth.regionOf(ensured.host || stored.host),
  };
}

/** 本月（今天所在自然月）heatmap 的 0 分日期，排除今天。 */
async function monthlyGaps(info) {
  const resp = await fetch(g.GROWTH_HOST + '/activity/growth/heatmap', {
    headers: wbAuth.authHeaders(info, {
      'Accept': 'application/json, text/plain, */*',
      'X-Product-Code': 'workbuddy',
      'Origin': g.GROWTH_HOST,
      'Referer': g.GROWTH_HOST + '/profile/growth-center',
    }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await resp.json();
  const cells = (j && j.data && j.data.cells) || [];
  const today = localDateKey();
  const monthPrefix = today.slice(0, 7);
  return cells
    .filter((c) => String(c.date).startsWith(monthPrefix))
    .filter((c) => !(Number(c.score) > 0))
    .map((c) => c.date)
    .filter((d) => d !== today);
}

async function snapshot(info) {
  const s = await g.fetchStreak(info);
  const r = await g.fetchRedeemSummary(info);
  return {
    ok: s.ok && r.ok,
    days: s.ok ? s.days : null,
    monthTotalDays: s.ok ? s.monthTotalDays : null,
    makeupCards: s.ok ? s.makeupCards : null,
    makeupDates: s.ok ? s.makeupDates : [],
    tier28: r.ok ? (r.tiers.find((t) => t.tier === '28d') || {}).status : ('查询失败:' + r.reason),
    raw: { streak: s, redeem: r },
  };
}

async function processAccount(a) {
  const out = { id: a.id, label: a.label || a.id, before: null, gaps: [], makeups: [], after: null, redeem28: null, errors: [] };
  const info = await toInfo(a.id);

  out.before = await snapshot(info);
  if (!out.before.ok) throw new Error('上游只读查询失败：' + JSON.stringify(out.before.raw).slice(0, 200));
  out.gaps = await monthlyGaps(info);

  if (!APPLY) return out;

  // ---- 用掉补登卡补齐到 28 天 ----
  if (out.before.days < TARGET_DAYS && out.before.makeupCards > 0) {
    const tried = new Set();
    let guard = 0;
    while (guard++ < 40) {
      const s = await g.fetchStreak(info);
      if (!s.ok) { out.errors.push('重读 streak 失败：' + s.reason); break; }
      if (s.days >= TARGET_DAYS) break;
      if (s.makeupCards <= 0) { out.errors.push(`补登卡已用完，仍差 ${TARGET_DAYS - s.days} 天`); break; }

      // 候选：0 分日里**最晚**的那个（从当前连登段起点向前一天补起）。
      // 孤立断登日只加 month_total_days，不延长连登段，补了也不解锁 28 天档位。
      const gaps = (await monthlyGaps(info)).filter((d) => !tried.has(d)).sort();
      const date = gaps.length ? gaps[gaps.length - 1] : (s.makeupDates || []).filter((d) => !tried.has(d)).sort().pop();
      if (!date) { out.errors.push('补登卡仍有余额，但上游不再给出可补日期'); break; }
      tried.add(date);

      const mr = await g.useMakeupCard(info, date); // 不传 seed → 每张卡独立幂等键
      if (mr.ok) out.makeups.push({ date, ok: true, cardsLeft: mr.cardsLeft });
      else if (mr.result === 'not_broken') out.makeups.push({ date, ok: false, reason: '该日本就已签，跳过' });
      else { out.makeups.push({ date, ok: false, reason: mr.reason || mr.result }); break; }
      await sleep(300);
    }
  }

  // ---- 补后复核 + 领 28 天档位 ----
  out.after = await snapshot(info);
  const status = out.after.tier28;
  if (status && status !== 'claimed' && status !== 'locked') {
    const rr = await g.redeemTier(info, '28d');
    out.redeem28 = rr.ok
      ? { ok: true, credit: rr.credit, energy: rr.energy }
      : { ok: false, result: rr.result, reason: rr.reason };
    if (rr.ok) out.after = await snapshot(info);
  } else {
    out.redeem28 = { ok: false, skipped: true, reason: '档位状态=' + String(status) };
  }

  return out;
}

async function main() {
  const accounts = store.list().filter((a) => a.enabled && a.edition === 'workbuddy');
  console.log(`模式：${APPLY ? '执行（用卡 + 领奖）' : '只读检查'}，共 ${accounts.length} 个 WorkBuddy 账号\n`);
  const results = [];
  for (const a of accounts) {
    try {
      results.push(await processAccount(a));
    } catch (e) {
      results.push({ id: a.id, label: a.label || a.id, fatal: e.message });
    }
    await sleep(400);
  }

  for (const r of results) {
    console.log('─'.repeat(64));
    console.log(`账号 ${r.label} (${r.id})`);
    if (r.fatal) { console.log(`  ✗ 失败：${r.fatal}`); continue; }
    console.log(`  连登 ${r.before.days} 天 / 本月累计 ${r.before.monthTotalDays}  补登卡 ${r.before.makeupCards}  28天档位 ${r.before.tier28}`);
    console.log(`  本月 0 分日（可补候选，排除今天）：${r.gaps.length ? r.gaps.join(', ') : '无'}`);
    if (APPLY) {
      for (const m of r.makeups) {
        console.log(m.ok ? `  ✓ 补登 ${m.date}（剩 ${m.cardsLeft ?? '?'} 张）` : `  · ${m.date}: ${m.reason}`);
      }
      console.log(`  补后：连登 ${r.after.days} 天  剩余卡 ${r.after.makeupCards}  28天档位 ${r.after.tier28}`);
      if (r.redeem28.ok) console.log(`  🎁 28 天奖励已领取：credit +${r.redeem28.credit ?? '?'} energy +${r.redeem28.energy ?? '?'}`);
      else console.log(`  28 天奖励未领取：${r.redeem28.reason}`);
      for (const e of r.errors) console.log(`  ! ${e}`);
    } else {
      console.log(`  判定：${r.before.days >= TARGET_DAYS ? '已满 28 天' : `不满 28 天（差 ${TARGET_DAYS - r.before.days} 天）`}`);
    }
  }

  try { require('../src/credentials/db').close(); } catch { /* ignore */ }
}

main().catch((e) => { console.error(e); process.exit(1); });
