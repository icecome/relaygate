'use strict';
/**
 * log/stats-cache.js — 流量统计增量物化缓存（P2）。
 * admin-extras 的 /stats/* 每次请求都全量读 logs/<date>/traffic.jsonl，文件较大时
 * 逐日 readFileSync 成为面板卡顿点。这里把每日原始行聚合成桶（按模型与按账号的
 * 计数、token 与费用汇总，加日级总量），缓存到 .trae-api/stats-cache/<date>.json：
 * 命中则直接按桶重建，未命中才全量读一次并回填；写日志时 invalidateDay() 使当日缓存失效。
 * 明细（traffic 原始行）不缓存，那是按日 jsonl，体量小；缓存只覆盖聚合维度。
 *
 * 提供与 log/stats.js 同签名的三个聚合函数，可直接替换：
 * cachedDailyStats / cachedModelStats / cachedAccountStats。
 * 产物结构统一到 stats.js 的 dailyStats/modelStats/accountStats，admin-extras 可零改动接入。
 */
const fs = require('fs');
const path = require('path');
const { numTok, isMasked, tokenSource, costOf, turnBuckets, addTurn, turnCounters } = require('./stats');
const { writeJsonAtomic } = require('../lib/atomic-write');
const { stateDir, legacyStateDir, logsDir } = require('../lib/paths');
const { round2, round4 } = require('../lib/round');
const { localDateKey, recentLocalDateKeys } = require('../lib/util');

// 读优先新位置，旧位置作为最后手段（缓存本身可重建，不做逐文件迁移）
const CACHE_DIR = () => {
  const fresh = path.join(stateDir(), 'stats-cache');
  if (fs.existsSync(fresh)) return fresh;
  const legacy = path.join(legacyStateDir(), 'stats-cache');
  return fs.existsSync(legacy) ? legacy : fresh;
};
/** 写入位置固定新目录，避免与旧目录交替读写出错。 */
const WRITE_DIR = () => path.join(stateDir(), 'stats-cache');
const CACHE_TTL_MS = 60 * 60 * 1000;
/**
 * 缓存桶版本。每次改动解析口径都要递增，否则旧桶继续被读：
 *   3 补 cacheReadTokens；4 补 token 来源三分类；
 *   5 补 tokensLost；6 estimatedCost 改为按当前标定重算；
 *   7 numTok 接受数字字符串（旧版写入文件的格式），tokensLost 仅计真脱敏行；
 *   8 补 costUpper（缺 cacheRead、按上界计价的行数）；
 *   9 按日键改为**本地日期**（原为 UTC，东八区 00:00-08:00 的请求落到前一天），
 *     同时按模型补 errors / promptTokens / completionTokens；
 *   10 补逻辑回合三计数 turns / turnsFailed / recoveredTurns（降级换候选会让
 *      同一次客户端请求产生多行 traffic，只按行数算成功率会系统性偏低）；
 *   11 补工具输出压缩节省 rtk*（只有跑过压缩的行才有，故以嵌套对象存在）。
 */
const BUCKET_VERSION = 11;

function todayKey() {
  return localDateKey();
}

