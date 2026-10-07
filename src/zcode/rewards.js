'use strict';
/**
 * zcode/rewards.js — ZCode 限时套餐（赠送额度）探测与领取。
 *
 * 链路（与官方客户端 billing 面同源，实证见 docs 与 zcode2api/app/claim.py）：
 *   1. POST /api/v1/event/report  ×2（app_launch / app_daily_active）
 *      —— 官方客户端启动与日活上报。上游据此判定「活跃用户」，
 *         是活动套餐投放资格的疑似信号；不带上报时常出现「客户端可见活动、
 *         preview 却为空」。无 Authorization，失败不阻断后续步骤。
 *   2. GET  /api/v1/zcode-plan/billing/preview?app_version=
 *      —— 返回当前账号「可领取」的套餐列表（plans[]）。已领取过则为空。
 *   3. POST /api/v1/zcode-plan/billing/claim  {plan_id}
 *      —— 领取。强制校验阿里云无感验证码（X-Aliyun-Captcha-Verify-Param
 *         + -Region），缺失/伪造一律 code 3007。
 *
 * 业务码语义（上游实证，映射为用户文案）：
 *   1001 套餐不存在或已下架     1002 活动结束或暂不可领取
 *   1003 已领取过（幂等，视为成功跳过）
 *   1004 不符合领取条件         1005 今日名额已用完
 *   3001 参数错误               3007 验证码校验失败（换码重试一次）
 *   3012 真风控 unusual activity（隔离账号）
 *
 * 职责边界：本模块只做「取数 + 领取 + 落库」，不含定时策略（jobs/zcode-rewards.js）
 * 与 HTTP 暴露（routes/zcode.js）。
 */
const store = require('../credentials/store');
const variant = require('../platform/variant');
const identity = require('./identity');
const fingerprint = require('./fingerprint');
const { request, unwrap, ZCodeApiError } = require('./client');
const captcha = require('./captcha');

const V = variant.variantOf(variant.ZCODE);
const ERR = V.errors;

/** 领取失败的用户文案（上游码 → 中文）。 */
const CLAIM_FAIL_TEXT = {
  [ERR.planNotFound]: '套餐不存在或已下架',
  [ERR.campaignEnded]: '活动已结束或套餐暂不可领取',
  [ERR.alreadyClaimed]: '该套餐已领取过',
  [ERR.ineligible]: '当前账号或客户端版本不符合领取条件',
  [ERR.quotaExhausted]: '今日领取名额已用完',
  [ERR.paramError]: '领取参数错误，请刷新后重试',
  [ERR.captchaFailed]: '验证码校验失败，请重试',
  401: '请先登录后再领取',
  [ERR.riskControl]: '账号被风控拦截（unusual activity），已停止自动化',
};

/** 领取结果语义（供调用方分流，不用字符串判断）。 */
const CLAIM_RESULT = Object.freeze({
  CLAIMED: 'claimed',
  ALREADY: 'already',
  FAILED: 'failed',
  RISK: 'risk',
});

/** 是否为 ZCode 账号（显式比较，不兜底）。 */
function isZcode(acct) {
  return !!acct && variant.isEdition(acct.edition, variant.ZCODE);
}

/** 账号是否具备走 billing 面的凭据。 */
function billingBlockReason(acct, { action = '操作' } = {}) {
  if (!isZcode(acct)) return `非 ZCode 账号，已跳过${action}`;
  if (!acct.enabled) return `账号已停用，已跳过${action}`;
  if (!String(acct.token || '').trim()) return `账号缺少 JWT 凭据，已跳过${action}`;
  return null;
}

/** 码 → 文案。 */
function failText(code, msg) {
  const base = CLAIM_FAIL_TEXT[code] || '领取失败';
  const server = String(msg || '').trim();
  return server ? `${base}（${server}）` : base;
}

/** 解析 preview 的套餐项（只保留 token 计量口径的授权项）。 */
function parsePlan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const planId = String(raw.plan_id || raw.planId || '').trim();
  if (!planId) return null;
  const grants = [];
  for (const ent of Array.isArray(raw.entitlements) ? raw.entitlements : []) {
    if (!ent || typeof ent !== 'object') continue;
    if (ent.meter !== 'model_usage' || ent.unit_type !== 'token') continue;
    const name = String(ent.show_name || ent.showName || '').trim();
    if (!name) continue;
    grants.push({
      name,
      units: Number(ent.grant_units || ent.grantUnits || 0) || 0,
      period: String(ent.period || 'one_time'),
      capabilities: Array.isArray(ent.capabilities) ? ent.capabilities : [],
    });
  }
  return {
    planId,
    name: String(raw.name || '').trim(),
    description: String(raw.description || '').trim(),
    priority: Number(raw.priority) || 0,
    grants,
  };
}

/**
 * 上报激活事件（官方客户端启动/日活）。
 * 失败只记录，不阻断——它只是「疑似」资格信号，且日活键在上游按
 * device_mid + 日期去重，重试无意义。
 * @returns {Promise<{ok:string[], failed:string[]}>}
 */
