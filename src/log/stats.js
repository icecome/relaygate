'use strict';
/**
 * log/stats.js — 流量日志多维统计聚合（从 traffic.jsonl 计算）。
 * 提供 daily / models / accounts 三维聚合，供 /v1/admin/stats/* 使用。
 * 费用估算复用 models/rates.estimateCost（无费率时估算为 null，聚合为 0）。
 */
const fs = require('fs');
const path = require('path');
const { estimateCost } = require('../models/rates');
const { round2, round4 } = require('../lib/round');
const { recentLocalDateKeys } = require('../lib/util');
const { logsDir } = require('../lib/paths');

/** 读取最近 N 天的 traffic.jsonl 行；按日期从新到旧合并，分页时优先命中近期数据。 */
function readTrafficLines(days) {
  const rows = [];
  const base = logsDir();
  for (const day of recentLocalDateKeys(days)) {
    const file = path.join(base, day, 'traffic.jsonl');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf-8');
    const dayRows = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        r._day = day; // 标记归属日
        dayRows.push(r);
      } catch { /* skip bad line */ }
    }
    // 单日内按时间倒序：jsonl 追加序即时间升序，反转后与跨日的新→旧顺序一致
    rows.push(...dayRows.reverse());
  }
  return rows;
}

/**
 * 该行是否带回上游 usage：Trae 平台多数请求带回，WorkBuddy 平台目前全部不带。
 * 判定必须是数值：2026-10-10 之前的日志里 token 字段被 sanitize 的 "token" 正则
 * 误脱敏成 "***" 字符串（现已修复）。字符串不是计量值——若按 != null 判定，
 * 这批历史行会被记成「已计量但 0 token」，使覆盖率虚高为 100%。
 */
function isMetered(r) {
  return numTok(r.totalTokens) != null || numTok(r.promptTokens) != null || numTok(r.completionTokens) != null;
}

/**
 * 计量值判定。
 *
 * 必须区分三种历史形态（2026-10-10 之前的日志三种都存在）：
 *   number  → 正常值
 *   "49569" → 数字字符串，值可完整还原（旧版写入文件的格式），应当接受
 *   "***"   → 被 sanitize 的 "token" 正则误脱敏，原值从未写入文件，不可还原
 *
 * 早先的实现一律拒绝字符串，把可还原的数字字符串也判成未计量，
 * 导致 2026-09 的 1053 行/日真实 token 被记作 0（覆盖率虚低、估算缺位）；
 * 而一律接受字符串时，`Number("***")` 为 NaN 又会让覆盖率虚高。
 * 故按「是否为纯数字」分流。
 */
