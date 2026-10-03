'use strict';
/**
 * routes/workbuddy.js — WorkBuddy 账号接入端点（抓取/导入/登录验证）。
 * 挂载前缀：/v1/workbuddy（见 index.js），管理鉴权按路由注入。
 *
 * 说明：导入的账号默认 enabled=false —— WorkBuddy 上游为 OpenAI 兼容
 * passthrough（copilot.tencent.com/v2/chat/completions），与 Trae 转换层不同，
 * 待上游对接（里程碑 2）后再启用，避免污染 Trae 账号池调度。
 *
 * 安全：凭据只来自「本机桌面客户端 auth 文件」与「账号库」，不接受
 * 请求体传入的 token（消除用户输入到上游请求的数据流）；
 * 上游 URL 由 workbuddy/auth.js 的常量映射按区域枚举生成。
 */
const { Router } = require('express');
const store = require('../credentials/store');
const wbAuth = require('../workbuddy/auth');
const { wbCheckinAccount, wbCheckinAllEnabled } = require('../upstream/wb-checkin');
const { authenticateAdmin } = require('../middleware/auth');

const router = Router();
const admin = (req, res, next) => authenticateAdmin(req, res, next);

function maskToken(t) {
  if (!t) return null;
  return t.length <= 16 ? '***' : t.slice(0, 8) + '…' + t.slice(-6);
}

