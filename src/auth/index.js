'use strict';
/**
 * auth/index.js — 认证统一入口（多账号版）。
 * 不依赖本机 Trae storage.json，凭据来自 credentials/store（导入或 OAuth）。
 * 职责：按账号 ID 取凭据，token 将过期时用 refreshToken 换新续期（复用
 * lib/auth.js exchangeToken）；构造上游请求头（复用 buildCommonHeaders 与
 * buildStreamHeaders 的设备与请求头构造）。
 * 兼容回退：未配置任何账号时退回本机登录态（第 0 号内部账号 source='local'），
 * 保证旧用法可用。
 */
const credStore = require('../credentials/store');
const legacy = require('../lib/auth.js');
const headersLib = require('../lib/headers.js');
const config = require('../config');

const REFRESH_MARGIN_MS = 30 * 60 * 1000; // 提前 30 分钟刷新

/**
 * WorkBuddy 账号的周期性续期间隔（7 天）。
 *
 * 为什么「临期才刷」不够：2026-10-18 实测 4 个 WB 账号 accessToken 的 JWT exp
 * 还有 3~4 周，上游却已拒绝服务（签到/成长中心全 401）。上游会单方面作废会话
 * （改密、异常登录、风控），而 JWT 自身还没到期——只按 expiredAt 判定的续期
 * 永远不会触发，账号就卡在「看起来没过期、实际已失效」的状态。
 *
 * 代价极低：WB 的 refresh 端点返回新 accessToken（30 天有效期）+ 新 refreshToken，
 * 单个账号每次续期只多一次 POST；每账号每周一次，8 个账号一天最多一次。
 * 间隔可经 env 覆盖，方便紧急情况下立即全量续期。
 */
const WB_REFRESH_STALE_MS = Number(process.env.WB_REFRESH_STALE_DAYS || 7) * 86400000;

function isExpiring(acct) {
  if (!acct || !acct.expiredAt) return true;
  const t = new Date(acct.expiredAt).getTime();
  if (isNaN(t)) return true;
  return t < Date.now() + REFRESH_MARGIN_MS;
}

/**
 * WorkBuddy 账号是否需要续期：临期（30 分钟内过期）或「距上次**成功**刷新已超过 N 天」。
 *
 * ⚠️ 判据读 lastRefreshAt（最近成功续期），**不是** lastKeepaliveAt。两者共用一个
 * 字段会同时坏掉两件事（2026-10-21 实测）：
 *   1. scheduler.runKeepalive 每天无条件写 lastKeepaliveAt ⇒ 差值恒 < 1 天
 *      ⇒ 「7 天周期续期」永不触发，等于该能力不存在；
 *   2. 续期**失败**也写 lastKeepaliveAt ⇒ 一次网络抖动把重试压满 7 天，
 *      而这正是本机制要兜的场景（上游单方面作废会话、JWT 却还没到期）。
 * 故 lastKeepaliveAt 保留为「最近一次保活尝试」的展示位（面板「保活」列读它），
 * lastRefreshAt 才是判据位，只在**成功**刷新时写。
 *
 * lastRefreshAt 缺失（升级上来的存量账号、或从未成功刷新过）视为需要续期。
 */
function wbNeedsRefresh(acct) {
  if (isExpiring(acct)) return true;
  const last = acct.lastRefreshAt ? new Date(acct.lastRefreshAt).getTime() : NaN;
  if (isNaN(last)) return true;
  return Date.now() - last >= WB_REFRESH_STALE_MS;
}

/** 对外展示用列表（token/refreshToken 已脱敏）。 */
function activeAccounts() {
  return credStore.list();
}

/** 内部用：带解密字段的完整账号（含 token/refreshToken），仅本模块调用。 */
function internalAccount(id) {
  return credStore.get(id);
}

/**
 * 确保某账号凭据有效（必要时刷新 token）。
 * @param {string|null} accountId 缺省时取第一个 enabled 账号；无账号则退本机
 * @returns {Promise<object>} 含 {token, userId, host, _edition}
 */