async function reportActivation(acct) {
  const fp = fingerprint.profileFor(acct, (fresh) => {
    try { store.update(acct.id, { fingerprint: fresh }); } catch { /* 落库失败不阻断 */ }
  });
  const userId = jwtUserId(acct.token);
  const result = { ok: [], failed: [] };
  if (!userId) {
    result.failed.push('JWT 无 user_id，跳过激活上报');
    return result;
  }
  for (const element of V.activationElements) {
    const body = buildActivationEvent(element, fp, userId);
    try {
      // eslint-disable-next-line no-await-in-loop
      const envelope = await request({
        method: 'POST',
        path: V.paths.eventReport,
        headers: identity.eventHeaders(),
        body,
        timeoutMs: 10000,
      });
      if (envelope && Number(envelope.code) === 0) result.ok.push(element);
      else result.failed.push(`${element}: code=${envelope && envelope.code}`);
    } catch (e) {
      result.failed.push(`${element}: ${e.message}`);
    }
  }
  return result;
}

/** 官方 sendReport 的 16 字段事件体（字段集固定，不可增删）。 */
function buildActivationEvent(element, fp, userId) {
  const crypto = require('crypto');
  return {
    event_id: crypto.randomUUID(),
    client_timezone: fp.timezone,
    client_language: fp.language,
    element_name: element,
    event_region: 'app',
    event_type: 'view',
    event_text: '',
    event_extra_detail: {},
    user_id: userId,
    screen_resolution: fp.screen,
    app_version: identity.appVersion(),
    device_os_category: fingerprint.osCategory(fp),
    device_os_version: fp.osVersion,
    device_mid: fp.deviceMid,
    mac_id: '',
    marketing_params: '{}',
  };
}

/** 从 JWT 解出 user_id（sub 兜底）；不校验签名（只读取自己存的凭据）。 */
function jwtUserId(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  const seg = t.split('.')[1];
  if (!seg) return null;
  try {
    const payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf-8'));
    const uid = payload.user_id || payload.sub;
    return uid != null && String(uid).trim() ? String(uid).trim() : null;
  } catch {
    return null;
  }
}

/**
 * 拉取当前账号可领取的套餐（按优先级降序）。
 * @returns {Promise<Array<object>>}
 */
async function previewPlans(acct) {
  const blocked = billingBlockReason(acct, { action: '查询' });
  if (blocked) throw new ZCodeApiError(blocked, { code: null });
  const envelope = await request({
    method: 'GET',
    path: V.paths.billingPreview,
    headers: buildBillingHeaders(acct),
    query: { app_version: identity.appVersion() },
  });
  const data = unwrap(envelope, { method: 'GET', path: V.paths.billingPreview });
  const raw = Array.isArray(data && data.plans) ? data.plans : [];
  return raw.map(parsePlan).filter(Boolean).sort((a, b) => (b.priority - a.priority) || a.planId.localeCompare(b.planId));
}

/** billing 面身份头（含账号指纹与 token）。 */
function buildBillingHeaders(acct) {
  const fp = fingerprint.profileFor(acct, (fresh) => {
    try { store.update(acct.id, { fingerprint: fresh }); } catch { /* 落库失败不阻断 */ }
  });
  return identity.identityHeaders(fp, { token: acct.token });
}

/**
 * 查询账号额度（billing/balance）。
 * 返回 { plans, balances, serverTime }。
 */
async function fetchBalance(acct) {
  const blocked = billingBlockReason(acct, { action: '查询额度' });
  if (blocked) throw new ZCodeApiError(blocked, { code: null });
  const envelope = await request({
    method: 'GET',
    path: V.paths.billingBalance,
    headers: buildBillingHeaders(acct),
    query: { app_version: identity.appVersion() },
  });
  const data = unwrap(envelope, { method: 'GET', path: V.paths.billingBalance }) || {};
  return {
    plans: Array.isArray(data.plans) ? data.plans : [],
    balances: Array.isArray(data.balances) ? data.balances : [],
    serverTime: data.server_time,
  };
}

/**
 * 领取指定套餐（或自动选优先级最高的）。
 *
 * 验证码策略：3007 换码重试一次（参数一次性且可能被风控拒绝）。
 * 幂等：1003「已领取过」按 already 返回，不视为失败。
 *
 * @param {object} acct
 * @param {string} [planId]
 * @param {{maxCaptchaRetries?:number}} [opts]
 * @returns {Promise<{result:string, planId:string, planName:string, grants:Array, message:string, code:number|null}>}
 */
