'use strict';
/**
 * workbuddy/oauth.js —— WorkBuddy 无感登录新账号（免退出 OAuth）。
 *
 * 对标 WorkDaddy 的「无感登录」：不退出当前 WorkBuddy、不打断桌面端，
 * 在系统浏览器完成扫码/授权后，新账号自动入库（credentials 库，edition=workbuddy）。
 *
 * 与 Trae 侧 `credentials/oauth.js` 的本地回环回调监听不同，WorkBuddy 用
 * 「网关拉 state + 轮询 auth/token（authorization-code 的后台完成变体）」，
 * 端点在 `{billingBase}/v2/plugin/*`。参考实现（WorkDaddy scripts/daemon.js
 * 的 /api/oauth/start、/api/oauth/poll、oauthPollOnce）逐行核对过：
 *
 *   1. POST /v2/plugin/auth/state?platform=workbuddy|workbuddy-ai
 *        → { data: { state, authUrl? } }；authority 的 state 短时效。
 *   2. 系统浏览器打开 `authUrl || {billingBase}/login/started?platform=…&state=…`
 *        —— 用户扫码/授权在本机浏览器完成，桌面端不受影响。
 *   3. GET  /v2/plugin/auth/token?state=…   （轮询；code 0/200 且拿到
 *        accessToken 即表示用户已授权，否则继续 done:false）
 *   4. GET  /v2/plugin/login/account?state=… （Bearer + 可选 X-Domain）
 *        → data.account，用于 uid/nickname 落库。
 *
 * 安全边界（沿用 RelayGate 既有原则）：
 *   - 上游 URL 由 region 枚举 → 常量映射生成，用户输入只选区域，不参与拼接；
 *   - token 只经 memory 传递，落库走 credentials/store 的统一 AES-256-GCM；
 *   - state 一次性 + 短 TTL，错误态可被一次性消费，不把授权链接打进日志。
 */
const crypto = require('crypto');
const wbAuth = require('./auth');
const store = require('../credentials/store');

const DEFAULT_STATE_TIMEOUT_SECONDS = 600;
const DEFAULT_STATE_RETENTION_SECONDS = 300;

/**
 * 会话超时秒数。**在调用时读 env**（而非模块加载时），
 * 这样测试可以单独把超时调到 0/负数验证超时分支，不需要重载模块。
 */
function stateTimeoutSeconds() {
  const v = Number(process.env.WB_OAUTH_TIMEOUT_SECONDS);
  return Number.isFinite(v) && v !== 0 ? v : DEFAULT_STATE_TIMEOUT_SECONDS;
}