async function ensureAuth(accountId) {
  const accts = credStore.list();
  if (!accts.length) {
    // 回退本机登录态
    const ai = await legacy.refreshTokenIfNeeded();
    return { ...ai };
  }

  let acct = null;
  if (accountId) {
    acct = internalAccount(accountId);
  } else {
    const summary = accts.find((a) => a.enabled);
    // list() 已脱敏，必须再 get() 取完整凭据才能 refresh
    if (summary) acct = internalAccount(summary.id);
  }
  if (!acct) throw new Error(`No account available${accountId ? `: ${accountId}` : ''}`);

  // WorkBuddy 账号：走 codebuddy.cn 的刷新端点（Keycloak OIDC），与 Trae 体系完全独立
  if (acct.edition === 'workbuddy') {
    if (wbNeedsRefresh(acct) && acct.refreshToken) {
      try {
        const wb = require('../workbuddy/auth');
        const r = await wb.refresh(acct.refreshToken);
        const patch = {
          token: r.accessToken,
          refreshToken: r.refreshToken,
          expiredAt: r.expiresAt,
          // 判据位：只有**成功**刷新才写。周期续期（wbNeedsRefresh）读它，
          // 每日保活轮写的 lastKeepaliveAt 不会再来重置这个窗口。
          lastRefreshAt: new Date().toISOString(),
          // 展示位：面板「保活」列读它，语义是「最近一次保活尝试的结果」。
          lastKeepaliveAt: new Date().toISOString(),
          lastKeepaliveResult: 'ok',
        };
        credStore.update(acct.id, patch);
        acct = { ...acct, ...patch };
      } catch (e) {
        console.error(`[auth] workbuddy refresh failed for ${acct.id}: ${e.message}`);
        // 续期失败必须让调用方看见：此前只 console.error 后照常返回旧 token，
        // 保活任务据此把「刷新失败」记成「保活成功」，面板永远看不到临期风险。
        //
        // ⚠️ 只写 lastKeepalive*（展示位），**不写 lastRefreshAt**（判据位）：
        // 否则一次网络抖动会把周期续期的重试压满 7 天，而第一次抖动恰恰是
        // 最该在下一轮重试的时候。
        const failAt = new Date().toISOString();
        const failResult = `fail: ${e.message}`.slice(0, 120);
        try {
          credStore.update(acct.id, { lastKeepaliveAt: failAt, lastKeepaliveResult: failResult });
        } catch { /* 落库失败不影响本次返回 */ }
        acct = { ...acct, _refreshError: e.message, lastKeepaliveAt: failAt, lastKeepaliveResult: failResult };
      }
    } else if (wbNeedsRefresh(acct) && !acct.refreshToken) {
      // 临期但无 refreshToken：不是成功，是「无法续期」，同样要让调用方知道
      acct = { ...acct, _refreshError: '临期但缺少 refreshToken，无法自动续期' };
    }
    return acct;
  }

  if (isExpiring(acct) && acct.refreshToken) {
    try {
      // OAuth（SOLO 线）账号带自己的 ClientID/authHost 换新；导入账号走默认
      const refreshed = await legacy.exchangeToken(acct.refreshToken, {
        clientId: acct.authClientId || undefined,
        host: acct.authHost || undefined,
      });
      if (refreshed && refreshed.token) {
        const patch = {
          token: refreshed.token,
          refreshToken: refreshed.refreshToken || acct.refreshToken,
          expiredAt: refreshed.expiredAt || acct.expiredAt,
          refreshExpiredAt: refreshed.refreshExpiredAt || acct.refreshExpiredAt,
          tokenReleaseAt: refreshed.tokenReleaseAt || acct.tokenReleaseAt,
        };
        credStore.update(acct.id, patch);
        acct = { ...acct, ...patch };
      }
    } catch (e) {
      console.error(`[auth] refresh failed for ${acct.id}: ${e.message}`);
      acct = { ...acct, _refreshError: e.message };
    }
  } else if (isExpiring(acct) && !acct.refreshToken) {
    acct = { ...acct, _refreshError: '临期但缺少 refreshToken，无法自动续期' };
  }

  return acct;
}

function headersFor(authInfo, requestId, lastEventId) {
  // authInfo 可能是账号记录（含 token/userId/devices/edition）或本机回退
  const like = {
    token: authInfo.token,
    userId: authInfo.userId,
    devices: authInfo.devices || null,
    _edition: authInfo._edition || authInfo.edition || 'cn',
  };
  const headers = requestId
    ? headersLib.buildStreamHeaders(like, legacy.getDeviceIds(), requestId, lastEventId)
    : headersLib.buildCommonHeaders(like, legacy.getDeviceIds());
  // TraeWork 身份：补齐真机 Work 线的功能头（值与 solo_work_lite 一致）
  if (process.env.TRAE_WORK_IDENTITY === 'on') {
    headers['X-App-Function'] = 'solo_work_lite';
    headers['X-Ide-Function'] = 'solo_work_lite';
  }
  return headers;
}

function getApiHost(acct) {
  if (process.env.TRAE_API_HOST) return process.env.TRAE_API_HOST;
  if (acct && acct.host) return acct.host;
  return legacy.getApiHost();
}

module.exports = {
  ensureAuth,
  headersFor,
  getApiHost,
  activeAccounts,
  // 导出仅供测试断言 WB 续期判据：临期或距上次刷新超过 WB_REFRESH_STALE_DAYS。
  wbNeedsRefresh,
  WB_REFRESH_STALE_MS,
};