'use strict';
/**
 * probes/wb-travel-status.js —— 派猫旅行状态明细（只读，不 depart/claim）。
 *
 * 除了三态（idle/traveling/arrived），还打出上游原文里的关键判据：
 *   depart_at / arrive_at / server_now（秒级 epoch，转 Asia/Shanghai 本地时间）
 *   daily_limit_reached（今日已派过，≠ 已领奖）
 *   reward_credit（arrived 才有意义）
 *
 * 用法：node scripts/probes/wb-travel-status.js [--raw] [--all]
 */
const store = require('../../src/credentials/store');
const auth = require('../../src/auth');
const wbAuth = require('../../src/workbuddy/auth');
const catTrip = require('../../src/workbuddy/cat-trip');
const { sleep } = require('../../src/lib/util');

const argv = process.argv.slice(2);
const RAW = argv.includes('--raw');
const ALL = argv.includes('--all');

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
  if (!sec) return '-';
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return String(sec);
  return new Date(n * 1000 + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + '+08';
}

(async () => {
  const accounts = store.list().filter((a) => a.edition === 'workbuddy' && (ALL || a.enabled));
  let arrived = 0; let traveling = 0; let idle = 0;
  for (const a of accounts) {
    const info = await toInfo(a.id, a);
    const t = await catTrip.fetchStatus(info);
    await sleep(300);
    if (!t.ok) { console.log(`${a.label} (${a.id}) | ERR ${t.reason}`); continue; }
    if (t.state === 'arrived') arrived += 1;
    else if (t.state === 'traveling') traveling += 1;
    else idle += 1;
    const remain = t.arriveAt && t.serverNow ? Math.max(0, t.arriveAt - t.serverNow) : null;
    console.log([
      `${a.label} (${a.id})`,
      `state=${t.state}`,
      t.location ? `地点=${t.location.name}/${t.location.duration_hours ?? t.durationHours ?? '?'}h` : '',
      `depart=${fmt(t.departAt)}`,
      `arrive=${fmt(t.arriveAt)}`,
      `server_now=${fmt(t.serverNow)}`,
      remain != null ? `剩余=${Math.round(remain / 60)}min` : '',
      `今日已派=${t.dailyLimitReached ? '是(有上限标记)' : '否'}`,
      `奖励=${t.rewardCredit ?? '-'}`,
      t.letter ? '有信件' : '',
      `record=${t.recordId ?? '-'}`,
    ].filter(Boolean).join(' | '));
    if (RAW) console.log('  raw: ' + JSON.stringify(t.raw));
  }
  console.log(`\n汇总：arrived=${arrived} traveling=${traveling} idle=${idle}（账号数 ${accounts.length}）`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
