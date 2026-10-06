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

function extractToken(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  if (req.headers['x-api-key']) return req.headers['x-api-key'];
  // n-13：不再接受 ?key= 查询参数——URL 会进入反代/访问日志，密钥落日志面
  // 过大。grep 确认前端与文档均未使用该形态，仅保留 Authorization / x-api-key。
  return null;
}

function isEnvLogin(token) {
  // K-1 权限分离：管理面只认 ADMIN_KEY / DB 登录密钥。
  // API_KEY 历史上可作管理面过渡登录，已移除——转发种子与管理凭据必须分值。
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && token === adminKey) return true;
  return false;
}

/** 转发面：仅校验访问密钥（kind=access）。登录密钥只用于管理面。 */
function authenticate(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: { message: 'Missing access key', type: 'auth_error' } });
  }
  const rec = apiKeys.verifyAccessKey(token);
  if (!rec) {
    return res.status(401).json({
      error: {
        message: 'Invalid access key. 请使用管理面创建的访问密钥（trae|workbuddy|all）。',
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

/** 管理面：登录密钥（DB kind=login）或 env ADMIN_KEY（兼容）。 */
function authenticateAdmin(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: { message: 'Missing login key', type: 'auth_error' } });
  }
  const rec = apiKeys.verifyLoginKey(token);
  if (rec) {
    req.keyKind = 'login';
    req.apiKeyId = rec.id;
    apiKeys.touchLastUsed(rec.id);
    return next();
  }
  if (isEnvLogin(token)) return next();
  return res.status(401).json({ error: { message: 'Invalid login key', type: 'auth_error' } });
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

/** 可选公开：STATUS_PUBLIC=true 时放行，否则要求 Admin。 */
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
  return res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error' } });
}

/**
 * K-2 scope 关卡：要求访问密钥具备指定 scope（如 models:read）。
 * - 登录密钥 / env ADMIN_KEY（管理域）天然放行：scope 只约束转发域；
 * - 访问密钥按 req.authKey.scopes 判定，缺失返回 403（401 会误导客户端重试凭据）。
 */
function requireKeyScope(scope) {
  return (req, res, next) => {
    if (req.keyKind === 'login') return next();
    const rec = req.authKey;
    if (!rec) return next(); // env 管理密钥等无记录路径
    const scopes = Array.isArray(rec.scopes) ? rec.scopes : [];
    if (scopes.includes(scope)) return next();
    return res.status(403).json({
      error: {
        message: `access denied: scope_missing:${scope}. 请让管理员为该访问密钥补充 scope。`,
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
