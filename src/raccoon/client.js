'use strict';
/**
 * raccoon/client.js —— Raccoon（商汤小浣熊）上游 HTTP 通道。
 *
 * 只负责发请求、解析信封、按业务码抛错，不含业务语义：
 *   - 域名与路径全部取自 `platform/variant.js`（单一事实源）
 *   - 身份头取自 `raccoon/product.js`
 *   - 代理复用本仓库统一的 HTTPS_PROXY / ALL_PROXY 语义
 *
 * 信封形态：`{ code, message, details, data }`，`code === 0` 为成功。
 * 上游对失败**两种表达都可能**：HTTP 4xx/5xx（如 refresh 失效直接 401），
 * 或 HTTP 200 + 非 0 code。故判定统一走信封，不看 HTTP 状态码。
 */
const variant = require('../platform/variant');
const product = require('./product');

const V = variant.variantOf(variant.RACCOON);
const HOST = V.hosts.openapi;

/** 上游业务错误（带 code/message/details，供上层映射用户文案）。 */
class RaccoonApiError extends Error {
  constructor(message, { code, status, body, method, url } = {}) {
    super(message);
    this.name = 'RaccoonApiError';
    this.code = code;
    this.status = status;
    this.body = body;
    this.method = method;
    this.url = url;
    // 供 pool.classifyError 的通用分类器读取
    if (code != null) this.upstreamCode = code;
  }
}

/** 网络层失败（连接/超时/DNS）。 */
class RaccoonNetworkError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'RaccoonNetworkError';
    this.code = cause && cause.code;
    this.cause = cause;
  }
}

function proxyDispatcher() {
  // 与 upstream/client.js 同源：优先 HTTPS_PROXY，其次 HTTP_PROXY / ALL_PROXY
  const url = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy || '';
  if (!url) return null;
  try {
    if (url.startsWith('socks')) {
      const { SocksProxyAgent } = require('socks-proxy-agent');
      return new SocksProxyAgent(url);
    }
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(url);
  } catch (e) {
    console.warn(`[raccoon] 代理初始化失败，直连: ${e.message}`);
    return null;
  }
}

let _dispatcher;

/** 把 proxy agent 挂到 fetch 的 dispatcher。 */
function withDispatcher(opts) {
  if (_dispatcher === undefined) _dispatcher = proxyDispatcher();
  if (_dispatcher) return { ...opts, dispatcher: _dispatcher };
  return opts;
}

/** 绝对 URL（路径可以是 variant.paths 的键名，也可以是字面路径）。 */
function urlFor(path, query) {
  const rel = path.startsWith('/') ? path : (V.paths[path] || path);
  const url = new URL(rel, HOST);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  return url;
}

/**
 * 发起一次请求并返回 `{ status, envelope, text }`。
 *
 * 刻意**不在此处抛业务错**：登录轮询要把「网络抖动/响应畸形」降级成
 * `pending` 而不是中断整个流程，那需要拿到状态与原文自行判断。
 * 业务错由 `unwrap()` 显式抛出。
 */
async function request({ method, path, headers, body, query, timeoutMs, allowEmpty = false }) {
  const url = urlFor(path, query);
  const init = withDispatcher({
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs || product.REQUEST_TIMEOUT_MS),
  });

  let resp;
  try {
    resp = await fetch(url.toString(), init);
  } catch (e) {
    throw new RaccoonNetworkError(`Raccoon 网络请求失败: ${e.message}`, e);
  }

  const text = await resp.text();
  if (!text.trim()) {
    if (allowEmpty) return { status: resp.status, envelope: null, text: '' };
    throw new RaccoonApiError(`Raccoon 空响应 HTTP ${resp.status}`, {
      status: resp.status, method, url: url.toString(),
    });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RaccoonApiError(`Raccoon 响应非 JSON HTTP ${resp.status}: ${text.slice(0, 160)}`, {
      status: resp.status, method, url: url.toString(),
    });
  }
  return { status: resp.status, envelope: normalizeEnvelope(json, resp.status), text };
}

/**
 * 归一化信封。
 *
 * `code` 缺失时用 HTTP 状态码兜底（≥400 视为失败）——上游少数端点只回
 * HTTP 码不带信封字段，若一律当 0 会把失败读成成功。
 */
function normalizeEnvelope(payload, status) {
  const rec = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const rawCode = rec.code;
  let code;
  if (typeof rawCode === 'number') code = rawCode;
  else if (typeof rawCode === 'string' && rawCode.trim() !== '' && Number.isFinite(Number(rawCode))) code = Number(rawCode);
  else code = status >= 400 ? status : 0;
  return {
    code,
    message: typeof rec.message === 'string' ? rec.message : '',
    details: typeof rec.details === 'string' ? rec.details : '',
    data: rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data) ? rec.data : undefined,
    raw: rec,
  };
}

/** 把信封里的错误拼成一条可读信息（服务端文案优先）。 */
function envelopeMessage(envelope, fallback) {
  if (!envelope) return fallback;
  const parts = [envelope.message, envelope.details].filter((s) => typeof s === 'string' && s.length > 0);
  return parts.length > 0 ? parts.join(': ') : fallback;
}

/** 断言 code===0 并返回 data；失败抛 RaccoonApiError。 */
function unwrap(envelope, { method, path, status } = {}) {
  if (!envelope || typeof envelope !== 'object') {
    throw new RaccoonApiError('Raccoon 响应信封为空', { method, url: path, status });
  }
  if (envelope.code !== 0) {
    throw new RaccoonApiError(envelopeMessage(envelope, `Raccoon 业务错误 code=${envelope.code}`), {
      code: Number.isFinite(envelope.code) ? envelope.code : null,
      status,
      body: envelope.raw,
      method,
      url: path,
    });
  }
  return envelope.data;
}

/** 账号记录 → 上游凭据形状（本模块与 auth/credits 共用的唯一转换点）。 */
function credentialOf(acct) {
  return {
    access_token: acct.token,
    refresh_token: acct.refreshToken,
    office_identity: acct.raccoonOrg || undefined,
    user_id: acct.userId || undefined,
    // device_id 刻意不填：本网关的登录流程不生成设备标识（参考实现同样只读不写），
    // 没有生成规则就不要发明一个 —— 猜错的设备标识比不发更糟。
  };
}

/** 便捷：带账号身份头发请求并解信封。 */
async function accountRequest(acct, { method, path, body, query, extraHeaders, timeoutMs, allowEmpty }) {
  const credential = credentialOf(acct);
  const headers = { ...product.headers(credential), ...extraHeaders };
  const r = await request({ method, path, headers, body, query, timeoutMs, allowEmpty });
  return { ...r, data: unwrap(r.envelope, { method, path, status: r.status }) };
}

module.exports = {
  HOST,
  RaccoonApiError,
  RaccoonNetworkError,
  request,
  normalizeEnvelope,
  envelopeMessage,
  unwrap,
  credentialOf,
  accountRequest,
  urlFor,
  // 供 chat.js 复用：对话面必须拿到**原始响应流**，不能走 request()（它会缓冲全文）
  withDispatcher,
};
