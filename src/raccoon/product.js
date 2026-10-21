'use strict';
/**
 * raccoon/product.js —— Raccoon（商汤小浣熊）协议**纯函数与常量**。
 *
 * 移植来源：参考项目 `dsh-our-free-model` 的
 * `vendor/channel-pack/src/raccoon.ts` 与 `raccoon-product.ts`
 * （MIT License, Copyright (c) 2026 Ebony-Vinyl）。
 *
 * 分层约定（与本仓库其余平台一致）：
 *   - **域名与路径在 `platform/variant.js`**（单一事实源），本文件不重复硬编码；
 *   - 本文件只放纯函数与协议常量，**不发请求、不碰账号库**；
 *   - HTTP 在 `client.js`，登录会话在 `auth.js`，积分在 `credits.js`。
 *
 * ## 三个必须记住的坑（原文照搬，改代码前先读）
 *
 * 1. **官方桌面端的登录链路不可复用**：它靠 `office-raccoon://auth/callback`
 *    自定义协议回调，而本网关是服务端进程，收不到该回调；且 `/code/authorize`
 *    页面的回调地址是**写死的**，改不成 localhost。故改为「本地生成 code +
 *    自行轮询」—— 实测任意自造 code 都被接受。
 * 2. **手机号必须 AES-128-CFB 加密**（密钥见 `PHONE_CIPHER_SECRET`），
 *    否则 `send_sms` 回 `100003 params_encryted_error`。
 * 3. **每日 300 积分没有端点**：服务端按日自动发放（`daily_grant`）。
 *    不要把它实现成签到按钮 —— 不存在可调用的端点，按钮必然失败。
 *    2026-10-15 解包 + 抓包**再次实证**：全量 asar 里没有任何 daily/checkin/
 *    sign_in 端点，`points/v1/*` 只有 `balance` 与 `bills` 两条；能主动调用的
 *    发放端点只有**一次性**的 `desktop/v1/login/points/grant`。
 *
 * ## 2026-10-15 解包新增的第四个大坑（P0，抓包实证）
 *
 * 4. **`X-Org-Code` 绝不能填 `"personal"`** —— 个人账号的 `office_identity`
 *    字面值就是 `"personal"`，上游会把它当真组织码查并回
 *    `400 org_not_found_error`，打掉**余额 / 模型目录 / 登录奖励 / 对话转发**。
 *    客户端自己的处理是显式排除 personal（见 {@link orgCodeOf}），必须照抄。
 */
const crypto = require('crypto');
const variant = require('../platform/variant');

const V = variant.variantOf(variant.RACCOON);

/**
 * 手机号传输层加密密钥。
 *
 * ⚠️ 这是**公开常量**（客户端把它硬编码在前端 bundle 里），只用于防止手机号
 * 明文出现在日志/代理里，**不是安全边界**。故放在源码里不引入新的泄露面。
 */
const PHONE_CIPHER_SECRET = 'senseraccoon2023';

/**
 * 续期提前窗口（秒）。
 * 照抄官方 `scheduleAuth.js` 的 `TOKEN_REFRESH_WINDOW_SECONDS = 300`。
 *
 * ⚠️ **token 寿命已由 2026-10-15 本机实测修正为 30 天**（`exp - nbf = 2592005s`），
 * 不是本文档早期记载的「约 3 小时」。判据来自解码本机客户端
 * `~/.box-agent/config/auth.json` 的 access_token：
 * `nbf=1792027241 exp=1794619246` ⇒ 720.0 小时。
 * 该数值只影响「多久续一次」，不影响正确性（提前窗口照旧 300s 即可），
 * 但它**推翻了**「必须每天定时保活」的紧迫性假设 —— 见 scheduler 的说明。
 */
const TOKEN_REFRESH_WINDOW_SECONDS = 300;

/** 请求超时（毫秒）。 */
const REQUEST_TIMEOUT_MS = Number(process.env.RACCOON_TIMEOUT_MS || 60_000);

/** 扫码轮询间隔（毫秒）。与客户端一致；面板按此时长轮询后端。 */
const QR_POLL_INTERVAL_MS = 2_000;

