'use strict';
/**
 * upstream/balance.js — 查询账号剩余积分（权益包）。
 * POST {ug}/trae/api/v2/pay/ide_user_ent_usage
 * body: { require_usage: true, req_source: 1|2 }
 * 解析规则与 SOLO main.js Uje() 一致：汇总 user_entitlement_pack_list 的 remaining。
 */
const store = require('../credentials/store');
const auth = require('../auth');
const legacy = require('../lib/auth');
const headersLib = require('../lib/headers');
const { runPlanned, localDateKey } = require('../lib/util');
const variant = require('../platform/variant');
// 权益包纯计算放在 credentials 域（pool 的 FEFO 排序也要用）；
// 留在本文件会让 credentials 反向依赖 upstream，方向倒置
const { roundCredits, summarizeExpiry } = require('../credentials/credits');

const DEFAULT_UG_HOST = variant.variantOf(variant.TRAE).hosts.ug;
const TIMEOUT_MS = 15000;

function ugHost() {
  if (process.env.TRAE_UG_HOST) return process.env.TRAE_UG_HOST.replace(/\/$/, '');
  return DEFAULT_UG_HOST;
}

async function postUg(acct, apiPath, body) {
  const url = ugHost() + apiPath;
  const headers = headersLib.buildCommonHeaders({
    token: acct.token,
    userId: acct.userId,
    devices: acct.devices,
    // 版本指纹缺失时按登录态选 CN/SG 内置默认值
    _edition: acct.edition || 'cn',
  });
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let data = null;
  try { data = await resp.json(); } catch { data = null; }
  return { ok: resp.ok, status: resp.status, data };
}

/** 从 pack 条目提取有效明细（已过滤 status/is_hide/过期）。 */
function extractActivePacks(packList, nowSec) {
  if (!Array.isArray(packList)) return [];
  const out = [];
  for (const pack of packList) {
    if (!pack || typeof pack !== 'object') continue;
    // status 常为 '1'/1 表示有效；无 status 视为有效
    if (pack.status != null && String(pack.status) !== '1' && String(pack.status).toLowerCase() !== 'active') {
      continue;
    }
    if (pack.is_hide === true) continue;
    const expireTime = typeof pack.expire_time === 'number' ? pack.expire_time : 0;
    if (expireTime > 0 && expireTime < nowSec) continue;

    const quota = pack.entitlement_base_info && pack.entitlement_base_info.quota
      ? pack.entitlement_base_info.quota
      : {};
    const limit = quota.credits_limit;
    const used = pack.usage && typeof pack.usage.credits_amount === 'number'
      ? pack.usage.credits_amount
      : 0;
    const unlimited = limit === -1;
    const remaining = unlimited ? null
      : (typeof limit === 'number' && limit > 0 ? Math.max(limit - used, 0) : 0);

    out.push({
      name: pack.entitlement_base_info && pack.entitlement_base_info.name
        ? String(pack.entitlement_base_info.name)
        : (pack.name ? String(pack.name) : null),
      packId: pack.id != null ? String(pack.id) : null,
      expireTime: expireTime || null,
      limit: unlimited ? null : (typeof limit === 'number' ? limit : null),
      used,
      remaining,
      unlimited,
    });
  }
  return out;
}

/**
 * 解析权益用量。
 * 优先 usage_summary.total_amount - consumed_amount（与官网「总可用积分」一致）。
 * 回退：汇总 status=1 且未过期的 pack remaining。
 * 两条路径均返回 packs 明细（含 expire_time），供临期展示。
 * req_source=2（Lite）才含 Work 专属包；req_source=1 往往只有通用积分。
 */
