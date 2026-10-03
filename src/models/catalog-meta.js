'use strict';
/**
 * models/catalog-meta.js — 目录元数据、指纹、增量 diff、同步检查点（P0）。
 */
const nodeCrypto = require('crypto');
const { db } = require('../credentials/db');

function fingerprintOf(meta) {
  const stable = {
    displayName: meta.displayName || meta.id,
    capability: meta.capability || null,
    multimodal: !!meta.multimodal,
    reasoning: !!meta.reasoning,
    rate: meta.rate != null ? Number(meta.rate) : null,
    afterRate: meta.afterRate != null ? Number(meta.afterRate) : null,
    maxInputTokens: meta.maxInputTokens != null ? Number(meta.maxInputTokens) : null,
    maxOutputTokens: meta.maxOutputTokens != null ? Number(meta.maxOutputTokens) : null,
  };
  return nodeCrypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

function normalizeMeta(providerId, item) {
  const modelId = String(item.id || item.model_id || item.config_name || '').trim();
  if (!modelId) return null;
  const now = new Date().toISOString();
  const meta = {
    providerId,
    modelId,
    displayName: item.display_name || item.name || modelId,
    version: item.version || null,
    capability: item.capability || null,
    multimodal: !!item.multimodal,
    reasoning: !!item.reasoning,
    rate: item.rate != null ? Number(item.rate) : null,
    afterRate: item.afterRate != null ? Number(item.afterRate) : null,
    maxInputTokens: item.maxInputTokens != null ? Number(item.maxInputTokens) : null,
    maxOutputTokens: item.maxOutputTokens != null ? Number(item.maxOutputTokens) : null,
    lifecycle: item.lifecycle || 'available',
    source: item.source || 'remote',
    discoveredAt: now,
    updatedAt: now,
    lastVerifiedAt: now,
  };
  meta.fingerprint = item.fingerprint || fingerprintOf(meta);
  return meta;
}

function upsertMeta(meta) {
  const d = db();
  d.prepare(
    `INSERT INTO catalog_models
      (provider_id, model_id, display_name, version, fingerprint, capabilities, limits, rate, lifecycle, source, discovered_at, updated_at, last_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_id, model_id) DO UPDATE SET
       display_name=excluded.display_name,
       version=excluded.version,
       fingerprint=excluded.fingerprint,
       capabilities=excluded.capabilities,
       limits=excluded.limits,
       rate=excluded.rate,
       lifecycle=excluded.lifecycle,
       source=excluded.source,
       updated_at=excluded.updated_at,
       last_verified_at=excluded.last_verified_at`,
  ).run(
    meta.providerId, meta.modelId, meta.displayName, meta.version, meta.fingerprint,
    JSON.stringify({ capability: meta.capability, multimodal: meta.multimodal, reasoning: meta.reasoning }),
    JSON.stringify({ maxInputTokens: meta.maxInputTokens, maxOutputTokens: meta.maxOutputTokens }),
    meta.rate, meta.lifecycle, meta.source, meta.discoveredAt, meta.updatedAt, meta.lastVerifiedAt,
  );
}

function listMeta(providerId) {
  const rows = providerId
    ? db().prepare('SELECT * FROM catalog_models WHERE provider_id = ? ORDER BY model_id').all(providerId)
    : db().prepare('SELECT * FROM catalog_models ORDER BY provider_id, model_id').all();
  return rows.map((r) => {
    let caps = {};
    let limits = {};
    try { caps = JSON.parse(r.capabilities || '{}'); } catch { /* ignore */ }
    try { limits = JSON.parse(r.limits || '{}'); } catch { /* ignore */ }
    return {
      providerId: r.provider_id,
      modelId: r.model_id,
      displayName: r.display_name,
      version: r.version,
      fingerprint: r.fingerprint,
      capability: caps.capability || null,
      multimodal: !!caps.multimodal,
      reasoning: !!caps.reasoning,
      maxInputTokens: limits.maxInputTokens != null ? limits.maxInputTokens : null,
      maxOutputTokens: limits.maxOutputTokens != null ? limits.maxOutputTokens : null,
      rate: r.rate,
      lifecycle: r.lifecycle,
      source: r.source,
      discoveredAt: r.discovered_at,
      updatedAt: r.updated_at,
      lastVerifiedAt: r.last_verified_at,
    };
  });
}

function setLifecycle(providerId, modelId, lifecycle) {
  db().prepare(
    'UPDATE catalog_models SET lifecycle = ?, updated_at = ? WHERE provider_id = ? AND model_id = ?',
  ).run(lifecycle, new Date().toISOString(), providerId, modelId);
}

/** 增量 diff：对比本地已有指纹与新列表 */
function diffAgainst(providerId, incomingMetas) {
  const existing = new Map(listMeta(providerId).map((m) => [m.modelId, m]));
  const incoming = new Map(incomingMetas.map((m) => [m.modelId, m]));
  const added = [];
  const changed = [];
  const removed = [];
  for (const [id, m] of incoming) {
    const prev = existing.get(id);
    if (!prev) added.push(m);
    else if (prev.fingerprint !== m.fingerprint) changed.push({ from: prev, to: m });
  }
  for (const [id, m] of existing) {
    if (!incoming.has(id)) removed.push(m);
  }
  return { added, changed, removed };
}

/** 应用 diff：upsert 新增/变更；删除标记 deprecated（延迟硬删） */
function applyDiff(providerId, diff) {
  for (const m of diff.added) upsertMeta(m);
  for (const c of diff.changed) upsertMeta(c.to);
  for (const m of diff.removed) setLifecycle(providerId, m.modelId, 'deprecated');
  return {
    added: diff.added.length,
    changed: diff.changed.length,
    deprecated: diff.removed.length,
  };
}

function getSyncState(providerId) {
  const r = db().prepare('SELECT * FROM catalog_sync_state WHERE provider_id = ?').get(providerId);
  if (!r) return null;
  return {
    providerId: r.provider_id,
    cursor: r.cursor,
    etag: r.etag,
    upstreamVersion: r.upstream_version,
    lastSyncAt: r.last_sync_at,
    lastOkAt: r.last_ok_at,
    lastError: r.last_error,
    status: r.status,
    partial: !!r.partial,
  };
}

function saveSyncState(providerId, patch = {}) {
  const prev = getSyncState(providerId) || {};
  const next = {
    cursor: patch.cursor !== undefined ? patch.cursor : prev.cursor,
    etag: patch.etag !== undefined ? patch.etag : prev.etag,
    upstreamVersion: patch.upstreamVersion !== undefined ? patch.upstreamVersion : prev.upstreamVersion,
    lastSyncAt: patch.lastSyncAt !== undefined ? patch.lastSyncAt : new Date().toISOString(),
    lastOkAt: patch.lastOkAt !== undefined ? patch.lastOkAt : prev.lastOkAt,
    lastError: patch.lastError !== undefined ? patch.lastError : prev.lastError,
    status: patch.status !== undefined ? patch.status : prev.status || 'idle',
    partial: patch.partial !== undefined ? (patch.partial ? 1 : 0) : (prev.partial ? 1 : 0),
  };
  db().prepare(
    `INSERT INTO catalog_sync_state (provider_id, cursor, etag, upstream_version, last_sync_at, last_ok_at, last_error, status, partial)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_id) DO UPDATE SET
       cursor=excluded.cursor, etag=excluded.etag, upstream_version=excluded.upstream_version,
       last_sync_at=excluded.last_sync_at, last_ok_at=excluded.last_ok_at, last_error=excluded.last_error,
       status=excluded.status, partial=excluded.partial`,
  ).run(
    providerId, next.cursor, next.etag, next.upstreamVersion,
    next.lastSyncAt, next.lastOkAt, next.lastError, next.status, next.partial,
  );
  return next;
}

module.exports = {
  fingerprintOf,
  normalizeMeta,
  upsertMeta,
  listMeta,
  setLifecycle,
  diffAgainst,
  applyDiff,
  getSyncState,
  saveSyncState,
};