/** 扫码登录整体超时（毫秒）。 */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** 扫码状态机的状态值（上游 `data.status`）。 */
const QR_STATUS = Object.freeze({
  PENDING: 'pending',
  LOGGING: 'logging',
  CANCELED: 'canceled',
  SUCCESS: 'success',
});

/** 「桌面端登录奖励」在账单里的 `event_name`（用于判定是否已领）。 */
const LOGIN_REWARD_EVENT_NAME = '桌面端登录奖励';
/** 登录奖励默认额度（服务端未在 popup 里给出时兜底）。 */
const LOGIN_REWARD_POINTS = 3000;

/**
 * 每日发放的积分额度（实测账单 `biz_type === 'daily_grant'` 恒为 +300）。
 * 仅作展示与「作废了多少」的基准，**不是**可领取额度 —— 没有领取端点。
 */
const DAILY_GRANT_POINTS = 300;

/** 账单里代表「每日发放 / 每日作废」的 `biz_type`（实测字符串，勿改）。 */
const DAILY_GRANT_BIZ_TYPE = 'daily_grant';
const DAILY_EXPIRE_BIZ_TYPE = 'daily_expire';

/**
 * 把积分账单聚合出**每日池**的运营视图（纯函数，不发请求）。
 *
 * ## 为什么这个函数才是本渠道「每日签到」的正确形态
 *
 * 每日 300 分**没有领取端点**（服务端自动发），所以「签到按钮」在这个渠道
 * 注定失败。但它**会过期** —— 实测账单同时给出
 * `grant_at` 与 `expire_at`，未用尽的部分由一条 `daily_expire` 负向账单清零：
 * 本机账号 2026-10-14 的 300 分**一分没花、整额作废**。
 *
 * 所以用户真正需要的是「**今天还剩多少、什么时候作废**」，据此决定要不要
 * 在过期前把额度烧掉。这把一个「领不到」的事实变成「可运营」的信息，
 * 是本渠道在每日维度上唯一有收益的自动化点。
 *
 * ## 口径
 *
 * - `remaining`：余额接口的 `daily_points`（当前每日池余额）。缺它则为 null。
 * - `grantedBatches`：`biz_type=daily_grant` 且 points>0 的发放批次数。
 * - `nextExpiryAt` / `nextExpiryHoursLeft`：**最早到期**的未作废批次时刻。
 *   到期时刻取账单的 `expire_at`；客户端自己的处理（模块 34917 的 `d()`）
 *   同样以 `expire_at` 为准，并对 `1971-01-01` 之前的哨兵值判为「无意义」，
 *   这里照抄该判据：无效时间戳的批次不参与到期判定。
 *   ⚠️ 将作废的**额度**是 `dailyRemaining`（每日池当前余额），不是各批次
 *   发放额之和 —— 发放额里已花掉的部分不会作废，相加会虚报损失。
 * - `expiredTotal`：所有 `daily_expire` 账单的绝对值之和（历史作废总量）。
 *
 * 时间参数用毫秒注入，便于单测；缺省为 `Date.now()`。
 *
 * @param {{balance?:{daily_points?:number}, incomeItems?:Array, expenseItems?:Array, nowMs?:number}} input
 */
