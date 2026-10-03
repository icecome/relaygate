'use strict';
/**
 * routes/model-router.js — 虚拟模型路由管理 API。
 * 挂载前缀：/v1/admin/model-router（管理鉴权）。
 */
const { Router } = require('express');
const { authenticateAdmin } = require('../middleware/auth');
const mr = require('../model-router');

const router = Router();
const admin = (req, res, next) => authenticateAdmin(req, res, next);

function ok(res, data) {
  res.json(data);
}

/** 总览：providers + virtualModels + health */
router.get('/overview', admin, (req, res) => {
  ok(res, { object: 'model_router_overview', ...mr.snapshot(), generatedAt: new Date().toISOString() });
});

// ----- Providers -----
router.get('/providers', admin, (req, res) => {
  ok(res, { object: 'list', data: mr.store.listProviders() });
});

router.put('/providers/:id', admin, (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: { message: 'id is required', type: 'invalid_request_error' } });
  const body = req.body || {};
  if (body.baseUrl != null && body.baseUrl !== '' && !/^https?:\/\//i.test(String(body.baseUrl))) {
    return res.status(400).json({ error: { message: 'baseUrl 必须是 http(s) URL', type: 'invalid_request_error' } });
  }
  const data = mr.store.upsertProvider(id, body);
  ok(res, { object: 'provider', data });
});

router.delete('/providers/:id', admin, (req, res) => {
  const r = mr.store.removeProvider(String(req.params.id || ''));
  if (!r.ok) return res.status(400).json({ error: { message: r.message, type: 'invalid_request_error' } });
  ok(res, { object: 'deleted', id: req.params.id });
});

// ----- Virtual models -----
router.get('/virtual', admin, (req, res) => {
  const data = mr.store.listVirtual().map((vm) => ({
    ...vm,
    candidates: mr.explainCandidates(vm.id),
  }));
  ok(res, { object: 'list', data });
});

router.get('/virtual/:id', admin, (req, res) => {
  const vm = mr.store.getVirtual(String(req.params.id || ''));
  if (!vm) return res.status(404).json({ error: { message: 'virtual model not found', type: 'invalid_request_error' } });
  ok(res, { object: 'virtual_model', data: { id: req.params.id, ...vm, candidates: mr.explainCandidates(req.params.id) } });
});

router.put('/virtual/:id', admin, (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: { message: 'id is required', type: 'invalid_request_error' } });
  const r = mr.store.upsertVirtual(id, req.body || {});
  if (!r.ok) return res.status(400).json({ error: { message: r.message, type: 'invalid_request_error' } });
  ok(res, { object: 'virtual_model', data: r.data });
});

router.delete('/virtual/:id', admin, (req, res) => {
  mr.store.removeVirtual(String(req.params.id || ''));
  ok(res, { object: 'deleted', id: req.params.id });
});

/** 解除限流冷却（虚拟模型级；id 缺省清全部）。 */
router.post('/virtual/:id/unfreeze', admin, (req, res) => {
  const id = req.params.id === '*' ? null : String(req.params.id || '');
  mr.clearCooldown(id);
  ok(res, { object: 'unfrozen', id: req.params.id });
});

/** 重新加载 model-router.json */
router.post('/reload', admin, (req, res) => {
  mr.store.reload();
  ok(res, { object: 'reloaded', ...mr.snapshot() });
});

/** 诊断：解释某虚拟模型当前候选可用性 */
router.get('/route-check/:id', admin, (req, res) => {
  const id = String(req.params.id || '');
  const vm = mr.store.getVirtual(id);
  if (!vm) return res.status(404).json({ error: { message: 'virtual model not found', type: 'invalid_request_error' } });
  const candidates = mr.explainCandidates(id);
  const usable = candidates.filter((c) => c.usable);
  ok(res, {
    object: 'route_check',
    virtualModel: id,
    strategy: vm.strategy,
    failover: vm.failover,
    wouldPick: usable[0] || null,
    usableCount: usable.length,
    candidates,
    generatedAt: new Date().toISOString(),
  });
});

/** 各 Provider 可选模型目录（候选下拉用）。 */
router.get('/available-models', admin, async (req, res) => {
  const out = {};
  const providers = mr.store.listProviders();
  for (const p of providers) {
    out[p.id] = await modelsForProvider(p);
  }
  ok(res, { object: 'available_models', data: out, generatedAt: new Date().toISOString() });
});

async function modelsForProvider(p) {
  const toRows = (ids, labelOf) =>
    [...new Set(ids.map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b)).map((id) => ({
      id,
      label: (labelOf && labelOf(id)) || id,
    }));

  try {
    if (p.type === 'builtin' && p.builtin === 'workbuddy') {
      const wbChat = require('../workbuddy/chat');
      try {
        const cat = await wbChat.modelCatalog(false);
        if (cat && cat.length) {
          return toRows(cat.map((m) => m.id), (id) => {
            const m = cat.find((x) => x.id === id);
            return m && m.name && m.name !== id ? `${id}（${m.name}）` : id;
          });
        }
      } catch { /* 回退静态 */ }
      return toRows(wbChat.WB_MODELS.filter((m) => m !== 'auto' && m !== 'default'));
    }
    if (p.type === 'builtin') {
      // trae：动态目录优先，失败回退本地 model-config
      try {
        const catalog = require('../models/catalog');
        const cat = await catalog.listWithStatus({ force: false });
        if (cat && cat.models && cat.models.length) {
          return toRows(cat.models.map((m) => m.id));
        }
      } catch { /* 回退 */ }
      const models = (require('../config').modelConfig && require('../config').modelConfig.models) || {};
      return toRows(Object.keys(models).filter((k) => k !== 'auto'));
    }
    // openai 兼容：配置里声明的 models；无声明则为空（界面允许自定义输入）
    return toRows(p.models || []);
  } catch {
    return [];
  }
}

module.exports = router;
