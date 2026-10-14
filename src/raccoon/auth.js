'use strict';
/**
 * raccoon/auth.js —— 扫码登录会话、凭据续期、用户信息与模型目录。
 *
 * ## 登录会话是**进程内内存态**，刻意不落盘
 *
 * 会话里含一次性票据（`qrcode_code`），落盘只会扩大泄露面；生命周期只有
 * 5 分钟；网关重启后未完成的登录本就应当作废（用户重新扫码即可，无副作用）。
 *
 * ## 为什么要有会话级串行化
 *
 * 面板每 2 秒轮询一次，用户完全可能开两个标签页。并发轮询会让同一个 code
 * 被查两次，并可能把「已成功」的状态读成「还在轮询」——表现为扫码后二维码
 * 不变、用户以为没成功。故同一会话的轮询串行化：后来的调用复用同一次
 * 在途请求（`inflight`），而不是再打一次上游。
 *
 * ## 与官方桌面端链路的差异
 *
 * 官方靠 `office-raccoon://auth/callback` 自定义协议回调，服务端进程收不到；
 * `/code/authorize` 的回调地址又写死改不成 localhost。故参考项目实测后改为
 * 「本地生成 code + 自行轮询」——**任意自造 code 都被接受**并进入 `pending`。
 */
const crypto = require('crypto');
const variant = require('../platform/variant');
const client = require('./client');
const product = require('./product');

const V = variant.variantOf(variant.RACCOON);

/** sessionId → 会话。进程内，不落盘。 */
const sessions = new Map();

/**
 * 登录类端点（send_sms / login_with_sms / refresh / login_with_qrcode_code）的请求头。
 *
 * ⚠️ 参考实现里这几个端点**只发 `Content-Type`** —— 没有 Authorization、
 * 没有 `X-Org-Code`、没有 platform/version。别图省事套用业务头的构造器。
 */
const LOGIN_HEADERS = Object.freeze({ 'Content-Type': 'application/json' });

/**
 * 清理过期会话。
 * 每次创建会话时顺带跑一遍：会话量极小（单人使用），不需要定时器。
 */
function sweep(now = Date.now()) {
  for (const [id, s] of sessions) {
    if (s.expiresAtMs <= now) sessions.delete(id);
  }
}

/**
 * 开启一次扫码登录会话。
 * @returns {{sessionId:string, code:string, qrUrl:string, expiresAtMs:number, pollIntervalMs:number, timeoutMs:number}}
 */
function startLoginSession() {
  const now = Date.now();
  sweep(now);
  const sessionId = crypto.randomBytes(12).toString('hex');
  const code = product.generateQrCode();
  const session = {
    sessionId,
    code,
    qrUrl: product.buildQrImageUrl(code),
    createdAtMs: now,
    expiresAtMs: now + product.LOGIN_TIMEOUT_MS,
    // 最近一次上游状态，供并发轮询复用
    status: product.QR_STATUS.PENDING,
    expiredAt: null,
    inflight: null,
    /** 成功后置为账号 id，重复轮询不再重复入库 */
    accountId: null,
  };
  sessions.set(sessionId, session);
  return {
    sessionId,
    code,
    qrUrl: session.qrUrl,
    expiresAtMs: session.expiresAtMs,
    pollIntervalMs: product.QR_POLL_INTERVAL_MS,
    timeoutMs: product.LOGIN_TIMEOUT_MS,
  };
}

/** 取会话；不存在或已过期返回 null。 */
function getLoginSession(sessionId) {
  sweep();
  return sessions.get(String(sessionId || '')) || null;
}

/** 取消会话（用户关闭弹窗）。 */
function cancelLoginSession(sessionId) {
  return sessions.delete(String(sessionId || ''));
}

/**
 * 轮询一次扫码状态。
 *
 * ⚠️ 任何异常都降级为 `pending`（网络抖动、响应畸形、未知 status）：
 * 轮询是 2 秒一次的循环，偶发失败不应中断整个登录流程；而把未知状态误判成
 * `success` 会让流程拿到空 token 后卡死，误判成 `canceled` 则会让用户正在
 * 扫的二维码被无故刷新。
 *
 * @returns {Promise<{status:string, account?:object, expiredAt?:string|null}>}
 */
