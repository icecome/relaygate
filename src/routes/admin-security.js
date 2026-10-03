'use strict';
/**
 * routes/admin-security.js — 目录同步 / 审计 / 模型画像（P0-P2）。
 * 挂载前缀：/v1/admin。
 */
const { Router } = require('express');
const { authenticateAdmin } = require('../middleware/auth');
const catalogSync = require('../models/catalog-sync');
const catalogMeta = require('../models/catalog-meta');
const auditLog = require('../log/audit');
const stats = require('../log/stats');

const router = Router();
const admin = (req, res, next) => authenticateAdmin(req, res, next);

// ===== Catalog 同步 =====

router.get('/catalog/status', admin, (req, res) => {
  res.json({ object: 'catalog_status', data: catalogSync.providerStatus(), generatedAt: new Date().toISOString() });
});

router.post('/catalog/sync', admin, async (req, res) => {
  const providerId = req.body && req.body.providerId;
  try {
    const result = providerId
      ? await catalogSync.syncProvider(String(providerId), { force: true })
      : await catalogSync.syncAll();
    res.json({ object: 'catalog_sync', data: result });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

router.get('/catalog/models', admin, (req, res) => {
  const providerId = req.query.providerId ? String(req.query.providerId) : null;
  const rows = catalogMeta.listMeta(providerId);
  res.json({ object: 'list', data: rows, total: rows.length });
});

router.patch('/catalog/models/:providerId/:modelId', admin, (req, res) => {
  const lifecycle = req.body && req.body.lifecycle;
  const allowed = new Set(['available', 'degraded', 'deprecated', 'retired', 'paused', 'draft']);
  if (!allowed.has(lifecycle)) {
    return res.status(400).json({ error: { message: `lifecycle must be one of ${[...allowed].join('|')}`, type: 'invalid_request_error' } });
  }
  catalogMeta.setLifecycle(String(req.params.providerId), String(req.params.modelId), lifecycle);
  auditLog.audit({
    action: 'catalog.lifecycle',
    actorKeyId: req.apiKeyId || null,
    resource: `model:${req.params.providerId}/${req.params.modelId}`,
    result: 'ok',
    meta: { lifecycle },
  });
  res.json({ ok: true, providerId: req.params.providerId, modelId: req.params.modelId, lifecycle });
});

// ===== 审计 =====

router.get('/audit', admin, (req, res) => {
  const rows = auditLog.query({
    action: req.query.action ? String(req.query.action) : null,
    actorKeyId: req.query.actorKeyId ? String(req.query.actorKeyId) : null,
    result: req.query.result ? String(req.query.result) : null,
    limit: req.query.limit ? Number(req.query.limit) : 100,
  });
  res.json({ object: 'list', data: rows, total: rows.length });
});

// ===== 模型画像（P2 聚合 traffic） =====

router.get('/models/stats', admin, (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days || '1', 10) || 1, 1), 30);
  const lines = stats.readTrafficLines(days);
  const rows = stats.modelStats(lines);
  res.json({
    object: 'model_stats',
    days,
    generatedAt: new Date().toISOString(),
    data: rows,
  });
});

module.exports = router;
