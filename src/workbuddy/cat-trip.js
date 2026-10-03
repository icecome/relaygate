'use strict';
/**
 * workbuddy/cat-trip.js — WorkBuddy 成长中心上游客户端。
 *
 * 真实上游（本机有效 token 实测确认，2026-09-24），base = https://www.workbuddy.cn：
 *   GET  /activity/growth/buddy/travel/status   → 旅行状态（idle/traveling/arrived）
 *   GET  /activity/growth/buddy/travel/config   → 可派地点目录（时长/奖励区间）
 *   POST /activity/growth/buddy/travel/depart   → 派猫出发（{location_id, duration_hours}）
 *   POST /activity/growth/buddy/travel/claim    → 领取到达奖励
 *   GET  /activity/growth/buddy/info            → 当前 Buddy 卡
 *   GET  /activity/growth/buddy/quota           → 能量与可开箱数
 *   POST /activity/growth/buddy/open            → 消耗能量开 Buddy 盲盒（{count, client_token}）
 *   GET  /activity/growth/tasks                 → 任务列表（code/status）
 *   POST /activity/growth/tasks/accept          → 接单（{task_codes:[], client_token}）
 *   POST /activity/growth/tasks/{code}/claim    → 任务领奖
 *   GET  /activity/growth/streak                → 连登 + 补登卡 + 兑换档位
 *   POST /activity/growth/makeup-cards/use      → 用补登卡（{target_date, client_token}）
 *   GET  /activity/growth/redeem/summary        → 兑换档位状态
 *   POST /activity/growth/redeem                → 兑换（{tier:"7d|14d|28d", client_token}）
 *   GET  /activity/growth/lottery/chances       → 抽奖次数
 *   POST /activity/growth/lottery/draw          → 抽奖（{client_token}）
 *
 * 关键语义（实测）：
 *   - travel.state 权威三态 idle|traveling|arrived；arrived 才有奖可领。
 *   - daily_limit_reached = 今日已派过（≠已领奖），不可当「已领」短路。
 *   - 写接口（depart/claim/redeem/draw/open/accept/makeup）多数需 client_token 幂等键。
 *   - 业务失败走 4xx + JSON 信封：400 invalid request / 403 天数不足 / 409 已兑换 / 400 无机会。
 * 认证：统一头（见 auth.js）+ X-Product-Code: workbuddy；带 /v2 与不带前缀实测均 200。
 */
const crypto = require('crypto');
const wbAuth = require('./auth');
const variant = require('../platform/variant');

const GROWTH_HOST = variant.variantOf(variant.WORKBUDDY).hosts.growth;
const GROWTH_BASE = GROWTH_HOST + '/activity/growth';
const PATH_STATUS = '/buddy/travel/status';
const PATH_CONFIG = '/buddy/travel/config';
const PATH_DEPART = '/buddy/travel/depart';
const PATH_CLAIM = '/buddy/travel/claim';
const PATH_BUDDY_INFO = '/buddy/info';
const PATH_BUDDY_QUOTA = '/buddy/quota';
const PATH_BUDDY_OPEN = '/buddy/open';
const PATH_TASKS = '/tasks';
const PATH_TASKS_ACCEPT = '/tasks/accept';
const PATH_STREAK = '/streak';
const PATH_MAKEUP_USE = '/makeup-cards/use';
const PATH_REDEEM_SUMMARY = '/redeem/summary';
const PATH_REDEEM = '/redeem';
const PATH_LOTTERY_CHANCES = '/lottery/chances';
const PATH_LOTTERY_DRAW = '/lottery/draw';

/** 幂等键：官方前端用 "u-<uuid>"，服务端据此去重。 */
function clientToken() {
  return 'u-' + crypto.randomUUID();
}

function growthHeaders(info) {
  return wbAuth.authHeaders(info, {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'X-Product-Code': 'workbuddy',
    'Origin': GROWTH_HOST,
    'Referer': GROWTH_HOST + '/profile/growth-center',
  });
}

