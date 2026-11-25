'use strict';
/**
 * middleware/auth.js — Bearer Token 认证中间件。
 *
 * 密钥分两类：
 * - login：管理面板登录密钥（authenticateAdmin）
 * - access：转发面访问密钥，绑定平台 trae|workbuddy（authenticate）
 */
const config = require('../config');
const apiKeys = require('../credentials/api-keys');
const authRateLimit = require('./auth-rate-limit');

/**
 * 拒收时补一行 traffic（延迟 require，避免把 traffic → rates → catalog →
 * upstream/client → auth 这条重链在中间件加载期拉进来，也避开任何加载环）。
 * @param {import('express').Request} req
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
function logReject(req, status, code, message) {
  try {
    require('../log/traffic').logRejected(req, { status, code, message });
  } catch { /* 日志失败不影响拒收响应 */ }
}

function extractToken(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  if (req.headers['x-api-key']) return req.headers['x-api-key'];
  // n-13：不再接受 ?key= 查询参数——URL 会进入反代与访问日志，密钥随之落到日志面。
  // grep 确认前端与文档均未使用该形态，仅保留 Authorization / x-api-key。
  return null;
}

function isEnvLogin(token) {
  // K-1 权限分离：管理面只认 ADMIN_KEY 与 DB 登录密钥。
  // API_KEY 历史上可作管理面过渡登录，已移除——转发种子密钥与管理凭据必须分值。
  // L-01：改用恒定时间比较，避免 === 在首个差异处短路的时序侧信道。
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return false;
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(adminKey);
  if (a.length !== b.length) return false;
  return require('crypto').timingSafeEqual(a, b);
}

/** 转发面：仅校验访问密钥（kind=access）。登录密钥只用于管理面。 */
function authenticate(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    logReject(req, 401, 'MISSING_ACCESS_KEY', 'Missing access key');
    return res.status(401).json({ error: { message: 'Missing access key', type: 'auth_error' } });
  }
  const rec = apiKeys.verifyAccessKey(token);
  if (!rec) {
    logReject(req, 401, 'INVALID_ACCESS_KEY', 'Invalid access key');
    return res.status(401).json({
      error: {
        message: 'Invalid access key。请使用管理面创建的访问密钥（trae|workbuddy|all）。',
        type: 'auth_error',
      },
    });
  }
  req.platform = rec.platform;
  req.keyScope = rec.scope || (rec.platform === 'all' ? 'universal' : 'platform');
  req.apiKeyId = rec.id;
  req.keyKind = 'access';
  req.authKey = rec;
  apiKeys.touchLastUsed(rec.id);
  next();
}

/** 管理面失败审计（M-05）：失败尝试此前完全不记录，事后无法发现探测行为。 */
function auditAdminFail(req, reason) {
  try {
    require('../log/audit').audit({
      action: 'auth.admin_fail',
      result: 'deny',
      reason,
      clientIp: authRateLimit.clientIp(req),
      userAgent: req.headers?.['user-agent'] || null,
    });
  } catch { /* 审计失败不影响鉴权响应 */ }
}

/** 管理面：登录密钥（DB kind=login）或 env ADMIN_KEY（兼容）。 */
function authenticateAdmin(req, res, next) {
  // 先判锁定：已锁定的 IP 直接 429，不再查库（M-05 失败限速）。
  if (authRateLimit.isLocked(req)) {
    auditAdminFail(req, 'rate_limited');
    const retryAfter = authRateLimit.recordFailure(req).retryAfter;
    res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
    return res.status(429).json({ error: { message: 'Too many failed login attempts', type: 'rate_limit_error', code: 'ADMIN_LOGIN_LIMIT' } });
  }
  const token = extractToken(req);
  if (!token) {
    auditAdminFail(req, 'missing');
    authRateLimit.recordFailure(req);
    return res.status(401).json({ error: { message: 'Missing login key', type: 'auth_error' } });
  }
  const rec = apiKeys.verifyLoginKey(token);
  if (rec) {
    req.keyKind = 'login';
    req.apiKeyId = rec.id;
    apiKeys.touchLastUsed(rec.id);
    authRateLimit.recordSuccess(req);
    return next();
  }
  if (isEnvLogin(token)) {
    authRateLimit.recordSuccess(req);
    return next();
  }
  auditAdminFail(req, 'invalid');
  const { retryAfter } = authRateLimit.recordFailure(req);
  if (retryAfter > 0) res.setHeader('Retry-After', String(retryAfter));
  // 达到阈值后本次返回 429，之前返回 401（语义与 Retry-After 一致）。
  const status = retryAfter > 0 ? 429 : 401;
  return res.status(status).json({
    error: {
      message: status === 429 ? 'Too many failed login attempts' : 'Invalid login key',
      type: status === 429 ? 'rate_limit_error' : 'auth_error',
      ...(status === 429 ? { code: 'ADMIN_LOGIN_LIMIT' } : {}),
    },
  });
}

