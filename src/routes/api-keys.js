'use strict';
/**
 * routes/api-keys.js — 密钥管理（登录密钥 setup + 访问密钥 CRUD）。
 * 挂载前缀：/v1/api-keys（见 index.js）。
 *
 * 免鉴权（仅当库内尚无 login key）：
 *   GET  /setup/status
 *   POST /setup/login-key
 * 管理鉴权（login key）：
 *   GET/POST/PATCH/DELETE 访问密钥与登录密钥重置
 */
const { Router } = require('express');
const apiKeys = require('../credentials/api-keys');
const { authenticateAdmin } = require('../middleware/auth');

const router = Router();
const admin = (req, res, next) => authenticateAdmin(req, res, next);

// ===== 首登 setup（库内无 login key 时开放）=====

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * 首登端点的准入判定。
 *
 * 该端点无鉴权（库内尚无 login key），若不设闸门，外部页面可用跨源简单请求
 * （text/plain，不触发预检）抢占首登并把合法用户锁在门外。
 * 判定为「浏览器发起的跨站请求」时拒绝；无 Origin 的非浏览器调用（CLI/curl）
 * 与同源请求（含经 LAN IP 访问面板）放行。
 */
function setupOriginAllowed(req) {
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site') return false;
  if (fetchSite === 'same-origin' || fetchSite === 'none') return true;
  const origin = String(req.headers.origin || '');
  if (!origin) return true; // 非浏览器调用（CLI 初始化 / curl）
  try {
    const host = new URL(origin).hostname;
    if (LOOPBACK_HOSTS.has(host)) return true;
    const selfHost = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return !!selfHost && host === selfHost;
  } catch {
    return false;
  }
}

router.get('/setup/status', (req, res) => {
  res.json({
    object: 'setup_status',
    hasLoginKey: apiKeys.hasLoginKey(),
    hasAccessKey: apiKeys.listKeys({ kind: 'access' }).some((k) => k.enabled),
  });
});

router.post('/setup/login-key', (req, res) => {
  if (!setupOriginAllowed(req)) {
    return res.status(403).json({
      error: {
        message: '首登端点仅接受本机来源的请求。请在服务器上打开管理面板，或执行 CLI：node scripts/login-key.js create',
        type: 'forbidden',
        code: 'SETUP_ORIGIN_DENIED',
      },
    });
  }
  if (apiKeys.hasLoginKey()) {
    return res.status(403).json({
      error: {
        message: '登录密钥已存在。请使用现有密钥登录，或运行 CLI 重置：node scripts/login-key.js reset',
        type: 'invalid_request_error',
      },
    });
  }
  const label = (req.body && req.body.label) || 'login';
  const created = apiKeys.createKey({ label, kind: 'login' });
  require('../log/audit').audit({
    action: 'key.setup',
    resource: `key:${created.id}`,
    result: 'ok',
    meta: { channel: 'first-login-setup' },
  });
  res.status(201).json({ object: 'login_key', ...created });
});

// ===== 登录密钥管理（需现有 login）=====

router.get('/login-key', admin, (req, res) => {
  const list = apiKeys.listKeys({ kind: 'login' });
  res.json({ object: 'list', data: list });
});

router.post('/login-key/reset', admin, (req, res) => {
  const label = (req.body && req.body.label) || 'login';
  const created = apiKeys.resetLoginKey({ label });
  require('../log/audit').audit({
    action: 'key.rotate',
    actorKeyId: req.apiKeyId || null,
    resource: `key:${created.id}`,
    result: 'ok',
    meta: { channel: 'login-key-reset', rotatedKind: 'login' },
  });
  res.status(201).json({ object: 'login_key', ...created });
});

// ===== 访问密钥 CRUD（需 login）=====

router.get('/', admin, (req, res) => {
  const kind = req.query.kind === 'login' || req.query.kind === 'access' ? req.query.kind : 'access';
  res.json({ object: 'list', kind, data: apiKeys.listKeys({ kind }) });
});

router.post('/', admin, (req, res) => {
  const { label, platform, kind } = req.body || {};
  const useKind = kind === 'login' ? 'login' : 'access';
  if (useKind === 'login') {
    // 通过此端点建 login 需显式；常规走 /login-key/reset
    const created = apiKeys.createKey({ label: label || 'login', kind: 'login' });
    return res.status(201).json({ object: 'login_key', ...created });
  }
  if (!platform || !apiKeys.PLATFORMS.has(platform)) {
    return res.status(400).json({
      error: { message: 'platform is required (trae|workbuddy|all)', type: 'invalid_request_error' },
    });
  }
  try {
    const created = apiKeys.createKey({
      label: label || null,
      kind: 'access',
      platform,
      scopes: req.body.scopes,
      resources: req.body.resources,
      expiresAt: req.body.expiresAt,
      rpmLimit: req.body.rpmLimit,
      keyType: req.body.keyType,
    });
    require('../log/audit').audit({
      action: 'key.create',
      actorKeyId: req.apiKeyId || null,
      resource: `key:${created.id}`,
      result: 'ok',
      meta: { platform, keyType: created.keyType },
    });
    res.status(201).json({ object: 'access_key', ...created });
  } catch (e) {
    res.status(400).json({ error: { message: e.message, type: 'invalid_request_error' } });
  }
});

