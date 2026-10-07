'use strict';
/**
 * upstream/checkin.js — Trae 每日签到（status / claim）。
 * 域：默认 https://api.trae.cn（UG），与 agent mchost 分离；可用 TRAE_UG_HOST 覆盖。
 *
 * 上游为设备维度限签：同 x-device-id 当日仅可 claim 一次。
 * 业务判定必须看 data.code（HTTP 200 仍可能是 9095 已签到）。
 */
const store = require('../credentials/store');
const auth = require('../auth');
const legacy = require('../lib/auth');
const headersLib = require('../lib/headers');
const { ensureAccountDevices } = require('../credentials/import');
const { sleep, runPlanned, localDateKey } = require('../lib/util');
const variant = require('../platform/variant');

// 域名与业务码统一从 platform/variant.js 取（单一事实源）
const DEFAULT_UG_HOST = variant.variantOf(variant.TRAE).hosts.ug;
const TIMEOUT_MS = 15000;
const CLAIM_GAP_MS = 2500;
const RATE_RETRY = 3;
/** 9074 实测较顽固，退避需拉长；第 1/2/3 次重试约 +5s/+10s/+20s。 */
const RATE_RETRY_DELAY_MS = 5000;

/** 上游业务码：设备/账号今日已签到。 */
const CODE_ALREADY = variant.variantOf(variant.TRAE).errors.alreadyCheckedIn[0];
/** 上游业务码：参与用户过多，可稍后重试。 */
const CODE_BUSY = variant.variantOf(variant.TRAE).errors.busy;
const PATHS = variant.variantOf(variant.TRAE).paths;
const ERRORS = variant.variantOf(variant.TRAE).errors;

function ugHost() {
  if (process.env.TRAE_UG_HOST) return process.env.TRAE_UG_HOST.replace(/\/$/, '');
  return DEFAULT_UG_HOST;
}

async function postUg(acct, apiPath) {
  const url = ugHost() + apiPath;
  const headers = headersLib.buildCommonHeaders({
    token: acct.token,
    userId: acct.userId,
    devices: acct.devices,
  });
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let data = null;
  try { data = await resp.json(); } catch { data = null; }
  return { ok: resp.ok, status: resp.status, data, url };
}

/**
 * 解析 status/claim 业务响应。
 * @returns {{code:number, message:string, enable:boolean, checkedIn:boolean, credits:number|null, raw:object}}
 */
function pickCheckinFields(data) {
  const root = (data && typeof data === 'object') ? data : {};
  // 兼容 data.data 包裹；无 data 包裹时直接用根对象
  const d = (root.data && typeof root.data === 'object') ? root.data : root;
  const code = Number(root.code ?? d.code ?? 0);
  const message = String(root.message ?? d.message ?? root.msg ?? d.msg ?? '');
  // checked_in 表示「本账号今日是否已签」；did_checked_in 仅作缺省兜底，避免设备侧字段抢占
  let checkedIn;
  if (d.checked_in !== undefined) checkedIn = !!d.checked_in;
  else if (d.checkedIn !== undefined) checkedIn = !!d.checkedIn;
  else checkedIn = !!(d.did_checked_in ?? d.didCheckedIn);
  const enable = d.enable !== false && d.enabled !== false;
  const credits = typeof d.credits === 'number'
    ? d.credits
    : (typeof root.credits === 'number' ? root.credits : null);
  return {
    code: Number.isFinite(code) ? code : 0,
    message,
    enable,
    checkedIn,
    credits,
    raw: root,
  };
}

/** 是否为「今日/设备已签到」类业务失败（非系统错误）。 */
function isAlreadyCode(code, message) {
  if (code === CODE_ALREADY) return true;
  const m = String(message || '');
  return (ERRORS.alreadyText || []).some((x) => m.includes(x));
}

function alreadyResult(acctId, label, note, checkinCredits, at, resultTag) {
  store.update(acctId, {
    lastCheckinAt: at,
    lastCheckinResult: resultTag,
  });
  return {
    accountId: acctId,
    label,
    checkedIn: true,
    enable: true,
    checkinCredits,
    claimed: false,
    at,
    note,
    result: resultTag,
  };
}

/** claim code=0 后回读 status，确认账号级已签，避免误标 claimed。 */
async function confirmCheckedIn(acct) {
  try {
    const st = await postUg(acct, PATHS.checkinStatus);
    if (!st.ok) return null;
    const fields = pickCheckinFields(st.data);
    if (fields.code !== 0) return fields;
    return fields;
  } catch (e) {
    console.warn(`[checkin] confirm status fail account=${acct.id}: ${e.message}`);
    return null;
  }
}

