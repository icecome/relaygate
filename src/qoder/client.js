'use strict';
/**
 * qoder/client.js — Qoder 上游 HTTP 通道（运营面）。
 *
 * 只负责发请求、解析信封与按业务码抛错，不含业务语义：
 *   - 目标域与路径全部取自 platform/variant.js（单一事实源），按账号 realm 选基址
 *   - 身份头为本模块内置（桌面端三头 + 账号 Bearer）
 *   - 代理复用项目统一的 applyProxy 语义（HTTPS_PROXY / ALL_PROXY）
 *
 * 信封形态：运营面多为裸 JSON（无统一 code 信封），错误以 HTTP 状态 +
 * { errorCode, errorMessage } / { code, message } 表达，由本模块归一成 QoderApiError。
 *
 * 桌面端头（/sash 活动平台必需，实证要点）：
 *   User-Agent: Qoder / cosy-clienttype: 10 / cosy-version: 0.4.3
 *   —— 缺失时服务端**不报错但返回空活动列表**（最难排查的一类失败）。
 *   cosy-machine* 六头刻意不发：本服务跑在服务器、无官方原生桥，
 *   发派生假值会被服务端判定非官方客户端，把「每日 100 Credits」整条过滤掉
 *   （qoder2api-hub 逐头隔离实测结论）。国际版可能因此看不到活动，UI 需明示。
 */
const variant = require('../platform/variant');
const { QoderCryptoError } = require('./crypto');

const V = variant.variantOf(variant.QODER);
const IDENTITY = V.identity;
const DEFAULT_TIMEOUT_MS = Number(process.env.QODER_TIMEOUT_MS || 25000);

/** 上游业务错误（带 errorCode/message/status，供上层映射用户文案）。 */
class QoderApiError extends Error {
  constructor(message, { code, status, body, method, url } = {}) {
    super(message);
    this.name = 'QoderApiError';
    this.code = code != null ? code : null;
    this.status = status != null ? status : null;
    this.body = body;
    this.method = method;
    this.url = url;
    if (this.code != null) this.upstreamCode = this.code;
  }
}

/** 网络层失败（连接/超时/DNS）。 */
class QoderNetworkError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'QoderNetworkError';
    this.code = cause && cause.code;
    this.cause = cause;
  }
}

/** 区域不可用（404/405/410）：该区域未开放此端点，不是账号问题。 */
class QoderRegionError extends Error {
  constructor(message, { status, method, url } = {}) {
    super(message);
    this.name = 'QoderRegionError';
    this.status = status != null ? status : null;
    this.method = method;
    this.url = url;
  }
}

function proxyDispatcher() {
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
    console.warn(`[qoder] 代理初始化失败，直连: ${e.message}`);
    return null;
  }
}

let _dispatcher;

/** 把 proxy agent 挂到 fetch 的 dispatcher（node-fetch 与 undici 都不支持 agent 选项）。 */
function withDispatcher(opts) {
  if (_dispatcher === undefined) _dispatcher = proxyDispatcher();
  if (_dispatcher) return { ...opts, dispatcher: _dispatcher };
  return opts;
}

/** 账号 realm → openapi 基址。 */
function baseFor(acct) {
  return variant.qoderOpenapiBase(variant.qoderRealmOfAccount(acct));
}

/** 账号 realm → gateway 基址（对话面 / COSY）。 */
function gatewayFor(acct) {
  return variant.qoderGatewayBase(variant.qoderRealmOfAccount(acct));
}

/**
 * 桌面端身份头（活动平台必需）。
 * @param {string} token dt- access token
 * @param {object} [extra] 追加头（调用方自定义）
 */
function desktopHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': IDENTITY.userAgent,
    'cosy-clienttype': IDENTITY.clientType,
    'cosy-version': IDENTITY.clientVersion,
    ...extra,
  };
}

/** 路径模板填充（'%s' → campaignId）。 */
function fillPath(template, ...args) {
  return String(template).replace(/%s/g, () => String(args.shift()));
}