async function readJson(resp) {
  const text = await resp.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 保留原文 */ }
  return { status: resp.status, text, json };
}

/** 请求带 JSON body 的变体（POST depart 需要 Content-Type）。 */
function jsonHeaders(info) {
  return growthHeaders(info);
}

async function doReq(path, info, { method = 'GET', body } = {}) {
  const resp = await fetch(GROWTH_BASE + path, {
    method,
    headers: jsonHeaders(info),
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const { status, text, json } = await readJson(resp);
  // 401 才是登录态失效；403 在成长中心是业务语义（如连登天数不足），必须原样带出
  if (status === 401) {
    return { ok: false, reason: 'token 无效或已过期（HTTP 401）', http: 401, code: 401 };
  }
  if (!json) {
    return { ok: false, reason: '上游异常 HTTP ' + status + ' ' + text.slice(0, 120), http: status };
  }
  const code = json.code != null ? Number(json.code) : 0;
  const msg = json.msg || json.message || '';
  if (code !== 0) {
    return { ok: false, code, reason: msg || ('上游返回 code ' + code), msg, raw: json, http: status };
  }
  return { ok: true, code, data: (json.data && typeof json.data === 'object') ? json.data : {}, raw: json };
}

/** 归一化旅行状态（由 travel/status 的 data 字段）。 */
function normalizeStatus(d) {
  const location = d.location && typeof d.location === 'object'
    ? {
      id: d.location.id ?? null,
      code: d.location.code || null,
      name: d.location.name || null,
      duration_hours: d.location.duration_hours ?? null,
    }
    : null;
  return {
    state: d.state || 'idle',
    buddyId: d.buddy_id ?? null,
    recordId: d.record_id ?? null,
    location,
    departAt: d.depart_at || null,
    arriveAt: d.arrive_at || null,
    serverNow: d.server_now || null,
    letter: d.letter || null,
    useDeeplink: d.use_deeplink || '',
    dailyLimitReached: !!d.daily_limit_reached,
    durationHours: d.duration_hours ?? null,
    rewardCredit: d.reward_credit ?? null,
  };
}

/** 查询当前旅行状态（只读）。 */
async function fetchStatus(info) {
  const r = await doReq(PATH_STATUS, info, { method: 'GET' });
  if (!r.ok) return { ok: false, reason: r.reason, code: r.code, http: r.http, raw: r.raw };
  return { ok: true, ...normalizeStatus(r.data), raw: r.raw };
}

/** 拉取可派地点目录（只读）。 */
async function fetchConfig(info) {
  const r = await doReq(PATH_CONFIG, info, { method: 'GET' });
  if (!r.ok) return { ok: false, reason: r.reason, code: r.code, http: r.http, raw: r.raw };
  const locations = Array.isArray(r.data.locations) ? r.data.locations.map((l) => ({
    id: l.id,
    code: l.code || null,
    name: l.name || null,
    durationHoursMin: l.duration_hours_min ?? null,
    durationHoursMax: l.duration_hours_max ?? null,
    rewardCreditMin: l.reward_credit_min ?? null,
    rewardCreditMax: l.reward_credit_max ?? null,
  })) : [];
  return { ok: true, locations, serverNow: r.data.server_now ?? null, raw: r.raw };
}

/**
 * 派猫出发。body {location_id, duration_hours}。
 * 地点/时长决定奖励（reward_credit）；有每日次数上限。
 */
async function depart(info, body) {
  const locationId = Number(body.location_id);
  const durationHours = Number(body.duration_hours);
  if (!Number.isFinite(locationId) || locationId <= 0) {
    return { ok: false, reason: 'location_id required（先调 config 拿到地点 id）', code: 400 };
  }
  if (!Number.isFinite(durationHours) || durationHours <= 0) {
    return { ok: false, reason: 'duration_hours required 且 > 0', code: 400 };
  }
  const r = await doReq(PATH_DEPART, info, { method: 'POST', body: { location_id: locationId, duration_hours: durationHours } });
  if (!r.ok) {
    if (r.code === 400 && /already traveling/i.test(r.reason)) return { ok: false, code: 400, result: 'already_traveling', reason: r.reason, raw: r.raw };
    if (r.code === 400 && /daily limit reached/i.test(r.reason)) return { ok: false, code: 400, result: 'daily_limit', reason: r.reason, raw: r.raw };
    return { ok: false, code: r.code, reason: r.reason, raw: r.raw };
  }
  return { ok: true, result: 'departed', ...normalizeStatus(r.data), raw: r.raw };
}

/** 领取到达奖励（确认动作）。 */
async function claimTravelReward(info) {
  const resp = await fetch(GROWTH_BASE + PATH_CLAIM, {
    method: 'POST',
    headers: jsonHeaders(info),
    body: '{}',
    signal: AbortSignal.timeout(15000),
  });
  const { status, text, json } = await readJson(resp);

  if (status === 401) {
    return { ok: false, reason: 'token 无效或已过期（HTTP 401）', http: 401, code: 401 };
  }
  if (!json) {
    return { ok: false, reason: '上游异常 HTTP ' + status + ' ' + text.slice(0, 120), http: status };
  }
  const code = json.code != null ? Number(json.code) : 0;
  const msg = json.msg || json.message || '';
  const d = (json.data && typeof json.data === 'object') ? json.data : {};

  if (code === 0) {
    return {
      ok: true,
      code,
      state: d.state || null,
      recordId: d.record_id ?? null,
      rewardCredit: d.reward_credit ?? null,
      letter: d.letter && typeof d.letter === 'object' ? d.letter : null,
      raw: json,
      http: status,
    };
  }
  if (code === 400 && /not arrived yet/i.test(msg)) {
    return { ok: false, code, result: 'not_arrived', reason: msg, raw: json };
  }
  if (code === 400 && /no unclaimed travel/i.test(msg)) {
    return { ok: false, code, result: 'no_unclaimed', reason: msg, raw: json };
  }
  return { ok: false, code, result: 'error', reason: msg || ('上游返回 code ' + code + ' / HTTP ' + status), raw: json };
}

// ---------- Buddy 卡 / 能量盲盒 ----------

/** 当前 Buddy 卡（只读）。 */
async function fetchBuddyInfo(info) {
  const r = await doReq(PATH_BUDDY_INFO, info, { method: 'GET' });
  if (!r.ok) return { ok: false, reason: r.reason, code: r.code };
  const b = r.data.buddy && typeof r.data.buddy === 'object' ? r.data.buddy : {};
  return {
    ok: true,
    name: b.name || null,
    rarity: b.rarity || null,
    personality: b.personality || null,
    soulDesc: b.soul_desc || null,
    instanceId: b.instance_id ?? null,
    baseStaticUrl: b.base_static_url || null,
    pollIntervalSeconds: r.data.poll_interval_seconds ?? null,
  };
}

/** 能量与可开箱数（只读）。 */
async function fetchBuddyQuota(info) {
  const r = await doReq(PATH_BUDDY_QUOTA, info, { method: 'GET' });
  if (!r.ok) return { ok: false, reason: r.reason, code: r.code };
  return {
    ok: true,
    balance: r.data.balance ?? null,
    affordable: r.data.affordable ?? 0,
    costPerOpen: r.data.cost_per_open ?? null,
    maxOpenCount: r.data.max_open_count ?? null,
  };
}

/** 消耗能量开 Buddy 盲盒（写；需 client_token）。 */
async function openBuddyBox(info, count = 1) {
  const n = Number(count) > 0 ? Math.floor(Number(count)) : 1;
  const r = await doReq(PATH_BUDDY_OPEN, info, { method: 'POST', body: { count: n, client_token: clientToken() } });
  if (!r.ok) return { ok: false, code: r.code, reason: r.reason };
  const results = Array.isArray(r.data.results) ? r.data.results : [];
  const names = results.map((x) => {
    const inst = x && x.instance ? x.instance : {};
    return inst.name || x.name || null;
  }).filter(Boolean);
  return { ok: true, count: r.data.count ?? n, results, names };
}

// ---------- 任务 ----------

/** 任务列表（只读）。status: available|accepted|completed|claimed… */
async function fetchTasks(info) {
  const r = await doReq(PATH_TASKS, info, { method: 'GET' });
  if (!r.ok) return { ok: false, reason: r.reason, code: r.code };
  const tasks = Array.isArray(r.data.tasks) ? r.data.tasks.map((t) => ({
    code: t.code || null,
    title: t.title || null,
    status: t.status || null,
    levelName: t.level_name || null,
  })) : [];
  return { ok: true, tasks };
}

/** 批量接单（写；{task_codes:[], client_token}）。 */
async function acceptTasks(info, codes) {
  const list = Array.isArray(codes) ? codes.filter(Boolean).slice(0, 20) : [];
  if (!list.length) return { ok: false, reason: 'task_codes required', code: 400 };
  const r = await doReq(PATH_TASKS_ACCEPT, info, { method: 'POST', body: { task_codes: list, client_token: clientToken() } });
  if (!r.ok) return { ok: false, code: r.code, reason: r.reason };
  const results = Array.isArray(r.data.results) ? r.data.results : [];
  return { ok: true, results };
}

/** 单任务领奖（写；路径带 code，body 空）。 */
async function claimTask(info, code) {
  const c = String(code || '').trim();
  if (!c) return { ok: false, reason: 'task code required', code: 400 };
  const r = await doReq('/tasks/' + encodeURIComponent(c) + '/claim', info, { method: 'POST', body: {} });
  if (!r.ok) {
    if (r.code === 400 && /already|已领/i.test(r.reason)) return { ok: false, code: 400, result: 'already_claimed', reason: r.reason };
    return { ok: false, code: r.code, result: 'error', reason: r.reason };
  }
  return {
    ok: true,
    alreadyClaimed: r.data.already_claimed === true,
    credit: r.data.credit ?? null,
    energy: r.data.energy ?? null,
  };
}

// ---------- 连登 / 补登 / 兑换 ----------

/** 连登状态 + 补登卡 + 兑换档位（只读）。 */
async function fetchStreak(info) {
  const r = await doReq(PATH_STREAK, info, { method: 'GET' });
  if (!r.ok) return { ok: false, reason: r.reason, code: r.code };
  const s = r.data.streak && typeof r.data.streak === 'object' ? r.data.streak : {};
  const cards = r.data.makeup_cards;
  const cardBalance = typeof cards === 'object' && cards ? cards.balance : cards;
  const rs = r.data.redemption_status && typeof r.data.redemption_status === 'object' ? r.data.redemption_status : {};
  return {
    ok: true,
    days: s.days ?? null,
    monthTotalDays: s.month_total_days ?? null,
    nextTier: s.next_tier || null,
    nextTierRemaining: s.next_tier_remaining ?? null,
    makeupDates: Array.isArray(s.makeup_dates) ? s.makeup_dates : [],
    makeupCards: cardBalance ?? 0,
    tiers: Array.isArray(rs.tiers) ? rs.tiers : [],
  };
}

/**
 * 使用补登卡（写；{target_date, client_token}）。
 * /streak 的 makeup_dates 偶尔会列出实际已签到的日期（与 heatmap 不一致），
 * 上游以 400 "date is not broken" 拒绝——属业务常态，非失败。
 */
async function useMakeupCard(info, targetDate) {
  const d = String(targetDate || '').trim();
  if (!d) return { ok: false, reason: 'target_date required', code: 400 };
  const r = await doReq(PATH_MAKEUP_USE, info, { method: 'POST', body: { target_date: d, client_token: clientToken() } });
  if (!r.ok) {
    if (r.code === 400 && /not broken|no makeup needed/i.test(r.reason || '')) {
      return { ok: false, code: 400, result: 'not_broken', reason: r.reason };
    }
    return { ok: false, code: r.code, result: 'error', reason: r.reason };
  }
  const cards = r.data.makeup_cards;
  const left = typeof cards === 'object' && cards ? cards.balance : cards;
  return { ok: true, date: d, cardsLeft: left ?? null };
}

/** 兑换档位状态（只读）。 */
async function fetchRedeemSummary(info) {
  const r = await doReq(PATH_REDEEM_SUMMARY, info, { method: 'GET' });
  if (!r.ok) return { ok: false, reason: r.reason, code: r.code };
  const d = r.data;
  return {
    ok: true,
    tiers: [
      { tier: '7d', status: d.starter_status || null },
      { tier: '14d', status: d.advanced_status || null },
      { tier: '28d', status: d.legendary_status || null },
    ],
    remainingDays: d.remaining_days ?? null,
  };
}

/**
 * 兑换连登奖励（写）。tier 必须是档位标识 "7d"/"14d"/"28d"，
 * 传天数或档位名会 400。403 = 连登天数不足（业务常态，不算失败）。
 */
async function redeemTier(info, tier) {
  const t = String(tier || '').trim();
  if (!['7d', '14d', '28d'].includes(t)) {
    return { ok: false, reason: 'tier must be one of 7d/14d/28d', code: 400 };
  }
  const r = await doReq(PATH_REDEEM, info, { method: 'POST', body: { tier: t, client_token: clientToken() } });
  if (!r.ok) {
    if (r.code === 403) return { ok: false, code: 403, result: 'tier_locked', reason: r.reason };
    if (r.code === 409) return { ok: false, code: 409, result: 'already_redeemed', reason: r.reason };
    return { ok: false, code: r.code, result: 'error', reason: r.reason };
  }
  return {
    ok: true,
    tier: t,
    credit: r.data.credit_granted ?? null,
    energy: r.data.energy_granted ?? null,
  };
}

// ---------- 抽奖 ----------

/** 抽奖次数（只读）。 */
async function fetchLotteryChances(info) {
  const r = await doReq(PATH_LOTTERY_CHANCES, info, { method: 'GET' });
  if (!r.ok) return { ok: false, reason: r.reason, code: r.code };
  return { ok: true, balance: r.data.balance ?? 0 };
}

/** 抽奖（写；{client_token}）。 */
async function drawLottery(info) {
  const r = await doReq(PATH_LOTTERY_DRAW, info, { method: 'POST', body: { client_token: clientToken() } });
  if (!r.ok) {
    if (r.code === 400 && /chance/i.test(r.reason)) return { ok: false, code: 400, result: 'no_chance', reason: r.reason };
    return { ok: false, code: r.code, result: 'error', reason: r.reason };
  }
  const prize = r.data.prize_name || r.data.prize || null;
  return {
    ok: true,
    prize: typeof prize === 'string' ? prize : (prize == null ? null : String(prize)),
    needAddress: r.data.need_address === true || r.data.require_address === true,
  };
}

module.exports = {
  fetchStatus,
  fetchConfig,
  depart,
  claimTravelReward,
  fetchBuddyInfo,
  fetchBuddyQuota,
  openBuddyBox,
  fetchTasks,
  acceptTasks,
  claimTask,
  fetchStreak,
  useMakeupCard,
  fetchRedeemSummary,
  redeemTier,
  fetchLotteryChances,
  drawLottery,
  clientToken,
  GROWTH_HOST,
  GROWTH_BASE,
  PATH_STATUS,
  PATH_CONFIG,
  PATH_DEPART,
  PATH_CLAIM,
};