/**
 * 对单个账号执行：确保 token → status → 未领取则 claim。
 * 成功仅当 claim 业务码为 0；9095 归为 already/device_already，不报成功领取。
 * @param {string} accountId
 * @returns {Promise<object>}
 */
async function checkinAccount(accountId) {
  const stored = store.get(accountId);
  if (!stored) throw new Error(`account not found: ${accountId}`);
  if (stored.enabled === false) throw new Error('account disabled');

  const authInfo = await auth.ensureAuth(accountId);
  let acct = { ...stored, ...authInfo };
  if (!acct.token) throw new Error('account has no token');

  // 旧账号 devices 缺失时先回填，避免多账号共用本机指纹导致只能签一次
  if (!acct.devices || !acct.devices.machineId || !acct.devices.devDeviceId) {
    ensureAccountDevices(acct.id);
    acct = { ...acct, ...(store.get(acct.id) || {}) };
  }

  const st = await postUg(acct, PATHS.checkinStatus);
  if (!st.ok) {
    console.error(`[checkin] status HTTP ${st.status} account=${acct.id}`);
    throw new Error(`checkin status failed: HTTP ${st.status}`);
  }
  const status = pickCheckinFields(st.data);
  if (status.code !== 0) {
    console.error(`[checkin] status code=${status.code} account=${acct.id} msg=${status.message}`);
    throw new Error(`checkin status failed: code=${status.code} ${status.message}`.trim());
  }

  const result = {
    accountId: acct.id,
    label: acct.label || acct.id,
    checkedIn: status.checkedIn,
    enable: status.enable,
    checkinCredits: status.credits,
    claimed: false,
    at: new Date().toISOString(),
  };

  if (!status.enable) {
    store.update(acct.id, {
      lastCheckinAt: result.at,
      lastCheckinResult: 'disabled',
    });
    result.note = 'checkin disabled for account/activity';
    result.result = 'disabled';
    return result;
  }

  // 今日已签（账号或设备）：不再 claim，避免误报成功
  if (status.checkedIn) {
    store.update(acct.id, {
      lastCheckinAt: result.at,
      lastCheckinResult: 'already',
    });
    result.note = 'already checked in';
    result.result = 'already';
    return result;
  }

  // claim：对 9074（人多/节流）指数退避重试；其余业务错误直接失败
  let claim = null;
  let claimed = null;
  for (let attempt = 0; attempt <= RATE_RETRY; attempt++) {
    if (attempt > 0) {
      const delay = RATE_RETRY_DELAY_MS * (2 ** (attempt - 1));
      console.warn(`[checkin] claim busy code=${CODE_BUSY} wait ${delay}ms retry ${attempt}/${RATE_RETRY} account=${acct.id}`);
      await sleep(delay);
    }
    claim = await postUg(acct, PATHS.checkinClaim);
    if (!claim.ok) {
      console.error(`[checkin] claim HTTP ${claim.status} account=${acct.id}`);
      store.update(acct.id, { lastCheckinAt: result.at, lastCheckinResult: `claim_http_${claim.status}` });
      const err = new Error(`checkin claim failed: HTTP ${claim.status}`);
      err.status = claim.status;
      throw err;
    }
    claimed = pickCheckinFields(claim.data);
    if (claimed.code === CODE_BUSY && attempt < RATE_RETRY) continue;
    break;
  }

  // HTTP 200 + 9095：设备/今日已签，不能算 claimed
  if (claimed.code !== 0) {
    const at = result.at;
    if (isAlreadyCode(claimed.code, claimed.message)) {
      const note = claimed.message || 'already checked in (device/account)';
      console.warn(`[checkin] claim already code=${claimed.code} account=${acct.id} ${note}`);
      return alreadyResult(
        acct.id,
        result.label,
        note,
        status.credits,
        at,
        claimed.code === CODE_ALREADY ? 'device_already' : 'already',
      );
    }
    store.update(acct.id, {
      lastCheckinAt: at,
      lastCheckinResult: `claim_code_${claimed.code}`,
    });
    console.error(`[checkin] claim code=${claimed.code} account=${acct.id} msg=${claimed.message}`);
    const err = new Error(`checkin claim failed: code=${claimed.code} ${claimed.message}`.trim());
    err.status = claim.status;
    throw err;
  }

  // code=0 后回读 status：若账号级仍为未签，不标 claimed（防假成功）
  const confirmed = await confirmCheckedIn(acct);
  if (confirmed && confirmed.code === 0 && confirmed.checkedIn === false) {
    console.warn(`[checkin] claim code=0 but status still unchecked account=${acct.id}`);
    store.update(acct.id, {
      lastCheckinAt: result.at,
      lastCheckinResult: 'claim_unconfirmed',
    });
    const err = new Error('checkin claim returned success but status still unchecked');
    throw err;
  }

  store.update(acct.id, {
    lastCheckinAt: result.at,
    lastCheckinResult: 'claimed',
  });
  result.claimed = true;
  result.checkedIn = true;
  result.result = 'claimed';
  // 签到积分仅在 result 中返回，不写 balance（balance=权益剩余）
  if (claimed.credits != null) result.checkinCredits = claimed.credits;
  else if (status.credits != null) result.checkinCredits = status.credits;
  if (confirmed && confirmed.credits != null) result.checkinCredits = confirmed.credits;
  return result;
}

