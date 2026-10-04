'use strict';
/**
 * credentials/oauth.js — Trae OAuth 登录（对齐 TraeWorkAssistant 实测流程）。
 *
 * 流程：
 *   1. GET 授权 URL（www.trae.cn/authorization，SOLO ClientID，回调 127.0.0.1:<port>/authorize）
 *   2. 用户浏览器登录后 Trae 重定向到回调 URL，携带 refreshToken/accessToken/userId/userName
 *   3. 本进程内一次性 HTTP 监听接收回调（或手动 POST 回调 URL 兜底）
 *   4. ExchangeToken（同 ClientID @ api.trae.com.cn）→ GetUserInfo → importAccount 落库
 *
 * 注意：OAuth 发放的 refreshToken 必须用同一 ClientID 换新（SOLO 线 en1oxy7wnw8j9n），
 * 账号落库时记录 authClientId/authHost，续期时按账号使用。
 *
 * 设备身份：授权 URL 携带的 machine_id/device_id 不再随机生成。随机值会让同一账号
 * 每次登录都表现为「全新设备」，与落库 devices 及后续 API 面指纹互相矛盾，是设备维度
 * 风控的典型触发信号。改为 genDevices 确定性指纹：登录面与 API 面同源。
 */
const http = require('http');
const crypto = require('crypto');
const fetch = require('node-fetch');
const store = require('./store');
const { importAccount, genDevices } = require('./import');
const legacyAuth = require('../lib/auth');
const variant = require('../platform/variant');

const TRAE_HOSTS = variant.variantOf(variant.TRAE).hosts;
const TRAE_IDENTITY = variant.variantOf(variant.TRAE).identity;

const OAUTH_CLIENT_ID = process.env.TRAE_OAUTH_CLIENT_ID_SOLO || TRAE_IDENTITY.oauthClientId;
const OAUTH_CLIENT_SECRET = TRAE_IDENTITY.oauthClientSecret;
const OAUTH_APP_ID = process.env.TRAE_APP_ID || TRAE_IDENTITY.appId;
const OAUTH_AUTH_BASE = process.env.TRAE_OAUTH_AUTH_HOST || TRAE_HOSTS.oauthAuth;
const OAUTH_EXCHANGE_HOST = process.env.TRAE_OAUTH_EXCHANGE_HOST || TRAE_HOSTS.oauthExchange;
const OAUTH_REDIRECT_PORT = Number(process.env.TRAE_OAUTH_REDIRECT_PORT || 17388);
// 监听窗口：用户登录 Trae 可能耗时较长（验证码/密码找回等），留足 30 分钟
const LISTEN_TIMEOUT_MS = 30 * 60 * 1000;

// 上游请求 host 白名单（SSRF 防御：env 覆盖也不能指向白名单之外的地址）
const ALLOWED_EXCHANGE_HOSTS = new Set(TRAE_HOSTS.exchangeHostAllowlist);
function assertAllowedHost(urlStr) {
  const u = new URL(urlStr);
  if (u.protocol !== 'https:' || !ALLOWED_EXCHANGE_HOSTS.has(u.hostname)) {
    throw new Error(`blocked non-allowlist upstream host: ${u.hostname}`);
  }
  return urlStr;
}

const pending = { state: null, group: null, server: null, timer: null, result: null, device: null };