function parseEntitlementUsage(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload;
  const nowSec = Math.floor(Date.now() / 1000);
  const packList = root.user_entitlement_pack_list || (root.data && root.data.user_entitlement_pack_list) || [];
  const packs = extractActivePacks(packList, nowSec);

  // 1) 官方汇总：total_amount - consumed_amount = 总可用
  const summary = root.usage_summary || (root.data && root.data.usage_summary);
  if (summary
    && typeof summary.total_amount === 'number'
    && typeof summary.consumed_amount === 'number') {
    const remaining = Math.max(summary.total_amount - summary.consumed_amount, 0);
    return {
      limit: summary.total_amount,
      used: summary.consumed_amount,
      remaining,
      isCreditsBilling: root.is_credits_billing === true,
      source: 'usage_summary',
      packs,
    };
  }

  // 2) pack 汇总（与 Uje 一致，并过滤无效/过期包）
  if (!packs.length) return null;

  let limitSum = 0;
  let usedSum = 0;
  let remainingSum = 0;
  let infinite = false;
  let hasCredits = false;

  for (const pack of packs) {
    if (pack.unlimited) {
      hasCredits = true;
      infinite = true;
    } else if (pack.limit != null && pack.limit > 0) {
      hasCredits = true;
      limitSum += pack.limit;
      remainingSum += pack.remaining;
    }
    if (pack.limit != null && pack.limit !== 0) {
      usedSum += pack.used;
    }
  }

  if (!hasCredits) return null;
  return {
    limit: infinite ? Number.POSITIVE_INFINITY : limitSum,
    used: usedSum,
    remaining: infinite ? Number.POSITIVE_INFINITY : remainingSum,
    isCreditsBilling: root.is_credits_billing === true,
    source: 'pack_list',
    packs,
  };
}

/**
 * WorkBuddy 余额：走 billing/meter 资源包（含到期时间）。
 * 与 Trae 权益接口分离，避免 edition 混用。
 */
async function refreshWorkbuddyBalance(stored) {
  const wbAuth = require('../workbuddy/auth');
  const ensured = await auth.ensureAuth(stored.id);
  const info = {
    accessToken: ensured.token || stored.token,
    refreshToken: ensured.refreshToken || stored.refreshToken,
    uid: ensured.userId || stored.userId,
    region: wbAuth.regionOf(ensured.host || stored.host),
  };
  const packsRes = await wbAuth.fetchResourcePacks(info);
  let balance = packsRes.totalRemaining;
  if (!packsRes.packs.length) {
    const check = await wbAuth.verify(info);
    if (!check.valid) throw new Error(check.reason || 'workbuddy verify failed');
    balance = check.balance != null ? check.balance : 0;
  }
  const snapshot = {
    updatedAt: new Date().toISOString(),
    packs: packsRes.packs,
    expiring: summarizeExpiry(packsRes.packs),
  };
  store.update(stored.id, { balance, entitlementSnapshot: snapshot });
  // 积分快照入历史。used 口径：各资源包已用量求和（limit - remaining）。
  //
  // 此前写 null，导致 WorkBuddy 的消耗只能用 remaining 差分推算——而 remaining
  // 会被「权益包到期作废」污染：包过期时 remaining 直接掉一块，但那不是消耗。
  // 实测该口径可达官方账单的 80 倍（783 vs 9.10），面板「今日消耗」因此虚高。
  //
  // pack.used 单调性更好：包作废/用尽时该值下降，credit-history 只累计正向增量，
  // 下降被自然忽略，之后从更低基线继续按真实增量计量——不再把作废读成消耗。
  try {
    const usedSum = packsRes.packs.reduce((s, p) => s + (Number.isFinite(p.used) ? p.used : 0), 0);
    require('../credentials/credit-history').add(stored.id, {
      remaining: balance,
      used: packsRes.packs.length ? roundCredits(usedSum) : null,
      source: 'workbuddy_resources',
    });
  } catch (e) { /* 快照失败不影响余额刷新 */ }
  return {
    accountId: stored.id,
    label: stored.label || stored.id,
    balance: roundCredits(balance),
    // used：各包已用量求和（下界口径，受包轮转影响但不受作废污染）。
    // 无包时保持 null（与「无法计量」区分于「0 消耗」）。
    used: packsRes.packs.length
      ? roundCredits(packsRes.packs.reduce((s, p) => s + (Number.isFinite(p.used) ? p.used : 0), 0))
      : null,
    limit: null,
    isCreditsBilling: true,
    source: 'workbuddy_resources',
    expiring: snapshot.expiring,
    packs: packsRes.packs,
  };
}