/** 最近 days 天的日期键（新→旧），本地日期口径，与日志目录一致。 */
function recentDays(days) {
  return recentLocalDateKeys(days);
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
 * tokens 仅累加已计量请求；metered 记录带回 usage 的请求数。两者分开才能得出真实覆盖率。
 */
function buildDayBucket(rows, dateKey) {
  const b = {
    date: dateKey,
    requests: 0, errors: 0, tokens: 0, metered: 0, exact: 0, estimated: 0, none: 0,
    tokensLost: 0, priced: 0, costUpper: 0,
    estimatedCost: 0, cacheReadTokens: 0, durationSumMs: 0, durationCount: 0, toolCalls: 0,
    byModel: {}, byAccount: {},
  };
  // 逻辑回合聚合（见 stats.js#turnBuckets）：只存三个计数，不把每回合的明细
  // 留在桶里——桶要覆盖历史每一天，逐回合存会让体积膨胀十倍以上。
  const turns = turnBuckets();
  let noTurnN = 0;
  // 工具输出压缩（RTK）节省：只有确实跑过压缩的行才计入；缺字段或不满足
  // 不变量（before - after === saved）都记 partial，供界面标注「下界」。
  const rtk = { calls: 0, before: 0, after: 0, saved: 0, blocks: 0, partial: false };
  for (const r of rows) {
    addTurn(turns, r, `#noturn${noTurnN++}`);
    const rtkBefore = numTok(r.rtkBytesBefore);
    if (rtkBefore != null) {
      const after = numTok(r.rtkBytesAfter);
      const saved = numTok(r.rtkSavedBytes);
      rtk.calls += 1;
      rtk.before += rtkBefore;
      rtk.after += after || 0;
      rtk.saved += saved || 0;
      rtk.blocks += numTok(r.rtkBlocks) || 0;
      if (after == null || saved == null || rtkBefore - after !== saved) rtk.partial = true;
    }
    b.requests++;
    if (r.error || (r.status && r.status >= 400)) b.errors++;
    const src = tokenSource(r);
    b[src]++;
    if (src !== 'none') b.metered++;
    // token 字段被脱敏成 "***"（非数字字符串）：原值已丢，只能计数。
    // 数字字符串（"49569"）可还原，numTok 已接受，不算丢失。
    if (isMasked(r.totalTokens) || isMasked(r.promptTokens)) b.tokensLost++;
    const pt = numTok(r.promptTokens) || 0;
    const ct = numTok(r.completionTokens) || 0;
    const tok = numTok(r.totalTokens) || (pt + ct);
    b.tokens += tok;
    b.cacheReadTokens += numTok(r.cacheReadTokens) || 0;
    // 一律按当前标定重算，不采信写入文件的 estimatedCost（历史为错误的 tier 口径，
    // 量纲差约 97 倍，详见 log/stats.js#costOf）。
    const c = costOf(r);
    if (c.priced) b.priced++;
    if (c.upperBound) b.costUpper++;
    const cost = c.cost;
    b.estimatedCost += cost;
    b.toolCalls += Number(r.toolCalls) || 0;
    if (typeof r.durationMs === 'number') { b.durationSumMs += r.durationMs; b.durationCount++; }
    const m = r.model || 'unknown';
    const bm = b.byModel[m] || (b.byModel[m] = { requests: 0, errors: 0, tokens: 0, metered: 0, cost: 0, cacheReadTokens: 0, promptTokens: 0, completionTokens: 0 });
    bm.requests++; bm.tokens += tok; if (src !== 'none') bm.metered++; bm.cost += cost; bm.cacheReadTokens += numTok(r.cacheReadTokens) || 0;
    bm.promptTokens += pt; bm.completionTokens += ct;
    if (r.error || (r.status && r.status >= 400)) bm.errors++;
    const a = r.account || 'unknown';
    const ba = b.byAccount[a] || (b.byAccount[a] = { requests: 0, errors: 0, tokens: 0, metered: 0, cost: 0 });
    ba.requests++;
    if (r.error || (r.status && r.status >= 400)) ba.errors++;
    if (src !== 'none') ba.metered++;
    ba.tokens += tok; ba.cost += cost;
  }
  return { ...b, ...turnCounters(turns), ...(rtk.calls > 0 ? { rtk } : {}) };
}

/** 取最近 days 天的桶：命中缓存取缓存，未命中则读日志构建并回填。 */
function getBuckets(days) {
  const out = [];
  for (const day of recentDays(days)) {
    const cached = readCache(day);
    if (cached && cached.date === day) {
      out.push(cached);
      continue;
    }
    const base = logsDir();
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

/** 按日聚合（输出结构统一到 stats.dailyStats）。 */
function cachedDailyStats(days) {
  return getBuckets(days)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((b) => ({
      date: b.date,
      requests: b.requests,
      errors: b.errors,
      tokens: round2(b.tokens),
      metered: b.metered,
      exact: b.exact || 0,
      estimated: b.estimated || 0,
      none: b.none || 0,
      unmetered: b.none != null ? b.none : b.requests - b.metered,
      tokensLost: b.tokensLost || 0,
      priced: b.priced || 0,
      costUpper: b.costUpper || 0,
      cacheReadTokens: round2(b.cacheReadTokens || 0),
      estimatedCost: round4(b.estimatedCost),
      // 逻辑回合口径（桶版本 >= 10 才有；旧桶会被 readCache 按版本号拒绝并重建）
      turns: b.turns || 0,
      turnsFailed: b.turnsFailed || 0,
      recoveredTurns: b.recoveredTurns || 0,
      // 工具输出压缩节省：该日一行都没跑过压缩时**不输出这些字段**（而不是输出 0），
      // 前端据此区分「压缩没效果」与「当时还没这个能力」。
      ...(b.rtk && b.rtk.calls > 0 ? {
        rtkCalls: b.rtk.calls,
        rtkBytesBefore: b.rtk.before,
        rtkBytesAfter: b.rtk.after,
        rtkSavedBytes: b.rtk.saved,
        rtkBlocks: b.rtk.blocks,
        rtkPercent: b.rtk.before > 0 ? round2((b.rtk.saved / b.rtk.before) * 100) : 0,
        ...(b.rtk.partial ? { rtkPartial: true } : {}),
      } : {}),
      byModel: Object.fromEntries(Object.entries(b.byModel).map(([k, v]) => [
        k,
        {
          requests: v.requests,
          tokens: round2(v.tokens),
          metered: v.metered,
          unmetered: v.requests - v.metered,
          cacheReadTokens: round2(v.cacheReadTokens || 0),
          estimatedCost: round4(v.cost),
        },
      ])),
    }));
}

/** 按模型聚合（输出结构统一到 stats.modelStats）。 */
function cachedModelStats(days) {
  const byModel = {};
  for (const b of getBuckets(days)) {
    for (const [m, v] of Object.entries(b.byModel)) {
      const acc = byModel[m] || (byModel[m] = { model: m, requests: 0, errors: 0, tokens: 0, metered: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, estimatedCost: 0, durationSumMs: 0, durationCount: 0, toolCalls: 0 });
      acc.requests += v.requests;
      // errors / promptTokens / completionTokens 自桶版本 9 起按模型逐个累计，
      // 是真实值而非 0。桶版本 < 9 的旧桶会被 readCache 按版本号拒绝，不会误读。
      acc.errors += v.errors || 0;
      acc.tokens += v.tokens;
      acc.metered += v.metered || 0;
      acc.promptTokens += v.promptTokens || 0;
      acc.completionTokens += v.completionTokens || 0;
      acc.cacheReadTokens += v.cacheReadTokens || 0;
      acc.estimatedCost += v.cost;
      // 时长与工具调用数桶内只按天汇总，没有分模型维度，只能按请求数占比摊派——
      // 这是估算，avgDurationMs 因此是近似值，展示层不标注精确口径。
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
      cacheReadTokens: round2(d.cacheReadTokens),
      estimatedCost: round4(d.estimatedCost),
      avgDurationMs: d.durationCount ? Math.round(d.durationSumMs / d.durationCount) : null,
      toolCalls: d.toolCalls,
    }))
    .sort((a, b) => b.requests - a.requests);
}

/** 按账号聚合（输出结构统一到 stats.accountStats）。 */
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

/** 写日志时使当日缓存失效。@param {string} [dateKey] 缺省为今天。 */
function invalidateDay(dateKey) {
  try {
    const file = cacheFile(dateKey || todayKey());
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch { /* 失效失败不影响主流程 */ }
}

/** 清空全部统计缓存。 */
function clearCache() {
  try {
    // 新旧两处都清，避免旧目录残留继续被读取
    fs.rmSync(WRITE_DIR(), { recursive: true, force: true });
    fs.rmSync(path.join(legacyStateDir(), 'stats-cache'), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = { cachedDailyStats, cachedModelStats, cachedAccountStats, invalidateDay, clearCache, todayKey, CACHE_DIR, WRITE_DIR, BUCKET_VERSION };