/**
 * 纯判定版管理面鉴权（无副作用，不写 req）。
 * 供「主防线不是管理密钥、但携带了管理密钥时可直接放行」的端点使用。
 * @returns {{ok:boolean, keyId:string|null}}
 */
function checkAdminToken(token) {
  if (!token) return { ok: false, keyId: null };
  const rec = apiKeys.verifyLoginKey(token);
  if (rec) {
    apiKeys.touchLastUsed(rec.id);
    return { ok: true, keyId: rec.id };
  }
  return { ok: isEnvLogin(token), keyId: null };
}

/** 可选公开：STATUS_PUBLIC=true 时放行，否则要求管理面鉴权。 */
function authenticateAdminOrPublic(req, res, next) {
  if (config.statusPublic) return next();
  return authenticateAdmin(req, res, next);
}

/**
 * 模型列表等双面端点：
 * - 有效访问密钥 → 强制按绑定平台过滤
 * - 仅登录密钥 → 管理视图（可 ?platform= 过滤，缺省全部）
 */
function authenticateAny(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    logReject(req, 401, 'MISSING_API_KEY', 'Missing API key');
    return res.status(401).json({ error: { message: 'Missing API key', type: 'auth_error' } });
  }
  const access = apiKeys.verifyAccessKey(token);
  if (access) {
    req.platform = access.platform;
    req.keyScope = access.scope || (access.platform === 'all' ? 'universal' : 'platform');
    req.apiKeyId = access.id;
    req.keyKind = 'access';
    req.authKey = access;
    apiKeys.touchLastUsed(access.id);
    return next();
  }
  const login = apiKeys.verifyLoginKey(token);
  if (login) {
    req.keyKind = 'login';
    req.apiKeyId = login.id;
    apiKeys.touchLastUsed(login.id);
    return next();
  }
  if (isEnvLogin(token)) return next();
  logReject(req, 401, 'INVALID_API_KEY', 'Invalid API key');
  return res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error' } });
}

/**
 * K-2 scope 关卡：要求访问密钥具备指定 scope（如 models:read）。
 * - 登录密钥与 env ADMIN_KEY（管理域）天然放行：scope 只约束转发域；
 * - 访问密钥按 req.authKey.scopes 判定，缺失返回 403（401 会误导客户端重试凭据）。
 */
function requireKeyScope(scope) {
  return (req, res, next) => {
    if (req.keyKind === 'login') return next();
    const rec = req.authKey;
    if (!rec) return next(); // env 管理密钥等无记录的路径
    const scopes = Array.isArray(rec.scopes) ? rec.scopes : [];
    if (scopes.includes(scope)) return next();
    logReject(req, 403, 'SCOPE_MISSING', `scope_missing:${scope}`);
    return res.status(403).json({
      error: {
        message: `access denied: scope_missing:${scope}。请让管理员为该访问密钥补充 scope。`,
        type: 'insufficient_scope',
        code: 'SCOPE_MISSING',
      },
    });
  };
}

module.exports = {
  authenticate,
  authenticateAdmin,
  authenticateAdminOrPublic,
  authenticateAny,
  checkAdminToken,
  requireKeyScope,
  extractToken,
};
