'use strict';
/**
 * upstream/balance.js — 查询账号剩余积分（权益包）。
 * POST {ug}/trae/api/v2/pay/ide_user_ent_usage
 * body: { require_usage: true, req_source: 1|2 }
 * 解析规则对齐 SOLO main.js Uje()：汇总 user_entitlement_pack_list 的 remaining。
 */
const store = require('../credentials/store');
const auth = require('../auth');
const legacy = require('../lib/auth');
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
  const headers = legacy.buildCommonHeaders({
    token: acct.token,
    userId: acct.userId,
    devices: acct.devices,
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

  // 2) pack 汇总（对齐 Uje，并过滤无效/过期包）
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
  try {
    require('../credentials/credit-history').add(stored.id, {
      remaining: balance,
      used: null,
      source: 'workbuddy_resources',
    });
  } catch (e) { /* 快照失败不影响余额刷新 */ }
  return {
    accountId: stored.id,
    label: stored.label || stored.id,
    balance: roundCredits(balance),
    used: null,
    limit: null,
    isCreditsBilling: true,
    source: 'workbuddy_resources',
    expiring: snapshot.expiring,
    packs: packsRes.packs,
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
  if (stored.edition === 'workbuddy') return refreshWorkbuddyBalance(stored);

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
 * 刷新全部 enabled 账号余额。
 *
 * 默认按 (本地日期, 账号id) 确定性错峰分散，避免多账号同时打上游权益接口
 * （余额刷新频率高，洪峰更容易触发限流）。spreadMinutes=0 时立即顺序执行。
 *
 * @param {{windowStartMs?:number, spreadMinutes?:number}} [opts]
 */
async function refreshBalanceAllEnabled(opts = {}) {
  const accounts = store.list().filter((a) => a.enabled);
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
  parseEntitlementUsage,
  summarizeExpiry,
  roundCredits,
  DEFAULT_UG_HOST,
};
