'use strict';
/**
 * models/catalog-sync.js — 远端模型目录同步（发现/增量/断点续传）。
 * Adapter 约定：fetchItems({cursor}) → {items, nextCursor, etag, version, notModified?}
 */
const catalog = require('./catalog');
const meta = require('./catalog-meta');
const { audit } = require('../log/audit');

/** Trae：基于现有 catalog.loadCatalog */
async function traeAdapter() {
  const cat = await catalog.loadCatalog({ force: true });
  const items = (cat.models || []).map((m) => ({
    id: m.id,
    display_name: m.display_name || m.id,
    capability: m.capability || (m.reasoning ? 'reasoning_model' : 'chat_model'),
    multimodal: !!m.multimodal,
    reasoning: !!m.reasoning,
    rate: m.rate != null ? m.rate : null,
    afterRate: m.afterRate != null ? m.afterRate : null,
    source: m.custom ? 'custom' : 'remote',
  }));
  return {
    items,
    nextCursor: null,
    etag: cat.syncedAt || String(cat.at || Date.now()),
    version: cat.source === 'upstream' ? 'upstream' : 'local',
    notModified: false,
    source: cat.source,
    error: cat.error || null,
  };
}

/** WorkBuddy：静态 + 动态目录 */
async function workbuddyAdapter() {
  const wbChat = require('../workbuddy/chat');
  let items = [];
  let source = 'static';
  try {
    const cat = await wbChat.modelCatalog(false);
    if (cat && cat.length) {
      items = cat.map((m) => ({
        id: m.id,
        display_name: m.name || m.id,
        capability: m.supportsReasoning ? 'reasoning_model' : 'chat_model',
        multimodal: false,
        reasoning: !!m.supportsReasoning,
        rate: m.rate != null ? m.rate : null,
        maxInputTokens: m.maxInputTokens != null ? m.maxInputTokens : null,
        maxOutputTokens: m.maxOutputTokens != null ? m.maxOutputTokens : null,
      }));
      source = 'upstream';
    }
  } catch { /* fallthrough */ }
  if (!items.length) {
    items = wbChat.WB_MODELS.filter((m) => m !== 'auto' && m !== 'default').map((id) => ({
      id,
      display_name: id,
      capability: 'chat_model',
    }));
  }
  return {
    items,
    nextCursor: null,
    etag: `${source}:${items.length}`,
    version: source,
    notModified: false,
    source,
  };
}

/** 通用 OpenAI 兼容：可选 GET /v1/models */
async function openaiAdapter(provider) {
  const dispatch = require('../model-router/dispatch');
  const key = dispatch.resolveApiKey(provider);
  const base = String(provider.baseUrl || '').replace(/\/+$/, '');
  if (!base || !key) {
    return {
      items: (provider.models || []).map((id) => ({ id, display_name: id, capability: 'chat_model' })),
      nextCursor: null,
      etag: `cfg:${(provider.models || []).length}`,
      version: 'config',
      notModified: false,
      source: 'config',
    };
  }
  try {
    const resp = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const j = await resp.json();
    const list = (j.data || j.models || []).map((m) => ({ id: m.id || m.name, display_name: m.id || m.name }));
    return {
      items: list,
      nextCursor: null,
      etag: `live:${list.length}`,
      version: 'live',
      notModified: false,
      source: 'upstream',
    };
  } catch (e) {
    return {
      items: (provider.models || []).map((id) => ({ id, display_name: id })),
      nextCursor: null,
      etag: `cfg:${(provider.models || []).length}`,
      version: 'config',
      notModified: false,
      source: 'config',
      error: e.message,
    };
  }
}

function adapterFor(providerId) {
  const store = require('../model-router/store');
  const p = store.getProvider(providerId);
  if (!p) return null;
  if (p.type === 'openai') return { provider: p, fn: () => openaiAdapter(p) };
  if (p.builtin === 'workbuddy') return { provider: p, fn: workbuddyAdapter };
  return { provider: p, fn: traeAdapter };
}

/**
 * 同步一个 Provider 的模型目录（幂等，支持断点）。
 * @param {string} providerId
 * @param {{force?:boolean}} opts
 */
async function syncProvider(providerId, opts = {}) {
  const ad = adapterFor(providerId);
  if (!ad) {
    return { ok: false, providerId, error: `unknown provider: ${providerId}` };
  }
  const state = meta.getSyncState(providerId) || {};
  meta.saveSyncState(providerId, { status: 'syncing', lastError: null });
  try {
    // 断点续传：若有 nextCursor 检查点则续拉；当前 adapter 均为单页，预留 cursor 字段
    const res = await ad.fn();
    if (res.notModified && !opts.force) {
      meta.saveSyncState(providerId, {
        status: 'ok',
        lastOkAt: new Date().toISOString(),
        etag: res.etag || state.etag,
        upstreamVersion: res.version || state.upstreamVersion,
        partial: false,
      });
      return { ok: true, providerId, notModified: true, syncedAt: new Date().toISOString() };
    }
    const metas = [];
    for (const raw of res.items || []) {
      const m = meta.normalizeMeta(providerId, raw);
      if (m) metas.push(m);
    }
    const diff = meta.diffAgainst(providerId, metas);
    const applied = meta.applyDiff(providerId, diff);
    const now = new Date().toISOString();
    meta.saveSyncState(providerId, {
      status: 'ok',
      lastOkAt: now,
      lastSyncAt: now,
      etag: res.etag || null,
      upstreamVersion: res.version || null,
      cursor: res.nextCursor || null,
      lastError: res.error || null,
      partial: !!res.nextCursor,
    });
    const summary = {
      ok: true,
      providerId,
      source: res.source,
      total: metas.length,
      ...applied,
      etag: res.etag || null,
      version: res.version || null,
      syncedAt: now,
      error: res.error || null,
    };
    if (applied.added || applied.changed || applied.deprecated) {
      audit({
        action: 'catalog.sync',
        result: 'ok',
        resource: `provider:${providerId}`,
        meta: applied,
      });
    }
    return summary;
  } catch (e) {
    meta.saveSyncState(providerId, {
      status: 'error',
      lastError: e.message,
      partial: false,
    });
    audit({
      action: 'catalog.sync',
      result: 'error',
      resource: `provider:${providerId}`,
      reason: e.message,
    });
    return { ok: false, providerId, error: e.message };
  }
}

/** 同步全部已启用 Provider */
async function syncAll() {
  const store = require('../model-router/store');
  const providers = store.listProviders().filter((p) => p.enabled);
  const results = [];
  for (const p of providers) {
    results.push(await syncProvider(p.id));
  }
  return results;
}

function providerStatus() {
  const store = require('../model-router/store');
  return store.listProviders().map((p) => ({
    provider: p,
    sync: meta.getSyncState(p.id),
    modelCount: meta.listMeta(p.id).length,
  }));
}

module.exports = {
  syncProvider,
  syncAll,
  providerStatus,
  traeAdapter,
  workbuddyAdapter,
  openaiAdapter,
  adapterFor,
};