function stateRetentionSeconds() {
  const v = Number(process.env.WB_OAUTH_RETENTION_SECONDS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_STATE_RETENTION_SECONDS;
}

/** region → oauth platform 参数（国内 workbuddy / 国际 workbuddy-ai）。 */
function platformOfRegion(region) {
  return wbAuth.validRegion(region) === 'global' ? 'workbuddy-ai' : 'workbuddy';
}

/** 无感登录的 billing 面 base（auth/state、auth/token、login/account 都在这）。 */
function authBaseOfRegion(region) {
  return wbAuth.billingBase(region);
}

/**
 * 进程内登录会话表：loginId → 状态机。
 * 每个会话一个 state；poll 期间幂等；超时或消费后自动清理（unref，不阻塞进程退出）。
 */
const sessions = new Map();

function scheduleCleanup(loginId, ms) {
  const t = setTimeout(() => sessions.delete(loginId), ms);
  if (t.unref) t.unref();
  return t;
}

/**
 * 发起无感登录。
 * @param {string} region 'cn' | 'global'
 * @returns {{loginId:string, verificationUri:string, state:string, expiresIn:number}}
 */
async function startLogin(region) {
  const r = wbAuth.validRegion(region);
  const base = authBaseOfRegion(r);
  const platform = platformOfRegion(r);
  const resp = await fetch(`${base}/v2/plugin/auth/state?platform=${encodeURIComponent(platform)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': wbAuth.UA },
    body: '{}',
    signal: AbortSignal.timeout(15000),
  });
  const text = await resp.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 走兜底错误 */ }
  if (!resp.ok) {
    const msg = (json && (json.msg || json.message)) || `HTTP ${resp.status}`;
    throw new Error(`获取授权 state 失败：${msg}`);
  }
  const d = (json && json.data) || {};
  const state = d.state || null;
  if (!state) throw new Error('授权端点缺少 state');

  const authUrl = d.authUrl || d.auth_url || d.url
    || `${base}/login/started?platform=${encodeURIComponent(platform)}&state=${encodeURIComponent(state)}`;

  const loginId = 'wd_' + crypto.randomBytes(16).toString('hex');
  const timeoutSec = stateTimeoutSeconds();
  const session = {
    loginId,
    state,
    region: r,
    base,
    startedAt: Date.now(),
    expiresAt: Date.now() + timeoutSec * 1000,
    done: false,
    result: null,
    error: null,
  };
  sessions.set(loginId, { session, timer: scheduleCleanup(loginId, (timeoutSec + stateRetentionSeconds()) * 1000) });
  return { loginId, verificationUri: authUrl, state, expiresIn: timeoutSec };
}

/**
 * 用授权结果把账号写入 credentials 库（edition=workbuddy）。
 * token 只在内存中组装，落库即密文。
 *
 * enabled 口径（与 routes/workbuddy.js#POST /import 保持一致）：
 *   - 新建账号 → enabled=false（全新授权未做在线余额验证，先不进调度池）；
 *   - 更新既有账号 → **保留原有 enabled**。
 *     此前无条件写 enabled:false，导致「已启用、正在服务流量的账号」被一次
 *     同 uid 重新授权静默停用（实测：重授权后 enabled true→false）。
 *     既有导入路径的保护是 `if (!existing.enabled) patch.enabled = false`，
 *     本模块沿用同一语义。
 */
function importAccount(tokenData, accData, region) {
  const uid = String((accData && (accData.uid || accData.userId || accData.user_id)) || '');
  if (!uid) throw new Error('官方接口未返回 uid，无法保存账号');
  const accessToken = String((tokenData && (tokenData.accessToken || tokenData.access_token)) || '');
  const refreshToken = String((tokenData && (tokenData.refreshToken || tokenData.refresh_token)) || '');
  if (!accessToken && !refreshToken) throw new Error('授权结果缺少 accessToken/refreshToken');

  const expiresIn = Number((tokenData && (tokenData.expiresIn || tokenData.expires_in)) || 5184000);
  const expiresAtMs = Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 5184000 * 1000);

  const nickname = (accData && (accData.nickname || accData.name)) || '';
  const phoneNumber = (accData && (accData.phoneNumber || accData.phone)) || '';
  const userId = uid;

  const patch = {
    label: nickname || phoneNumber || ('wb-' + uid.slice(-6)),
    edition: 'workbuddy',
    source: 'oauth',
    token: accessToken || null,
    refreshToken: refreshToken || null,
    expiredAt: new Date(expiresAtMs).toISOString(),
    userId,
    userRegion: region,
    host: wbAuth.chatHost(region),
  };

  /*
   * 去重必须限定在 WorkBuddy 账号内：不同平台的 userId 空间可能碰撞
   * （uid 为手机号时尤其容易与其它渠道重合），无 edition 过滤会把别的平台
   * 账号静默改写成 WB 账号并覆盖其 token。
   */
  const existing = store.list().find((a) => a.edition === 'workbuddy' && String(a.userId) === uid);
  if (existing) {
    // 既有账号：只更新凭据与元数据，**不动 enabled**（保持它当前的调度状态）。
    const updated = store.update(existing.id, patch);
    return { id: updated.id, uid: userId, nickname, action: 'updated', enabled: updated.enabled === true };
  }
  // 新建账号：默认停用，待验证余额后再启用（与 workbuddy.js#POST /import 一致）
  const created = store.add(Object.assign({}, patch, { enabled: false }), 'workbuddy');
  return { id: created.id, uid: userId, nickname, action: 'created', enabled: false };
}

/**
 * 轮询一次授权结果。
 * @returns {Promise<{done:boolean, result?:object, error?:string}>}
 */
async function poll(loginId) {
  const entry = sessions.get(loginId);
  if (!entry) return { done: true, error: '登录请求不存在或已过期' };
  const { session } = entry;
  if (session.done) return { done: true, result: session.result, error: session.error };
  if (Date.now() > session.expiresAt) {
    session.done = true;
    session.error = '登录超时，请重新发起';
    return { done: true, error: session.error };
  }

  // 一次往返：能拿到 accessToken 才算授权完成；否则不推进状态。
  try {
    const tokenResp = await fetch(
      `${session.base}/v2/plugin/auth/token?state=${encodeURIComponent(session.state)}`,
      { method: 'GET', headers: { 'User-Agent': wbAuth.UA }, signal: AbortSignal.timeout(10000) },
    );
    const tokenText = await tokenResp.text().catch(() => '');
    let tokenJson = null;
    try { tokenJson = JSON.parse(tokenText); } catch { /* ignore */ }
    const code = tokenJson && tokenJson.code != null ? Number(tokenJson.code) : -1;
    const data = (tokenJson && tokenJson.data) || {};
    const accessToken = data.accessToken || data.access_token || '';
    if ((code !== 0 && code !== 200) || !accessToken) return { done: false };

    const accResp = await fetch(
      `${session.base}/v2/plugin/login/account?state=${encodeURIComponent(session.state)}`,
      {
        method: 'GET',
        headers: Object.assign(
          { Authorization: `Bearer ${accessToken}`, 'User-Agent': wbAuth.UA },
          data.domain ? { 'X-Domain': String(data.domain) } : {},
        ),
        signal: AbortSignal.timeout(10000),
      },
    );
    const accText = await accResp.text().catch(() => '');
    let accJson = null;
    try { accJson = JSON.parse(accText); } catch { /* ignore */ }
    const accData = (accJson && (accJson.data || (accJson.account || accJson))) || {};

    session.done = true;
    try {
      session.result = importAccount(data, accData, session.region);
    } catch (e) {
      session.error = e.message;
    }
    return { done: true, result: session.result, error: session.error };
  } catch (e) {
    // 网络抖动不算完成，也不推进状态；调用方（前端轮询 / 测试）自行决定重试或中止。
    return { done: false, transient: true, error: e && e.name === 'AbortError' ? '请求超时' : e.message };
  }
}

/** 主动作废一个登录会话（测试 teardown / 用户取消）。 */
function cancel(loginId) {
  const entry = sessions.get(loginId);
  if (!entry) return false;
  if (entry.timer) clearTimeout(entry.timer);
  sessions.delete(loginId);
  return true;
}

/**
 * 读取会话的**非敏感**状态（测试与诊断用）。
 * 只回 expiresAt / done / createdAt，不回 state / token 等任何凭据相关字段。
 */
function peekSession(loginId) {
  const entry = sessions.get(loginId);
  if (!entry) return null;
  return {
    expiresAt: entry.session.expiresAt,
    done: entry.session.done,
    createdAt: entry.session.startedAt || null,
  };
}

/** 当前在途会话数（诊断）。 */
function pendingCount() {
  return sessions.size;
}

/**
 * 会话剩余存活毫秒数（诊断/前端提示用）：未找到返回 null。
 * 不返回 state / token 等任何凭据相关字段。
 */
function remainingMs(loginId) {
  const entry = sessions.get(loginId);
  if (!entry) return null;
  return Math.max(0, entry.session.expiresAt - Date.now());
}

module.exports = {
  startLogin,
  poll,
  cancel,
  pendingCount,
  peekSession,
  remainingMs,
  stateTimeoutSeconds,
  stateRetentionSeconds,
  platformOfRegion,
  authBaseOfRegion,
  // 供测试注入：不直接改写 fetch 全局，仅导出默认实现便于断言参数
  _importAccount: importAccount,
};