function summarizeDailyPoints(input = {}) {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const balance = input.balance && typeof input.balance === 'object' ? input.balance : {};
  const income = Array.isArray(input.incomeItems) ? input.incomeItems : [];
  const expense = Array.isArray(input.expenseItems) ? input.expenseItems : [];

  const dailyRemaining = Number.isFinite(balance.daily_points) ? balance.daily_points : null;

  /** 解析时间戳 → 毫秒；无效或 1971 年以前的哨兵值返回 null（与客户端一致）。 */
  const toMs = (value) => {
    if (typeof value !== 'string' || value.trim().length === 0) return null;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms) || ms <= new Date('1971-01-01T00:00:00Z').getTime()) return null;
    return ms;
  };

  const granted = [];
  for (const item of income) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (item.biz_type !== DAILY_GRANT_BIZ_TYPE) continue;
    const points = Number.isFinite(item.points) ? item.points : 0;
    if (points <= 0) continue;
    granted.push({
      points,
      grantedAtMs: toMs(item.grant_at),
      expiresAtMs: toMs(item.expire_at),
      createdAt: typeof item.created_at === 'string' ? item.created_at : '',
      bizId: typeof item.biz_id === 'string' ? item.biz_id : '',
    });
  }
  granted.sort((a, b) => (a.grantedAtMs ?? Number.MAX_SAFE_INTEGER) - (b.grantedAtMs ?? Number.MAX_SAFE_INTEGER));

  // 作废总量：daily_expire 是负向账单，取绝对值累加
  let expiredTotal = 0;
  for (const item of expense) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (item.biz_type !== DAILY_EXPIRE_BIZ_TYPE) continue;
    const points = Number.isFinite(item.points) ? item.points : 0;
    if (points < 0) expiredTotal += -points;
  }

  // 待作废：取**最早到期**的批次。
  // ⚠️ 不能把各批次的 points 相加当「将损失额度」—— 那是发放额，其中已花掉的
  // 部分不会作废。真正会作废的额度就是 daily_remaining（每日池当前余额），
  // 到期时刻取最早那一批的 expire_at（实测同批 grant→expire 约 7 天）。
  const live = granted.filter((g) => g.expiresAtMs !== null && g.expiresAtMs > nowMs);
  const nextExpiry = live.length
    ? live.reduce((min, g) => (g.expiresAtMs < min.expiresAtMs ? g : min), live[0])
    : null;

  // 今日是否已发放 daily_grant。**如实标出上游状态**（不是我们能不能延长）：
  // 实测 2026-10-19/10-20 连续两天上游未产生当日 daily_grant（全量账单扫描证实），
  // 此时「保活未延长」不是失败，而是**无可延长对象**。面板据此显示
  // 「上游尚未发放今日每日积分」而非「签到失败」。
  const todayKeyOf = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const todayKey = todayKeyOf(nowMs);
  const grantedToday = granted.some((g) => g.grantedAtMs !== null && todayKeyOf(g.grantedAtMs) === todayKey);

  return {
    claimable: false,
    grantPoints: DAILY_GRANT_POINTS,
    dailyRemaining,
    grantedBatches: granted.length,
    nextExpiryAt: nextExpiry ? new Date(nextExpiry.expiresAtMs).toISOString() : null,
    nextExpiryHoursLeft: nextExpiry
      ? Math.max(0, Math.round((nextExpiry.expiresAtMs - nowMs) / 3600_000 * 10) / 10)
      : null,
    expiredTotal,
    grantedToday,
    observedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * 兜底模型表（远端目录拉不到时用）。
 *
 * ⚠️ `contextWindow` / `maxTokens` 是**实测值**（参考项目 2026-09-26 逐条核对），
 * 不要省成 0：下游若拿 0 当上限会直接把请求判成非法，整轮对话起不来。
 *
 * ⚠️ **1 倍也要显示倍率**（参考项目里的真实用户报障：「为什么 Kimi-K3 没有倍率，
 * ide 是 1 倍，1 倍也要显示倍率」）。早期按「1 倍是默认，显示属噪声」省略它，
 * 结果该模型在列表里看起来没有计费信息 —— 用户无法区分「它就是 1 倍」与
 * 「我们没取到它的倍率」。
 *
 * ⚠️ **不含 `Raccoon-Auto`**：它是客户端 i18n 条目，不是远端模型 ——
 * 直接把该名字发给 `chat/completions` 会 404。
 */
const FALLBACK_MODELS = Object.freeze([
  { id: 'sn-sensenova-6-8-flash', name: 'SenseNova-6.8-Flash · 免费', contextWindow: 256000, maxTokens: 63999, supportsImage: true },
  { id: 'sn-sensenova-6-8-flash-lite', name: 'SenseNova-6.8-Flash-Lite · 免费', contextWindow: 256000, maxTokens: 63999, supportsImage: true },
  { id: 'sn-glm-5-3', name: 'GLM-5-3 · x0.75', contextWindow: 1000000, maxTokens: 100000, supportsImage: true },
  { id: 'sn-kimi-k3', name: 'Kimi-K3 · x1', contextWindow: 1000000, maxTokens: 100000, supportsImage: true },
  { id: 'sn-glm-5-3-flash', name: 'GLM-5-3-Flash · x0.2→x0.1', contextWindow: 1000000, maxTokens: 100000, supportsImage: true },
  { id: 'sn-deepseek-v4-1-flash', name: 'DeepSeek-V4.1-Flash · x0.25', contextWindow: 1000000, maxTokens: 100000, supportsImage: true },
]);

/**
 * 远端 `tags` 缺 `vision`、但**实测能看图**的模型（显式白名单）。
 *
 * ⚠️ 为什么不能「恒 true」：远端 `tags` 的真实用途是客户端「Raccoon-Auto 选模」
 * 的偏好标签，回答的是「适不适合这类任务」，**不是**「能不能吃图」。参考项目
 * 已穷举 9 个条目：顶层 14 个键、`params` 只有 `context_window` 与 `max_tokens`，
 * 用模态相关正则扫描**命中 0 个** ⇒ 远端从未下发模态字段。
 * 故只覆盖有真实请求证据的个案（`tags` 无 vision 但带图实测 6/6 全部读对）。
 * 若改成「该家恒支持」，将来上架纯文本模型时会把图放行、让上游回一个更难懂的 400。
 */
const IMAGE_CAPABILITY_OVERRIDES = new Set([
  'sn-deepseek-v4-1-flash',
  'sn-glm-5-3-flash',
]);

/* ---------- 凭据 ---------- */

/**
 * 解码 JWT payload 的 `exp`，换算成**毫秒**时间戳。
 *
 * ⚠️ 只解码、**不验签** —— 我们只需要知道什么时候该续期，签名由服务端校验。
 * ⚠️ 任何解析失败都返回 undefined 而**不抛错**：凭据可能被手工改坏，
 * 那时应当降级成「无过期信息」（宁可试一次），而不是让整个平台崩。
 */
function decodeJwtExpMs(token) {
  if (typeof token !== 'string' || token.length === 0) return undefined;
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] || '', 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
    const exp = payload.exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return undefined;
    return exp * 1000;
  } catch {
    return undefined;
  }
}