async function pollLoginSession(sessionId) {
  const session = getLoginSession(sessionId);
  if (!session) return { status: 'expired' };
  if (session.accountId) return { status: product.QR_STATUS.SUCCESS, accountId: session.accountId };

  // 串行化：同一会话已有在途请求时复用它
  if (session.inflight) return session.inflight;

  session.inflight = (async () => {
    let envelope;
    try {
      const r = await client.request({
        method: 'POST',
        path: 'loginWithQrcode',
        headers: { ...LOGIN_HEADERS },
        body: { qrcode_code: session.code },
      });
      envelope = r.envelope;
    } catch {
      return { status: product.QR_STATUS.PENDING };
    }
    if (!envelope || envelope.code !== 0 || envelope.data === undefined) {
      return { status: product.QR_STATUS.PENDING };
    }

    const raw = envelope.data.status;
    const status = typeof raw === 'string' ? raw : '';
    const expiredAt = typeof envelope.data.expired_at === 'string' ? envelope.data.expired_at : null;

    if (status === product.QR_STATUS.CANCELED) {
      session.status = product.QR_STATUS.CANCELED;
      return { status: product.QR_STATUS.CANCELED };
    }
    if (status === product.QR_STATUS.LOGGING) {
      session.status = product.QR_STATUS.LOGGING;
      session.expiredAt = expiredAt;
      return { status: product.QR_STATUS.LOGGING, expiredAt };
    }
    if (status === product.QR_STATUS.SUCCESS) {
      const accessToken = typeof envelope.data.access_token === 'string' ? envelope.data.access_token : '';
      const refreshToken = typeof envelope.data.refresh_token === 'string' ? envelope.data.refresh_token : '';
      // ⚠️ 缺 token 的 success 视为未完成：否则会产出空凭据并让流程卡死
      if (accessToken.length === 0) return { status: product.QR_STATUS.PENDING };

      const expMs = product.decodeJwtExpMs(accessToken);
      const credential = {
        access_token: accessToken,
        refresh_token: refreshToken,
        ...expMs !== undefined ? { expires_at: String(expMs) } : {},
        ...typeof envelope.data.office_identity === 'string' && envelope.data.office_identity.length > 0
          ? { office_identity: envelope.data.office_identity }
          : {},
      };
      const saved = await persistLogin(credential);
      session.status = product.QR_STATUS.SUCCESS;
      session.accountId = saved.id;
      return { status: product.QR_STATUS.SUCCESS, account: saved };
    }
    return { status: product.QR_STATUS.PENDING };
  })();

  try {
    return await session.inflight;
  } finally {
    session.inflight = null;
  }
}

/**
 * 把登录结果落库（幂等：同 userId 更新而非重复插入）。
 *
 * 昵称与手机号的处理（照抄参考项目的结论）：
 *   - 远端的 `name` 是**服务端自动生成的默认名**（实测 `RaccoonAva`），
 *     微信扫码**不回传微信昵称**，所以它不能单独用来区分多账号；
 *   - `user_info.phone` 是唯一可靠的区分依据，故只把**尾号 4 位**拼进 label
 *     （完整手机号是 PII，本网关不需要它做别的，就不落盘）。
 */
async function persistLogin(credential) {
  const store = require('../credentials/store');
  let info = {};
  try {
    info = await fetchUserInfo(credential);
  } catch {
    // 用户信息只用于展示，失败不该让登录失败
  }

  const userId = info.userId || null;
  const nickname = info.nickname || '';
  const phone = info.phone || '';
  const tail = phone.replace(/\D/g, '').slice(-4);
  const base = nickname || (userId ? `raccoon-${userId}` : 'raccoon');
  const label = tail ? `${base}-${tail}` : base;

  const acct = {
    label,
    edition: variant.RACCOON,
    mode: 'jwt',
    token: credential.access_token,
    refreshToken: credential.refresh_token || null,
    expiredAt: credential.expires_at ? new Date(Number(credential.expires_at)).toISOString() : null,
    refreshExpiredAt: null,
    userId,
    host: V.hosts.openapi,
    source: 'login',
    raccoonOrg: info.officeIdentity || credential.office_identity || null,
    // 刻意不生成设备标识：参考实现全链路只读不写 device_id，
    // 我们拿不到生成规则，猜一个假设备号比不发更糟。
  };

  const existing = store.list().find((a) => variant.isEdition(a.edition, variant.RACCOON)
    && a.userId && userId && String(a.userId) === String(userId));
  if (existing) {
    return store.update(existing.id, {
      ...acct,
      lastCheckinResult: 'login_updated',
    });
  }
  return store.add(acct, 'login');
}

/**
 * 拉取用户信息（展示用）。
 *
 * ⚠️ 失败时返回**空对象**而不是抛错：用户信息只用于昵称展示，
 * 不该因为它失败而让整个登录流程失败（登录已经成功了）。
 */
