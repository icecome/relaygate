'use strict';
/**
 * routes/admin-traffic.js —— 流量日志与用量统计端点。
 * 挂载前缀：/v1/admin（见 index.js）。
 *
 * 数据源口径（界面上并列展示、不混算）：
 *   /traffic、/stats/daily|models|accounts —— 网关转发侧，读 logs/<date>/traffic.jsonl
 *   /stats/client —— 客户端侧，读 %USERPROFILE%\.workbuddy\projects 下的 jsonl
 *   /stats/official-usage —— 官方账单接口，精确积分（仅 WorkBuddy 账号）
 */
const { Router } = require('express');
const { authenticateAdmin } = require('../middleware/auth');
const { localDateKey } = require('../lib/util');
const { readTrafficLines, dailyStats, modelStats, accountStats, numTok, isMasked } = require('../log/stats');
const { loadRateMap } = require('../models/rates');
const bu = require('../workbuddy/billing-usage');
const tu = require('../upstream/trae-usage');
const credStore = require('../credentials/store');

const router = Router();
const admin = (req, res, next) => authenticateAdmin(req, res, next);

/** 缓存开关：STATS_CACHE=off 时回退原全量扫描路径。 */
const statsCacheEnabled = () => process.env.STATS_CACHE !== 'off';

/**
 * 统计端点的最大查询窗口（天）。
 *
 * 面板的日历热力图固定看 17 周 = 119 天，向上取整到 180 天留出余量；
 * 原先的 90 天上限会让热力图取不满 17 列。窗口上限只是防御性护栏
 * （避免有人传 days=100000 逐日扫盘），不是产品限制。
 */
const MAX_STATS_DAYS = 180;

/** 流量日志（读 logs/YYYY-MM-DD/traffic.jsonl）；page/page_size 开启分页，缺省保持旧行为。 */
router.get('/traffic', admin, (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days || '1', 10) || 1, 1), 7);
  const account = req.query.account ? String(req.query.account) : null;
  const status = req.query.status ? String(req.query.status) : null;
  const model = req.query.model ? String(req.query.model) : null;

  // 复用 stats.readTrafficLines（已按新到旧合并），避免内联重复读文件逻辑
  const lines = readTrafficLines(days);

  let rows = lines;
  if (account) rows = rows.filter((r) => r.account === account);
  if (model) rows = rows.filter((r) => (r.model || 'unknown') === model);
  if (status) {
    rows = rows.filter((r) => {
      if (status === 'error') return !!r.error || (r.status && r.status >= 400);
      return String(r.status) === status;
    });
  }
  rows.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));

  const total = rows.length;
  const paged = req.query.page != null || req.query.page_size != null;
  let data;
  let page = 1;
  let pageSize = total;
  let totalPages = 1;
  if (paged) {
    pageSize = Math.min(Math.max(parseInt(req.query.page_size || '50', 10) || 50, 1), 200);
    totalPages = Math.max(1, Math.ceil(total / pageSize));
    page = Math.min(Math.max(parseInt(req.query.page || '1', 10) || 1, 1), totalPages);
    data = rows.slice((page - 1) * pageSize, page * pageSize);
  } else {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10) || 200, 1), 1000);
    data = rows.slice(0, limit);
  }

  const byModel = {};
  const byAccount = {};
  const byStatus = {};
  let tokensTotal = 0;
  let tokensMasked = 0;
  for (const r of lines) {
    const m = r.model || 'unknown';
    byModel[m] = (byModel[m] || 0) + 1;
    const a = r.account || 'unknown';
    byAccount[a] = (byAccount[a] || 0) + 1;
    const s = r.error ? 'error' : String(r.status || 'ok');
    byStatus[s] = (byStatus[s] || 0) + 1;
    // 只累加可还原的数值（含数字字符串）：被脱敏成星号掩码的行无法还原，
    // 单列 tokensMasked 计数，界面据此提示「总量是下界」
    const t = numTok(r.totalTokens);
    if (t != null) tokensTotal += t;
    else if (isMasked(r.totalTokens)) tokensMasked++;
  }

  res.json({
    object: 'list',
    totalScan: lines.length,
    returned: data.length,
    total,
    page,
    pageSize,
    totalPages,
    summary: {
      byModel, byAccount, byStatus, tokens: tokensTotal,
      // 被历史脱敏破坏、无法还原 token 的行数：界面据此提示「总量偏小」
      tokensMasked,
    },
    data,
  });
});

/** 积分快照历史（usedTotal 增量为主口径，remainingDelta 受包到期污染仅作对照）。 */
router.get('/credit-history', admin, (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days || '1', 10) || 1, 1), 30);
  const data = require('../credentials/credit-history').summary(days);
  const sumBy = (k) => data.reduce((s, d) => s + (d[k] || 0), 0);
  res.json({
    object: 'list',
    days,
    // usedTotal：上游 consumed_amount 增量，主口径（与官方账单基本吻合）
    totalUsed: Math.round(sumBy('usedTotal') * 100) / 100,
    // remainingDelta：剩余下降量，含权益包到期作废，仅作对照
    remainingDelta: Math.round(sumBy('remainingDelta') * 100) / 100,
    data,
  });
});

