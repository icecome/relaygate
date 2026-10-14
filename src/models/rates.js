'use strict';
/**
 * models/rates.js — 模型费率缓存（用于费用估算）。
 * 费率来源：动态目录（catalog.listWithStatus 的 rate 字段）优先，本地 model-config.tiers 作最后手段。
 * 缓存 TTL 内复用，避免每次统计都请求上游。
 */
const config = require('../config');
const catalog = require('./catalog');
const { peekCalibration } = require('./pricing-calib');

const TTL_MS = 10 * 60 * 1000;

let cache = null; // { at, map: { [modelIdLower]: number } }
let inflight = null;

/** 本地 tier → 近似倍率（仅当动态目录不可用时作最后手段）。
 *
 * 量纲警示：这张表的值不是「积分/千 token」。tier=5 → rate=1 的含义是
 * 「1 倍」，但下方 estimateCost 会把它当积分率用，等价于 1 积分/千 token，
 * 而账单实测约 0.0103 积分/千 token——虚高约 97 倍。
 * 历史日志里的 estimatedCost 正是这个口径固化的（实测 2026-09-27 单日
 * 241,539 积分 vs 账单 1,976.61）。
 * 现已改为「一律按标定系数重算、不采信写入文件的值」，本表仅在模型完全没有标定
 * 且动态目录也取不到时才会命中，是最后手段。
 */
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
    } catch { /* 动态目录失败则用本地最后手段 */ }
    cache = { at: Date.now(), map };
    return map;
  })().finally(() => { inflight = null; });

  return inflight;
}

/** 同步取已缓存的费率（无缓存则用本地最后手段，不发起网络请求）。 */
function peekRate(model) {
  const key = String(model || '').toLowerCase();
  if (!key) return null;
  if (cache && cache.map[key] != null) return cache.map[key];
  const local = localRateMap();
  return local[key] != null ? local[key] : null;
}

/**
 * 估算一次调用的积分消耗。
 *
 * 三级口径（精度递减，取第一个非 null）：
 *   1. 账单标定系数（models/pricing-calib.js）——官方账单实测的分段费率，
 *      对 GLM/Qwen 等模型误差可到 0.001%，是唯一可当作「账单口径」的数字；
 *   2. 动态目录 consumption_rate（catalog）——上游自己公布的倍率；
 *   3. 本地 tier 倍率（TIER_RATE_FALLBACK）——量纲不可信，见上方警示。
 *
 * 标定口径按 DSH token-meter 的分桶模型，分别对未命中缓存的输入、
 * 输出、缓存读三类 token 计价。
 *
 * @param {string} model
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @param {{cacheRead?:number, platform?:string}} [opts] 已知缓存读 token 与平台
 * @returns {number|null} 估算积分（保留 4 位小数），无任何费率时 null
 */
function estimateCost(model, promptTokens, completionTokens, opts = {}) {
  const pt = Number(promptTokens) || 0;
  const ct = Number(completionTokens) || 0;
  if (pt + ct <= 0) return null;

  // 1) 账单标定系数（最精确；平台决定查哪张系数表）
  const cacheRead = Number(opts.cacheRead) || 0;
  const c = peekCalibration(model, opts.platform);
  if (c) {
    const uncached = Math.max(0, pt - cacheRead);
    // 无缓存读信息时按「全部未缓存」计，这是上界：真实调用含缓存命中，
    // 未缓存单价是缓存读的 4~15 倍，故结果会高估。
    // 实测 2026-09-27：241.5M token 缺 cacheRead 字段，按全未缓存算得 14133 积分，
    // 而官方账单仅 1976.61（高估 7.1 倍）；按 90% 命中率折算则吻合。
    // 调用方（stats.costOf）用 priced 标记区分，界面据此提示估算偏保守。
    const credits = uncached * c.uncached + ct * c.output + cacheRead * c.cacheRead;
    return credits > 0 ? Math.round(credits * 10000) / 10000 : null;
  }

  // 2) 动态目录倍率（上游公布的口径）
  const rate = peekRate(model);
  if (rate == null) return null;
  return Math.round(((pt + ct) * rate / 1000) * 10000) / 10000;
}

/** 该模型是否有账单标定系数（供调用方判断估算可信度）。 */
function hasCalibration(model, platform) {
  return peekCalibration(model, platform) != null;
}

module.exports = { loadRateMap, peekRate, estimateCost, hasCalibration };
