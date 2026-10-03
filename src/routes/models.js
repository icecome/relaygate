'use strict';
/**
 * routes/models.js — 模型列表端点。
 * 主数据源：上游 get_detail_param 动态目录（catalog）；失败回退本地 model-config。
 * 默认过滤 unavailable；?availability=all|usable|unknown|unavailable 过滤视图。
 */
const { Router } = require('express');
const config = require('../config');
const { getModelDetailParam } = require('../upstream/client');
const availability = require('../models/availability');
const catalog = require('../models/catalog');
const wbChat = require('../workbuddy/chat');

const router = Router();

function wantCustom(req) {
  const v = String(req.query.include_custom || req.query.custom || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

async function listModels(req, res) {
  const view = String(req.query.availability || 'default');
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  // 平台过滤：转发 Key 按绑定平台；管理 Key 可用 ?platform=；缺省管理面返回全部
  const platformFilter = req.platform || String(req.query.platform || '').toLowerCase() || null;
  try {
    const cat = await catalog.listWithStatus({ force: refresh, includeCustom: wantCustom(req) });
    let rows = cat.models;
    if (view === 'default' || view === 'usable') {
      rows = rows.filter((m) => !availability.isHidden(m.id));
    } else if (view === 'unavailable') {
      rows = rows.filter((m) => availability.isHidden(m.id));
    } else if (view === 'unknown') {
      rows = rows.filter((m) => m.status === 'unknown');
    }

    const list = rows.map((m) => {
      const base = {
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: m.custom ? 'user' : 'trae',
        display_name: m.display_name || m.id,
        custom: !!m.custom,
      };
      if (view !== 'default') base.availability = m.status;
      return base;
    });

    // WorkBuddy 目录：Key 已绑定平台时返回裸 id（无需 wb/ 前缀）
    const wbList = wbChat.WB_MODELS.map((id) => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'workbuddy',
      display_name: id,
      custom: false,
    }));

    let data;
    if (platformFilter === 'workbuddy') {
      data = wbList;
    } else if (platformFilter === 'trae') {
      data = list;
    } else {
      data = list.concat(wbList.map((m) => ({ ...m, id: 'wb/' + m.id, display_name: 'wb/' + m.id })));
    }

    // 虚拟模型 ID（model-router）：仅通用密钥（all）与管理视图可见
    try {
      const allowVirtual = !req.platform || req.platform === 'all' || req.keyKind === 'login';
      if (allowVirtual) {
        const virt = require('../model-router').store.listVirtual()
          .filter((vm) => vm.enabled)
          .map((vm) => ({
            id: vm.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'model-router',
            display_name: vm.description || vm.id,
            custom: true,
            virtual: true,
          }));
        data = virt.concat(data);
      }
    } catch { /* model-router 未就绪时忽略 */ }

    res.json({
      object: 'list',
      source: cat.source,
      syncedAt: cat.syncedAt,
      endpoint: cat.endpoint || null,
      platform: platformFilter || 'all',
      data,
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
}

router.get('/v1/models', listModels);

router.get('/v1/models/status', async (req, res) => {
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  try {
    const cat = await catalog.listWithStatus({ force: refresh, includeCustom: wantCustom(req) });
    // 预热动态目录（含倍率）；失败/未就绪时以静态目录兜底（倍率列显示 —）
    let wbModels = [];
    try { wbModels = await wbChat.modelCatalog(refresh); } catch (e) { /* 回退静态 */ }
    if (!wbModels.length) wbModels = wbChat.WB_MODELS.map((id) => ({ id, name: id, rateText: null, rate: null }));
    // 目录始终展示，但无启用账号时状态为 unavailable（实际无法调用）
    const wbEnabled = require('../credentials/store').list().some((a) => a.enabled && a.edition === 'workbuddy');
    const wbStatus = wbEnabled ? 'available' : 'unavailable';
    const wbReason = wbEnabled ? null : '无可用 WorkBuddy 账号';
    const traeRows = cat.models.map((m) => ({
      id: m.id,
      display_name: m.display_name || m.id,
      status: m.status,
      capability: m.capability || null,
      multimodal: !!m.multimodal,
      custom: !!m.custom,
      reason: m.reason || null,
      source: 'trae-cn',
      source_name: 'Trae CN',
      rateText: m.rate != null ? 'x' + m.rate : null,
      rate: m.rate != null ? m.rate : null,
      feeLevel: m.feeLevel != null ? m.feeLevel : null,
      scene: m.scene || null,
      peak: null,
    }));
    const wbRows = wbModels.map((m) => ({
      id: 'wb/' + m.id,
      display_name: m.name || ('wb/' + m.id),
      status: wbStatus,
      capability: m.supportsReasoning ? 'reasoning_model' : 'chat_model',
      multimodal: false,
      custom: false,
      reason: wbReason,
      source: 'workbuddy-cn',
      source_name: 'WorkBuddy CN',
      rateText: m.rateText || null,
      rate: m.rate,
      peak: null,
      maxInputTokens: m.maxInputTokens || null,
    }));
    let data = wbRows.concat(traeRows);
    try {
      const virt = require('../model-router').store.listVirtual().map((vm) => {
        const cands = require('../model-router').explainCandidates(vm.id);
        const usable = cands.filter((c) => c.usable).length;
        return {
          id: vm.id,
          display_name: vm.description || vm.id,
          status: vm.enabled && usable > 0 ? 'usable' : (vm.enabled ? 'unknown' : 'unavailable'),
          capability: 'virtual_router',
          multimodal: false,
          custom: true,
          virtual: true,
          reason: vm.enabled ? (usable ? null : '全部候选不可用') : '已禁用',
          source: 'model-router',
          source_name: '虚拟模型',
          rateText: null,
          rate: null,
          peak: null,
          candidates: cands.length,
          usableCandidates: usable,
        };
      });
      data = virt.concat(data);
    } catch { /* ignore */ }
    const hostNote = [
      '模型来源：Trae CN（官方模型配置接口，与客户端同源）',
      wbEnabled ? ' 与 WorkBuddy CN（官方模型目录）' : ' 与 WorkBuddy CN（目录可见；无可用账号）',
      '；倍率（x）为真实积分消耗率；两平台接口均未提供峰谷价格',
    ].join('');
    res.json({
      object: 'list',
      strategy: config.poolStrategy,
      upstreamFunction: config.upstreamFunction || null,
      upstreamChatPath: config.upstreamChatPath,
      source: cat.source,
      syncedAt: cat.syncedAt,
      endpoint: cat.endpoint || null,
      hostNote,
      data,
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

router.delete('/v1/models/status', (req, res) => {
  const m = req.query.model;
  availability.reset(m ? String(m) : null);
  res.json({ cleared: m || 'all' });
});

router.get('/v1/models/detail', async (req, res) => {
  try {
    const data = await getModelDetailParam(req.query.function || 'chat_v3');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

/** 强制刷新上游目录（运维/面板按钮用）。 */
router.post('/v1/models/refresh', async (req, res) => {
  try {
    const cat = await catalog.listWithStatus({ force: true });
    res.json({
      ok: true,
      source: cat.source,
      syncedAt: cat.syncedAt,
      count: cat.models.length,
      error: cat.error || null,
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

module.exports = router;