/** 取路径：V.paths 的键名或字面路径。 */
function resolvePath(pathOrKey) {
  const p = String(pathOrKey || '');
  return p.startsWith('/') ? p : (V.paths[p] || p);
}

/**
 * 发起一次 Qoder 运营面请求。
 *
 * @param {object} opts
 * @param {string} opts.method
 * @param {string} opts.path        V.paths 键名或字面路径
 * @param {string} opts.token       dt- access token
 * @param {string} [opts.realm]     'cn' | 'intl'（缺省从 acct 推；再缺省 intl）
 * @param {object} [opts.acct]      账号对象（realm 来源之一）
 * @param {object} [opts.body]      JSON body
 * @param {Record<string,string>} [opts.query]
 * @param {Record<string,string>} [opts.extraHeaders]
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.allowEmpty] 空响应体返回 null 而不报错
 * @param {boolean} [opts.allowRegionError] 区域不可用返回 null 而不抛错
 * @returns {Promise<object|null>} 解析后的 JSON
 */
async function request(opts) {
  const {
    method, path: pathOrKey, token, realm, acct, body, query,
    extraHeaders, timeoutMs, allowEmpty = false, allowRegionError = false,
  } = opts;
  const r = variant.qoderRealm(realm || (acct ? variant.qoderRealmOfAccount(acct) : 'intl'));
  const base = variant.qoderOpenapiBase(r);
  const rel = resolvePath(pathOrKey);
  const url = new URL(rel, base);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  if (!token) {
    throw new QoderApiError('缺少 Qoder 访问凭据（token）', { code: null, method, url: url.toString() });
  }
  const headers = desktopHeaders(token, extraHeaders);
  const init = withDispatcher({
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs || DEFAULT_TIMEOUT_MS),
  });

  let resp;
  try {
    resp = await fetch(url.toString(), init);
  } catch (e) {
    throw new QoderNetworkError(`Qoder 网络请求失败: ${e.message}`, e);
  }

  const text = await resp.text();
  const trimmed = text.trim();

  // 区域不可用：404/405/410 —— 上游在该区域未开放此端点
  if (V.errors.regionUnavailable.includes(resp.status)) {
    if (allowRegionError) return null;
    throw new QoderRegionError(
      `Qoder 当前区域（${r}）不支持该接口 HTTP ${resp.status}`,
      { status: resp.status, method, url: url.toString() },
    );
  }

  if (!trimmed) {
    if (allowEmpty) return null;
    throw new QoderApiError(`Qoder 空响应 HTTP ${resp.status}`, {
      status: resp.status, method, url: url.toString(),
    });
  }

  let json;
  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new QoderApiError(`Qoder 响应非 JSON HTTP ${resp.status}: ${trimmed.slice(0, 160)}`, {
      status: resp.status, method, url: url.toString(),
    });
  }

  // 业务错误信封：{ errorCode, errorMessage } 或 { code, message }
  const errCode = json.errorCode != null ? json.errorCode : (json.code != null && resp.status >= 400 ? json.code : null);
  const errMsg = json.errorMessage || json.message;
  if (resp.status >= 400 || (errCode != null && Number(errCode) !== 0)) {
    throw new QoderApiError(String(errMsg || `Qoder 业务错误 HTTP ${resp.status}`).trim(), {
      code: errCode != null ? Number(errCode) : null,
      status: resp.status,
      body: json,
      method,
      url: url.toString(),
    });
  }
  return json;
}

/** 便捷：带账号发请求。 */
async function accountRequest(acct, opts = {}) {
  if (!acct || !String(acct.token || '').trim()) {
    throw new QoderApiError('账号缺少访问凭据（token）', { code: null });
  }
  return request({ ...opts, acct, token: acct.token, realm: variant.qoderRealmOfAccount(acct) });
}

module.exports = {
  V,
  DEFAULT_TIMEOUT_MS,
  QoderApiError,
  QoderNetworkError,
  QoderRegionError,
  baseFor,
  gatewayFor,
  desktopHeaders,
  resolvePath,
  fillPath,
  request,
  accountRequest,
};
