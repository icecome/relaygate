'use strict';
/**
 * log/stats.js — 流量日志多维统计聚合（从 traffic.jsonl 计算）。
 * 提供 daily / models / accounts 三维聚合，供 /v1/admin/stats/* 使用。
 * 费用估算复用 models/rates.estimateCost（无费率时估算为 null，聚合为 0）。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { estimateCost } = require('../models/rates');

/** 读取最近 N 天的 traffic.jsonl 行（按日期从新到旧合并，便于分页场景优先命中近期数据）。 */
function readTrafficLines(days) {
  const rows = [];
  const base = path.join(config.ROOT, 'logs');
  for (let d = 0; d < days; d++) {
    const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
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
    // 单日内按时间倒序（jsonl 追加序即时间升序，反转后与跨日的新→旧一致）
    rows.push(...dayRows.reverse());
  }
  return rows;
}

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function round4(n) {
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0;
}

/** 该行是否带回上游 usage。Trae 平台多数请求带，WorkBuddy 平台目前全部不带。 */
function isMetered(r) {
  return r.totalTokens != null || r.promptTokens != null || r.completionTokens != null;
}

/** 该行的 token 数。未计量记 0，同时由调用方单独累计 metered 计数以便区分。 */
function tokensOf(r) {
  return Number(r.totalTokens) || (Number(r.promptTokens) || 0) + (Number(r.completionTokens) || 0);
}

function costOf(r) {
  if (typeof r.estimatedCost === 'number') return r.estimatedCost;
  const c = estimateCost(r.model, r.promptTokens, r.completionTokens);
  return c != null ? c : 0;
}

/**
 * 按日聚合：requests / tokens / estimatedCost（含 per-model 拆分）。
 * tokens 只累加已计量请求；metered / unmetered 给出覆盖情况，
 * 避免把「未带回 usage」误读成「消耗 0 token」。
 */
function dailyStats(lines) {
  const byDay = {};
  for (const r of lines) {
    const day = r._day || String(r.ts || '').slice(0, 10);
    if (!byDay[day]) byDay[day] = { date: day, requests: 0, errors: 0, tokens: 0, metered: 0, estimatedCost: 0, byModel: {} };
    const d = byDay[day];
    d.requests++;
    if (r.error || (r.status && r.status >= 400)) d.errors++;
    const metered = isMetered(r);
    const tok = tokensOf(r);
    if (metered) d.metered++;
    d.tokens += tok;
    d.estimatedCost += costOf(r);
    const m = r.model || 'unknown';
    if (!d.byModel[m]) d.byModel[m] = { requests: 0, tokens: 0, metered: 0, estimatedCost: 0 };
    d.byModel[m].requests++;
    d.byModel[m].tokens += tok;
    if (metered) d.byModel[m].metered++;
    d.byModel[m].estimatedCost += costOf(r);
  }
  return Object.values(byDay)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((d) => ({
      ...d,
      unmetered: d.requests - d.metered,
      tokens: round2(d.tokens),
      estimatedCost: round4(d.estimatedCost),
      byModel: Object.fromEntries(Object.entries(d.byModel).map(([k, v]) => [
        k,
        { requests: v.requests, tokens: round2(v.tokens), metered: v.metered, unmetered: v.requests - v.metered, estimatedCost: round4(v.estimatedCost) },
      ])),
    }));
}

/**
 * 按模型聚合：requests / tokens / avgDurationMs / estimatedCost。
 * tokenSum 为已计量合计；unmetered 单列，不并入 tokenSum。
 */
function modelStats(lines) {
  const byModel = {};
  for (const r of lines) {
    const m = r.model || 'unknown';
    if (!byModel[m]) byModel[m] = { model: m, requests: 0, errors: 0, tokens: 0, metered: 0, promptTokens: 0, completionTokens: 0, estimatedCost: 0, durationSumMs: 0, durationCount: 0, toolCalls: 0 };
    const d = byModel[m];
    d.requests++;
    if (r.error || (r.status && r.status >= 400)) d.errors++;
    const pt = Number(r.promptTokens) || 0;
    const ct = Number(r.completionTokens) || 0;
    if (isMetered(r)) d.metered++;
    d.promptTokens += pt;
    d.completionTokens += ct;
    d.tokens += tokensOf(r);
    d.estimatedCost += costOf(r);
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
      promptTokens: round2(d.promptTokens),
      completionTokens: round2(d.completionTokens),
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
    d.estimatedCost += costOf(r);
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

module.exports = { readTrafficLines, dailyStats, modelStats, accountStats, isMetered };