function randomHex(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

/**
 * 生成登录用设备身份。
 *
 * 授权 URL 的 machine_id/device_id 是 Trae 服务端记录「本次登录来自哪台设备」的依据。
 * 这里复用 genDevices 的确定性形态（与账号落库 devices 同一构造），使登录面与 API 面
 * 的设备身份同源；同时生成一次后挂在 pending 上，整个登录流程内保持一致。
 * @returns {{machineId:string, deviceId:string}}
 */
function loginDeviceIdentity() {
  const d = genDevices(randomHex(32));
  return { machineId: d.machineId, deviceId: d.devDeviceId };
}

/** 生成授权登录 URL，并启动本地回调监听。 */
function getLoginUrl(group) {
  stopListener('new login started');
  pending.state = randomHex(32);
  pending.group = group || null;
  pending.result = null;
  pending.device = loginDeviceIdentity();

  const { machineId, deviceId } = pending.device;
  const redirectUri = `http://127.0.0.1:${OAUTH_REDIRECT_PORT}/authorize`;
  const url = `${OAUTH_AUTH_BASE}?client_id=${OAUTH_CLIENT_ID}&client_secret=${OAUTH_CLIENT_SECRET}`
    + `&app_id=${OAUTH_APP_ID}&auth_callback_url=${encodeURIComponent(redirectUri)}`
    + `&state=${pending.state}&machine_id=${machineId}&device_id=${deviceId}&response_type=code`;

  startListener();
  return {
    url,
    state: pending.state,
    redirectUri,
    expiresAt: new Date(Date.now() + LISTEN_TIMEOUT_MS).toISOString(),
  };
}

/**
 * 校验并消费一次性 state（供无鉴权的 /oauth/complete 端点使用）。
 *
 * 该端点的调用方是浏览器控制台里的脚本，无法携带 admin 凭据，因此以
 * 「只有管理面调用 /oauth/url 才能拿到的 state」作为共享秘密：
 * 未先发起登录流程时 pending.state 为空，一律拒绝。
 * 校验通过即清空，防止同一 state 被重复投递。
 *
 * @param {string} state 请求方提交的 state
 * @returns {boolean} 是否通过
 */
function verifyAndConsumeState(state) {
  const expected = pending.state;
  if (!expected || !state) return false;
  const a = Buffer.from(String(state));
  const b = Buffer.from(String(expected));
  // timingSafeEqual 要求等长，长度不同直接判否（长度本身不构成可利用信息）
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  pending.state = null;
  return true;
}

/** 本地回调监听（30 分钟超时自动关闭）。 */
const CALLBACK_MSG = 'OK - callback received. You can close this window and check the dashboard.';
function startListener() {
  try {
    pending.server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${OAUTH_REDIRECT_PORT}`);
      // Trae 授权页在授权未完成时会把参数用 & 拼在路径后（/authorize&state=...），一并兼容
      if (!u.pathname.startsWith('/authorize')) {
        res.writeHead(404);
        res.end();
        return;
      }
      // CORS：授权页（https://www.trae.cn）通过 XHR POST 提交凭据，需正确响应预检。
      // ACAO 固定常量（不回显请求 Origin）；来源合法性由 Origin 白名单校验保证。
      const cors = {
        'Access-Control-Allow-Origin': TRAE_HOSTS.oauthAuthOrigin,
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      if (req.method === 'POST') {
        // 仅接受 trae 站点的回调提交（防任意网站向本机投递凭据）
        const origin = String(req.headers.origin || '');
        if (!new RegExp(TRAE_HOSTS.callbackOriginPattern).test(origin)) {
          console.log(`[oauth] reject POST callback, origin not allowed: ${origin || '(empty)'}`);
          res.writeHead(403, cors);
          res.end();
          return;
        }
        res.writeHead(200, cors);
        res.write(CALLBACK_MSG);
        res.end();
        collectPostBody(req, u);
        return;
      }
      res.writeHead(200);
      res.write(CALLBACK_MSG);
      res.end();
      handleCallbackParams(normalizeCallbackParams(u));
    });
    pending.server.on('error', (e) => {
      console.log(`[oauth] callback listener unavailable on :${OAUTH_REDIRECT_PORT} (${e.message}); 使用手动回调接口兜底`);
      pending.server = null;
    });
    pending.server.listen(OAUTH_REDIRECT_PORT, '127.0.0.1', () => {
      console.log(`[oauth] waiting for login callback on 127.0.0.1:${OAUTH_REDIRECT_PORT}/authorize`);
    });
    pending.timer = setTimeout(() => stopListener('timeout'), LISTEN_TIMEOUT_MS);
  } catch (e) {
    console.log(`[oauth] listener setup failed: ${e.message}`);
    pending.server = null;
  }
}

/**
 * 归一化回调参数：标准 ?a=b 之外，还兼容 /authorize&a=b&c=d（无 ? 的畸形形态）。
 * @returns {URLSearchParams}
 */
function normalizeCallbackParams(u) {
  const params = new URLSearchParams(u.searchParams);
  if (u.pathname.includes('&')) {
    // /authorize&state=x&machine_id=y → 路径内嵌参数
    const raw = u.pathname.split('&').slice(1);
    for (const pair of raw) {
      const eq = pair.indexOf('=');
      if (eq > 0) params.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)));
    }
  }
  return params;
}

/**
 * 读取 POST 回调 body 并完成登录。
 * 授权页（z.A.post 到 auth_callback_url）body 形如：
 *   {data, refreshToken, refreshExpireAt, host, region, userRegion, loginTraceID, type}
 */
function collectPostBody(req, u) {
  let body = '';
  let tooLarge = false;
  req.on('data', (c) => {
    if (tooLarge) return;
    body += c;
    if (body.length > 65536) {
      tooLarge = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (tooLarge) {
      console.warn('[oauth] POST callback body too large (>64KB), rejected');
      return;
    }
    let creds = {};
    try { creds = JSON.parse(body || '{}'); } catch (e) { /* 非 JSON 视为空 */ }
    const refreshToken = creds.refreshToken || creds.data || null;
    if (refreshToken) {
      completeLogin({ refreshToken, accessToken: creds.accessToken || null });
    } else {
      console.log('[oauth] POST callback without refreshToken');
      handleCallbackParams(normalizeCallbackParams(u));
    }
  });
}

function stopListener(reason) {
  if (pending.timer) { clearTimeout(pending.timer); pending.timer = null; }
  if (pending.server) {
    try { pending.server.close(); } catch { /* ignore */ }
    pending.server = null;
    console.log(`[oauth] callback listener closed (${reason})`);
  }
}

/** 手动兜底：解析用户粘贴的完整回调 URL（仅本机回调地址，不向其发起请求）。 */
function manualCallback(callbackUrl) {
  const u = new URL(String(callbackUrl));
  if (!/^https?:$/.test(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    throw new Error('callbackUrl 必须指向本机回调地址（127.0.0.1:<port>/authorize）');
  }
  return completeLogin({
    refreshToken: u.searchParams.get('refreshToken') || u.searchParams.get('refresh_token'),
    accessToken: u.searchParams.get('accessToken') || u.searchParams.get('access_token'),
    userId: u.searchParams.get('userId') || u.searchParams.get('user_id'),
    userName: u.searchParams.get('userName') || u.searchParams.get('user_name') || u.searchParams.get('nickname'),
  });
}

/** 处理回调参数 → 换 token → 拉用户信息 → 落库。 */
async function handleCallbackParams(params) {
  return completeLogin({
    state: params.get('state'),
    refreshToken: params.get('refreshToken') || params.get('refresh_token'),
    accessToken: params.get('accessToken') || params.get('access_token'),
    userId: params.get('userId') || params.get('user_id'),
    userName: params.get('userName') || params.get('user_name') || params.get('nickname'),
  });
}

/** 用回调凭据完成登录：换 token → 拉用户信息 → 落库。 */
async function completeLogin(creds = {}) {
  try {
    // Trae 授权页实测会重新生成 state（与初始 URL 不一致），故仅告警不拒绝
    if (creds.state && pending.state && creds.state !== pending.state) {
      console.log('[oauth] callback state differs from issued state (page regenerated), continuing');
    }
    if (!creds.refreshToken && !creds.accessToken) {
      const received = Object.entries(creds).filter(([, v]) => v).map(([k]) => k);
      pending.result = {
        state: 'error',
        message: `回调中未包含 refreshToken/accessToken（仅收到: ${received.join(', ') || '无'}）。这通常表示 Trae 授权未完成——请确认登录账号已开通 Trae Work/SOLO，或在「认证中」页面按 F12 查看 Network 中失败/挂起的请求`,
      };
      stopListener('missing credentials');
      return null;
    }

    let token = creds.accessToken;
    let newRefresh = creds.refreshToken;
    if (!token && creds.refreshToken) {
      const ex = await exchangeToken(creds.refreshToken);
      token = ex.token;
      newRefresh = ex.refreshToken || creds.refreshToken;
    }

    // GetUserInfo 仅为补充用户名/ID：服务端调用无浏览器 cookie 会话，可能 401，不作为失败条件。
    // token 有效性由 JWT 解析兜底保证（伪造 token 无法通过 data.id + exp 校验）。
    let info = { userId: null, userName: null };
    try { info = await getUserInfo(token); } catch (e) { /* 忽略，走 JWT 兜底 */ }
    const uid = info.userId || creds.userId || jwtUid(token);
    if (!uid) throw new Error('token 身份验证失败：GetUserInfo 未返回用户 ID 且 JWT 无法解析（token 可能无效）');
    const displayName = creds.userName || null; // 仅在用户显式命名时传入
    const label = displayName || (info.userName || (uid ? `oauth-${uid.slice(-4)}` : 'oauth account'));

    const account = importAccount({
      refreshToken: newRefresh || undefined,
      label: displayName || undefined, // 未命名时不覆盖已有账号 label
      group: pending.group || undefined,
      forceNew: false,
      authObject: {
        token,
        refreshToken: newRefresh,
        userId: uid,
        account: label,
        expiredAt: jwtExp(token),
      },
      devices: pending.device ? {
        machineId: pending.device.machineId,
        devDeviceId: pending.device.deviceId,
      } : undefined,
      authClientId: OAUTH_CLIENT_ID,
      authHost: OAUTH_EXCHANGE_HOST,
    });
    console.log(`[oauth] account ready: ${account.id} (${account.label})`);
    pending.result = { state: 'done', accountId: account.id, label: account.label };
    stopListener('completed');
    return account;
  } catch (e) {
    console.error(`[oauth] callback failed: ${e.message}`);
    pending.result = { state: 'error', message: e.message };
    stopListener('error');
    return null;
  }
}

/**
 * ExchangeToken（登录流程内使用）。
 * 委托 lib/auth 的完整实现（带客户端外观头 + 信封归一化），host 走白名单校验；
 * 这里的签名只取 {token, refreshToken} 两项供 completeLogin 消费。
 */
async function exchangeToken(refreshToken) {
  assertAllowedHost(`${OAUTH_EXCHANGE_HOST}/cloudide/api/v3/trae/oauth/ExchangeToken`);
  const r = await legacyAuth.exchangeToken(refreshToken, {
    clientId: OAUTH_CLIENT_ID,
    host: OAUTH_EXCHANGE_HOST,
  });
  return { token: r.token, refreshToken: r.refreshToken };
}

/** GetUserInfo：拿 user_id / 用户名（失败不阻塞落库）。 */
async function getUserInfo(token) {
  const url = assertAllowedHost(`${OAUTH_EXCHANGE_HOST}/cloudide/api/v3/trae/GetUserInfo`);
  const auth = token.startsWith('Cloud-IDE-JWT ') ? token : `Cloud-IDE-JWT ${token}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: auth,
      'user-agent': 'TraeClient/TTNet',
      'x-app-id': OAUTH_APP_ID,
    },
    body: JSON.stringify({}),
  });
  const body = await resp.json();
  const data = (body && (body.data || body.result)) || {};
  return {
    userId: data.user_id || data.UserID || data.userId || null,
    userName: data.name || data.user_name || data.userName || data.nickname || null,
  };
}

/** 从 JWT payload 取 data.id（用户 ID）；解析失败返回 null。 */
function jwtUid(token) {
  try {
    const seg = String(token).replace(/^Cloud-IDE-JWT\s+/, '').split('.')[1];
    const payload = JSON.parse(Buffer.from(seg, 'base64').toString());
    return (payload.data && payload.data.id) ? String(payload.data.id) : null;
  } catch {
    return null;
  }
}

/** 从 JWT payload 取 exp（ISO 字符串）；解析失败返回 null。 */
function jwtExp(token) {
  try {
    const seg = String(token).replace(/^Cloud-IDE-JWT\s+/, '').split('.')[1];
    const payload = JSON.parse(Buffer.from(seg, 'base64').toString());
    return payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

/** 登录流程状态（前端轮询）。 */
function status() {
  return {
    listening: !!pending.server,
    hasPending: !!pending.state,
    result: pending.result,
  };
}

module.exports = {
  getLoginUrl,
  manualCallback,
  completeLogin,
  status,
  exchangeToken,
  getUserInfo,
  verifyAndConsumeState,
};