/** 读取本机桌面客户端登录态（脱敏）。 */
router.get('/local', admin, (req, res) => {
  try {
    const info = wbAuth.readAuthFile();
    if (!info) {
      return res.json({ found: false, hint: '未找到 WorkBuddy 桌面端登录态（%LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info）' });
    }
    res.json({
      found: true,
      file: info.file,
      uid: info.uid,
      nickname: info.nickname,
      phoneNumber: info.phoneNumber,
      region: info.region,
      expiresAt: info.expiresAtMs ? new Date(info.expiresAtMs).toISOString() : null,
      accessToken: maskToken(info.accessToken),
      refreshToken: maskToken(info.refreshToken),
    });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 将 WorkBuddy 登录态导入账号库（默认 enabled=false，同 userId 去重更新）。
 *  凭据来源二选一：本机桌面客户端 auth 文件（默认，带在线验证）；
 *  或 body.infoJsonText —— 粘贴的 workbuddy-desktop.info 文件内容（跨机导入，
 *  不做在线验证、始终 enabled=false，导入后可用 /verify 补验）。 */
router.post('/import', admin, async (req, res) => {
  try {
    const labelOverride = (req.body && req.body.label) || null;
    let info;
    let verified = false;
    let check = null;

    const infoJsonText = (req.body && req.body.infoJsonText) || null;
    if (infoJsonText) {
      // 跨机导入：解析粘贴的 .info 文件内容（不做在线验证，凭据不回显）
      let raw;
      try { raw = JSON.parse(String(infoJsonText)); } catch (e) {
        return res.status(400).json({ error: { message: 'infoJsonText 不是合法 JSON', type: 'invalid_request_error' } });
      }
      const acc = raw.account || {};
      const auth = raw.auth || {};
      if (!auth.accessToken && !auth.refreshToken) {
        return res.status(400).json({ error: { message: '文件内容缺少 auth.accessToken/refreshToken', type: 'invalid_request_error' } });
      }
      info = {
        uid: acc.uid || null, nickname: acc.nickname || null, phoneNumber: acc.phoneNumber || null,
        accessToken: auth.accessToken || null, refreshToken: auth.refreshToken || null,
        expiresAtMs: auth.expiresAt || null, region: wbAuth.regionOf(auth.domain),
      };
    } else {
      info = wbAuth.readAuthFile();
      if (!info) return res.status(404).json({ error: { message: '未找到可导入的 WorkBuddy 登录态', type: 'not_found' } });
    }
    if (!info.accessToken && !info.refreshToken) {
      return res.status(400).json({ error: { message: '登录态缺少 accessToken/refreshToken', type: 'invalid_request_error' } });
    }

    const userId = info.uid || info.phoneNumber || null;
    let account;
    const existing = userId && store.list().find((a) => String(a.userId) === String(userId));
    const patch = {
      label: labelOverride || info.nickname || info.phoneNumber || (userId ? 'wb-' + String(userId).slice(-6) : 'workbuddy'),
      edition: 'workbuddy',
      source: 'workbuddy',
      token: info.accessToken || null,
      refreshToken: info.refreshToken || null,
      expiredAt: info.expiresAtMs ? new Date(info.expiresAtMs).toISOString() : null,
      userId,
      host: wbAuth.chatHost(info.region),
    };

    if (infoJsonText) {
      // 跨机粘贴导入：未在线验证，一律禁用，待 /verify 补验
      patch.enabled = false;
      account = existing && !forceFlag(req) ? store.update(existing.id, patch) : store.add(patch, 'workbuddy');
      account.action = existing && !forceFlag(req) ? 'updated' : 'created';
      account.verified = false;
    } else {
      // 本机抓取：在线验证（无效凭据不入库）
      check = await wbAuth.verify(info);
      if (!check.valid) {
        return res.status(400).json({ error: { message: '登录验证失败：' + check.reason, type: 'invalid_request_error' } });
      }
      patch.balance = check.balance != null ? check.balance : null;
      if (existing && !forceFlag(req)) {
        if (!existing.enabled) patch.enabled = false;
        account = store.update(existing.id, patch);
        account.action = 'updated';
      } else {
        patch.enabled = false; // 默认禁用，待 chat 上游对接后启用
        account = store.add(patch, 'workbuddy');
        account.action = 'created';
      }
      account.verifiedBalance = check.balance;
    }
    res.json(account);
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

function forceFlag(req) { return !!(req.body && req.body.force); }

/** 登录验证 + 余额查询（body {accountId}；缺省时验证本机登录态）。 */
router.post('/verify', admin, async (req, res) => {
  try {
    let info;
    let accountId = null;
    if (req.body && req.body.accountId) {
      accountId = String(req.body.accountId);
      const a = store.get(accountId);
      if (!a) return res.status(404).json({ error: { message: 'account not found', type: 'not_found' } });
      info = { accessToken: a.token, refreshToken: a.refreshToken, uid: a.userId, region: wbAuth.regionOf(a.host) };
    } else {
      info = wbAuth.readAuthFile();
    }
    if (!info || (!info.accessToken && !info.refreshToken)) {
      return res.status(404).json({ error: { message: '无可用 WorkBuddy 凭据', type: 'not_found' } });
    }
    const check = await wbAuth.verify(info);
    if (check.valid && accountId) {
      store.update(accountId, { balance: check.balance != null ? check.balance : null, errorCount: 0, coolUntil: null });
    }
    res.json(check);
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

/** 手动触发 token 刷新（body {accountId}）。 */
router.post('/refresh', admin, async (req, res) => {
  try {
    const a = req.body && req.body.accountId && store.get(req.body.accountId);
    if (!a || !a.refreshToken) return res.status(404).json({ error: { message: '账号不存在或无 refreshToken', type: 'not_found' } });
    const r = await wbAuth.refresh(a.refreshToken);
    store.update(a.id, { token: r.accessToken, refreshToken: r.refreshToken, expiredAt: r.expiresAt });
    res.json({ ok: true, expiredAt: r.expiresAt, accessToken: maskToken(r.accessToken) });
  } catch (err) {
    res.status(502).json({ error: { message: err.message, type: 'upstream_error' } });
  }
});

/** 解析签到用凭据：优先 body.accountId，缺省回退本机登录态。 */
function checkinInfo(req) {
  if (req.body && req.body.accountId) {
    const a = store.get(String(req.body.accountId));
    if (!a) return { error: { status: 404, message: 'account not found' } };
    return {
      info: { accessToken: a.token, refreshToken: a.refreshToken, uid: a.userId, region: wbAuth.regionOf(a.host) },
      accountId: a.id,
    };
  }
  const info = wbAuth.readAuthFile();
  if (!info) return { error: { status: 404, message: '无本机 WorkBuddy 登录态' } };
  return { info, accountId: null };
}

/** 签到状态查询（只读，不消耗）。body {accountId} 可选，缺省查本机登录态。 */
router.post('/checkin-status', admin, async (req, res) => {
  try {
    const { error, info } = checkinInfo(req);
    if (error) return res.status(error.status).json({ error: { message: error.message, type: 'not_found' } });
    res.json(await wbAuth.checkinStatus(info));
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

/** 单账号每日签到（status → claim，写 lastCheckinResult）。body {accountId} */
router.post('/checkin', admin, async (req, res) => {
  try {
    if (req.body && req.body.accountId) {
      const r = await wbCheckinAccount(String(req.body.accountId));
      return res.json(r);
    }
    // 无 accountId：本机登录态（无库记录，不写 store）
    const { error, info } = checkinInfo(req);
    if (error) return res.status(error.status).json({ error: { message: error.message, type: 'not_found' } });
    const st = await wbAuth.checkinStatus(info);
    if (!st.ok) return res.json(st);
    if (st.checkedIn) {
      return res.json({ ok: true, alreadyCheckedIn: true, checkedIn: true, result: 'already', streakDays: st.streakDays });
    }
    const ck = await wbAuth.checkin(info);
    res.json(ck);
  } catch (err) {
    const status = err.message && /not found/i.test(err.message) ? 404
      : err.message && /disabled/i.test(err.message) ? 400
      : 500;
    res.status(status).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

/** 批量签到：全部 enabled 的 WorkBuddy 账号。手动触发不参与错峰。 */
router.post('/checkin-all', admin, async (req, res) => {
  try {
    const r = await wbCheckinAllEnabled({ spreadMinutes: 0 });
    res.json({ ...r, object: 'wb_checkin.batch' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

module.exports = router;
