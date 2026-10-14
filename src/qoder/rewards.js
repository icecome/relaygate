'use strict';
/**
 * qoder/rewards.js — Qoder 每日积分（100 Credits）活动查询与领取。
 *
 * 上游形态（官方新活动平台，双区域同构、仅域名不同）：
 *   GET  /sash/api/v1/me/campaigns
 *     → { showCampaign, claimable, campaigns: [{
 *          campaignId, campaignKey, actionType, claimStatus,
 *          benefit: { kind:'CREDITS', amount, modelScope, validity:{mode,days} },
 *          startAt, endAt, placements:[{content:{zh,en}}] }] }
 *   POST /sash/api/v1/me/campaigns/{campaignId}/claim
 *     → { grantId, status:'CLAIMED', replayed, benefit, campaignId, campaignKey,
 *         claimedAt, grantedAt, expiresAt }
 *
 * 官方规则（上游文案实证，双区域逐字一致）：
 *   「每天领 100 Credits / 每日 10:00（UTC+8）刷新，领取后 30 天有效」
 *   validity.mode = 'RELATIVE_DAYS', days = 30 —— 是「领取后 30 日」，
 *   不是固定月底过期。积分进 addOnQuota（与 userQuota 两段隔离）。
 *
 * 幂等（实测）：对已领取活动重复 claim 返回同一 grantId + replayed:true，
 * 额度不重复增加。因此本模块不做本地去重也可安全重试，但仍记录 lastClaim 供面板展示。
 *
 * 职责边界：取数、领取、归一化；定时策略在 jobs/qoder-rewards.js，
 * HTTP 暴露在 routes/qoder.js。
 */
const variant = require('../platform/variant');
const { accountRequest, QoderApiError, QoderRegionError } = require('./client');

const V = variant.variantOf(variant.QODER);
const ERR = V.errors;

