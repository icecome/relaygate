'use strict';
/**
 * auth/index.js — 认证统一入口（多账号版）。
 *
 * 需求演进：不依赖本机 Trae storage.json，凭据来自 credentials/store（导入/OAuth）。
 * 职责：
 *   - 按账号 ID 取凭据；token 将过期时用 refreshToken 换新续期（复用 lib/auth.js exchangeToken）
 *   - 构造上游请求头（复用 buildCommonHeaders/buildStreamHeaders 的设备/头构造）
 *
 * 兼容回退：未配置任何账号时退回本机登录态（第 0 号内部账号 source='local'），保证旧用法可用。
 */
const credStore = require('../credentials/store');
const legacy = require('../lib/auth.js');
const config = require('../config');

const REFRESH_MARGIN_MS = 30 * 60 * 1000; // 提前 30 分钟刷新

function isExpiring(acct) {
  if (!acct || !acct.expiredAt) return true;
  const t = new Date(acct.expiredAt).getTime();
  if (isNaN(t)) return true;
  return t < Date.now() + REFRESH_MARGIN_MS;
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
    if (isExpiring(acct) && acct.refreshToken) {
      try {
        const wb = require('../workbuddy/auth');
        const r = await wb.refresh(acct.refreshToken);
        const patch = { token: r.accessToken, refreshToken: r.refreshToken, expiredAt: r.expiresAt };
        credStore.update(acct.id, patch);
        acct = { ...acct, ...patch };
      } catch (e) {
        console.error(`[auth] workbuddy refresh failed for ${acct.id}: ${e.message}`);
      }
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
    }
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
    ? legacy.buildStreamHeaders(like, legacy.getDeviceIds(), requestId, lastEventId)
    : legacy.buildCommonHeaders(like, legacy.getDeviceIds());
  // TraeWork 身份：补齐真机 Work 线的功能头（值与 solo_work_lite 对齐）
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

module.exports = { ensureAuth, headersFor, getApiHost, activeAccounts };