router.patch('/:id', admin, (req, res) => {
  const patch = {};
  if (req.body && req.body.label !== undefined) patch.label = req.body.label;
  if (req.body && req.body.enabled !== undefined) patch.enabled = !!req.body.enabled;
  if (req.body && req.body.scopes !== undefined) patch.scopes = req.body.scopes;
  if (req.body && req.body.resources !== undefined) patch.resources = req.body.resources;
  if (req.body && req.body.expiresAt !== undefined) patch.expiresAt = req.body.expiresAt;
  if (req.body && req.body.rpmLimit !== undefined) patch.rpmLimit = req.body.rpmLimit;
  const updated = apiKeys.updateKey(req.params.id, patch);
  if (!updated) {
    return res.status(404).json({ error: { message: 'API key not found', type: 'invalid_request_error' } });
  }
  require('../log/audit').audit({
    action: 'key.update',
    actorKeyId: req.apiKeyId || null,
    resource: `key:${req.params.id}`,
    result: 'ok',
    meta: { fields: Object.keys(patch) },
  });
  res.json({ object: 'api_key', ...updated });
});

/** 轮换：双密钥窗口（旧密钥宽限期内仍可用） */
router.post('/:id/rotate', admin, (req, res) => {
  const old = apiKeys.getKey(req.params.id);
  if (!old || old.kind !== 'access') {
    return res.status(404).json({ error: { message: 'Access key not found', type: 'invalid_request_error' } });
  }
  const graceMs = req.body && req.body.graceMs != null ? Number(req.body.graceMs) : undefined;
  const r = apiKeys.rotateKey(req.params.id, { graceMs });
  if (!r) {
    return res.status(404).json({ error: { message: 'Access key not found', type: 'invalid_request_error' } });
  }
  require('../log/audit').audit({
    action: 'key.rotate',
    actorKeyId: req.apiKeyId || null,
    resource: `key:${req.params.id}`,
    result: 'ok',
    meta: { newKeyId: r.newKey.id, oldExpiresAt: r.oldExpiresAt },
  });
  res.status(201).json({ object: 'access_key', rotatedFrom: req.params.id, oldExpiresAt: r.oldExpiresAt, ...r.newKey });
});

/** 撤销：立即失效，不可恢复 */
router.post('/:id/revoke', admin, (req, res) => {
  const ok = apiKeys.revokeKey(req.params.id);
  require('../log/audit').audit({
    action: 'key.revoke',
    actorKeyId: req.apiKeyId || null,
    resource: `key:${req.params.id}`,
    result: ok ? 'ok' : 'error',
    reason: ok ? null : 'not_found_or_already_revoked',
  });
  if (!ok) {
    return res.status(404).json({ error: { message: 'API key not found or already revoked', type: 'invalid_request_error' } });
  }
  res.json({ object: 'api_key', id: req.params.id, revoked: true });
});

router.delete('/:id', admin, (req, res) => {
  const key = apiKeys.getKey(req.params.id);
  if (key && key.kind === 'login') {
    // 不允许通过 REST 删光登录密钥（必须走 CLI reset，避免锁死）
    return res.status(400).json({
      error: {
        message: '登录密钥请使用 CLI 重置：node scripts/login-key.js reset',
        type: 'invalid_request_error',
      },
    });
  }
  const ok = apiKeys.deleteKey(req.params.id);
  if (!ok) {
    return res.status(404).json({ error: { message: 'API key not found', type: 'invalid_request_error' } });
  }
  res.json({ object: 'api_key', id: req.params.id, deleted: true });
});

/** 重置访问密钥：删除旧记录并创建同平台新密钥 */
router.post('/:id/reset', admin, (req, res) => {
  const old = apiKeys.getKey(req.params.id);
  if (!old || old.kind !== 'access') {
    return res.status(404).json({ error: { message: 'Access key not found', type: 'invalid_request_error' } });
  }
  apiKeys.deleteKey(old.id);
  const created = apiKeys.createKey({
    label: old.label,
    kind: 'access',
    platform: old.platform,
    scopes: old.scopes,
    resources: old.resources,
    rpmLimit: old.rpmLimit,
  });
  require('../log/audit').audit({
    action: 'key.reset',
    actorKeyId: req.apiKeyId || null,
    resource: `key:${old.id}`,
    result: 'ok',
    meta: { newKeyId: created.id },
  });
  res.status(201).json({ object: 'access_key', ...created });
});

/**
 * 复制用：返回明文（仅登录密钥可调）。
 * 界面不展示明文，仅写入剪贴板；无密文备份的旧密钥返回 404。
 */
router.get('/:id/reveal', admin, (req, res) => {
  const key = apiKeys.getKey(req.params.id);
  if (!key) {
    return res.status(404).json({ error: { message: 'API key not found', type: 'invalid_request_error' } });
  }
  const plain = apiKeys.revealKeyPlain(key.id);
  if (!plain) {
    return res.status(404).json({
      error: {
        message: '该密钥无明文备份（历史数据），请重置后使用新密钥。',
        type: 'invalid_request_error',
      },
    });
  }
  // K-4：明文回显属高危读操作，落审计（谁在何时复制了哪把密钥）
  require('../log/audit').audit({
    action: 'key.reveal',
    actorKeyId: req.apiKeyId || null,
    resource: `key:${key.id}`,
    result: 'ok',
    meta: { keyKind: key.kind, platform: key.platform },
  });
  res.json({ object: 'api_key_plain', id: key.id, key: plain });
});

module.exports = router;