async function claimPlan(acct, planId, opts = {}) {
  const blocked = billingBlockReason(acct, { action: '领取' });
  if (blocked) throw new ZCodeApiError(blocked, { code: null });

  let target = String(planId || '').trim();
  let planName = '';
  let grants = [];
  if (!target) {
    const plans = await previewPlans(acct);
    if (!plans.length) {
      return {
        result: CLAIM_RESULT.FAILED, planId: '', planName: '', grants: [],
        message: '当前没有可领取的套餐', code: null,
      };
    }
    target = plans[0].planId;
    planName = plans[0].name || plans[0].planId;
    grants = plans[0].grants;
  }

  const maxRetries = Math.max(1, Number(opts.maxCaptchaRetries || 2));
  let lastCode = null;
  let lastMsg = '';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // 验证码每次现解：certifyId 一次性，复用必被拒（F008 重复提交检测）
    let verify;
    try {
      // eslint-disable-next-line no-await-in-loop
      verify = await captcha.getVerifyParam();
    } catch (e) {
      if (e instanceof captcha.CaptchaUnavailableError) {
        return {
          result: CLAIM_RESULT.FAILED, planId: target, planName, grants,
          message: `验证码不可用：${e.message}`, code: null,
        };
      }
      return {
        result: CLAIM_RESULT.FAILED, planId: target, planName, grants,
        message: e.message, code: null,
      };
    }

    const headers = {
      ...buildBillingHeaders(acct),
      ...captcha.claimHeaders(verify.param, verify.region),
    };

    let envelope;
    try {
      // eslint-disable-next-line no-await-in-loop
      envelope = await request({
        method: 'POST',
        path: V.paths.billingClaim,
        headers,
        body: { plan_id: target },
      });
    } catch (e) {
      if (e instanceof ZCodeApiError) {
        lastCode = e.code;
        lastMsg = e.message;
      } else {
        return {
          result: CLAIM_RESULT.FAILED, planId: target, planName, grants,
          message: e.message, code: null,
        };
      }
      break;
    }

    const code = Number(envelope && envelope.code);
    const msg = String((envelope && (envelope.msg || envelope.message)) || '').trim();

    if (code === 0) {
      const plan = (envelope.data && envelope.data.plan) || {};
      return {
        result: CLAIM_RESULT.CLAIMED,
        planId: String(plan.plan_id || target),
        planName: planName || String(plan.name || target),
        grants,
        message: msg || '领取成功',
        code: 0,
        plan,
      };
    }
    if (code === ERR.alreadyClaimed) {
      return {
        result: CLAIM_RESULT.ALREADY, planId: target, planName, grants,
        message: failText(code, msg), code,
      };
    }
    if (code === ERR.riskControl) {
      return {
        result: CLAIM_RESULT.RISK, planId: target, planName, grants,
        message: failText(code, msg), code,
      };
    }
    lastCode = code;
    lastMsg = msg;
    if (code === ERR.captchaFailed && attempt < maxRetries) {
      console.warn(`[zcode-rewards] 账号 ${acct.label || acct.id} 验证码被拒，换码重试`);
      continue;
    }
    break;
  }

  return {
    result: CLAIM_RESULT.FAILED, planId: target, planName, grants,
    message: failText(lastCode, lastMsg), code: lastCode,
  };
}

/**
 * 探测（不领取）：上报激活 → preview。
 * 这是定时任务的主路径，也是「只查不领」模式的实现。
 *
 * @param {object} acct
 * @param {{activation?:boolean}} [opts]
 * @returns {Promise<{accountId:string, label:string, plans:Array, activation:object|null, error:string|null}>}
 */
async function probe(acct, opts = {}) {
  const out = {
    accountId: acct.id,
    label: acct.label || acct.id,
    plans: [],
    activation: null,
    error: null,
  };
  if (opts.activation !== false) {
    try {
      out.activation = await reportActivation(acct);
    } catch (e) {
      out.activation = { ok: [], failed: [e.message] };
    }
  }
  try {
    out.plans = await previewPlans(acct);
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

/**
 * 对单个账号执行「探测 + 领取全部可领套餐」。
 * @param {object} acct
 * @param {{claim?:boolean}} [opts] claim=false 时只探测
 */
async function runForAccount(acct, opts = {}) {
  const probed = await probe(acct, opts);
  const out = { ...probed, claimed: [], already: [], failed: [], risk: null };
  if (opts.claim === false || probed.error || !probed.plans.length) return out;

  for (const plan of probed.plans) {
    // eslint-disable-next-line no-await-in-loop
    const r = await claimPlan(acct, plan.planId);
    if (r.result === CLAIM_RESULT.CLAIMED) out.claimed.push(r);
    else if (r.result === CLAIM_RESULT.ALREADY) out.already.push(r);
    else if (r.result === CLAIM_RESULT.RISK) { out.risk = r; break; }
    else out.failed.push(r);
    // 账号内多套餐间保底间隔：避免同刻连击上游
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 1500));
  }
  return out;
}

module.exports = {
  CLAIM_RESULT,
  CLAIM_FAIL_TEXT,
  isZcode,
  billingBlockReason,
  parsePlan,
  jwtUserId,
  buildActivationEvent,
  reportActivation,
  previewPlans,
  fetchBalance,
  claimPlan,
  probe,
  runForAccount,
};