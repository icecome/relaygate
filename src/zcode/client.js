'use strict';
/**
 * zcode/client.js — ZCode 上游 HTTP 通道（billing 运营面）。
 *
 * 只负责「发请求 + 解析信封 + 按业务码抛错」，不含任何业务语义：
 *   - 目标域与路径全部取自 platform/variant.js（单一事实源）
 *   - 身份头取自 zcode/identity.js
 *   - 代理复用项目统一的 applyProxy 语义（HTTPS_PROXY / ALL_PROXY）
 *
 * 信封形态：{ code, msg, data, logid }，code===0 为成功。
 * 上游对 auth 失效与验证码失败的区分见 errors.js 的 ZCode 码表。
 */
const config = require('../config');
const variant = require('../platform/variant');
const identity = require('./identity');
const fingerprint = require('./fingerprint');

const V = variant.variantOf(variant.ZCODE);
const HOST = V.hosts.zcode;
const DEFAULT_TIMEOUT_MS = Number(process.env.ZCODE_TIMEOUT_MS || 25000);

/** 上游业务错误（带 code/msg/logid，供上层映射用户文案）。 */
class ZCodeApiError extends Error {
  constructor(message, { code, logid, status, body, method, url } = {}) {
    super(message);
    this.name = 'ZCodeApiError';
    this.code = code;
    this.logid = logid;
    this.status = status;
    this.body = body;
    this.method = method;
    this.url = url;
    // 供 pool.classifyError 的通用分类器读取
    if (code != null) this.upstreamCode = code;
  }
}

/** 网络层失败（连接/超时/DNS）。 */
class ZCodeNetworkError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ZCodeNetworkError';
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
    console.warn(`[zcode] 代理初始化失败，直连: ${e.message}`);
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

/**
 * 发起一次 ZCode 请求并解出信封。
 *
 * @param {object} opts
 * @param {string} opts.method
 * @param {string} opts.path          variant.paths 里的键名或字面路径
 * @param {Record<string,string>} opts.headers
 * @param {object} [opts.body]        JSON body
 * @param {Record<string,string>} [opts.query]
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.allowEmpty] 空响应体时返回 null 而不报错
 * @returns {Promise<object|null>} 解析后的信封
 */
async function request({ method, path, headers, body, query, timeoutMs, allowEmpty = false }) {
  const rel = path.startsWith('/') ? path : (V.paths[path] || path);
  const url = new URL(rel, HOST);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== '') url.searchParams.set(k, String(v));
    }
  }
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
    throw new ZCodeNetworkError(`ZCode 网络请求失败: ${e.message}`, e);
  }

  const text = await resp.text();
  if (!text.trim()) {
    if (allowEmpty) return null;
    throw new ZCodeApiError(`ZCode 空响应 HTTP ${resp.status}`, {
      status: resp.status, method, url: url.toString(),
    });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ZCodeApiError(`ZCode 响应非 JSON HTTP ${resp.status}: ${text.slice(0, 160)}`, {
      status: resp.status, method, url: url.toString(),
    });
  }
  return json;
}

/** 解出信封并断言 code===0；失败抛 ZCodeApiError（带上游 code/msg）。 */
function unwrap(envelope, { method, path } = {}) {
  if (!envelope || typeof envelope !== 'object') {
    throw new ZCodeApiError('ZCode 响应信封为空', { method, url: path });
  }
  const code = Number(envelope.code);
  if (code !== 0) {
    const msg = String(envelope.msg || envelope.message || '').trim();
    throw new ZCodeApiError(msg || `ZCode 业务错误 code=${envelope.code}`, {
      code: Number.isFinite(code) ? code : null,
      logid: envelope.logid,
      body: envelope,
      method,
      url: path,
    });
  }
  return envelope.data;
}

/** 便捷：带账号身份头发请求。 */
async function accountRequest(acct, { method, path, body, query, extraHeaders, timeoutMs, allowEmpty }) {
  const fp = fingerprint.profileFor(acct, (fresh) => {
    try { require('../credentials/store').update(acct.id, { fingerprint: fresh }); } catch { /* 落库失败不阻断 */ }
  });
  const headers = { ...identity.identityHeaders(fp, { token: acct.token, apiKey: acct.apiKey }), ...extraHeaders };
  return request({ method, path, headers, body, query, timeoutMs, allowEmpty });
}

module.exports = {
  HOST,
  ZCodeApiError,
  ZCodeNetworkError,
  request,
  unwrap,
  accountRequest,
  appVersion: identity.appVersion,
};