async function fetchUserInfo(credential) {
  const r = await client.request({
    method: 'GET',
    path: 'userInfo',
    headers: product.headers(credential),
  });
  const data = client.unwrap(r.envelope, { method: 'GET', path: 'userInfo', status: r.status });
  if (!data) return {};
  return {
    userId: typeof data.id === 'string' ? data.id : null,
    nickname: typeof data.name === 'string' ? data.name : '',
    officeIdentity: typeof data.office_identity === 'string' ? data.office_identity : '',
    phone: typeof data.phone === 'string' ? data.phone : '',
  };
}

/**
 * 用 refresh_token 换新凭据。
 *
 * ⚠️ 服务端可能**只返回新的 access_token**（不带新 refresh_token），此时必须
 * **保留旧值** —— 否则续期一次就把账号变成不可续期。
 * ⚠️ 服务端不返回的附加字段（office_identity / device_id）也要保留。
 * ⚠️ 401 或 code 200003 表示 refresh_token 已失效，抛「请重新登录」且不重试。
 */
async function refreshCredential(credential) {
  const r = await client.request({
    method: 'POST',
    path: 'refresh',
    headers: product.headers(credential),
    body: { refresh_token: credential.refresh_token },
  });
  if (r.status === 401 || (r.envelope && r.envelope.code === V.errors.refreshExpired)) {
    const err = new client.RaccoonApiError('raccoon 登录态已过期，请重新登录', { code: V.errors.refreshExpired, status: r.status });
    err.needsRelogin = true;
    throw err;
  }
  const data = client.unwrap(r.envelope, { method: 'POST', path: 'refresh', status: r.status });
  const accessToken = data && typeof data.access_token === 'string' ? data.access_token : '';
  if (accessToken.length === 0) {
    throw new client.RaccoonApiError('raccoon 续期响应缺少 access_token', { status: r.status });
  }
  const nextRefresh = data.refresh_token && typeof data.refresh_token === 'string' && data.refresh_token.length > 0
    ? data.refresh_token
    : credential.refresh_token;
  const expMs = product.decodeJwtExpMs(accessToken);
  return {
    ...credential,
    access_token: accessToken,
    refresh_token: nextRefresh,
    ...expMs !== undefined ? { expires_at: String(expMs) } : {},
  };
}

/**
 * 续期并回写账号库（定时保活与请求前兜底共用）。
 * @returns {Promise<object>} 更新后的账号记录
 */
async function refreshAccount(acct) {
  const store = require('../credentials/store');
  const credential = client.credentialOf(acct);
  if (!product.isRefreshable(credential)) {
    const err = new client.RaccoonApiError('raccoon 凭据没有 refresh_token，无法续期，请重新登录');
    err.needsRelogin = true;
    throw err;
  }
  const next = await refreshCredential(credential);
  return store.update(acct.id, {
    token: next.access_token,
    refreshToken: next.refresh_token || null,
    expiredAt: next.expires_at ? new Date(Number(next.expires_at)).toISOString() : acct.expiredAt,
  });
}

/**
 * 拉取远端模型目录；任何失败都回退兜底表（**不抛错**）。
 *
 * 兜底表有 6 个实测模型，够面板显示与对话选模；远端目录提供精确倍率与窗口。
 * 远端失败时返回兜底并带上 `source: 'fallback'`，让面板能说明「倍率可能不是最新」。
 */
async function fetchModelCatalog(acct) {
  try {
    const r = await client.request({
      method: 'GET',
      path: 'modelCatalog',
      headers: product.catalogHeaders(client.credentialOf(acct)),
      timeoutMs: 20_000,
    });
    if (!r.envelope || r.envelope.code !== 0) return { source: 'fallback', models: product.fallbackCatalog() };
    // 解析器吃的是**原始信封**（它自己判 code 并取 data.categories）
    const models = product.parseModelCatalog(r.envelope.raw);
    if (!models.length) return { source: 'fallback', models: product.fallbackCatalog() };
    return { source: 'remote', models };
  } catch {
    return { source: 'fallback', models: product.fallbackCatalog() };
  }
}

module.exports = {
  startLoginSession,
  getLoginSession,
  cancelLoginSession,
  pollLoginSession,
  persistLogin,
  fetchUserInfo,
  refreshCredential,
  refreshAccount,
  fetchModelCatalog,
  // 仅供单测
  _sessions: sessions,
};
