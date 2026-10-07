'use strict';
/**
 * routes/zcode.js — ZCode 运营面端点。
 * 挂载前缀：/v1/zcode（见 index.js）。全部走管理鉴权。
 *
 * 能力边界：只做「凭据导入 / 探测 / 领取 / 额度查询 / 设置」。
 * 不提供对话转发——上游 messages 通道的头形态未在转发池验证前不启用。
 */
const { Router } = require('express');
const store = require('../credentials/store');
const variant = require('../platform/variant');
const fingerprint = require('../zcode/fingerprint');
const rewards = require('../zcode/rewards');
const localClient = require('../zcode/local');
const zcodeJobs = require('../jobs/zcode-rewards');
const { authenticateAdmin } = require('../middleware/auth');
const { maskSecret: maskToken } = require('../lib/mask');

const router = Router();
const admin = (req, res, next) => authenticateAdmin(req, res, next);

const V = variant.variantOf(variant.ZCODE);

/** 账号出参脱敏（token/apiKey 不出网）。 */
function redact(acct) {
  const { token, refreshToken, apiKey, ...rest } = acct || {};
  return {
    ...rest,
    hasToken: !!token,
    hasApiKey: !!apiKey,
  };
}

/** 汇总账号的奖励快照（供面板）。 */
function rewardSummary(acct) {
  const snap = acct.entitlementSnapshot || {};
  return {
    lastProbeAt: snap.lastProbeAt || null,
    lastClaimAt: snap.lastClaimAt || null,
    lastClaimPlan: snap.lastClaimPlan || null,
    plans: snap.plans || [],
    balances: snap.balances || [],
  };
}

// ── 状态 ────────────────────────────────────────────────────────────────────

/** 平台能力 + 定时任务状态 + 求解器可用性。 */
router.get('/status', admin, (req, res) => {
  res.json({
    platform: { id: V.id, label: V.label, capability: V.capability },
    jobs: zcodeJobs.snapshot(),
    solver: zcodeJobs.solverStatus(),
    localClient: {
      installed: localClient.isClientInstalled(),
      credentialsPath: localClient.credentialsPath(),
    },
  });
});

// ── 账号 ────────────────────────────────────────────────────────────────────

/** 列出 ZCode 账号（含奖励快照摘要）。 */
router.get('/accounts', admin, (req, res) => {
  const list = store.list()
    .filter((a) => variant.isEdition(a.edition, variant.ZCODE))
    .map((a) => ({ ...redact(a), rewards: rewardSummary(a) }));
  res.json({ object: 'list', data: list });
});

/** 删除 ZCode 账号。 */
router.delete('/accounts/:id', admin, (req, res) => {
  const acct = store.get(req.params.id);
  if (!acct) return res.status(404).json({ error: { message: 'account not found', type: 'invalid_request_error' } });
  if (!variant.isEdition(acct.edition, variant.ZCODE)) {
    return res.status(400).json({ error: { message: 'not a zcode account', type: 'invalid_request_error' } });
  }
  const ok = store.remove(req.params.id);
  res.json({ ok });
});

/** 换发设备指纹（风控后换设备语义；device_mid 必变）。 */
router.post('/accounts/:id/fingerprint/rotate', admin, (req, res) => {
  const acct = store.get(req.params.id);
  if (!acct) return res.status(404).json({ error: { message: 'account not found', type: 'invalid_request_error' } });
  if (!variant.isEdition(acct.edition, variant.ZCODE)) {
    return res.status(400).json({ error: { message: 'not a zcode account', type: 'invalid_request_error' } });
  }
  const fp = fingerprint.rotate();
  const updated = store.update(acct.id, { fingerprint: fp });
  res.json({ ok: true, fingerprint: fp, account: redact(updated) });
});

// ── 本机导入 ────────────────────────────────────────────────────────────────

/** 预检本机客户端凭据（不解密全文，只看能不能读 + 有哪些字段）。 */
router.get('/local/preview', admin, (req, res) => {
  try {
    if (!localClient.isClientInstalled()) {
      return res.json({ installed: false, path: localClient.credentialsPath() });
    }
    const acct = localClient.buildAccountFromLocal();
    res.json({
      installed: true,
      path: localClient.credentialsPath(),
      deviceMidReused: !!(acct.fingerprint && acct.fingerprint.deviceMid),
      account: {
        label: acct.label,
        userId: acct.userId,
        mode: acct.mode,
        hasToken: !!acct.token,
      },
    });
  } catch (e) {
    res.status(400).json({ error: { message: e.message, type: 'invalid_request_error' } });
  }
});

/** 从本机客户端凭据导入（幂等：同 userId 更新而非重复插入）。 */
router.post('/local/import', admin, (req, res) => {
  try {
    const acct = localClient.buildAccountFromLocal();
    // 保证有设备档案：导入时若无客户端 device_mid 则生成成套 SKU
    const existingByUser = store.list().find((a) => variant.isEdition(a.edition, variant.ZCODE)
      && a.userId && acct.userId && String(a.userId) === String(acct.userId));
    if (existingByUser) {
      const prev = store.get(existingByUser.id);
      // 同设备沿用原档案（fingerprint 一经分配即稳定，避免每次导入换设备身份）
      const fp = fingerprint.validate(prev.fingerprint) ? prev.fingerprint : acct.fingerprint;
      const updated = store.update(existingByUser.id, {
        ...acct,
        fingerprint: fp,
        lastCheckinResult: 'local_import_updated',
      });
      return res.json({ action: 'updated', account: redact(updated) });
    }
    const created = store.add(acct, 'local');
    return res.status(201).json({ action: 'created', account: redact(created) });
  } catch (e) {
    res.status(400).json({ error: { message: e.message, type: 'invalid_request_error' } });
  }
});

