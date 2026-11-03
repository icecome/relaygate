'use strict';
/**
 * probes/wb-streak-raw.js —— 打印某账号 /activity/growth/streak 的原始响应，
 * 用于排查 makeup_dates 与 heatmap 不一致（上游 400 not_broken 的那类假候选）。
 *
 * 用法：node scripts/probes/wb-streak-raw.js [accountId|label]
 */
const store = require('../../src/credentials/store');
const auth = require('../../src/auth');
const wbAuth = require('../../src/workbuddy/auth');
const catTrip = require('../../src/workbuddy/cat-trip');

const key = process.argv[2] || null;

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
  const all = store.list().filter((a) => a.edition === 'workbuddy');
  const accounts = key ? all.filter((a) => a.id === key || a.label === key || a.userId === key) : all;
  if (!accounts.length) { console.error('账号不存在：' + key); process.exit(1); }
  for (const a of accounts) {
    const info = await toInfo(a.id, a);
    const paths = ['/streak', '/heatmap'];
    for (const p of paths) {
      const resp = await fetch(catTrip.GROWTH_BASE + p, {
        headers: wbAuth.authHeaders(info, {
          Accept: 'application/json, text/plain, */*',
          'X-Product-Code': 'workbuddy',
          Origin: catTrip.GROWTH_HOST,
          Referer: catTrip.GROWTH_HOST + '/profile/growth-center',
        }),
        signal: AbortSignal.timeout(20000),
      });
      const text = await resp.text();
      console.log(`\n===== ${a.label} (${a.id}) ${p} HTTP ${resp.status} =====`);
      try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text.slice(0, 2000)); }
    }
    const cs = await wbAuth.checkinStatus(info);
    console.log(`\n===== ${a.label} (${a.id}) checkin-activity-status =====`);
    console.log(JSON.stringify({ ok: cs.ok, checkedIn: cs.checkedIn, streakDays: cs.streakDays, dates: cs.dates }, null, 2));
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
