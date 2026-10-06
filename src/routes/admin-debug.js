'use strict';
/**
 * routes/admin-debug.js — 调试与诊断端点：模型探活、一键测试、SSE 事件流、配置热更新。
 * 挂载前缀：/v1/admin（见 index.js）。
 */
const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const pool = require('../credentials/pool');
const { authenticateAdmin } = require('../middleware/auth');

const router = Router();
const admin = (req, res, next) => authenticateAdmin(req, res, next);

/** 模型探活：最小请求打上游（真实调用）。 */
router.post('/models/probe', admin, async (req, res) => {
  const model = String((req.body && req.body.model) || req.query.model || '').trim();
  if (!model) {
    return res.status(400).json({ error: { message: 'model required', type: 'invalid_request_error' } });
  }
  const { llmUtilsChat } = require('../upstream/client');
  const { normalizeTraeMessages } = require('../transform/request');
  const startedAt = Date.now();
  try {
    const { result, accountId } = await pool.run((accountId) =>
      llmUtilsChat(
        normalizeTraeMessages([{ role: 'user', content: 'ping' }]),
        model, false, { accountId },
      ), { maxSwitches: 1 });
    if (model !== 'auto') require('../models/availability').markUsable(model);
    res.json({
      ok: true,
      model,
      accountId,
      durationMs: Date.now() - startedAt,
      hasBody: !!(result && (result.data || result.body)),
    });
  } catch (err) {
    if (model !== 'auto') {
      const { isModelConfigError, isPlanLimitError } = require('../upstream/errors');
      if (isModelConfigError(err) || isPlanLimitError(err)) {
        require('../models/availability').markUnavailable(model, err.message);
      }
    }
    res.status(502).json({
      ok: false,
      model,
      message: err.message,
      durationMs: Date.now() - startedAt,
    });
  }
});

/** 自定义消息测试某模型（真实调用上游，返回完整响应）。 */
router.post('/test-chat', admin, async (req, res) => {
  const body = req.body || {};
  const model = String(body.model || 'auto').trim();
  const message = String(body.message || 'ping').trim();
  const stream = body.stream === true;
  const maxTokens = Number(body.max_tokens) || 128;

  if (!model || !message) {
    return res.status(400).json({ error: { message: 'model and message required', type: 'invalid_request_error' } });
  }
  const { llmUtilsChat } = require('../upstream/client');
  const { normalizeTraeMessages } = require('../transform/request');
  const startedAt = Date.now();
  try {
    const { result, accountId } = await pool.run((accountId) =>
      llmUtilsChat(
        normalizeTraeMessages([{ role: 'user', content: message }]),
        model, false, { accountId, max_tokens: maxTokens },
      ), { maxSwitches: 1 });
    if (model !== 'auto') require('../models/availability').markUsable(model);
    // 从非流式聚合结果中提取文本
    const choice = result && result.choices && result.choices[0];
    const content = choice && choice.message ? (choice.message.content || '') : '';
    const usage = result && result.usage ? result.usage : null;
    res.json({
      ok: true,
      model,
      accountId,
      durationMs: Date.now() - startedAt,
      content,
      usage,
      finishReason: choice ? choice.finish_reason : null,
    });
  } catch (err) {
    if (model !== 'auto') {
      const { isModelConfigError, isPlanLimitError, isModelRateLimitError } = require('../upstream/errors');
      if (isModelConfigError(err) || isPlanLimitError(err) || isModelRateLimitError(err)) {
        require('../models/availability').markUnavailable(model, err.message);
      }
    }
    res.status(502).json({
      ok: false,
      model,
      message: err.message,
      durationMs: Date.now() - startedAt,
    });
  }
});

/** ===== SSE 调试模式 ===== */

const SSE_DEBUG_ENABLED = () => process.env.TRAE_DEBUG_SSE === 'true';
const SSE_DEBUG_DIR = () => path.join(config.ROOT, 'logs', new Date().toISOString().slice(0, 10));
const SSE_DEBUG_FILE = () => path.join(SSE_DEBUG_DIR(), 'sse-debug.jsonl');

/** SSE 调试状态。 */
router.get('/debug/sse/status', admin, (req, res) => {
  res.json({ object: 'sse_debug_status', enabled: SSE_DEBUG_ENABLED() });
});

/** 查询某请求/某天的 SSE 事件流。 */
router.get('/debug/sse', admin, (req, res) => {
  if (!SSE_DEBUG_ENABLED()) {
    return res.json({ object: 'list', enabled: false, data: [], hint: 'SSE 调试未开启，设置 TRAE_DEBUG_SSE=true 并重启后生效' });
  }
  const days = Math.min(Math.max(parseInt(req.query.days || '1', 10) || 1, 1), 7);
  const requestId = req.query.request_id ? String(req.query.request_id) : null;
  const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10) || 200, 1), 1000);

  const rows = [];
  const base = path.join(config.ROOT, 'logs');
  for (let d = 0; d < days; d++) {
    const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    const file = path.join(base, day, 'sse-debug.jsonl');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (requestId && r.requestId !== requestId) continue;
        rows.push(r);
      } catch { /* skip bad line */ }
    }
  }
  rows.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  const total = rows.length;
  res.json({ object: 'list', enabled: true, total, data: rows.slice(0, limit) });
});

/** ===== 配置热更新 ===== */

/** 查看当前生效的关键配置。 */
router.get('/config', admin, (req, res) => {
  res.json({
    object: 'runtime_config',
    port: config.port,
    host: config.host,
    poolStrategy: config.poolStrategy,
    maxInFlightPerAccount: config.maxInFlightPerAccount,
    minBalanceToUse: config.minBalanceToUse,
    ratePaceMs: config.ratePaceMs,
    rateWindowMs: config.rateWindowMs,
    rateWindowMax: config.rateWindowMax,
    rateCooldownMs: config.rateCooldownMs,
    schedulerEnabled: config.schedulerEnabled,
    checkinHour: config.checkinHour,
    checkinMinute: config.checkinMinute,
    keepaliveHour: config.keepaliveHour,
    tokenRefreshLeadHours: config.tokenRefreshLeadHours,
    modelProbeIntervalHours: config.modelProbeIntervalHours,
    upstreamFunction: config.upstreamFunction || null,
    upstreamChatPath: config.upstreamChatPath,
    toolProtocol: config.toolProtocol,
    maxRetries: config.maxRetries,
    retryBaseDelay: config.retryBaseDelay,
    requestTimeoutMs: config.requestTimeoutMs,
    statusPublic: config.statusPublic,
    // K-1 后语义 = 「管理域已配置」（DB 登录密钥或 env ADMIN_KEY）
    adminSeparated: require('../credentials/api-keys').hasLoginKey() || !!config.adminKey,
  });
});

/** 重新加载 model-config.json / model-fallback.json / .env 关键项。 */
router.post('/config/reload', admin, (req, res) => {
  try {
    const before = {
      modelCount: Object.keys(config.modelConfig.models || {}).length,
      poolStrategy: config.poolStrategy,
    };
    config.reload();
    const after = {
      modelCount: Object.keys(config.modelConfig.models || {}).length,
      poolStrategy: config.poolStrategy,
    };
    res.json({ object: 'config_reload', ok: true, before, after, reloadedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

module.exports = router;