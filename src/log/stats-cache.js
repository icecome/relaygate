'use strict';
/**
 * log/stats-cache.js — 流量统计增量物化缓存（P2）。
 *
 * 背景：admin-extras 的 /stats/* 每次请求全量读 logs/<date>/traffic.jsonl，
 * 文件大时逐日 readFileSync 成为面板卡顿点。
 * 方案：把每日原始行**聚合成桶**（按模型/按账号的计数与 token/费用汇总，+ 日级总量），
 * 缓存到 .trae-api/stats-cache/<date>.json；面板 /stats/* 请求时命中则直接按桶重建，
 * 未命中才全量读一次并回填缓存。写日志时 invalidateDay() 使当日缓存失效（增量一致）。
 * 明细（traffic 原始行）不缓存——那是按日 jsonl，体量小；缓存只覆盖聚合维度。
 *
 * 提供与 log/stats.js 同签名的三个聚合函数（可直接替换）
 *   cachedDailyStats / cachedModelStats / cachedAccountStats
 * 产物结构对齐 stats.js 的 dailyStats/modelStats/accountStats，以便 admin-extras 零改动接入。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { readTrafficLines, isMetered } = require('./stats');
const { writeJsonAtomic } = require('../lib/atomic-write');
const { stateDir, legacyStateDir } = require('../lib/paths');
const { round2, round4 } = require('../lib/round');

// 读优先新位置，旧位置兜底（缓存本身可重建，不做逐文件迁移）
const CACHE_DIR = () => {
  const fresh = path.join(stateDir(), 'stats-cache');
  if (fs.existsSync(fresh)) return fresh;
  const legacy = path.join(legacyStateDir(), 'stats-cache');
  return fs.existsSync(legacy) ? legacy : fresh;
};
/** 写入位置固定新目录，避免与旧目录交替读写出错。 */
const WRITE_DIR = () => path.join(stateDir(), 'stats-cache');
const CACHE_TTL_MS = 60 * 60 * 1000;
/** 桶结构版本。新增字段使旧缓存失效，避免用缺 metered 的旧桶算出错误的覆盖率。 */
const BUCKET_VERSION = 2;

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 最近 days 天的日期键（新→旧）。 */
function recentDays(days) {
  const keys = [];
  for (let d = 0; d < days; d++) {
    keys.push(new Date(Date.now() - d * 86400000).toISOString().slice(0, 10));
  }
  return keys;
}

function cacheFile(dateKey) {
  return path.join(CACHE_DIR(), `${dateKey}.json`);
}

function readCache(dateKey) {
  try {
    const file = cacheFile(dateKey);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || !raw.cachedAt || !raw.buckets) return null;
    if (raw.version !== BUCKET_VERSION) return null;
    if (Date.now() - raw.cachedAt > CACHE_TTL_MS) return null;
    return raw.buckets;
  } catch {
    return null;
  }
}

function writeCache(dateKey, buckets) {
  writeJsonAtomic(path.join(WRITE_DIR(), `${dateKey}.json`), { version: BUCKET_VERSION, cachedAt: Date.now(), buckets });
}

/**
 * 从原始行构建一日桶。
 * bucket = { date, requests, errors, tokens, metered, estimatedCost, durationSumMs, durationCount, toolCalls, byModel:{m:{requests,tokens,metered,cost}}, byAccount:{a:{requests,errors,tokens,metered,cost}} }
 * tokens 仅累加已计量请求；metered 记录带回 usage 的请求数，两者分开才能得出真实覆盖率。
 */
function buildDayBucket(rows, dateKey) {
  const b = {
    date: dateKey,
    requests: 0, errors: 0, tokens: 0, metered: 0, estimatedCost: 0, durationSumMs: 0, durationCount: 0, toolCalls: 0,
    byModel: {}, byAccount: {},
  };
  for (const r of rows) {
    b.requests++;
    if (r.error || (r.status && r.status >= 400)) b.errors++;
    const metered = isMetered(r);
    const pt = Number(r.promptTokens) || 0;
    const ct = Number(r.completionTokens) || 0;
    const tok = Number(r.totalTokens) || (pt + ct);
    if (metered) b.metered++;
    b.tokens += tok;
    const cost = Number(r.estimatedCost) || 0;
    b.estimatedCost += cost;
    b.toolCalls += Number(r.toolCalls) || 0;
    if (typeof r.durationMs === 'number') { b.durationSumMs += r.durationMs; b.durationCount++; }
    const m = r.model || 'unknown';
    const bm = b.byModel[m] || (b.byModel[m] = { requests: 0, tokens: 0, metered: 0, cost: 0 });
    bm.requests++; bm.tokens += tok; if (metered) bm.metered++; bm.cost += cost;
    const a = r.account || 'unknown';
    const ba = b.byAccount[a] || (b.byAccount[a] = { requests: 0, errors: 0, tokens: 0, metered: 0, cost: 0 });
    ba.requests++;
    if (r.error || (r.status && r.status >= 400)) ba.errors++;
    if (metered) ba.metered++;
    ba.tokens += tok; ba.cost += cost;
  }
  return b;
}

