'use strict';
/**
 * upstream/wb-checkin.js — WorkBuddy 每日签到（status → claim）。
 * 凭据来自 credentials/store（edition=workbuddy），不依赖桌面客户端进程。
 *
 * 上游（见 workbuddy/auth.js）：
 *   POST {billingBase}/v2/billing/meter/checkin-activity-status
 *   POST {billingBase}/v2/billing/meter/daily-checkin
 * 已签到业务码：code=10001 或 msg 含「已签到」，归为 already，不算 claimed。
 */
const store = require('../credentials/store');
const auth = require('../auth');
const wbAuth = require('../workbuddy/auth');
const { runPlanned, localDateKey } = require('../lib/util');
const variant = require('../platform/variant');

const CLAIM_GAP_MS = 2000;
/** 上游业务码：今日已签到。 */
const CODE_ALREADY = variant.variantOf(variant.WORKBUDDY).errors.alreadyCheckedIn[0];

function isWorkbuddy(acct) {
  return acct && acct.edition === 'workbuddy';
}

/** 从 checkin 响应判定是否「已签到」类结果。 */
function isAlreadyResult(ck) {
  if (!ck) return false;
  if (ck.alreadyCheckedIn === true) return true;
  if (ck.code === CODE_ALREADY) return true;
  const m = String(ck.reason || ck.msg || ck.message || '');
  return m.includes('已签到');
}

/** 账号 → 上游 info（ensureAuth 已按 edition 刷新 token）。 */
function toInfo(acct) {
  return {
    accessToken: acct.token || null,
    refreshToken: acct.refreshToken || null,
    uid: acct.userId || null,
    region: wbAuth.regionOf(acct.host),
  };
}

/**
 * 对单个 WorkBuddy 账号执行签到。
 * @param {string} accountId
 * @returns {Promise<object>} 与 Trae checkin 对齐的 result 字段
 */
async function wbCheckinAccount(accountId) {
  const stored = store.get(accountId);
  if (!stored) throw new Error(`account not found: ${accountId}`);
  if (!isWorkbuddy(stored)) throw new Error('not a workbuddy account');
  if (stored.enabled === false) throw new Error('account disabled');

  const ensured = await auth.ensureAuth(accountId);
  const info = toInfo({ ...stored, ...ensured });
  if (!info.accessToken && !info.refreshToken) throw new Error('account has no token');

  const at = new Date().toISOString();
  const result = {
    accountId: stored.id,
    label: stored.label || stored.id,
    checkedIn: false,
    enable: true,
    checkinCredits: null,
    claimed: false,
    at,
  };

  const st = await wbAuth.checkinStatus(info);
  if (!st.ok) {
    store.update(accountId, { lastCheckinAt: at, lastCheckinResult: 'status_fail' });
    throw new Error(`checkin status failed: ${st.reason || 'unknown'}`);
  }

  result.checkedIn = !!st.checkedIn;
  result.enable = st.active !== false;
  result.streakDays = st.streakDays ?? null;
  result.totalCredits = st.totalCredits ?? null;
  result.checkinCredits = st.todayCredit ?? st.dailyCredit ?? null;

  if (!result.enable) {
    store.update(accountId, { lastCheckinAt: at, lastCheckinResult: 'disabled' });
    result.result = 'disabled';
    result.note = 'checkin disabled for account/activity';
    return result;
  }

  if (st.checkedIn) {
    store.update(accountId, { lastCheckinAt: at, lastCheckinResult: 'already' });
    result.result = 'already';
    result.note = 'already checked in';
    return result;
  }

  const ck = await wbAuth.checkin(info);
  if (!ck.ok) {
    if (isAlreadyResult(ck)) {
      store.update(accountId, { lastCheckinAt: at, lastCheckinResult: 'already' });
      result.checkedIn = true;
      result.result = 'already';
      result.note = ck.reason || 'already checked in';
      return result;
    }
    store.update(accountId, { lastCheckinAt: at, lastCheckinResult: 'claim_fail' });
    throw new Error(`checkin claim failed: ${ck.reason || 'unknown'}`);
  }

  if (isAlreadyResult(ck)) {
    store.update(accountId, { lastCheckinAt: at, lastCheckinResult: 'already' });
    result.checkedIn = true;
    result.result = 'already';
    result.note = 'already checked in';
    return result;
  }

  store.update(accountId, { lastCheckinAt: at, lastCheckinResult: 'claimed' });
  result.claimed = true;
  result.checkedIn = true;
  result.result = 'claimed';
  if (ck.credited != null) result.checkinCredits = ck.credited;
  if (ck.streakDays != null) result.streakDays = ck.streakDays;
  if (ck.totalCredits != null) result.totalCredits = ck.totalCredits;
  return result;
}

/**
 * 对所有 enabled 的 WorkBuddy 账号签到。
 *
 * 与 Trae 侧同口径：默认按 (本地日期, 账号id) 确定性错峰分散到时间窗内，
 * 避免多账号同时打上游签到接口。spreadMinutes=0 时退回立即顺序执行。
 *
 * @param {{windowStartMs?:number, spreadMinutes?:number}} [opts]
 */
async function wbCheckinAllEnabled(opts = {}) {
  const accounts = store.list().filter((a) => a.enabled && isWorkbuddy(a));
  const claimed = [];
  const already = [];
  const disabled = [];
  const failed = [];

  const runOne = async (a) => {
    try {
      const r = await wbCheckinAccount(a.id);
      if (r.claimed) claimed.push(r);
      else if (r.result === 'disabled') disabled.push(r);
      else already.push(r);
    } catch (e) {
      console.error(`[wb-checkin] account fail ${a.id}: ${e.message}`);
      failed.push({ id: a.id, label: a.label || a.id, reason: e.message });
    }
  };

  const spreadMinutes = Number(opts.spreadMinutes) || 0;
  const windowMs = spreadMinutes > 0 ? spreadMinutes * 60 * 1000 : 0;
  const salt = localDateKey();

  if (windowMs > 0) {
    console.log(`[wb-checkin] spreading ${accounts.length} accounts over ${spreadMinutes}min window (salt=${salt})`);
  }
  await runPlanned(accounts, {
    keyOf: (a) => a.id,
    run: runOne,
    salt,
    windowStartMs: opts.windowStartMs || Date.now(),
    windowMs,
    gapMs: CLAIM_GAP_MS,
  });

  const ok = [...claimed, ...already, ...disabled];
  const summary = {
    claimed: claimed.length,
    already: already.length,
    disabled: disabled.length,
    failed: failed.length,
  };
  console.log(`[wb-checkin] batch done total=${accounts.length} ${JSON.stringify(summary)}`);
  return {
    claimed,
    already,
    disabled,
    failed,
    ok,
    total: accounts.length,
    summary,
  };
}

module.exports = {
  wbCheckinAccount,
  wbCheckinAllEnabled,
  CODE_ALREADY,
  isAlreadyResult,
  isWorkbuddy,
};
