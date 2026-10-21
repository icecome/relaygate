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

/** 远端取消服务端签发的二维码（幂等，失败只记日志）。 */
async function cancelRemoteQr(code) {
  if (!code) return;
  try {
    await client.request({
      method: 'PUT',
      path: 'qrCancel',
      headers: { ...LOGIN_HEADERS },
      body: { qrcode_code: code, status: 'canceled' },
    });
  } catch (e) {
    // 取消失败不影响本地清理（服务端会按 expires_in 自然过期）
    console.warn(`[raccoon] 远端取消二维码失败 code=${code}: ${e.message}`);
  }
}

/**
 * 开启一次扫码登录会话（**新 IAM 链路**，2026-10-18 切换）。
 *
 * 与旧实现的根本差异：`qrcode_code` 由**服务端签发**，不再本地自造。
 * 流程：先 `POST /api/iam/v1/auth/mp/qrcode` 拿 `{qrcode_code, scan_path,
 * expires_in, poll_interval}`，再用 `buildQrUrl` 拼出二维码内容。
 *
 * 为什么必须服务端签发：官方已把 `/login/mp` 页面改为只认签发码 ——
 * 自造码访问该页直接 404，微信端就报「二维码过期」。实测（2026-10-18）：
 * 旧 `login_with_qrcode_code` 虽仍回 200 pending，但永远走不到 success。
 *
 * ⚠️ 上游请求失败时**抛错**（旧版是同步函数不会抛）：路由层会转成 500，
 * 面板显示「发起登录失败」并允许重试 —— 这比给一个必然扫不上的假二维码诚实。
 *
 * @returns {Promise<{sessionId:string, code:string, qrUrl:string,
 *                    expiresAtMs:number, pollIntervalMs:number, timeoutMs:number}>}
 */
async function startLoginSession() {
  const now = Date.now();
  sweep(now);

  const r = await client.request({
    method: 'POST',
    path: 'qrCreate',
    headers: { ...LOGIN_HEADERS },
    body: {},
  });
  const data = client.unwrap(r.envelope, { method: 'POST', path: 'qrCreate', status: r.status });
  const code = typeof data.qrcode_code === 'string' ? data.qrcode_code : '';
  const scanPath = typeof data.scan_path === 'string' ? data.scan_path : '';
  // 缺这两个字段说明响应形状不对，别拿残缺信息拼二维码
  if (!code || !scanPath) {
    throw new client.RaccoonApiError('扫码创建响应缺少 qrcode_code / scan_path', {
      method: 'POST', path: 'qrCreate', status: r.status, body: r.envelope && r.envelope.raw,
    });
  }

  let qrUrl;
  try {
    qrUrl = product.buildQrUrl({
      origin: V.identity.qrOrigin,
      scanPath,
      code,
      brand: V.identity.qrAppname,
      source: V.identity.qrSource,
    });
  } catch (e) {
    // 服务端给的 scanPath 不合白名单：这是上游异常，绝不能拿它拼二维码
    // （可能是配置变更或攻击面），直接失败并告知用户
    await cancelRemoteQr(code);
    throw new client.RaccoonApiError(`扫码路径校验失败（scanPath=${JSON.stringify(scanPath)}）：${e.message}`, {
      method: 'POST', path: 'qrCreate', status: r.status, body: { scanPath },
    });
  }

  // 服务端给的 300s 有效期为准；本地超时仍用 5 分钟兜底（含轮询迟到窗口）
  const expiresInMs = Number.isFinite(data.expires_in) && data.expires_in > 0
    ? data.expires_in * 1000
    : product.LOGIN_TIMEOUT_MS;
  const pollIntervalMs = Number.isFinite(data.poll_interval) && data.poll_interval > 0
    ? Math.max(1000, data.poll_interval * 1000)
    : product.QR_POLL_INTERVAL_MS;

  const sessionId = crypto.randomBytes(12).toString('hex');
  const session = {
    sessionId,
    code,
    qrUrl,
    createdAtMs: now,
    expiresAtMs: now + Math.min(expiresInMs, product.LOGIN_TIMEOUT_MS),
    pollIntervalMs,
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
    qrUrl,
    expiresAtMs: session.expiresAtMs,
    pollIntervalMs,
    timeoutMs: product.LOGIN_TIMEOUT_MS,
  };
}

/** 取会话；不存在或已过期返回 null。 */
function getLoginSession(sessionId) {
  sweep();
  return sessions.get(String(sessionId || '')) || null;
}

