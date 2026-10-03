'use strict';
/**
 * models/rates.js — 模型费率缓存（用于费用估算）。
 * 费率来源：动态目录（catalog.listWithStatus 的 rate 字段）优先，本地 model-config.tiers 兜底。
 * 缓存 TTL 内复用，避免每次统计都打上游。
 */
const config = require('../config');
const catalog = require('./catalog');

const TTL_MS = 10 * 60 * 1000;

let cache = null; // { at, map: { [modelIdLower]: number } }
let inflight = null;

/** 本地 tier → 近似倍率（仅当动态目录不可用时兜底）。 */
const TIER_RATE_FALLBACK = { 1: 10, 2: 5, 3: 3, 4: 1.5, 5: 1 };

function localRateMap() {
  const map = {};
  const models = config.modelConfig.models || {};
  const tiers = config.modelConfig.tiers || {};
  for (const [id, v] of Object.entries(models)) {
    if (typeof v.rate === 'number') map[id.toLowerCase()] = v.rate;
    else if (v.tier != null && TIER_RATE_FALLBACK[v.tier] != null) map[id.toLowerCase()] = TIER_RATE_FALLBACK[v.tier];
  }
  return map;
}

async function loadRateMap({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cache.at < TTL_MS) return cache.map;
  if (inflight) return inflight;

  inflight = (async () => {
    const map = localRateMap();
    try {
      const cat = await catalog.listWithStatus({ force });
      for (const m of cat.models || []) {
        if (typeof m.rate === 'number') map[String(m.id).toLowerCase()] = m.rate;
        else if (typeof m.afterRate === 'number') map[String(m.id).toLowerCase()] = m.afterRate;
      }
    } catch { /* 动态目录失败则用本地兜底 */ }
    cache = { at: Date.now(), map };
    return map;
  })().finally(() => { inflight = null; });

  return inflight;
}

/** 同步取已缓存的费率（无缓存则用本地兜底，不发起网络请求）。 */
function peekRate(model) {
  const key = String(model || '').toLowerCase();
  if (!key) return null;
  if (cache && cache.map[key] != null) return cache.map[key];
  const local = localRateMap();
  return local[key] != null ? local[key] : null;
}

/**
 * 估算一次调用的积分消耗。
 * @param {string} model
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @returns {number|null} 估算积分（保留 4 位小数），无费率时 null
 */
function estimateCost(model, promptTokens, completionTokens) {
  const rate = peekRate(model);
  if (rate == null) return null;
  const tokens = (Number(promptTokens) || 0) + (Number(completionTokens) || 0);
  if (tokens <= 0) return null;
  // 约定：rate 为每千 token 的积分倍率
  return Math.round((tokens * rate / 1000) * 10000) / 10000;
}

module.exports = { loadRateMap, peekRate, estimateCost };