/**
 * 解析凭据的过期时刻（毫秒）。
 * 取值优先级：`expires_at`（显式字段）→ **JWT 的 `exp`**。
 *
 * ⚠️ 回退到 JWT 是**必需的**，不是锦上添花：`expires_at` 是可选字段，
 * 老凭据或手工导入的凭据可能没有它。只读 `expires_at` 会让过期判定恒为 false，
 * 于是续期永远跳过这些账号 —— 表现为「凭据悄悄过期、续期从不触发」，属静默失效。
 * 这与 ZCode「JWT 无 exp、长期有效」是相反的坑，不要照抄那边。
 */
function credentialExpiresAtMs(credential) {
  const raw = credential && credential.expires_at;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return decodeJwtExpMs(credential && credential.access_token);
}

/**
 * 凭据是否已过期。
 * 无任何过期信息（既无 `expires_at` 也不是 JWT）时视为**不过期**：
 * 宁可用一个可能过期的凭据去试（服务端会回 401，我们能识别并续期），
 * 也不要凭猜测阻止用户使用。
 */
function isExpired(credential, now = Date.now()) {
  const at = credentialExpiresAtMs(credential);
  return at !== undefined && at <= now;
}

/** 是否已进入「提前续期窗口」，供定时保活使用。 */
function needsRefresh(credential, now = Date.now()) {
  const at = credentialExpiresAtMs(credential);
  if (at === undefined) return false;
  return at - TOKEN_REFRESH_WINDOW_SECONDS * 1000 <= now;
}

/** 凭据是否可静默续期（判据是 refresh_token 非空；raccoon **有** refresh 端点）。 */
function isRefreshable(credential) {
  return typeof (credential && credential.refresh_token) === 'string'
    && credential.refresh_token.trim().length > 0;
}

/* ---------- 登录 ---------- */

