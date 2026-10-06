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

/**
 * 改单个候选的开关（enabled / pinned）。
 *
 * 与 PUT /virtual/:id 分开的原因：面板上的候选表是展开时读到的快照，
 * 整体回写会把其他候选的旧值一并覆盖（并发改动、后台同步都可能撞车）。
 * 这里按候选 id 定点改，只接受布尔开关，不接受模型名等结构性字段。
 *
 * candidateId 走查询参数而非路径段：候选 id 形如 `workbuddy/wb/hy3`，含斜杠。
 * 即使前端 encodeURIComponent 编成 %2F，Express 解码后仍按路径分隔符切分，
 * 路由匹配失败会落到转发面鉴权中间件，返回 401「Invalid access key」——
 * 症状是面板误判为登录失效。查询参数不做路径切分，可彻底避开。
 */
router.patch('/virtual/:id/candidate', admin, (req, res) => {
  const id = String(req.params.id || '');
  const candidateId = String((req.query && req.query.candidateId) || '');
  if (!candidateId) {
    return res.status(400).json({ error: { message: 'candidateId is required', type: 'invalid_request_error' } });
  }
  const vm = mr.store.getVirtual(id);
  if (!vm) return res.status(404).json({ error: { message: 'virtual model not found', type: 'invalid_request_error' } });
  const idx = vm.candidates.findIndex((c) => c.id === candidateId);
  if (idx < 0) {
    return res.status(404).json({ error: { message: `candidate not found: ${candidateId}`, type: 'invalid_request_error' } });
  }
  const body = req.body || {};
  const patch = {};
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.pinned === 'boolean') patch.pinned = body.pinned;
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: { message: 'enabled / pinned 至少提供一个布尔值', type: 'invalid_request_error' } });
  }
  const candidates = vm.candidates.map((c, i) => (i === idx ? { ...c, ...patch } : c));
  const r = mr.store.setVirtualCandidates(id, candidates);
  if (!r.ok) return res.status(400).json({ error: { message: r.message, type: 'invalid_request_error' } });
  ok(res, { object: 'candidate', data: r.data.candidates[idx] });
});

/**
 * 兜底：旧路径形态（候选 id 落在路径段）仍可能被旧版前端调用。
 * 未命中任何管理面路由时不该掉进转发面鉴权，故显式声明并返回可读错误。
 */
router.all('/virtual/:id/candidates/*', admin, (req, res) => {
  res.status(404).json({
    error: {
      message: 'endpoint moved: use PATCH /v1/admin/model-router/virtual/:id/candidate?candidateId=...',
      type: 'invalid_request_error',
    },
  });
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

/** 重新同步自动分层虚拟模型（拉取两平台目录 → 按窗口分层 → 倍率排序写回）。 */
router.post('/virtual/resync-auto', admin, async (req, res) => {
  try {
    const r = await mr.autotier.syncAutoTiers({ force: true });
    ok(res, { object: 'autotier_sync', ...r, generatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
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
