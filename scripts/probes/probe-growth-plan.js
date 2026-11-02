'use strict';
/**
 * probes/probe-growth-plan.js — WorkBuddy「成长计划」全账号只读探测。
 *
 * 用途：列出一批 WorkBuddy 账号在成长计划里的剩余任务、连登/兑换/旅行/能量/抽奖状态，
 * 以及各类到期时间（任务是否带截止、登录态 expiresAt、签到活动 end_time、积分包 FEFO 最近到期）。
 *
 * 安全：**只发只读请求**（GET / 幂等的 POST 查询），不调用 accept / claim / depart /
 * redeem / draw / open 等任何写接口，因此不会消耗次数、不会改上游状态。
 *
 * 用法：
 *   node scripts/probes/probe-growth-plan.js [--json out.json]
 * 依赖：credentials/store 里已导入 edition=workbuddy 的账号（凭据库同网关）。
 */
const fs = require('fs');
const path = require('path');
const store = require('../../src/credentials/store');
const auth = require('../../src/auth');
const wbAuth = require('../../src/workbuddy/auth');
const variant = require('../../src/platform/variant');
const { sleep } = require('../../src/lib/util');

const V = variant.variantOf(variant.WORKBUDDY);
const GROWTH = V.hosts.growth;                 // https://www.workbuddy.cn
const BILLING = V.hosts.billing.cn;            // https://www.codebuddy.cn
const BASE = GROWTH + '/activity/growth';

/** 只读端点清单：name → [url, method] */
const READS = {
  tasks: [BASE + '/tasks', 'GET'],
  streak: [BASE + '/streak', 'GET'],
  redeemSummary: [BASE + '/redeem/summary', 'GET'],
  travelStatus: [BASE + '/buddy/travel/status', 'GET'],
  buddyQuota: [BASE + '/buddy/quota', 'GET'],
  buddyInfo: [BASE + '/buddy/info', 'GET'],
  lotteryChances: [BASE + '/lottery/chances', 'GET'],
  heatmap: [BASE + '/heatmap', 'GET'],
  checkinActivity: [BILLING + '/v2/billing/meter/checkin-activity-status', 'POST'],
};

const argv = process.argv.slice(2);
const jsonFlag = argv.indexOf('--json');
const OUT = jsonFlag >= 0 ? argv[jsonFlag + 1] : null;

/** 账号 → 上游请求 info（ensureAuth 会按 edition 刷新过期 token）。 */
async function toInfo(accountId) {
  const stored = store.get(accountId);
  let ensured = {};
  try { ensured = (await auth.ensureAuth(accountId)) || {}; } catch { /* 用库里的 token 兜底 */ }
  return {
    accessToken: ensured.token || stored.token,
    refreshToken: ensured.refreshToken || stored.refreshToken,
    uid: ensured.userId || stored.userId,
    region: wbAuth.regionOf(ensured.host || stored.host),
  };
}

function headers(info) {
  return wbAuth.authHeaders(info, {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'X-Product-Code': 'workbuddy',
    Origin: GROWTH,
    Referer: GROWTH + '/profile/growth-center',
  });
}

async function read(url, method, info) {
  try {
    const h = headers(info);
    if (method === 'POST') h['Content-Type'] = 'application/json';
    const r = await fetch(url, {
      method,
      headers: h,
      body: method === 'POST' ? '{}' : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 保留文本 */ }
    return { http: r.status, json, text: json ? undefined : text.slice(0, 300) };
  } catch (e) {
    return { http: 0, error: e.message };
  }
}

async function main() {
  const accounts = store.list().filter((a) => a.edition === 'workbuddy');
  const out = { at: new Date().toISOString(), growthHost: GROWTH, billingHost: BILLING, count: accounts.length, accounts: [] };

  for (const a of accounts) {
    const raw = store.get(a.id);
    const rec = {
      id: a.id,
      label: a.label,
      uid: raw.userId,
      enabled: !!a.enabled,
      tokenExpiredAt: raw.expiredAt || null,
      refreshExpiredAt: raw.refreshExpiredAt || null,
      reads: {},
      packs: [],
    };
    let info;
    try {
      info = await toInfo(a.id);
    } catch (e) {
      rec.error = 'ensureAuth: ' + e.message;
      out.accounts.push(rec);
      continue;
    }
    if (!info.accessToken) {
      rec.error = 'no access token';
      out.accounts.push(rec);
      continue;
    }
    for (const [name, [url, method]] of Object.entries(READS)) {
      rec.reads[name] = await read(url, method, info);
      await sleep(250);
    }
    try {
      const packs = await wbAuth.fetchResourcePacks(info);
      rec.packs = (packs.packs || packs.packages || []).filter((p) => (p.remaining || 0) > 0);
    } catch (e) {
      rec.packsError = e.message;
    }
    await sleep(300);
    out.accounts.push(rec);
    const t = (rec.reads.tasks.json || {}).data || {};
    console.log(`${a.label} | tasks=${(t.tasks || []).length} | tokenExp=${rec.tokenExpiredAt} | packs=${rec.packs.length}`);
  }

  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf-8');
    console.log('written: ' + OUT);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
  console.log(`\n(done, ${out.count} accounts, ${path.basename(__filename)})`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