function numTok(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

/** 该字段是否被历史脱敏破坏（值为 "***" 之类，不可还原）。 */
function isMasked(v) {
  return typeof v === 'string' && !/^\d+$/.test(v);
}

/** 该行的 token 数。未计量记 0；由调用方单独累计 metered 计数以作区分。 */
function tokensOf(r) {
  return numTok(r.totalTokens) ?? ((numTok(r.promptTokens) || 0) + (numTok(r.completionTokens) || 0));
}

/**
 * 该行的计费模型名。
 *
 * 必须优先取 pricedModel（日志侧按真实命中的上游模型写入）：
 * 虚拟模型 ID（vm/long-context）在费率表与标定表中都没有条目，用它查费率恒为 null。
 * 历史日志没有 pricedModel 时退回解析 routedTo，最后才用 model。
 */
function pricedModelOf(r) {
  if (typeof r.pricedModel === 'string' && r.pricedModel) return r.pricedModel;
  const rt = typeof r.routedTo === 'string' ? r.routedTo : '';
  if (rt) {
    // routedTo 形如 "trae/qwen3.8-flash@max" / "workbuddy/wb/space-bunny"，
    // 取最后一段作为模型名（provider 段可能自带斜杠）
    const seg = rt.split('/').filter(Boolean).pop();
    if (seg) return seg;
  }
  return r.model || '';
}

/**
 * 该行的积分估算。
 *
 * 一律按当前标定系数重算，不采信日志里固化的 estimatedCost。
 * 原因：2026-10-10 之前写入文件的值使用 tier 倍率口径（tier=5 → rate=1，
 * 即「1 积分/千 token」），而账单实测约 0.0103 积分/千 token——量纲差约 97 倍，
 * 实测 2026-09-27 单日固化值合计 241,539 积分，当日官方账单只有 1,976.61。
 *
 * 无 cacheRead 字段的历史行按「全部未缓存」计价，属于上界（高估），
 * 由返回值 upperBound 标记，界面据此提示估算偏保守。
 *
 * @returns {{cost:number, priced:boolean, upperBound:boolean}}
 *   priced=false 表示该行无可用 token，估算缺位（读作「不知道」而非 0）
 */
function costOf(r) {
  const c = estimateCost(pricedModelOf(r), r.promptTokens, r.completionTokens, {
    cacheRead: numTok(r.cacheReadTokens),
    platform: r.platform,
  });
  if (c == null) return { cost: 0, priced: false, upperBound: false };
  // 有 token 但缺缓存读信息 → 按全未缓存算，是上界
  const upperBound = numTok(r.cacheReadTokens) == null && (numTok(r.promptTokens) || 0) > 0;
  return { cost: c, priced: true, upperBound };
}

/**
 * 该行 token 的来源分类。
 *   exact     上游回传的真实 usage，可当账单口径
 *   estimated tiktoken 补算，数值但非账单口径，只作趋势
 *   none      完全没有 token（错误请求，或上游不带 usage 且补算未开）
 *
 * 三者必须分开：metered（有数值）把 exact 与 estimated 混在一起，
 * 前端若把 unmetered 读作补算数就是错的——unmetered 实际是 none。
 */
function tokenSource(r) {
  if (r.tokensEstimated === true) return 'estimated';
  if (isMetered(r)) return 'exact';
  return 'none';
}

/**
 * 按日聚合：requests / tokens / estimatedCost（含 per-model 拆分）。
 * tokens 只累加已计量请求；metered / unmetered 给出覆盖情况，
 * 避免把「未带回 usage」误读成「消耗 0 token」。
 *
 * 缓存读单列 cacheReadTokens：标定费率对未缓存输入与缓存读分别计价
 * （实测两者单价差 4~8 倍），界面需要它解释为何 20 万 token 只花 0.7 积分。
 * exact / estimated / none 三个来源分开计数，前端才能标出多少 token 是真值。
 */
/**
 * 逐日汇总「逻辑回合」口径。
 *
 * 一次客户端请求 = 一个回合同（`turnId`）；降级换候选会为同一次客户端请求
 * 产生**多行** traffic（每个候选一行）。只按行数算成功率会把「降级 3 次后成功」
 * 记成「3 次失败 + 1 次成功」——实测虚拟模型 22,890 成功 / 1,936 失败，
 * 该口径下成功率被低估的上界是 7.80%。
 *
 * 历史行没有 turnId：每行各自算一个回合（等价于「无降级的单次尝试」），
 * 这样旧数据仍有意义，且不需要 ?? 0 之类的兜底——「没测量」与「测得 0」
 * 在这里不会混淆，因为回合数就是行数。
 */
function turnBuckets() {
  return new Map();
}

/** 累计一行到回合桶。 */
function addTurn(buckets, r, fallbackKey) {
  const key = r.turnId != null ? String(r.turnId) : fallbackKey;
  let slot = buckets.get(key);
  if (!slot) {
    slot = { ok: 0, err: 0 };
    buckets.set(key, slot);
  }
  if (r.error || (r.status && r.status >= 400)) slot.err++;
  else slot.ok++;
}

/** 由回合桶得出三个计数：总回合 / 全败回合 / 失败后恢复的回合。 */
function turnCounters(buckets) {
  let turnsFailed = 0;
  let recoveredTurns = 0;
  for (const v of buckets.values()) {
    if (!v.ok) turnsFailed++;
    else if (v.err) recoveredTurns++;
  }
  return { turns: buckets.size, turnsFailed, recoveredTurns };
}

function dailyStats(lines) {
  const byDay = {};
  const turnsByDay = {};
  // 无 turnId 的历史行用它兜底成「一行一回合」；只需在单日内唯一
  let noTurnN = 0;
  for (const r of lines) {
    const day = r._day || String(r.ts || '').slice(0, 10);
    if (!byDay[day]) {
      byDay[day] = {
        date: day, requests: 0, errors: 0, tokens: 0, metered: 0,
        exact: 0, estimated: 0, none: 0, tokensLost: 0, priced: 0, costUpper: 0,
        estimatedCost: 0, cacheReadTokens: 0, byModel: {},
      };
      turnsByDay[day] = turnBuckets();
    }
    const d = byDay[day];
    addTurn(turnsByDay[day], r, `#noturn${noTurnN++}`);
    d.requests++;
    if (r.error || (r.status && r.status >= 400)) d.errors++;
    const src = tokenSource(r);
    d[src]++;
    if (src !== 'none') d.metered++;
    // token 字段被脱敏成 "***"：历史脱敏缺陷的痕迹，原值从未写入文件，不可还原。
    // 数字字符串（"49569"）可完整还原，numTok 已接受，不算丢失。
    if (isMasked(r.totalTokens) || isMasked(r.promptTokens)) d.tokensLost++;
    d.tokens += tokensOf(r);
    d.cacheReadTokens += numTok(r.cacheReadTokens) || 0;
    const c = costOf(r);
    if (c.priced) d.priced++;
    if (c.upperBound) d.costUpper++;
    d.estimatedCost += c.cost;
    const m = r.model || 'unknown';
    if (!d.byModel[m]) d.byModel[m] = { requests: 0, tokens: 0, metered: 0, estimatedCost: 0 };
    d.byModel[m].requests++;
    d.byModel[m].tokens += tokensOf(r);
    if (src !== 'none') d.byModel[m].metered++;
    d.byModel[m].estimatedCost += c.cost;
  }
  return Object.values(byDay)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((d) => ({
      ...d,
      ...turnCounters(turnsByDay[d.date] || turnBuckets()),
      unmetered: d.none,
      tokens: round2(d.tokens),
      cacheReadTokens: round2(d.cacheReadTokens),
      estimatedCost: round4(d.estimatedCost),
      // priced：能算出估算积分的行数。它小于请求数时，估算总量是下界，
      // 界面据此标注，避免把「算不出」读成「没消耗」。
      priced: d.priced,
      // costUpper：缺 cacheRead 信息、按「全未缓存」计价的行数（估算偏高的上界）
      costUpper: d.costUpper,
      byModel: Object.fromEntries(Object.entries(d.byModel).map(([k, v]) => [
        k,
        { requests: v.requests, tokens: round2(v.tokens), metered: v.metered, unmetered: v.requests - v.metered, estimatedCost: round4(v.estimatedCost) },
      ])),
    }));
}

/**
 * 按模型聚合：requests / tokens / avgDurationMs / estimatedCost。
 * tokenSum 为已计量合计；unmetered 单列，不并入 tokenSum。
 * 另计 cacheReadTokens（缓存读），供前端解释标定费率的分桶口径。
 */
function modelStats(lines) {
  const byModel = {};
  for (const r of lines) {
    const m = r.model || 'unknown';
    if (!byModel[m]) byModel[m] = { model: m, requests: 0, errors: 0, tokens: 0, metered: 0, estimated: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, estimatedCost: 0, durationSumMs: 0, durationCount: 0, toolCalls: 0 };
    const d = byModel[m];
    d.requests++;
    if (r.error || (r.status && r.status >= 400)) d.errors++;
    const pt = numTok(r.promptTokens) || 0;
    const ct = numTok(r.completionTokens) || 0;
    const src = tokenSource(r);
    if (src !== 'none') d.metered++;
    if (src === 'estimated') d.estimated++;
    d.promptTokens += pt;
    d.completionTokens += ct;
    d.tokens += tokensOf(r);
    d.cacheReadTokens += numTok(r.cacheReadTokens) || 0;
    d.estimatedCost += costOf(r).cost;
    d.toolCalls += Number(r.toolCalls) || 0;
    if (typeof r.durationMs === 'number') { d.durationSumMs += r.durationMs; d.durationCount++; }
  }
  return Object.values(byModel)
    .map((d) => ({
      model: d.model,
      requests: d.requests,
      errors: d.errors,
      tokens: round2(d.tokens),
      metered: d.metered,
      unmetered: d.requests - d.metered,
      estimated: d.estimated,
      promptTokens: round2(d.promptTokens),
      completionTokens: round2(d.completionTokens),
      cacheReadTokens: round2(d.cacheReadTokens),
      estimatedCost: round4(d.estimatedCost),
      avgDurationMs: d.durationCount ? Math.round(d.durationSumMs / d.durationCount) : null,
      toolCalls: d.toolCalls,
    }))
    .sort((a, b) => b.requests - a.requests);
}

/** 按账号聚合：requests / tokens / estimatedCost / errorRate。tokenShare 基于已计量总量。 */
function accountStats(lines) {
  const byAccount = {};
  let tokensAll = 0;
  for (const r of lines) if (isMetered(r)) tokensAll += tokensOf(r);
  for (const r of lines) {
    const a = r.account || 'unknown';
    if (!byAccount[a]) byAccount[a] = { accountId: a, requests: 0, errors: 0, tokens: 0, metered: 0, estimatedCost: 0 };
    const d = byAccount[a];
    d.requests++;
    if (r.error || (r.status && r.status >= 400)) d.errors++;
    if (isMetered(r)) d.metered++;
    d.tokens += tokensOf(r);
    d.estimatedCost += costOf(r).cost;
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

module.exports = {
  readTrafficLines, dailyStats, modelStats, accountStats,
  isMetered, numTok, isMasked, pricedModelOf, tokenSource, costOf,
  // 逻辑回合聚合（stats-cache 复用同一实现，避免两处口径漂移）
  turnBuckets, addTurn, turnCounters,
};