/**
 * ZCode 额度刷新：billing/balance（token 计量口径，不是积分）。
 *
 * 口径隔离（重要，勿改回）：ZCode 赠送额度的单位是 token（单包量级 1e8），
 * 而 accounts.balance / entitlement_snapshot.packs / credit_history 三处都是
 * 积分口径（单位 credit，量级 1e3）。此前把 token 数写进这三处，导致
 * /v1/admin/credit-history 的 totalUsed 被单个 ZCode 账号抬高 4 个数量级
 * （实测 86,560,855 tokens 混进约 5,400 credits 的今日消耗里），面板
 * 「可用额度 / 今日消耗」「3 日内到期积分」同样被污染，pool 的 FEFO 排序与
 * 低余额告警读到的也是 token 数。
 * 因此本函数只写 entitlement_snapshot.tokenBuckets（独立键，所有以 .packs
 * 为口径的聚合天然排除），balance 列保持 null，且不写 credit_history。
 * ZCode 的额度展示走 /v1/zcode 的 rewards 快照。
 */
async function refreshZcodeBalance(stored) {
  const rewards = require('../zcode/rewards');
  const r = await rewards.fetchBalance(stored);
  const tokenBuckets = (r.balances || []).map((b) => ({
    name: b.show_name || b.entitlement_id,
    bucketId: b.bucket_id || null,
    planId: b.plan_id || null,
    meter: b.meter || 'model_usage',
    unit: b.unit_type || 'token',
    limit: Number(b.total_units) || 0,
    used: Number(b.used_units) || 0,
    remaining: Number(b.remaining_units) || 0,
    expireTime: Number(b.expires_at) || null,
  }));
  const totalRemaining = tokenBuckets.reduce((s, b) => s + b.remaining, 0);
  // 合并而非整体替换：保留 routes/zcode.js 写入的 lastProbeAt / lastClaimAt
  // （领取历史），否则每轮余额刷新都会把领取记录抹掉。
  const prev = (stored.entitlementSnapshot && typeof stored.entitlementSnapshot === 'object')
    ? stored.entitlementSnapshot
    : {};
  const snapshot = {
    ...prev,
    updatedAt: new Date().toISOString(),
    // 刻意不写 packs：写进去就会被积分口径的聚合（前端 creditTotals、
    // summarizeExpiry/Fefo、credit-alerts、FEFO 排序）吃进去
    tokenBuckets,
    tokenRemaining: totalRemaining,
    plans: r.plans,
  };
  // balance 列（积分）保持 null：ZCode 无积分概念
  store.update(stored.id, { balance: null, entitlementSnapshot: snapshot });
  return {
    accountId: stored.id,
    label: stored.label || stored.id,
    // 积分口径字段一律置空，防止调用方误加
    balance: null,
    used: null,
    limit: null,
    isCreditsBilling: false,
    source: 'zcode_billing_balance',
    unit: 'token',
    tokenRemaining: totalRemaining,
    tokenBuckets,
    expiring: { d3: 0, d7: 0 },
    packs: [],
  };
}

/**
 * Qoder 额度刷新。
 *
 * 口径隔离（与 ZCode 同原则，勿改回）：Qoder 的额度是**多维度**的——
 *   userQuota（基础，300）+ addOnQuota（签到/赠送，100，landing 进本处）
 * 两段独立、不互相包含，且单位虽都是 credit，但 addOnQuota 由每日活动产生，
 * 与 userQuota 的「套餐内基础额度」语义不同。把它俩加总后写进
 * accounts.balance / entitlement_snapshot.packs / credit_history 会污染
 * 既有积分口径（这正是此前 ZCode 踩过的坑——token 数混进 credits）。
 *
 * 因此本函数只把两段额度写进 entitlementSnapshot.quota（独立键，所有以
 * .packs 为口径的聚合天然排除），balance 列保持 null，且不写 credit_history。
 * 面板展示「基础额度 / 赠送额度 / 合计」走 /v1/qoder 的快照。
 */
