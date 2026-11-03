'use strict';
/**
 * probes/wb-growth-status.js —— 成长中心巡检表（只读）。
 *
 * 一次拉齐三份数据并交叉核对：
 *   GET /activity/growth/streak           连登天数 / 补登卡余额 / 上游候选补登日
 *   GET /activity/growth/heatmap          逐日活跃分（成长中心热力墙，判「有没有断」的权威口径）
 *   GET /activity/growth/buddy/travel/status  旅行三态 / 地点 / 可领奖励
 *   POST {billing}/v2/billing/meter/checkin-activity-status  签到日历（另一套口径）
 *
 * 输出每账号一行 + 明细：最近 N 天热力、真实缺口日、与上游候选是否一致。
 * 全部只读，不消耗任何次数/卡片。
 *
 * 用法：node scripts/probes/wb-growth-status.js [--days 10] [--json out.json] [--all]
 */
const fs = require('fs');
const store = require('../../src/credentials/store');
const auth = require('../../src/auth');
const wbAuth = require('../../src/workbuddy/auth');
const catTrip = require('../../src/workbuddy/cat-trip');
const { sleep } = require('../../src/lib/util');

const argv = process.argv.slice(2);
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const DAYS = Number(arg('--days')) || 10;
const ALL = argv.includes('--all');
const OUT = arg('--json');

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

async function getJson(path, info) {
  const r = await fetch(catTrip.GROWTH_BASE + path, {
    headers: wbAuth.authHeaders(info, {
      Accept: 'application/json, text/plain, */*',
      'X-Product-Code': 'workbuddy',
      Origin: catTrip.GROWTH_HOST,
      Referer: catTrip.GROWTH_HOST + '/profile/growth-center',
    }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保留原文 */ }
  return { http: r.status, json, text: json ? null : text.slice(0, 200) };
}

/** 今天（Asia/Shanghai）YYYY-MM-DD，避免容器时区坑。 */
function todayCN() {
  const t = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  return t.slice(0, 10);
}

(async () => {
  const accounts = store.list().filter((a) => a.edition === 'workbuddy' && (ALL || a.enabled));
  const today = todayCN();
  const out = { at: new Date().toISOString(), today, days: DAYS, accounts: [] };
  const rows = [];

  for (const a of accounts) {
    const info = await toInfo(a.id, a);
    const rec = { id: a.id, label: a.label, uid: a.userId, enabled: !!a.enabled };

    const st = await catTrip.fetchStreak(info); await sleep(250);
    const hm = await getJson('/heatmap', info); await sleep(250);
    const tr = await catTrip.fetchStatus(info); await sleep(250);
    const ck = await wbAuth.checkinStatus(info); await sleep(200);

    const cells = ((hm.json || {}).data || {}).cells || [];
    const tail = cells.slice(-DAYS).map((c) => ({ date: c.date, score: c.score, active: (c.score || 0) > 0 }));
    const gaps = cells
      .filter((c) => c.date <= today && c.date >= '2026-10-01')
      .filter((c) => !(c.score > 0))
      .map((c) => c.date);
    const cands = st.ok ? (st.makeupDates || []) : [];
    const gapSet = new Set(gaps);
    // 交叉核对：上游候选里哪些实际有活跃分（假候选）
    const falseCands = cands.filter((d) => !gapSet.has(d));

    rec.streak = st;
    rec.travel = tr;
    rec.heatmapTail = tail;
    rec.activityGaps = gaps;
    rec.falseCandidates = falseCands;
    rec.checkin = { ok: ck.ok, checkedIn: ck.checkedIn, streakDays: ck.streakDays, count: (ck.dates || []).length };
    out.accounts.push(rec);

    rows.push({
      label: a.label,
      id: a.id,
      streak: st.ok ? st.days : 'ERR',
      next: st.ok ? `${st.nextTier || '-'}(差${st.nextTierRemaining ?? '?'})` : '-',
      cards: st.ok ? st.makeupCards : '-',
      cands: cands.join(',') || '无',
      falseCands: falseCands.join(',') || '无',
      gaps: gaps.join(',') || '无',
      travel: tr.ok ? tr.state : 'ERR',
      where: tr.ok && tr.location ? `${tr.location.name}/${tr.durationHours ?? '?'}h` : '-',
      reward: tr.ok && tr.rewardCredit != null ? tr.rewardCredit : '-',
      tail: tail.map((c) => (c.active ? String(c.score) : '·')).join(' '),
    });
  }

  console.log(`今天 ${today}（Asia/Shanghai）| 最近 ${DAYS} 天热力，· = 当日无活跃\n`);
  for (const r of rows) {
    console.log(`${r.label} (${r.id})`);
    console.log(`  连登 ${r.streak} 天 | 下一档 ${r.next} | 补登卡 ${r.cards} 张 | 签到口径连登 ${''}`);
    console.log(`  上游候选补登=${r.cands}  其中假候选(当日其实有活跃)=${r.falseCands}`);
    console.log(`  本月真实无活跃日=${r.gaps}`);
    console.log(`  旅行=${r.travel} ${r.where} 可领=${r.reward} | 近${DAYS}天热力: ${r.tail}\n`);
  }

  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf-8'); console.log('written: ' + OUT); }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