/**
 * 按日聚合：requests / tokens / estimatedCost（含 per-model 拆分）。
 *
 * 额外合入官方账单的按日积分（officialCredit），让「网关计量」与「上游账单」
 * 在同一行对照——历史日期网关侧 token 因脱敏缺陷丢失时，账单侧仍是完整真值。
 */
router.get('/stats/daily', admin, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), MAX_STATS_DAYS);
    await loadRateMap();
    const data = statsCacheEnabled()
      ? require('../log/stats-cache').cachedDailyStats(days)
      : dailyStats(readTrafficLines(days));
    const totalRequests = data.reduce((s, d) => s + d.requests, 0);
    // 逻辑回合汇总：一次客户端请求 = 一个回合；降级换候选会给同一回合写多行。
    // 按行算成功率会把「降级后成功」记成失败，故单独给出回合口径。
    const turns = data.reduce((s, d) => ({
      turns: s.turns + (d.turns || 0),
      turnsFailed: s.turnsFailed + (d.turnsFailed || 0),
      recoveredTurns: s.recoveredTurns + (d.recoveredTurns || 0),
    }), { turns: 0, turnsFailed: 0, recoveredTurns: 0 });

    // 官方账单按日积分（读本地缓存，不打上游）
    let official = null;
    try {
      const od = require('../models/official-daily').dailyCredits(days);
      const map = new Map(od.byDay.map((x) => [x.date, x]));
      official = {
        traeCreditTotal: od.traeCreditTotal,
        wbCreditTotal: od.wbCreditTotal,
        totalCredit: Math.round((od.traeCreditTotal + od.wbCreditTotal) * 100) / 100,
      };
      for (const d of data) {
        const o = map.get(d.date);
        if (!o) continue;
        d.officialCredit = o.totalCredit;
        d.officialTraeCredit = o.traeCredit;
        d.officialWbCredit = o.wbCredit;
        d.officialTokens = o.traeTokens; // 仅 Trae 账单带 token
        d.officialSessions = o.traeSessions;
        d.officialRequests = o.wbRequests;
        d.officialCovered = o.covered;
      }
    } catch { /* 账单聚合失败不影响网关口径 */ }

    res.json({ object: 'list', days, totalRequests, turns, data, official, cached: statsCacheEnabled() });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 按模型聚合：requests / tokens / avgDurationMs / estimatedCost。 */
router.get('/stats/models', admin, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '7', 10) || 7, 1), MAX_STATS_DAYS);
    await loadRateMap();
    if (statsCacheEnabled()) {
      const { cachedModelStats } = require('../log/stats-cache');
      const data = cachedModelStats(days);
      const totalRequests = data.reduce((s, d) => s + d.requests, 0);
      return res.json({ object: 'list', days, totalRequests, data, cached: true });
    }
    const lines = readTrafficLines(days);
    const data = modelStats(lines);
    res.json({ object: 'list', days, totalRequests: lines.length, data });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 按账号聚合：requests / tokens / estimatedCost / errorRate。 */
router.get('/stats/accounts', admin, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '7', 10) || 7, 1), MAX_STATS_DAYS);
    await loadRateMap();
    if (statsCacheEnabled()) {
      const { cachedAccountStats } = require('../log/stats-cache');
      const data = cachedAccountStats(days);
      const totalRequests = data.reduce((s, d) => s + d.requests, 0);
      return res.json({ object: 'list', days, totalRequests, data, cached: true });
    }
    const lines = readTrafficLines(days);
    const data = accountStats(lines);
    res.json({ object: 'list', days, totalRequests: lines.length, data });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 统计缓存状态与清空（运维）。 */
router.get('/stats/cache', admin, (req, res) => {
  const sc = require('../log/stats-cache');
  res.json({ object: 'stats_cache', enabled: statsCacheEnabled(), dir: sc.CACHE_DIR() });
});

/**
 * 积分/token 标定系数（官方账单回归结果）。
 * 每模型给出 uncached/output/cacheRead 三个「积分/token」系数与拟合质量
 * （n 为样本数，R²=1 表示逐会话账单可被三系数精确还原），面板据此展示
 * 「估算积分」的可信度；系数为 null 的模型按 tier 倍率口径计算。
 */
router.get('/stats/pricing-calibration', admin, (req, res) => {
  const pc = require('../models/pricing-calib');
  if (req.query.refresh === '1') pc.clearCache();
  res.json({
    object: 'pricing_calibration',
    ...pc.snapshot(),
    // 换算比：账单实测的「积分 ↔ token」均值（无账单数据时为 null）
    ratio: pc.summarizeRatio(),
  });
});

router.post('/stats/pricing-calibration/clear', admin, (req, res) => {
  const pc = require('../models/pricing-calib');
  pc.clearCache();
  res.json({ ok: true });
});