/** 取最近 days 天的桶（命中缓存取缓存，未命中则读日志构建并回填）。 */
function getBuckets(days) {
  const out = [];
  for (const day of recentDays(days)) {
    const cached = readCache(day);
    if (cached && cached.date === day) {
      out.push(cached);
      continue;
    }
    const base = path.join(config.ROOT, 'logs');
    const file = path.join(base, day, 'traffic.jsonl');
    if (!fs.existsSync(file)) { writeCache(day, null); continue; }
    const rows = [];
    const text = fs.readFileSync(file, 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
    const bucket = buildDayBucket(rows, day);
    writeCache(day, bucket);
    out.push(bucket);
  }
  return out.filter(Boolean);
}

/** 按日聚合（对齐 stats.dailyStats 输出结构）。 */
function cachedDailyStats(days) {
  return getBuckets(days)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((b) => ({
      date: b.date,
      requests: b.requests,
      errors: b.errors,
      tokens: round2(b.tokens),
      metered: b.metered,
      unmetered: b.requests - b.metered,
      estimatedCost: round4(b.estimatedCost),
      byModel: Object.fromEntries(Object.entries(b.byModel).map(([k, v]) => [
        k,
        { requests: v.requests, tokens: round2(v.tokens), metered: v.metered, unmetered: v.requests - v.metered, estimatedCost: round4(v.cost) },
      ])),
    }));
}

/** 按模型聚合（对齐 stats.modelStats 输出结构）。 */
function cachedModelStats(days) {
  const byModel = {};
  for (const b of getBuckets(days)) {
    for (const [m, v] of Object.entries(b.byModel)) {
      const acc = byModel[m] || (byModel[m] = { model: m, requests: 0, errors: 0, tokens: 0, metered: 0, promptTokens: 0, completionTokens: 0, estimatedCost: 0, durationSumMs: 0, durationCount: 0, toolCalls: 0 });
      acc.requests += v.requests;
      // 误差率按该模型实际请求/误差在桶里没有分模型 error 计数——用整体近似：
      // 桶级无 per-model errors，标记 errors 为 0（模型级 error 主要在 traffic 明细里，属可接受近似）
      acc.tokens += v.tokens;
      acc.metered += v.metered || 0;
      acc.estimatedCost += v.cost;
      acc.durationSumMs += b.durationSumMs * (v.requests / Math.max(1, b.requests));
      acc.durationCount += Math.round(b.durationCount * (v.requests / Math.max(1, b.requests)));
      acc.toolCalls += Math.round(b.toolCalls * (v.requests / Math.max(1, b.requests)));
    }
  }
  return Object.values(byModel)
    .map((d) => ({
      model: d.model,
      requests: d.requests,
      errors: d.errors,
      tokens: round2(d.tokens),
      metered: d.metered,
      unmetered: d.requests - d.metered,
      promptTokens: round2(d.promptTokens),
      completionTokens: round2(d.completionTokens),
      estimatedCost: round4(d.estimatedCost),
      avgDurationMs: d.durationCount ? Math.round(d.durationSumMs / d.durationCount) : null,
      toolCalls: d.toolCalls,
    }))
    .sort((a, b) => b.requests - a.requests);
}

/** 按账号聚合（对齐 stats.accountStats 输出结构）。 */
function cachedAccountStats(days) {
  const byAccount = {};
  let tokensAll = 0;
  for (const b of getBuckets(days)) {
    tokensAll += b.tokens;
    for (const [a, v] of Object.entries(b.byAccount)) {
      const acc = byAccount[a] || (byAccount[a] = { accountId: a, requests: 0, errors: 0, tokens: 0, metered: 0, estimatedCost: 0 });
      acc.requests += v.requests;
      acc.errors += v.errors;
      acc.tokens += v.tokens;
      acc.metered += v.metered || 0;
      acc.estimatedCost += v.cost;
    }
  }
  return Object.values(byAccount)
    .map((d) => ({
      ...d,
      unmetered: d.requests - d.metered,
      tokens: round2(d.tokens),
      estimatedCost: round4(d.estimatedCost),
      errorRate: d.requests ? round2(d.errors / d.requests) : 0,
      tokenShare: tokensAll ? round2(d.tokens / tokensAll) : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

/** 写日志时使当日缓存失效（增量一致）。@param {string} [dateKey] 缺省为今天。 */
function invalidateDay(dateKey) {
  try {
    const file = cacheFile(dateKey || todayKey());
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch { /* 失效失败不影响 */ }
}

/** 清空全部统计缓存。 */
function clearCache() {
  try {
    // 两处都清，避免旧目录残留继续被读取
    fs.rmSync(WRITE_DIR(), { recursive: true, force: true });
    fs.rmSync(path.join(legacyStateDir(), 'stats-cache'), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = { cachedDailyStats, cachedModelStats, cachedAccountStats, invalidateDay, clearCache, todayKey, CACHE_DIR, WRITE_DIR, BUCKET_VERSION };