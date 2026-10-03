'use strict';
/**
 * routes/credentials.js — 凭据管理端点。
 * 挂载前缀：/v1/credentials（见 index.js）。管理鉴权按路由注入。
 */
const { Router } = require('express');
const store = require('../credentials/store');
const { importAccount, importMany, ensureAllMissingDevices, resetAccountDevices } = require('../credentials/import');
const oauth = require('../credentials/oauth');
const { checkinAccount, checkinAllEnabled } = require('../upstream/checkin');
const { refreshBalance, refreshBalanceAllEnabled, summarizeExpiry } = require('../upstream/balance');
const { authenticateAdmin, checkAdminToken, extractToken } = require('../middleware/auth');

const router = Router();
const admin = (req, res, next) => authenticateAdmin(req, res, next);

/** 从 entitlement_snapshot 推导临期汇总（过期时间已过的包会被过滤）。 */
function expiringFromSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.packs)) {
    return { d3: 0, d7: 0, packs: [] };
  }
  const expiring = summarizeExpiry(snapshot.packs);
  return {
    d3: expiring.d3,
    d7: expiring.d7,
    packs: snapshot.packs,
  };
}

function withExpiry(account) {
  const { entitlementSnapshot, ...rest } = account;
  const exp = expiringFromSnapshot(entitlementSnapshot);
  return {
    ...rest,
    expiring3d: exp.d3,
    expiring7d: exp.d7,
    packs: exp.packs,
    entitlementSnapshotUpdatedAt: entitlementSnapshot && entitlementSnapshot.updatedAt
      ? entitlementSnapshot.updatedAt
      : null,
  };
}

// 启动加载路由时，为历史 devices=null 账号回填独立指纹
try {
  const backfilled = ensureAllMissingDevices();
  if (backfilled.filled) {
    console.log(`[credentials] backfilled devices for ${backfilled.filled}/${backfilled.total} accounts`);
  }
} catch (e) {
  console.error(`[credentials] backfill devices failed: ${e.message}`);
}

// 列出账号（已脱敏）
router.get('/', admin, (req, res) => {
  res.json({ object: 'list', data: store.list().map(withExpiry) });
});

// 新增（单条）/ 批量导入凭据
router.post('/', admin, (req, res) => {
  const body = req.body || {};
  try {
    if (Array.isArray(body.items)) {
      const r = importMany(body.items);
      return res.status(201).json({
        imported: r.ok,
        updated: r.updated || [],
        failed: r.failed,
      });
    }
    const acct = importAccount(body);
    return res.status(201).json(acct);
  } catch (err) {
    return res.status(400).json({ error: { message: err.message, type: 'invalid_request_error' } });
  }
});

// 账号池摘要（供仪表盘）
router.get('/summary', admin, (req, res) => {
  const list = store.list().map(withExpiry);
  const enabled = list.filter((a) => a.enabled).length;
  const now = Date.now();
  const cooling = list.filter((a) => a.coolUntil && new Date(a.coolUntil).getTime() > now).length;
  const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);
  res.json({
    total: list.length,
    enabled,
    disabled: list.length - enabled,
    cooling,
    expiring3d: round2(list.reduce((s, a) => s + (a.expiring3d || 0), 0)),
    expiring7d: round2(list.reduce((s, a) => s + (a.expiring7d || 0), 0)),
    accounts: list,
  });
});