async function refreshQoderBalance(stored) {
  const rewards = require('../qoder/rewards');
  const q = await rewards.fetchQuota(stored);
  const num = (o) => (o && Number.isFinite(Number(o.remaining)) ? Number(o.remaining) : 0);
  const quota = {
    updatedAt: new Date().toISOString(),
    userType: q.userType,
    usageType: q.usageType,
    // 两段隔离展示，不互相合并
    base: q.base ? {
      total: Number(q.base.total) || 0,
      remaining: Number(q.base.remaining) || 0,
      used: Number(q.base.used) || 0,
      expiresAt: q.base.expiresAt || null,
    } : null,
    addOn: q.addOn ? {
      total: Number(q.addOn.total) || 0,
      remaining: Number(q.addOn.remaining) || 0,
      used: Number(q.addOn.used) || 0,
      expiresAt: q.addOn.expiresAt || null,
    } : null,
    // 仅供面板展示的合计（**不**写进 accounts.balance / credit_history）
    totalRemaining: num(q.base) + num(q.addOn),
    isQuotaExceeded: q.isQuotaExceeded,
  };
  const prev = (stored.entitlementSnapshot && typeof stored.entitlementSnapshot === 'object')
    ? stored.entitlementSnapshot
    : {};
  // 合并：保留 rewards 写入的 lastClaim* 领取历史。
  // 注意 quota 必须作为**嵌套键**写入（而非把 base/addOn 摊平到快照顶层）：
  // routes/credentials.js 的 withExpiry 按 snap.quota 取，摊平后前端读不到。
  const snapshot = { ...prev, quota };
  store.update(stored.id, { balance: null, entitlementSnapshot: snapshot });
  return {
    accountId: stored.id,
    label: stored.label || stored.id,
    balance: null,
    used: null,
    limit: null,
    isCreditsBilling: false,
    source: 'qoder_quota',
    unit: 'credit',
    realm: variant.qoderRealmOfAccount(stored),
    quota,
    expiring: { d3: 0, d7: 0 },
    packs: [],
  };
}

/**
 * 刷新单账号剩余积分并写回 balance（remaining）。
 * 默认 req_source=2（Lite），以包含 Work 专属积分包。
 * 禁用账号也可查询（只读）；批量接口 refreshBalanceAllEnabled 仍只跑 enabled。
 * @param {string} accountId
 */
async function refreshBalance(accountId) {
  const stored = store.get(accountId);
  if (!stored) throw new Error(`account not found: ${accountId}`);
  if (variant.isEdition(stored.edition, variant.WORKBUDDY)) return refreshWorkbuddyBalance(stored);
  // ZCode 账号走自己的 billing/balance（zcode/rewards.js）；这里只做分流
  if (variant.isEdition(stored.edition, variant.ZCODE)) return refreshZcodeBalance(stored);
  // Qoder 账号走自己的 quota 刷新（多维度额度，独立键隔离）
  if (variant.isEdition(stored.edition, variant.QODER)) return refreshQoderBalance(stored);

  const authInfo = await auth.ensureAuth(accountId);
  const acct = { ...stored, ...authInfo };
  if (!acct.token) throw new Error('account has no token');

  const reqSource = Number(process.env.TRAE_ENT_REQ_SOURCE || 2);
  const resp = await postUg(acct, '/trae/api/v2/pay/ide_user_ent_usage', {
    require_usage: true,
    req_source: reqSource,
  });
  if (!resp.ok) {
    throw new Error(`entitlement usage failed: HTTP ${resp.status}`);
  }
  if (resp.data && typeof resp.data.code === 'number' && resp.data.code !== 0) {
    throw new Error(`entitlement usage business error: code=${resp.data.code} ${resp.data.message || ''}`);
  }

  const parsed = parseEntitlementUsage(resp.data);
  if (!parsed) {
    return {
      accountId: acct.id,
      label: acct.label || acct.id,
      balance: null,
      used: null,
      limit: null,
      isCreditsBilling: false,
      expiring: { d3: 0, d7: 0 },
      packs: [],
      note: 'no credits packs in entitlement response',
    };
  }

  const balance = parsed.remaining === Number.POSITIVE_INFINITY
    ? null
    : roundCredits(parsed.remaining);
  const expiring = summarizeExpiry(parsed.packs);
  const snapshot = {
    updatedAt: new Date().toISOString(),
    packs: parsed.packs,
    expiring,
  };
  store.update(acct.id, { balance, entitlementSnapshot: snapshot });
  // 积分快照入历史（供差分统计消耗）
  try {
    require('../credentials/credit-history').add(acct.id, {
      remaining: balance,
      used: parsed.used,
      source: parsed.source,
    });
  } catch (e) { /* 快照失败不影响余额刷新 */ }

  return {
    accountId: acct.id,
    label: acct.label || acct.id,
    balance,
    used: parsed.used,
    limit: parsed.limit === Number.POSITIVE_INFINITY ? null : parsed.limit,
    isCreditsBilling: parsed.isCreditsBilling,
    source: parsed.source,
    reqSource,
    expiring,
    packs: parsed.packs,
  };
}