/** 领取结果语义（供调用方分流，不用字符串判断）。 */
const CLAIM_RESULT = Object.freeze({
  CLAIMED: 'claimed',
  ALREADY: 'already',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

/** 是否为 Qoder 账号（显式比较，不做默认推断）。 */
function isQoder(acct) {
  return !!acct && variant.isEdition(acct.edition, variant.QODER);
}

/** 账号是否具备走运营面的凭据。 */
function blockReason(acct, { action = '操作' } = {}) {
  if (!isQoder(acct)) return `非 Qoder 账号，已跳过${action}`;
  if (!acct.enabled) return `账号已停用，已跳过${action}`;
  if (!String(acct.token || '').trim()) return `账号缺少访问凭据，已跳过${action}`;
  return null;
}

/** 取活动的中文文案（placements 取不到时回退英文，再回退空）。 */
function campaignText(c) {
  // c 可能为 null/undefined（上游条目缺字段时），不能直接读 .placements
  const placements = c && Array.isArray(c.placements) ? c.placements : [];
  for (const p of placements) {
    const zh = p && p.content && p.content.zh;
    if (zh && (zh.title || zh.description)) {
      return { title: String(zh.title || ''), description: String(zh.description || '') };
    }
  }
  for (const p of placements) {
    const en = p && p.content && p.content;
    if (en && en.title) return { title: String(en.title), description: String(en.description || '') };
  }
  return { title: '', description: '' };
}

/**
 * 归一化一个活动条目。
 * 只认 actionType=CLAIM_BENEFIT 且 benefit.kind=CREDITS 的「可领取积分活动」；
 * VIEW_DETAILS 类（纯展示）不计入。
 */
function parseCampaign(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const campaignId = String(raw.campaignId || raw.campaign_id || '').trim();
  if (!campaignId) return null;
  const benefit = (raw.benefit && typeof raw.benefit === 'object') ? raw.benefit : {};
  const validity = (benefit.validity && typeof benefit.validity === 'object') ? benefit.validity : {};
  const text = campaignText(raw);
  return {
    campaignId,
    campaignKey: String(raw.campaignKey || raw.campaign_key || '').trim(),
    actionType: String(raw.actionType || raw.action_type || '').trim(),
    claimStatus: String(raw.claimStatus || raw.claim_status || '').trim(),
    kind: String(benefit.kind || '').trim(),
    amount: Number(benefit.amount || 0) || 0,
    // validity.mode = 'RELATIVE_DAYS' → 领取后 N 天；'ABSOLUTE' → 固定到期
    validityMode: String(validity.mode || '').trim(),
    validityDays: Number(validity.days || 0) || 0,
    startAt: raw.startAt != null ? new Date(Number(raw.startAt) * 1000).toISOString() : null,
    endAt: raw.endAt != null ? new Date(Number(raw.endAt) * 1000).toISOString() : null,
    title: text.title,
    description: text.description,
    detailUrl: (() => {
      const placements = Array.isArray(raw.placements) ? raw.placements : [];
      for (const p of placements) {
        if (p && p.content && p.content.zh && p.content.zh.detailUrl) return String(p.content.zh.detailUrl);
      }
      for (const p of placements) {
        if (p && p.content && p.content.detailUrl) return String(p.content.detailUrl);
      }
      return null;
    })(),
  };
}

/** 是否为「可领取的积分活动」。 */
function isClaimableCredits(c) {
  return !!c && c.actionType === 'CLAIM_BENEFIT'
    && c.kind.toUpperCase() === 'CREDITS'
    && c.claimStatus === 'CLAIMABLE';
}

/**
 * 查询账号的活动平台状态。
 * @returns {Promise<{showCampaign:boolean, claimable:boolean, campaigns:Array, claimableCampaigns:Array}>}
 */
async function fetchCampaigns(acct) {
  const blocked = blockReason(acct, { action: '查询活动' });
  if (blocked) throw new QoderApiError(blocked, { code: null });
  const json = await accountRequest(acct, { method: 'GET', path: 'campaigns' });
  const campaigns = (Array.isArray(json && json.campaigns) ? json.campaigns : [])
    .map(parseCampaign).filter(Boolean);
  return {
    showCampaign: !!(json && json.showCampaign),
    claimable: !!(json && json.claimable),
    campaigns,
    claimableCampaigns: campaigns.filter(isClaimableCredits),
  };
}

/**
 * 查询账号积分额度（两段隔离：userQuota 基础 + addOnQuota 赠送/签到）。
 * @returns {Promise<{userType:string, usageType:string, base:object, addOn:object|null,
 *                    totalRemaining:number, expiresAt:string|null, isQuotaExceeded:boolean}>}
 */
async function fetchQuota(acct) {
  const blocked = blockReason(acct, { action: '查询额度' });
  if (blocked) throw new QoderApiError(blocked, { code: null });
  const j = await accountRequest(acct, { method: 'GET', path: 'quota' });
  const base = (j && j.userQuota && typeof j.userQuota === 'object') ? j.userQuota : null;
  const addOn = (j && j.addOnQuota && typeof j.addOnQuota === 'object') ? j.addOnQuota : null;
  const num = (o) => (o && Number.isFinite(Number(o.remaining)) ? Number(o.remaining) : 0);
  return {
    userType: (j && j.userType) || null,
    usageType: (j && j.usageType) || null,
    base,
    addOn,
    // 仅供展示：运营面各自展示两段，**不得**加总后写入积分口径
    // （accounts.balance / entitlement_snapshot.packs / credit_history）
    totalRemaining: num(base) + num(addOn),
    expiresAt: j && j.expiresAt ? new Date(Number(j.expiresAt)).toISOString() : null,
    isQuotaExceeded: !!(j && j.isQuotaExceeded),
  };
}

/**
 * 领取指定活动（或自动挑第一个可领的积分活动）。
 *
 * 幂等：上游对已领取活动返回 replayed:true，按 ALREADY 计，不算失败。
 *
 * @param {object} acct
 * @param {string} [campaignId] 缺省自动挑第一个可领的积分活动
 * @returns {Promise<{result:string, campaignId:string, campaignKey:string, amount:number,
 *                    grantId:string|null, expiresAt:string|null, replayed:boolean,
 *                    message:string, code:number|null}>}
 */
async function claimCampaign(acct, campaignId) {
  const blocked = blockReason(acct, { action: '领取' });
  if (blocked) throw new QoderApiError(blocked, { code: null });

  let target = String(campaignId || '').trim();
  let targetCampaign = null;
  if (!target) {
    const { claimableCampaigns } = await fetchCampaigns(acct);
    if (!claimableCampaigns.length) {
      return {
        result: CLAIM_RESULT.SKIPPED, campaignId: '', campaignKey: '', amount: 0,
        grantId: null, expiresAt: null, replayed: false,
        message: '当前没有可领取的积分活动', code: null,
      };
    }
    targetCampaign = claimableCampaigns[0];
    target = targetCampaign.campaignId;
  }

  const path = require('./client').fillPath(V.paths.campaignClaim, target);
  let json;
  try {
    json = await accountRequest(acct, { method: 'POST', path, body: {} });
  } catch (e) {
    if (e instanceof QoderRegionError) {
      return {
        result: CLAIM_RESULT.FAILED, campaignId: target,
        campaignKey: targetCampaign ? targetCampaign.campaignKey : '',
        amount: targetCampaign ? targetCampaign.amount : 0,
        grantId: null, expiresAt: null, replayed: false,
        message: e.message, code: null,
      };
    }
    if (e instanceof QoderApiError) {
      // 409 已领取（部分区域用 HTTP 码表达）按 already 计
      if (e.status === ERR.alreadyClaimed) {
        return {
          result: CLAIM_RESULT.ALREADY, campaignId: target,
          campaignKey: targetCampaign ? targetCampaign.campaignKey : '',
          amount: targetCampaign ? targetCampaign.amount : 0,
          grantId: null, expiresAt: null, replayed: true,
          message: '该活动今日已领取', code: e.status,
        };
      }
      return {
        result: CLAIM_RESULT.FAILED, campaignId: target,
        campaignKey: targetCampaign ? targetCampaign.campaignKey : '',
        amount: targetCampaign ? targetCampaign.amount : 0,
        grantId: null, expiresAt: null, replayed: false,
        message: e.message, code: e.code != null ? e.code : e.status,
      };
    }
    throw e;
  }

  const benefit = (json && json.benefit && typeof json.benefit === 'object') ? json.benefit : {};
  const replayed = !!(json && json.replayed);
  const status = String((json && json.status) || '').toUpperCase();
  return {
    result: replayed || status === 'CLAIMED' && !json.grantedAt ? CLAIM_RESULT.ALREADY : CLAIM_RESULT.CLAIMED,
    campaignId: String((json && json.campaignId) || target),
    campaignKey: String((json && json.campaignKey) || (targetCampaign && targetCampaign.campaignKey) || ''),
    amount: Number(benefit.amount || (targetCampaign && targetCampaign.amount) || 0) || 0,
    grantId: (json && json.grantId) || null,
    expiresAt: (json && json.expiresAt) || null,
    replayed,
    message: replayed ? '该活动已领取（幂等返回）' : '领取成功',
    code: null,
  };
}

/**
 * 探测（不领取）：拉活动列表 + 额度。
 * @returns {Promise<{accountId,label,realm,campaigns,claimableCampaigns,quota,error}>}
 */
async function probe(acct) {
  const out = {
    accountId: acct.id,
    label: acct.label || acct.id,
    realm: variant.qoderRealmOfAccount(acct),
    campaigns: [],
    claimableCampaigns: [],
    quota: null,
    error: null,
  };
  try {
    const c = await fetchCampaigns(acct);
    out.campaigns = c.campaigns;
    out.claimableCampaigns = c.claimableCampaigns;
  } catch (e) {
    out.error = e.message;
  }
  // 额度单独 try：活动查询失败不应连带丢掉额度（面板两块信息独立）
  try {
    out.quota = await fetchQuota(acct);
  } catch (e) {
    if (!out.error) out.error = `额度查询失败：${e.message}`;
  }
  return out;
}

/**
 * 对单账号执行「探测 + 领取全部可领积分活动」。
 *
 * 汇总口径：
 *   - claimed       本轮真实发放（replayed=false）
 *   - already       上游幂等返回 replayed=true（重复领取不会重复发放）
 *   - alreadyToday  列表级判定：当日积分活动已是 CLAIMED（今日已领过，
 *                   无需再调 claim——上游也不会有 CLAIMABLE 项）
 *   - failed        领取失败（网络/业务码）
 *
 * @param {object} acct
 * @param {{claim?:boolean}} [opts] claim=false 时只探测
 */
async function runForAccount(acct, opts = {}) {
  const probed = await probe(acct);
  const out = {
    ...probed,
    claimed: [], already: [], failed: [], alreadyToday: [],
  };
  if (probed.error) return out;

  // 列表级「今日已领」：已 CLAIMED 的积分活动（当日投放批次）
  out.alreadyToday = probed.campaigns.filter(
    (c) => c.actionType === 'CLAIM_BENEFIT' && c.kind.toUpperCase() === 'CREDITS' && c.claimStatus === 'CLAIMED',
  );

  if (opts.claim === false || !probed.claimableCampaigns.length) return out;

  for (const c of probed.claimableCampaigns) {
    // eslint-disable-next-line no-await-in-loop
    const r = await claimCampaign(acct, c.campaignId);
    if (r.result === CLAIM_RESULT.CLAIMED) out.claimed.push(r);
    else if (r.result === CLAIM_RESULT.ALREADY) out.already.push(r);
    else out.failed.push(r);
    // 账号内多活动间保底间隔，避免同刻连击上游
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 1200));
  }
  return out;
}

module.exports = {
  CLAIM_RESULT,
  isQoder,
  blockReason,
  parseCampaign,
  isClaimableCredits,
  campaignText,
  fetchCampaigns,
  fetchQuota,
  claimCampaign,
  probe,
  runForAccount,
};