// ── 奖励 ────────────────────────────────────────────────────────────────────

/** 探测单个账号可领套餐（不领取）。 */
router.post('/accounts/:id/rewards/probe', admin, async (req, res) => {
  const acct = store.get(req.params.id);
  if (!acct) return res.status(404).json({ error: { message: 'account not found', type: 'invalid_request_error' } });
  if (!variant.isEdition(acct.edition, variant.ZCODE)) {
    return res.status(400).json({ error: { message: 'not a zcode account', type: 'invalid_request_error' } });
  }
  try {
    const r = await rewards.probe(acct, { activation: req.body.activation !== false });
    // 快照落库（面板可见；不含敏感字段）
    try {
      store.update(acct.id, {
        entitlementSnapshot: {
          ...(acct.entitlementSnapshot || {}),
          lastProbeAt: new Date().toISOString(),
          plans: r.plans,
          lastError: r.error,
        },
      });
    } catch { /* 快照失败不影响响应 */ }
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: { message: e.message, type: 'upstream_error' } });
  }
});

/** 探测全部 ZCode 账号（不领取）。 */
router.post('/rewards/probe', admin, async (req, res) => {
  // 必须用 jobs.zcodeAccounts()：store.list() 被 safeTok 剥掉 token，
  // 直接拿它发上游会一律「缺少 JWT 凭据」
  const accounts = zcodeJobs.zcodeAccounts();
  const results = [];
  for (const a of accounts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      results.push(await rewards.probe(a, { activation: req.body && req.body.activation !== false }));
    } catch (e) {
      results.push({ accountId: a.id, label: a.label || a.id, plans: [], error: e.message, activation: null });
    }
  }
  res.json({ object: 'zcode.probe.batch', total: accounts.length, results });
});

/** 领取单个账号（planId 缺省自动选优先级最高）。 */
router.post('/accounts/:id/rewards/claim', admin, async (req, res) => {
  const acct = store.get(req.params.id);
  if (!acct) return res.status(404).json({ error: { message: 'account not found', type: 'invalid_request_error' } });
  if (!variant.isEdition(acct.edition, variant.ZCODE)) {
    return res.status(400).json({ error: { message: 'not a zcode account', type: 'invalid_request_error' } });
  }
  try {
    const r = await rewards.claimPlan(acct, req.body && req.body.planId);
    try {
      store.update(acct.id, {
        entitlementSnapshot: {
          ...(acct.entitlementSnapshot || {}),
          lastClaimAt: new Date().toISOString(),
          lastClaimPlan: { planId: r.planId, planName: r.planName, result: r.result, message: r.message },
        },
      });
    } catch { /* 快照失败不影响响应 */ }
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: { message: e.message, type: 'upstream_error' } });
  }
});

/** 对全部账号执行一轮「探测 + 领取」（等同定时任务手动触发）。 */
router.post('/rewards/run', admin, async (req, res) => {
  try {
    const r = await zcodeJobs.runRewards({ trigger: 'manual', claim: req.body.claim !== false });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

// ── 额度 ────────────────────────────────────────────────────────────────────

/** 查询单账号额度（billing/balance），并写入 entitlementSnapshot。 */
router.post('/accounts/:id/balance', admin, async (req, res) => {
  const acct = store.get(req.params.id);
  if (!acct) return res.status(404).json({ error: { message: 'account not found', type: 'invalid_request_error' } });
  if (!variant.isEdition(acct.edition, variant.ZCODE)) {
    return res.status(400).json({ error: { message: 'not a zcode account', type: 'invalid_request_error' } });
  }
  try {
    const r = await rewards.fetchBalance(acct);
    try {
      store.update(acct.id, {
        entitlementSnapshot: {
          ...(acct.entitlementSnapshot || {}),
          lastBalanceAt: new Date().toISOString(),
          balances: r.balances,
          plans: r.plans,
        },
        // 汇总剩余 token 作为 balance（面板余额列显示口径）
        balance: (r.balances || []).reduce((s, b) => s + (Number(b.remaining_units) || 0), 0) || null,
      });
    } catch { /* 快照失败不影响响应 */ }
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: { message: e.message, type: 'upstream_error' } });
  }
});

// ── 设置 ────────────────────────────────────────────────────────────────────

router.get('/settings', admin, (req, res) => {
  res.json(zcodeJobs.snapshot());
});

router.post('/settings', admin, (req, res) => {
  try {
    const eff = zcodeJobs.save(req.body || {});
    res.json(eff);
  } catch (e) {
    res.status(400).json({ error: { message: e.message, type: 'invalid_request_error' } });
  }
});

// ── 诊断 ────────────────────────────────────────────────────────────────────

/** 验证码求解自检（真实求解一次，供排障）。 */
router.post('/diagnose/captcha', admin, async (req, res) => {
  try {
    const cfg = await require('../zcode/captcha').fetchConfig();
    const v = await require('../zcode/captcha').getVerifyParam();
    res.json({ ok: true, config: cfg, paramLength: v.param.length, region: v.region });
  } catch (e) {
    res.status(502).json({ ok: false, error: { message: e.message, type: 'captcha_error' } });
  }
});

module.exports = router;