/**
 * 加密手机号，供 `send_sms` / `login_with_sms` 使用。
 *
 * 算法照抄客户端（渲染层模块 68284 的 `yv()`）：
 *   key    = UTF8("senseraccoon2023") → 16 字节 ⇒ AES-128
 *   iv     = 随机 16 字节
 *   mode   = CFB, padding = NoPadding
 *   输出   = Base64(iv ‖ ciphertext)
 *
 * ⚠️ 必须**显式**写 `aes-128-cfb`：密钥是 16 字节，写成 `aes-256-cfb` 会因长度
 * 不足而抛错（不会自动补齐）。
 * ⚠️ 填充语义已实测：CFB 是流密码，`setAutoPadding(true/false)` 输出**完全一致**。
 * 这里显式关掉以对齐 CryptoJS 的 NoPadding，避免读者误以为有填充。
 *
 * @param {string} phone
 * @param {Buffer} [iv] 仅供单测注入固定值；生产路径省略（随机）。
 */
function encryptPhone(phone, iv) {
  return encryptSecret(phone, iv);
}

/**
 * 通用传输层加密（AES-128-CFB，密钥 `PHONE_CIPHER_SECRET`）。
 *
 * ⚠️ 2026-10-20 实证：`login_with_password` / `reset_password` 的 `password` 字段
 * **用同一套算法加密**（不是只限手机号）：
 *   - 空/缺 → `100003 params_encryted_error`
 *   - 用本函数加密错密码 → `100002 params_invalid_error`（说明加密对了、只是密码错）
 * 故密码字段也走这里。复用 {@link encryptPhone} 的算法（二者等价）。
 *
 * @param {string} plaintext 明文（手机号或密码）
 * @param {Buffer} [iv] 仅供单测注入固定值
 */
function encryptSecret(plaintext, iv) {
  const key = Buffer.from(PHONE_CIPHER_SECRET, 'utf8');
  const nonce = iv || crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cfb', key, nonce);
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return Buffer.concat([nonce, ciphertext]).toString('base64');
}

/**
 * 生成一个扫码用的 `qrcode_code`（32 位小写 hex = 16 字节随机）。
 *
 * ⚠️ **2026-10-18 起此函数不再用于扫码登录**：官方已把扫码迁移到新 IAM API
 * （`/api/iam/v1/auth/mp/qrcode`），`qrcode_code` 改由**服务端签发**
 * （`qr-<uuid>` 形态），客户端自造的 code 在新体系里不被接受 ——
 * 二维码指向的 `/login/mp` 页面只对签发码生效（实测自造码访问即 404）。
 * 保留此函数仅供单测与对照；扫码登录走 `auth.js` 的新 `qrCreate` 流程。
 */
function generateQrCode() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 构造二维码承载的登录页 URL（**新 IAM 体系**，2026-10-18 从官网 chunk 309
 * 逐字复刻，含同源与路径白名单校验）。
 *
 * 官方算法（buildQrUrl，变量名对应）：
 * ```js
 * let i = new URL(origin);                      // e = qrOrigin（必须 https）
 * if (i.protocol !== 'https:' || i.username || i.password) throw INVALID_QR_PATH;
 * if (!scanPath.startsWith('/') || scanPath.startsWith('//') || /[\\\s#]/.test(scanPath)) throw …;
 * let a = decodeURIComponent(scanPath);
 * if (/[\\\s#]/.test(a) || a.startsWith('//') || /%[0-9a-f]{2}/i.test(a)) throw …;
 * let s = new URL(scanPath, origin);
 * if (s.origin !== i.origin || s.hash) throw …;  // ★ 防跳域
 * s.search = '';
 * s.searchParams.set('code', code);
 * s.searchParams.set('appname', brand);
 * s.searchParams.set('source', 'platform');
 * return s.href;
 * ```
 *
 * ⚠️ `scanPath` 来自**服务端响应**，必须当不可信输入对待：
 * 白名单挡掉三类攻击 —— 跳到第三方域（`s.origin !== origin`）、协议相对地址
 * （`//evil.com`）、以及把参数挤进 hash/路径的注入（`#` 与 `%xx`）。
 * 官方连「decode 后再查一遍」都做了（防双编码绕过），这里照抄。
 *
 * @param {{origin:string, scanPath:string, code:string, brand:string, source:string}} p
 * @returns {string} 二维码内容 URL
 * @throws Error 当 origin/scanPath 不满足白名单（抛 `INVALID_QR_PATH`，与官方一致）
 */