// 批量：全部启用账号串行签到
// 手动触发不参与确定性错峰（用户点「立即签到」期望立刻执行），spreadMinutes=0
router.post('/checkin', admin, async (req, res) => {
  try {
    const r = await checkinAllEnabled({ spreadMinutes: 0 });
    res.json({ ...r, object: 'checkin.batch' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

// 单账号签到
router.post('/:id/checkin', admin, async (req, res) => {
  try {
    const r = await checkinAccount(req.params.id);
    res.json(r);
  } catch (err) {
    const status = err.message && /not found/i.test(err.message) ? 404
      : err.message && /disabled/i.test(err.message) ? 400
      : err.status && Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status
      : 500;
    res.status(status).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

// 批量刷新剩余积分
router.post('/balance', admin, async (req, res) => {
  try {
    const r = await refreshBalanceAllEnabled();
    res.json({ ...r, object: 'balance.batch' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

// 单账号刷新剩余积分（禁用账号也可查，便于导入后先看余额再启用）
router.post('/:id/balance', admin, async (req, res) => {
  try {
    const r = await refreshBalance(req.params.id);
    res.json(r);
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404
      : /disabled/i.test(err.message) ? 400
      : 500;
    res.status(status).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

// ===== 分组 / 设备 / OAuth（需在 GET /:id 之前注册，避免被通配捕获） =====

// 分组汇总（分组名 → 账号数；name=null 表示未分组）
router.get('/groups', admin, (req, res) => {
  const counts = {};
  for (const a of store.list()) {
    const g = a.group || '__ungrouped__';
    counts[g] = (counts[g] || 0) + 1;
  }
  const data = Object.entries(counts).map(([name, count]) => ({
    name: name === '__ungrouped__' ? null : name,
    count,
  }));
  res.json({ object: 'list', data });
});

// 生成 OAuth 授权 URL 并启动本地回调监听
router.get('/oauth/url', admin, (req, res) => {
  try {
    const r = oauth.getLoginUrl(req.query.group || null);
    res.json({ ...r, statusUrl: '/v1/credentials/oauth/status' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

// OAuth 登录状态（前端轮询）
router.get('/oauth/status', admin, (req, res) => {
  res.json(oauth.status());
});

// 查看单个账号详情（已脱敏）
router.get('/:id', admin, (req, res) => {
  const acct = store.get(req.params.id);
  if (!acct) return res.status(404).json({ error: { message: 'account not found', type: 'not_found' } });
  const { token, refreshToken, ...safe } = acct;
  res.json(withExpiry(safe));
});

// 删除账号
router.delete('/:id', admin, (req, res) => {
  const ok = store.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: { message: 'account not found', type: 'not_found' } });
  res.json({ deleted: req.params.id });
});

// 更新账号（启用/禁用、清冷却、改 label / priority 等白名单字段）
router.patch('/:id', admin, (req, res) => {
  const acct = store.get(req.params.id);
  if (!acct) return res.status(404).json({ error: { message: 'account not found', type: 'not_found' } });
  const ALLOWED = [
    'enabled', 'label', 'coolUntil', 'priority', 'tags', 'group', 'costTier',
  ];
  const patch = {};
  for (const k of ALLOWED) {
    if (req.body && req.body[k] !== undefined) patch[k] = req.body[k];
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: { message: 'no updatable field provided', type: 'invalid_request_error' } });
  }
  if (patch.coolUntil === null) patch.coolUntil = null;
  if (patch.group === '') patch.group = null; // 空串 = 移出分组
  const updated = store.update(req.params.id, patch);
  res.json(updated);
});

// ===== 设备指纹管理 =====

// 重置单账号设备指纹（新随机种子，deviceGen +1）
router.post('/:id/device/reset', admin, (req, res) => {
  try {
    res.json(resetAccountDevices(req.params.id));
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : 500;
    res.status(status).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

// 批量重置启用账号的设备指纹
router.post('/device/reset-all', admin, (req, res) => {
  const targets = store.list().filter((a) => a.enabled);
  const ok = [];
  const failed = [];
  for (const a of targets) {
    try {
      ok.push(resetAccountDevices(a.id));
    } catch (e) {
      failed.push({ accountId: a.id, reason: e.message });
    }
  }
  res.json({ ok, failed, total: targets.length });
});

// ===== OAuth 控制台一键完成（页面竞态 bug 的可靠替代路径） =====
// 用户在 www.trae.cn 授权页的浏览器控制台运行仪表盘提供的代码片段：
// 片段在本机完成 GetRefreshToken + ExchangeToken（带 trae.cn cookie），并把结果 POST 到本端点。
// 浏览器控制台无法携带管理密钥，故该端点免 admin、以 Origin 白名单限制来源。

const OAUTH_COMPLETE_CORS = { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

function oauthCompleteOriginAllowed(origin) {
  if (!origin) return false; // 无 Origin（curl 等）一律拒绝：本端点无 admin 鉴权，仅靠 Origin 白名单兜底
  try {
    const h = new URL(origin).hostname;
    return h === '127.0.0.1' || h === 'localhost' || /(^|\.)trae\.(cn|com|ai|com\.cn)$/.test(h);
  } catch {
    return false;
  }
}

router.options('/oauth/complete', (req, res) => {
  const origin = String(req.headers.origin || '');
  res.set(Object.assign({ 'Access-Control-Max-Age': '86400' }, OAUTH_COMPLETE_CORS));
  if (oauthCompleteOriginAllowed(origin)) res.set('Access-Control-Allow-Origin', origin || '*');
  res.status(204).end();
});

// 无鉴权端点的准入：管理密钥（显式携带时）或一次性 state 二者之一。
// 调用方是授权页控制台里的脚本，拿不到管理密钥，因此以 /oauth/url 签发、
// 只存在于本进程内存的 state 作为共享秘密；state 校验通过即作废。
function oauthCompleteAllowed(req) {
  if (checkAdminToken(extractToken(req)).ok) return true;
  return oauth.verifyAndConsumeState((req.body || {}).state);
}

router.post('/oauth/complete', async (req, res) => {
  const origin = String(req.headers.origin || '');
  if (!oauthCompleteOriginAllowed(origin)) {
    return res.status(403).json({ error: { message: 'origin not allowed', type: 'forbidden' } });
  }
  res.set(Object.assign({ 'Access-Control-Allow-Origin': origin || '*' }, OAUTH_COMPLETE_CORS));
  if (!oauthCompleteAllowed(req)) {
    return res.status(403).json({
      error: {
        message: 'oauth state 校验失败：请先在管理面板点击「OAuth 登录」发起流程，再提交回调。state 一次性有效且与本次登录绑定。',
        type: 'forbidden',
        code: 'OAUTH_STATE_INVALID',
      },
    });
  }
  try {
    const { token, refreshToken, name } = req.body || {};
    if (!token && !refreshToken) {
      return res.status(400).json({ error: { message: 'token or refreshToken is required', type: 'invalid_request_error' } });
    }
    // 名称做净化（仅用于 label 展示）
    const safeName = name != null ? String(name).replace(/["'`;\\]/g, '').trim().slice(0, 60) : '';
    const account = await oauth.completeLogin({ accessToken: token || null, refreshToken: refreshToken || null, userName: safeName || null });
    res.json({ ok: !!account, account, detail: oauth.status().result });
  } catch (err) {
    res.status(400).json({ error: { message: err.message, type: 'invalid_request_error' } });
  }
});

// 手动兜底：粘贴完整回调 URL（仅解析参数，不向该地址发起任何请求）
router.post('/oauth/callback', admin, async (req, res) => {
  try {
    const callbackUrl = req.body && req.body.callbackUrl;
    if (!callbackUrl) {
      return res.status(400).json({ error: { message: 'callbackUrl is required', type: 'invalid_request_error' } });
    }
    // 回调 URL 只应是 Trae 重定向到本机监听器的地址：限定 http(s) 且 host 为本机
    const u = new URL(String(callbackUrl));
    if (!/^https?:$/.test(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
      return res.status(400).json({ error: { message: 'callbackUrl 必须指向本机回调地址（127.0.0.1:<port>/authorize）', type: 'invalid_request_error' } });
    }
    // 兼容 Trae 授权页的畸形形态：/authorize&state=...（参数用 & 拼在路径后，无 ?）
    const params = new URLSearchParams(u.searchParams);
    if (u.pathname.includes('&')) {
      for (const pair of u.pathname.split('&').slice(1)) {
        const eq = pair.indexOf('=');
        if (eq > 0) params.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)));
      }
    }
    const account = await oauth.completeLogin({
      refreshToken: params.get('refreshToken') || params.get('refresh_token'),
      accessToken: params.get('accessToken') || params.get('access_token'),
      userId: params.get('userId') || params.get('user_id'),
      userName: params.get('userName') || params.get('user_name') || params.get('nickname'),
      state: params.get('state'),
    });
    const detail = oauth.status().result;
    res.json({ ok: !!account, account, detail });
  } catch (err) {
    res.status(400).json({ error: { message: err.message, type: 'invalid_request_error' } });
  }
});

module.exports = router;
