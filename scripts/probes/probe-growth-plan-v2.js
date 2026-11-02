'use strict';
/**
 * probes/probe-growth-plan-v2.js — WorkBuddy「成长计划」任务中心（v2）只读探测。
 *
 * 与 probe-growth-plan.js 的区别：v1 的 `/activity/growth/tasks` 只返回 5 个新手徽章任务；
 * 任务中心页面用的是 **`/v2/activity/growth/tasks`**，带 accept_status / progress /
 * valid_start / valid_end（到期时间）/ reward_* 等完整字段，并含「进阶任务区」的手动领取任务。
 *
 * 安全：全部为只读 GET，不调用 accept / claim。
 *
 * 用法：node scripts/probes/probe-growth-plan-v2.js [--json out.json]
 */
const fs = require('fs');
const store = require('../../src/credentials/store');
const auth = require('../../src/auth');
const wbAuth = require('../../src/workbuddy/auth');
const variant = require('../../src/platform/variant');
const { sleep } = require('../../src/lib/util');

const G = variant.variantOf(variant.WORKBUDDY).hosts.growth;
const READS = {
  tasks: '/v2/activity/growth/tasks',
  subscribeStatus: '/v2/activity/growth/subscribe-task/status',
  profile: '/v2/activity/growth/profile',
  badges: '/v2/activity/growth/badges',
  streak: '/activity/growth/streak',
};

const argv = process.argv.slice(2);
const i = argv.indexOf('--json');
const OUT = i >= 0 ? argv[i + 1] : null;

async function toInfo(id) {
  const s = store.get(id);
  let e = {};
  try { e = (await auth.ensureAuth(id)) || {}; } catch { /* 库内 token 兜底 */ }
  return {
    accessToken: e.token || s.token,
    refreshToken: e.refreshToken || s.refreshToken,
    uid: e.userId || s.userId,
    region: wbAuth.regionOf(e.host || s.host),
  };
}

function hdrs(info) {
  return wbAuth.authHeaders(info, {
    Accept: 'application/json, text/plain, */*',
    'X-Product-Code': 'workbuddy',
    Origin: G,
    Referer: G + '/profile/growth-space',
  });
}

async function get(p, info) {
  try {
    const r = await fetch(G + p, { headers: hdrs(info), signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 保留文本 */ }
    return { http: r.status, json, text: json ? undefined : text.slice(0, 300) };
  } catch (e) {
    return { http: 0, error: e.message };
  }
}

(async () => {
  const accounts = store.list().filter((a) => a.edition === 'workbuddy');
  const out = { at: new Date().toISOString(), host: G, count: accounts.length, accounts: [] };
  for (const a of accounts) {
    const rec = { id: a.id, label: a.label, uid: a.userId, reads: {} };
    const info = await toInfo(a.id);
    rec.tokenOk = !!info.accessToken;
    for (const [name, p] of Object.entries(READS)) {
      rec.reads[name] = await get(p, info);
      await sleep(250);
    }
    const t = ((rec.reads.tasks.json || {}).data || {}).tasks || [];
    out.accounts.push(rec);
    console.log(`${a.label} | tasks=${t.length} | http=${rec.reads.tasks.http}`);
  }
  const target = OUT || 'C:\\opt\\workstations\\project\\web\\_wbtmp\\growth_v2.json';
  fs.writeFileSync(target, JSON.stringify(out, null, 2), 'utf-8');
  console.log('written: ' + target);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