function buildQrUrl({ origin, scanPath, code, brand, source }) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.username || base.password) {
    throw new Error('INVALID_QR_PATH');
  }
  if (typeof scanPath !== 'string'
    || !scanPath.startsWith('/')
    || scanPath.startsWith('//')
    || /[\\\s#]/.test(scanPath)) {
    throw new Error('INVALID_QR_PATH');
  }
  // 官方是「原文查一遍、decode 后再查一遍」：原文挡单编码（%2e%2e），
  // decode 后挡二次编码与解码后才暴露的 // 注入。两层缺一不可。
  //
  // decodeURIComponent 对非法百分号编码（如 '/%zz'）抛 URIError，而本函数的
  // 错误契约是 INVALID_QR_PATH。不包成同一类型的话，调用方只能靠 try/catch
  // 兜住任意异常，错误分类就失效了。
  let decoded;
  try {
    decoded = decodeURIComponent(scanPath);
  } catch {
    throw new Error('INVALID_QR_PATH');
  }
  if (/[\\\s#]/.test(decoded)
    || decoded.startsWith('//')
    || /%[0-9a-f]{2}/i.test(scanPath)) {
    throw new Error('INVALID_QR_PATH');
  }
  const u = new URL(scanPath, base);
  if (u.origin !== base.origin || u.hash) {
    throw new Error('INVALID_QR_PATH');
  }
  u.search = '';
  u.searchParams.set('code', code);
  u.searchParams.set('appname', brand);
  u.searchParams.set('source', source);
  return u.href;
}

/**
 * `X-Org-Code` 头的取值 —— **必须过滤掉 `personal`**。
 *
 * ⚠️ **P0，2026-10-15 抓包实证**：个人账号的 `office_identity` 字面值是
 * `"personal"`（本机客户端 `~/.box-agent/config/auth.json` 实测即为此值）。
 * 把它原样塞进 `X-Org-Code` 会被组织服务当成一个真实 org code 去查，
 * 回 `400 {code:200022, message:"org_not_found_error"}`。实测影响面：
 *
 * | 端点 | `X-Org-Code: ""` | `X-Org-Code: "personal"` |
 * |---|---|---|
 * | `points/v1/balance` | 200 | **400 org_not_found** |
 * | `llm/v2/model_catalog` | 200 | **400 org_not_found** |
 * | `desktop/v1/login/points/grant` | 200 | **400 org_not_found** |
 * | `llm/v2/chat/completions` | 200 | **400 org_not_found** |
 * | `points/v1/bills` | 200 | 200（该端点不查 org） |
 * | `auth/v1/user_info` | 200 | 200（同上） |
 *
 * 也就是说：**积分、模型目录、登录奖励、整条对话转发全挂**，只有账单和
 * 用户信息能过。早期参考实现写的是「个人账号为空串」，恰好绕开了这个坑；
 * 本仓库把 `office_identity` 落进 `raccoonOrg` 列后原样透传，就踩中了。
 *
 * 客户端自己的处理（asar 渲染层模块 79746 的 `createHeaders()`）正是如此：
 * `let e = cookie||""; e && "personal" !== e && (c = e)` —— **显式排除 personal**。
 * 这里照抄该判据，而不是「非空就发」。
 *
 * 企业账号的 org code 是真码（如 `xxxx`），仍要照发，故不能简化成恒空串。
 */
function orgCodeOf(credential) {
  const raw = typeof (credential && credential.office_identity) === 'string'
    ? credential.office_identity.trim()
    : '';
  if (raw.length === 0) return '';
  // personal 是「个人身份」的标记值，不是组织码；大小写不敏感以防上游变体
  if (raw.toLowerCase() === 'personal') return '';
  return raw;
}

/**
 * 业务端点请求头（依据客户端 `createHeaders()`）。
 *
 * ⚠️ **四个调用点的头集合互不相同，不要图省事统一成一份**（参考实现即如此，
 * 逐点照抄才对得上上游）：
 *   - `send_sms` / `login_with_sms` / `refresh` / `login_with_qrcode_code`：
 *     **只有** `Content-Type`（无 Authorization、无任何业务头）；
 *   - `user_info`：本函数默认形态（不含 platform / version）；
 *   - `points/*` 与 `desktop/v1/login/points/grant`：用 {@link desktopHeaders}
 *     （含 `X-Client-Platform` + `X-Client-Version`；后者**必需**该头）；
 *   - `chat/completions`：含 `X-Client-Platform` 但**不含** version，且
 *     `Accept: text/event-stream`（见 `chat.js`）；
 *   - `model_catalog`：手写四头，**无 Content-Type**（见 {@link catalogHeaders}）。
 *
 * ⚠️ 刻意**不发送 `User-Agent`**：参考实现里该字段注释写明「仅记录用；实测该
 * 端点不校验 UA」，全链路没有任何地方把它写进请求头。没有证据的头不要凭直觉加。
 */
function headers(credential, opts = {}) {
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential.access_token}`,
    // 个人账号必须发空串，绝不能发 "personal"（见 {@link orgCodeOf}）；
    // 客户端总是发送该头，故保留键本身。
    'X-Org-Code': orgCodeOf(credential),
    'X-Raccoon-Language': 'zh',
  };
  if (opts.platform) h['X-Client-Platform'] = opts.platform;
  if (opts.version) h['X-Client-Version'] = opts.version;
  // device_id 只在凭据里存在时才发；本网关的登录流程**不生成**它
  // （参考实现同样只读不写，故该头在实践中不出现）。没有生成规则就不要发明一个。
  if (credential.device_id) h['X-Client-Device-ID'] = credential.device_id;
  return h;
}

/** 桌面端点的完整身份头（积分与一次性登录奖励用）。 */
function desktopHeaders(credential) {
  return headers(credential, {
    platform: V.identity.clientPlatform,
    version: V.identity.clientVersion,
  });
}

/** 目录请求头：实测只需要四个头，**不带** X-Client-Platform。 */
function catalogHeaders(credential) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${credential.access_token}`,
    'X-Org-Code': orgCodeOf(credential),
    'X-Raccoon-Language': 'zh',
  };
}

