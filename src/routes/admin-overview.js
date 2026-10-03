'use strict';
/**
 * routes/admin-overview.js — 面板概览与运行时诊断端点。
 * 挂载前缀：/v1/admin（见 index.js）。
 */
const { Router } = require('express');
const config = require('../config');
const pool = require('../credentials/pool');
const scheduler = require('../jobs/scheduler');
const sticky = require('../session/sticky');
const { authenticateAdmin } = require('../middleware/auth');
const { enabled: notifyEnabled } = require('../notify');

const router = Router();
const admin = (req, res, next) => authenticateAdmin(req, res, next);

/** Route Check：不发真实请求，解释当前调度候选。 */
router.get('/route-check', admin, (req, res) => {
  const exclude = req.query.exclude ? String(req.query.exclude).split(',') : [];
  const candidates = pool.explainCandidates(exclude);
  const usable = candidates.filter((c) => c.usable)
    .sort((a, b) => (b.priority - a.priority) || ((b.balance || -1) - (a.balance || -1)));
  res.json({
    object: 'route_check',
    strategy: config.poolStrategy,
    maxInFlightPerAccount: config.maxInFlightPerAccount,
    minBalanceToUse: config.minBalanceToUse,
    wouldPick: usable[0] || null,
    usableCount: usable.length,
    candidates,
    generatedAt: new Date().toISOString(),
  });
});

/** 当前粘性会话（脱敏）。 */
router.get('/sticky', admin, (req, res) => {
  res.json({ object: 'list', data: sticky.listSafe(), ttlMs: sticky.TTL_MS });
});

/** 导出账号备份（含密文 token，仅 Admin）。 */
router.get('/credentials/export', admin, (req, res) => {
  try {
    const rows = require('../credentials/db').db()
      .prepare('SELECT * FROM accounts')
      .all();
    const payload = {
      object: 'trae_relay_export',
      version: 1,
      exportedAt: new Date().toISOString(),
      accounts: rows.map((r) => ({
        id: r.id,
        label: r.label,
        edition: r.edition,
        token_enc: r.token_enc,
        refresh_token_enc: r.refresh_token_enc,
        expired_at: r.expired_at,
        refresh_expired_at: r.refresh_expired_at,
        token_release_at: r.token_release_at,
        user_id: r.user_id,
        host: r.host,
        user_region: r.user_region,
        devices: r.devices ? JSON.parse(r.devices) : null,
        source: r.source,
        enabled: !!r.enabled,
        balance: r.balance,
        error_count: r.error_count,
        cool_until: r.cool_until,
        last_picked_at: r.last_picked_at,
        last_checkin_at: r.last_checkin_at,
        last_checkin_result: r.last_checkin_result,
        entitlement_snapshot: r.entitlement_snapshot,
        priority: r.priority || 0,
        tags: r.tags ? JSON.parse(r.tags) : null,
      })),
    };
    const filename = `relay-gate-export-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 客户端接入配置生成（不含真实密钥明文）。 */
router.get('/client-config', admin, (req, res) => {
  const proto = req.protocol || 'http';
  const host = req.get('host') || `localhost:${config.port}`;
  const baseUrl = `${proto}://${host}`;
  res.json({
    object: 'client_config',
    baseUrl,
    openai: {
      OPENAI_BASE_URL: `${baseUrl}/v1`,
      OPENAI_API_KEY: '<你的 API_KEY>',
      curl: `curl ${baseUrl}/v1/chat/completions -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d '{"model":"auto","messages":[{"role":"user","content":"hi"}],"stream":true}'`,
    },
    anthropic: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: '<你的 API_KEY>',
      curl: `curl ${baseUrl}/v1/messages -H "x-api-key: $API_KEY" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" -d '{"model":"auto","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'`,
    },
    codex: {
      base_url: `${baseUrl}/v1/responses`,
      note: 'Responses 协议最小兼容；复杂事件族可能不完整',
    },
    notes: [
      '转发面使用 API_KEY；管理面板使用 ADMIN_KEY（若已分离）。',
      '默认仅监听 127.0.0.1；跨机请 SSH 隧道或自配 HOST + 防火墙。',
      'SSE 场景请关闭反代缓冲：proxy_buffering off; proxy_read_timeout 600s;',
      '流式一旦开始输出，不在中途切换账号重试。',
    ],
  });
});

/** 运行状态增强（粘性明细 + 池快照）。 */
router.get('/runtime', admin, (req, res) => {
  res.json({
    object: 'runtime',
    status: require('./status').buildStatus(),
    sticky: sticky.listSafe(),
    pool: pool.snapshot(),
    scheduler: scheduler.snapshot(),
    notify: { enabled: notifyEnabled() },
    keys: {
      adminSeparated: config.adminKey !== config.apiKey,
    },
  });
});

module.exports = router;