/**
 * 对所有 enabled 的 Trae 账号签到。
 *
 * 默认按 (本地日期, 账号id) 确定性错峰：账号在同一时间窗内分散触发，
 * 避免固定时刻批量打上游自造洪峰；窗口由 checkinSpreadMinutes 控制
 * （0=关闭，退回原先的「立即顺序执行」行为）。
 *
 * 错峰偏移与调用时刻无关，因此同日重跑（手动触发、重启后补跑）会落在
 * 同一时刻，天然幂等；上游另有「已签到」业务码兜底，重复调用不会重复领取。
 *
 * @param {{windowStartMs?:number, spreadMinutes?:number}} [opts]
 */
async function checkinAllEnabled(opts = {}) {
  // 只跑 Trae 系账号（显式白名单）。不能写 edition !== 'workbuddy'：
  // 那会把新平台（如 zcode）的账号误抓进 Trae 签到链。
  const accounts = store.list().filter((a) => a.enabled && variant.isTrae(a.edition));
  const claimed = [];
  const already = [];
  const disabled = [];
  const failed = [];
  const busyRetry = [];

  const runOne = async (a) => {
    try {
      const r = await checkinAccount(a.id);
      if (r.claimed) claimed.push(r);
      else if (r.result === 'disabled' || r.note === 'checkin disabled for account/activity') disabled.push(r);
      else already.push(r);
    } catch (e) {
      console.error(`[checkin] account fail ${a.id}: ${e.message}`);
      const item = { id: a.id, label: a.label || a.id, reason: e.message };
      if (e.message && e.message.includes(`code=${CODE_BUSY}`)) busyRetry.push(item);
      else failed.push(item);
    }
  };

  const spreadMinutes = Number(opts.spreadMinutes) || 0;
  const windowMs = spreadMinutes > 0 ? spreadMinutes * 60 * 1000 : 0;
  const salt = localDateKey();

  if (windowMs > 0) {
    console.log(`[checkin] spreading ${accounts.length} accounts over ${spreadMinutes}min window (salt=${salt})`);
  }
  await runPlanned(accounts, {
    keyOf: (a) => a.id,
    run: runOne,
    salt,
    windowStartMs: opts.windowStartMs || Date.now(),
    windowMs,
    gapMs: CLAIM_GAP_MS,
  });

  // 9074：全部账号走完后再串行补跑一轮（错开高峰）
  if (busyRetry.length) {
    console.warn(`[checkin] retry busy accounts: ${busyRetry.map((x) => x.label).join(', ')}`);
    await sleep(RATE_RETRY_DELAY_MS * 2);
    for (const item of busyRetry) {
      try {
        const r = await checkinAccount(item.id);
        if (r.claimed) claimed.push(r);
        else if (r.result === 'disabled') disabled.push(r);
        else already.push(r);
      } catch (e) {
        console.error(`[checkin] busy-retry fail ${item.id}: ${e.message}`);
        failed.push(item);
      }
      await sleep(CLAIM_GAP_MS);
    }
  }

  // ok = 未失败的历史兼容（含 already/disabled），供旧调用方
  const ok = [...claimed, ...already, ...disabled];
  const summary = {
    claimed: claimed.length,
    already: already.length,
    disabled: disabled.length,
    failed: failed.length,
  };
  console.log(`[checkin] batch done total=${accounts.length} ${JSON.stringify(summary)}`);
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
  checkinAccount,
  checkinAllEnabled,
  ugHost,
  DEFAULT_UG_HOST,
  pickCheckinFields,
  CODE_ALREADY,
};