/**
 * 批量余额刷新的进程级互斥。
 *
 * 此前 jobs/balance-refresh.js 的定时器与 jobs/scheduler.js 签到后的串行刷新
 * 各自维护 running 标志，互不知情，可在同一时刻各跑一轮，造成重复请求上游。
 * 锁提到本模块，所有批量入口共用；单账号 refreshBalance 不受限。
 */
let batchRunning = false;

/** 当前是否有批量刷新在执行。 */
function isBatchRunning() {
  return batchRunning;
}

/**
 * 以互斥方式执行一轮批量刷新。
 * @param {(opts: object) => Promise<object>} fn 实际刷新逻辑
 * @param {object} [opts] 原样传给 fn，同时可含 skipLock 强制执行（内部复用）
 * @returns {Promise<object>} fn 的结果；若因互斥被跳过则返回 {skipped:true, running:true}
 */
async function withBatchLock(fn, opts = {}) {
  if (batchRunning) return { skipped: true, running: true };
  batchRunning = true;
  try {
    return await fn(opts);
  } finally {
    batchRunning = false;
  }
}

/**
 * 刷新全部 enabled 账号余额。
 *
 * 默认按（本地日期, 账号 id）确定性错峰分散，避免多账号同时请求上游权益接口
 * （余额刷新频率高，洪峰更容易触发限流）。spreadMinutes=0 时立即顺序执行。
 *
 * 批量入口受 withBatchLock 互斥保护；内部也可传 skipLock 供已持锁的调用方复用。
 *
 * @param {{windowStartMs?:number, spreadMinutes?:number, skipLock?:boolean}} [opts]
 */
async function refreshBalanceAllEnabled(opts = {}) {
  if (opts.skipLock) return refreshBatch(opts);
  return withBatchLock(refreshBatch, opts);
}

async function refreshBatch(opts) {
  // 只跑「声明了 balance 能力」的启用账号（trae 系 + workbuddy + zcode 均具备；
  // 未来新增无余额概念的平台在此自动排除）
  const variant = require('../platform/variant');
  const accounts = store.list().filter((a) => a.enabled && variant.can(a.edition, 'balance'));
  const ok = [];
  const failed = [];
  const spreadMinutes = Number(opts.spreadMinutes) || 0;
  const windowMs = spreadMinutes > 0 ? spreadMinutes * 60 * 1000 : 0;
  const salt = localDateKey();

  await runPlanned(accounts, {
    keyOf: (a) => a.id,
    run: async (a) => {
      try {
        ok.push(await refreshBalance(a.id));
      } catch (e) {
        failed.push({ id: a.id, label: a.label || a.id, reason: e.message });
      }
    },
    salt,
    windowStartMs: opts.windowStartMs || Date.now(),
    windowMs,
  });
  return { ok, failed, total: accounts.length };
}

module.exports = {
  refreshBalance,
  refreshBalanceAllEnabled,
  refreshQoderBalance,
  isBatchRunning,
  parseEntitlementUsage,
  DEFAULT_UG_HOST,
};