/* ---------- 模型目录 ---------- */

/** 倍率格式化：去掉浮点噪声，`0.75` → `0.75`、`1` → `1`、`0.1` → `0.1`。 */
function formatMultiplier(value) {
  return String(Number(value.toFixed(4)));
}

/**
 * 最终展示名：`GLM-5-3 · x0.75` / `SenseNova-6.8-Flash · 免费` /
 * `GLM-5-3-Flash · x0.2→x0.1` / `Kimi-K3 · x1`。
 *
 * 三条展示规则：
 *   - 生效价为 **0** → 显示「免费」（**不是** `x0`）；
 *   - 生效价 **严格小于**原价 → 显示 `x原价→x折后价`（箭头比「（促销 …）」短）；
 *   - 其余（**含 1 倍**）→ 显示 `x生效价`。
 *
 * 非有限数/负数：不追加后缀，避免产出「模型名 · 」这种孤立分隔符。
 * 这条只处理「取不到倍率」，与「倍率恰好是 1」是两回事（后者要显示）。
 */
function displayName(model) {
  const name = typeof model.description === 'string' && model.description.length > 0
    ? model.description
    : model.id;
  const effective = model.effectiveMultiplier;
  if (typeof effective !== 'number' || !Number.isFinite(effective) || effective < 0) return name;
  if (effective === 0) return `${name} · 免费`;

  const base = model.baseMultiplier;
  const hasBase = typeof base === 'number' && Number.isFinite(base) && base > 0;
  if (hasBase && base > effective) {
    return `${name} · x${formatMultiplier(base)}→x${formatMultiplier(effective)}`;
  }
  return `${name} · x${formatMultiplier(effective)}`;
}

/**
 * 远端目录条目的图片能力判定 —— **远端解析路径专用**。
 * 兜底表路径不走本函数：它的真相源是 `FALLBACK_MODELS[].supportsImage`。
 */
function supportsImage(modelId, tags) {
  if (IMAGE_CAPABILITY_OVERRIDES.has(modelId)) return true;
  const list = Array.isArray(tags) ? tags : [];
  return list.includes('vision') || list.includes('image') || list.includes('image-understanding');
}