router.post('/stats/cache/clear', admin, (req, res) => {
  const sc = require('../log/stats-cache');
  res.json({ ok: sc.clearCache() });
});

/** 客户端消耗（WorkBuddy 本机会话日志）。 */
router.get('/stats/client', admin, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 400);
    const force = req.query.force === '1';
    const cl = require('../log/client-logs');
    const r = cl.scan({ force });

    // 按日窗口裁剪（客户端日志保留全部历史，前端只看最近 days 天）。
    // 用日历减法取本地日期，不能用固定 24h 平移（夏令时切换日会错位一天）。
    const now = new Date();
    const cutoffKey = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)));
    const byDay = r.byDay.filter((d) => d.date >= cutoffKey);

    // 模型明细同样按窗口重算：桶里的 byModel 是全量，不能直接截断
    const byModel = {};
    for (const d of byDay) {
      for (const [m, v] of Object.entries(d.byModel || {})) {
        const t = byModel[m] || (byModel[m] = { model: m, requests: 0, tokens: 0, credit: 0 });
        t.requests += v.requests;
        t.tokens += v.tokens;
        t.credit += Number(v.credit) || 0;
      }
    }
    const models = Object.values(byModel)
      .map((m) => ({ ...m, credit: Math.round(m.credit * 100) / 100 }))
      .sort((a, b) => b.tokens - a.tokens);

    const totals = byDay.reduce((s, d) => ({
      requests: s.requests + d.requests,
      tokens: s.tokens + d.tokens,
      input: s.input + d.input,
      output: s.output + d.output,
      cacheRead: s.cacheRead + d.cacheRead,
      credit: s.credit + d.credit,
    }), { requests: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, credit: 0 });

    res.json({
      object: 'client_stats',
      available: r.available,
      reason: r.reason || null,
      root: r.root,
      days,
      files: r.files,
      cachedFiles: r.cachedFiles,
      parsedFiles: r.parsedFiles,
      // 客户端日志无账号标识，只能给全局汇总，不做账号归因
      scope: 'local-device',
      totals: {
        requests: totals.requests,
        tokens: totals.tokens,
        input: totals.input,
        output: totals.output,
        cacheRead: totals.cacheRead,
        cacheHitRate: totals.input ? Math.round((totals.cacheRead / totals.input) * 10000) / 10000 : 0,
        credit: Math.round(totals.credit * 100) / 100,
      },
      data: byDay,
      models,
    });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 客户端日志解析缓存清空（口径变更或排查用）。 */
router.post('/stats/client/cache/clear', admin, (req, res) => {
  const cl = require('../log/client-logs');
  res.json({ ok: cl.clearCache(), dir: cl.CACHE_DIR() });
});

/** 官方账单（精确积分）：WorkBuddy 逐请求 + Trae 逐会话，双平台汇总。 */
router.get('/stats/official-usage', admin, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 90);
    const accountId = req.query.account ? String(req.query.account) : null;

    let wb;
    let trae;
    if (accountId) {
      const acct = credStore.get(accountId);
      if (!acct) return res.status(404).json({ error: { message: `account not found: ${accountId}`, type: 'invalid_request_error' } });
      // 显式平台分流（isEdition 不做回退匹配）：ZCode 等新平台两侧账单都不适用，
      // 返回空集合而不是误投给 Trae/WB 的账单端点
      const variant = require('../platform/variant');
      const isWb = variant.isEdition(acct.edition, variant.WORKBUDDY);
      const isTrae = variant.isEdition(acct.edition, variant.TRAE);
      const one = isWb ? await bu.scanAccount(accountId, days)
        : isTrae ? await tu.scanAccount(accountId, days)
          : { accountId, label: acct.label || accountId, days, available: false, credit: 0, requests: 0, tokens: 0, byDay: [], byModel: [], unavailableReason: '平台不提供官方账单' };
      wb = isWb ? { accounts: [one] } : { accounts: [] };
      trae = isTrae ? { accounts: [one] } : { accounts: [] };
    } else {
      [wb, trae] = await Promise.all([bu.scanAll(days), tu.scanAll(days)]);
    }
    const accounts = [
      ...wb.accounts.map((a) => ({ ...a, platform: 'workbuddy', granularity: 'request' })),
      ...trae.accounts.map((a) => ({ ...a, platform: 'trae', granularity: 'session' })),
    ];
    res.json({ object: 'official_usage', days, accounts });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

router.post('/stats/official-usage/cache/clear', admin, (req, res) => {
  const okWb = bu.clearCache();
  const okTrae = tu.clearCache();
  // 分端返回各自结果：ok 仅在两端都成功时为 true，
  // workbuddy/trae 字段让调用方能区分「全失败」与「部分失败」。
  res.json({
    ok: okWb && okTrae,
    workbuddy: okWb,
    trae: okTrae,
    dir: bu.cacheDir(),
    traeDir: tu.cacheDir(),
  });
});

module.exports = router;