/** 取消会话（用户关闭弹窗）：本地删除 + 远端取消签发码。 */
function cancelLoginSession(sessionId) {
  const s = sessions.get(String(sessionId || ''));
  sessions.delete(String(sessionId || ''));
  if (s) void cancelRemoteQr(s.code);
  return !!s;
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
        path: 'qrPoll',
        headers: { ...LOGIN_HEADERS },
        body: { qrcode_code: session.code },
      });
      envelope = r.envelope;
    } catch {
      return { status: product.QR_STATUS.PENDING };
    }
    // ⚠️ 过期判据必须读 `envelope.raw.code` 原文，**不能**读 `envelope.code`：
    // normalizeEnvelope 把非数字 code（新 IAM 用字符串业务码，如
    // `AUTH_QRCODE_EXPIRED`）在 HTTP 200 时折成 **0**，字符串信息只剩在 raw 里。
    // 只判 `envelope.code !== 0` 会让过期码被当成成功信封，进而落到下面的
    // `data` 分支读到一个 `data:null` → 恒回 pending，二维码永不刷新、用户卡住。
    // 实测（2026-10-18）：这就是「微信提示二维码过期但面板一直转圈」的成因。
    const rawCode = envelope && envelope.raw && typeof envelope.raw.code === 'string'
      ? envelope.raw.code
      : '';
    if (/QRCODE_EXPIRED|EXPIRED/i.test(rawCode)) {
      session.status = 'expired';
      sessions.delete(sessionId);
      return { status: 'expired' };
    }
    // 其它非 0（数字业务码或 HTTP 兜底码）与畸形响应一律降级为 pending：
    // 轮询是 2 秒循环，偶发抖动不该中断；但误判 success 会拿到空 token 卡死。
    if (envelope && envelope.code !== 0) {
      return { status: product.QR_STATUS.PENDING };
    }
    if (!envelope || envelope.data === undefined) {
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
      let accessToken = typeof envelope.data.access_token === 'string' ? envelope.data.access_token : '';
      let refreshToken = typeof envelope.data.refresh_token === 'string' ? envelope.data.refresh_token : '';
      // ⚠️ 缺 token 的 success 视为未完成：否则会产出空凭据并让流程卡死
      if (accessToken.length === 0) return { status: product.QR_STATUS.PENDING };

      // ⚠️ 2026-10-19 实测（P0）：新 IAM 扫码 success **不回 refresh_token**，
      // 而未确认的会话打任何 `/api/web/*` 都回
      // `400 code=200901 iam_confirm_required`（积分/用户信息/对话全挂）。
      // 实测确认手段就是**做一次 refresh**：拿 access_token 当 refresh_token
      // 调 `auth/v1/refresh`，服务端会补发完整的 access+refresh 令牌对，
      // 并把该会话标记为已确认 —— 之后原 token 也直接可用。
      // 对照组：Olivia 的凭据来自桌面客户端（本地 auth.json，客户端自己完成
      // 过确认），从没出现过 200901。
      if (refreshToken.length === 0) {
        try {
          const rr = await client.request({
            method: 'POST',
            path: 'refresh',
            headers: { ...LOGIN_HEADERS },
            body: { refresh_token: accessToken },
          });
          const rd = rr.envelope && rr.envelope.code === 0 ? rr.envelope.data : null;
          if (rd && typeof rd.access_token === 'string' && rd.access_token.length > 0) {
            accessToken = rd.access_token;
            if (typeof rd.refresh_token === 'string' && rd.refresh_token.length > 0) {
              refreshToken = rd.refresh_token;
            }
          }
        } catch {
          // 确认失败不阻塞登录：token 本身有效，上游可能只是暂时不给 refresh；
          // 但 200901 会在首次业务请求时出现，由调用方凭错误文案感知。
        }
      }

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
async function persistLogin(credential, opts = {}) {
  const store = require('../credentials/store');
  let info = {};
  try {
    info = await fetchUserInfo(credential);
  } catch {
    // 用户信息只用于展示，失败不该让登录失败
  }

  const userId = info.userId || null;
  const nickname = info.nickname || '';
  // 手机号优先取远端 user_info；取不到时用调用方给的（密码登录场景已知）
  const phone = info.phone || (typeof opts.phone === 'string' ? opts.phone : '');
  const tail = phone.replace(/\D/g, '').slice(-4);
  const base = nickname || (userId ? `raccoon-${userId}` : 'raccoon');
  // 调用方可显式给 label（密码登录时手机号是已知的，不必依赖 user_info）
  const label = opts.label || (tail ? `${base}-${tail}` : base);

  const acct = {
    label,
    edition: variant.RACCOON,
    mode: 'jwt',
    token: credential.access_token,
    refreshToken: credential.refresh_token || null,
    expiredAt: credential.expires_at ? new Date(Number(credential.expires_at)).toISOString() : null,
    refreshExpiredAt: null,
    // ⚠️ userId 只在**确实拿到**时才写。这里如果无条件写 null，user_info 一次失败
    // 就会把既有账号的 userId 抹掉 —— 而抹掉之后，userId 这条路（一级幂等键）
    // 与「已有 userId 才参与手机号匹配」的二级回退同时失效，下一轮必然新建账号
    // （实测：3 次调用变 3 条）。不能把「没查到」当成「没有身份」。
    ...(userId ? { userId } : {}),
    host: V.hosts.openapi,
    source: 'login',
    raccoonOrg: info.officeIdentity || credential.office_identity || null,
    // 密码登录路径已知手机号：一并落库作为下次的幂等键（扫码路径 phone 为空，
    // 不写该列，保持既有「不落 PII」的口径）。
    ...(phone ? { raccoonPhone: phone } : {}),
    // 刻意不生成设备标识：参考实现全链路只读不写 device_id，
    // 我们拿不到生成规则，猜一个假设备号比不发更糟。
  };

  // 幂等键两级回退（2026-10-21 修复「user_info 失败就新增重复账号」）：
  // 只认 userId 是有洞的——fetchUserInfo 失败被 catch 成 {} ⇒ userId=null
  // ⇒ existing=null ⇒ 每次 store.add()。每日保活每天调一次密码登录，只要某天
  // user_info 偶发失败就会多一条账号（实测连跑 3 天变 3 条）。
  const raccoons = store.list().filter((a) => variant.isEdition(a.edition, variant.RACCOON));
  // 一级：userId（最可靠）
  let existing = userId
    ? raccoons.find((a) => a.userId && String(a.userId) === String(userId))
    : null;
  // 二级：手机号。手机号是**强身份键**（一个手机号属于且仅属于一个上游账号），
  // 且只有密码登录路径才会落这一列，因此不必再要求「对方已有 userId」——
  // 前面的「没拿到 userId 就写 null」曾让这条回退永远命中不到自己刚写过的账号。
  if (!existing && phone) {
    const digits = phone.replace(/\D/g, '');
    existing = raccoons.find((a) => {
      const full = store.get(a.id);
      const stored = full && full.raccoonPhone ? full.raccoonPhone.replace(/\D/g, '') : '';
      return stored && stored === digits;
    });
  }
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

/**
 * 用「手机号 + 密码」做一次**真实登录**，返回并落库新凭据。
 *
 * ## 为什么这条路重要（2026-10-20 实证）
 *
 * 每日积分的**发放载体是真实登录**，不是网关代打 grant：
 *   - 全量账单证实 10-19/10-20 上游未产生当日 daily_grant；
 *   - grant / refresh / balance / catalog 等端点均不能触发发放；
 *   - IAM `last_login_at` 不因这些调用更新；
 *   - 而客户端真实运行时（`login_with_*`）会立即产生 daily_grant。
 *
 * `login_with_password` 是网关侧**唯一可编程复刻的真实登录入口**（扫码需要人扫，
 * 短信需要滑块 + 手机）。故它是「网关每日保活」的正解。
 *
 * ## 协议细节（实测）
 *
 * - 端点：`POST /api/web/auth/v1/login_with_password`
 * - 头：**只有** `Content-Type`（无 Authorization、无业务头），与其它登录端点一致
 * - body：`{ nation_code, phone, password }`，**phone 与 password 都要加密**
 *   （AES-128-CFB，`product.encryptSecret`）
 * - 错误码：`100003 params_encryted_error` = 没加密；
 *   `100002 params_invalid_error` = 加密对了但密码错
 *
 * @param {{nationCode?:string, phone:string, password:string, label?:string}} p
 * @returns {Promise<{account:object, credential:object}>}
 */
async function loginWithPassword({ nationCode = '86', phone, password, label }) {
  if (typeof phone !== 'string' || phone.trim().length === 0) {
    throw new client.RaccoonApiError('密码登录需要手机号', { code: 'MISSING_PHONE' });
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new client.RaccoonApiError('密码登录需要密码', { code: 'MISSING_PASSWORD' });
  }

  const r = await client.request({
    method: 'POST',
    path: 'loginWithPassword',
    headers: { ...LOGIN_HEADERS },
    body: {
      nation_code: nationCode,
      phone: product.encryptSecret(phone),
      password: product.encryptSecret(password),
    },
  });
  const data = client.unwrap(r.envelope, { method: 'POST', path: 'loginWithPassword', status: r.status });
  const accessToken = data && typeof data.access_token === 'string' ? data.access_token : '';
  const refreshToken = data && typeof data.refresh_token === 'string' ? data.refresh_token : '';
  if (accessToken.length === 0) {
    throw new client.RaccoonApiError('密码登录未返回 access_token', {
      method: 'POST', path: 'loginWithPassword', status: r.status, body: r.envelope && r.envelope.raw,
    });
  }

  const expMs = product.decodeJwtExpMs(accessToken);
  const credential = {
    access_token: accessToken,
    refresh_token: refreshToken,
    ...expMs !== undefined ? { expires_at: String(expMs) } : {},
    ...typeof data.office_identity === 'string' && data.office_identity.length > 0
      ? { office_identity: data.office_identity }
      : {},
  };
  // phone 必须传下去：它是 user_info 不可用时唯一可用的幂等键，
  // 也是下一次「配置密码登录」能对上同一条账号的依据。
  const account = await persistLogin(credential, { label, phone });
  return { account, credential };
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
  loginWithPassword,
  fetchModelCatalog,
  // 仅供单测
  _sessions: sessions,
};