/**
 * 解析远端模型目录。
 *
 * 实测响应形态：`{ code: 0, data: { categories: [ { type: 'chat', models: [...] } ] } }`
 * —— 只取 `type === 'chat'` 那一类。
 *
 * 逐条归一化的**关键细节**（照抄参考实现，别按直觉改）：
 *   - **模型 id 在远端的 `name` 字段**（不是 `id`）；
 *   - `visible === false` 的条目要跳过（字段缺失视为可见，不因缺字段而隐藏模型）；
 *   - 倍率在 `billing_effective_multiplier` / `billing_multiplier`；
 *   - 窗口与上限在 `params.context_window` / `params.max_tokens`；
 *   - 重名去重，保留首次出现。
 *
 * @returns {Array<{id,name,contextWindow,maxTokens,supportsImage,status,statusNote,multiplier}>}
 */
function parseModelCatalog(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return [];
  if (payload.code !== 0) return [];
  const data = typeof payload.data === 'object' && payload.data !== null && !Array.isArray(payload.data)
    ? payload.data
    : undefined;
  if (data === undefined) return [];
  const categories = Array.isArray(data.categories) ? data.categories : [];
  const chat = categories.find((c) => c && typeof c === 'object' && !Array.isArray(c) && c.type === 'chat');
  if (chat === undefined) return [];
  const models = Array.isArray(chat.models) ? chat.models : [];

  const readPositiveInt = (value) => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0);
  const seen = new Set();
  const out = [];
  for (const raw of models) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const id = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (id.length === 0 || seen.has(id)) continue;
    if (raw.visible === false) continue;
    seen.add(id);

    const params = raw.params && typeof raw.params === 'object' ? raw.params : {};
    const description = typeof raw.description === 'string' && raw.description.length > 0 ? raw.description : id;
    const effective = typeof raw.billing_effective_multiplier === 'number' ? raw.billing_effective_multiplier : Number.NaN;
    const base = typeof raw.billing_multiplier === 'number' ? raw.billing_multiplier : Number.NaN;
    const rawStatus = typeof raw.billing_status === 'string' ? raw.billing_status : '';
    const status = rawStatus === 'discount' || rawStatus === 'limited_free' ? rawStatus : 'normal';
    const statusNote = typeof raw.billing_status_note === 'string' ? raw.billing_status_note : '';
    const tags = Array.isArray(raw.tags)
      ? raw.tags.filter((t) => typeof t === 'string').map((t) => t.toLowerCase())
      : [];

    out.push({
      id,
      name: displayName({ id, description, effectiveMultiplier: effective, baseMultiplier: base, status, statusNote }),
      contextWindow: readPositiveInt(params.context_window),
      maxTokens: readPositiveInt(params.max_tokens),
      supportsImage: supportsImage(id, tags),
      status,
      statusNote,
      // 倍率原值，供面板展示与计费参考（0 表示免费）
      multiplier: Number.isFinite(effective) ? effective : null,
    });
  }
  return out;
}

/** 兜底模型表转成同一形状（远端目录不可用时使用）。 */
function fallbackCatalog() {
  return FALLBACK_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    supportsImage: m.supportsImage === true,
    status: 'normal',
    statusNote: '',
    multiplier: null,
  }));
}

module.exports = {
  PHONE_CIPHER_SECRET,
  TOKEN_REFRESH_WINDOW_SECONDS,
  REQUEST_TIMEOUT_MS,
  QR_POLL_INTERVAL_MS,
  LOGIN_TIMEOUT_MS,
  QR_STATUS,
  LOGIN_REWARD_EVENT_NAME,
  LOGIN_REWARD_POINTS,
  DAILY_GRANT_POINTS,
  DAILY_GRANT_BIZ_TYPE,
  DAILY_EXPIRE_BIZ_TYPE,
  summarizeDailyPoints,
  FALLBACK_MODELS,
  IMAGE_CAPABILITY_OVERRIDES,
  decodeJwtExpMs,
  credentialExpiresAtMs,
  isExpired,
  needsRefresh,
  isRefreshable,
  encryptPhone,
  encryptSecret,
  generateQrCode,
  buildQrUrl,
  orgCodeOf,
  headers,
  desktopHeaders,
  catalogHeaders,
  formatMultiplier,
  displayName,
  supportsImage,
  parseModelCatalog,
  fallbackCatalog,
};
