'use strict';
/**
 * routes/admin-extras.js — 面板运维扩展端点。
 * 挂载前缀：/v1/admin（见 index.js）。
 */
const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const pool = require('../credentials/pool');
const scheduler = require('../jobs/scheduler');
const sticky = require('../session/sticky');
const { authenticateAdmin } = require('../middleware/auth');
const { explainCandidates } = require('../credentials/pool');
const { notifyDetail, enabled: notifyEnabled } = require('../notify');
const { readTrafficLines, dailyStats, modelStats, accountStats } = require('../log/stats');
const { loadRateMap, estimateCost } = require('../models/rates');

const router = Router();
const admin = (req, res, next) => authenticateAdmin(req, res, next);

/** Route Check：不发真实请求，解释当前调度候选。 */
router.get('/route-check', admin, (req, res) => {
  const exclude = req.query.exclude ? String(req.query.exclude).split(',') : [];
  const candidates = explainCandidates(exclude);
  const usable = candidates.filter((c) => c.usable)
    .sort((a, b) => (b.priority - a.priority) || ((b.balance || -1) - (a.balance || -1)));
  res.json({
    object: 'route_check',
    strategy: config.poolStrategy,
    maxInFlightPerAccount: config.maxInFlightPerAccount,
    minBalanceToUse: config.minBalanceToUse,
    wouldPick: usable[0] || null,
    usableCount: usable.length,
    candidates,
    generatedAt: new Date().toISOString(),
  });
});

/** 当前粘性会话（脱敏）。 */
router.get('/sticky', admin, (req, res) => {
  res.json({ object: 'list', data: sticky.listSafe(), ttlMs: sticky.TTL_MS });
});

/** 流量日志（读 logs/YYYY-MM-DD/traffic.jsonl）；page/page_size 开启分页，缺省保持旧行为。 */
router.get('/traffic', admin, (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days || '1', 10) || 1, 1), 7);
  const account = req.query.account ? String(req.query.account) : null;
  const status = req.query.status ? String(req.query.status) : null;

  // 复用 stats.readTrafficLines（已按新→旧合并），避免内联重复读文件逻辑
  const lines = readTrafficLines(days);

  let rows = lines;
  if (account) rows = rows.filter((r) => r.account === account);
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
  for (const r of lines) {
    const m = r.model || 'unknown';
    byModel[m] = (byModel[m] || 0) + 1;
    const a = r.account || 'unknown';
    byAccount[a] = (byAccount[a] || 0) + 1;
    const s = r.error ? 'error' : String(r.status || 'ok');
    byStatus[s] = (byStatus[s] || 0) + 1;
    tokensTotal += Number(r.totalTokens) || 0;
  }

  res.json({
    object: 'list',
    totalScan: lines.length,
    returned: data.length,
    total,
    page,
    pageSize,
    totalPages,
    summary: { byModel, byAccount, byStatus, tokens: tokensTotal },
    data,
  });
});

/** 积分快照历史（差分统计各账号消耗，仅 Admin）。 */
router.get('/credit-history', admin, (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days || '1', 10) || 1, 1), 30);
  const data = require('../credentials/credit-history').summary(days);
  const totalUsed = data.reduce((s, d) => s + (d.todayUsed || 0), 0);
  res.json({
    object: 'list',
    days,
    totalUsed: Math.round(totalUsed * 100) / 100,
    data,
  });
});

/** 导出账号备份（含密文 token，仅 Admin）。 */
router.get('/credentials/export', admin, (req, res) => {
  try {
    const rows = require('../credentials/db').db()
      .prepare('SELECT * FROM accounts')
      .all();
    const payload = {
      object: 'trae_relay_export',
      version: 1,
      exportedAt: new Date().toISOString(),
      accounts: rows.map((r) => ({
        id: r.id,
        label: r.label,
        edition: r.edition,
        token_enc: r.token_enc,
        refresh_token_enc: r.refresh_token_enc,
        expired_at: r.expired_at,
        refresh_expired_at: r.refresh_expired_at,
        token_release_at: r.token_release_at,
        user_id: r.user_id,
        host: r.host,
        user_region: r.user_region,
        devices: r.devices ? JSON.parse(r.devices) : null,
        source: r.source,
        enabled: !!r.enabled,
        balance: r.balance,
        error_count: r.error_count,
        cool_until: r.cool_until,
        last_picked_at: r.last_picked_at,
        last_checkin_at: r.last_checkin_at,
        last_checkin_result: r.last_checkin_result,
        entitlement_snapshot: r.entitlement_snapshot,
        priority: r.priority || 0,
        tags: r.tags ? JSON.parse(r.tags) : null,
      })),
    };
    const filename = `relay-gate-export-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 客户端接入配置生成（不含真实密钥明文）。 */
router.get('/client-config', admin, (req, res) => {
  const proto = req.protocol || 'http';
  const host = req.get('host') || `localhost:${config.port}`;
  const baseUrl = `${proto}://${host}`;
  res.json({
    object: 'client_config',
    baseUrl,
    openai: {
      OPENAI_BASE_URL: `${baseUrl}/v1`,
      OPENAI_API_KEY: '<你的 API_KEY>',
      curl: `curl ${baseUrl}/v1/chat/completions -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d '{"model":"auto","messages":[{"role":"user","content":"hi"}],"stream":true}'`,
    },
    anthropic: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: '<你的 API_KEY>',
      curl: `curl ${baseUrl}/v1/messages -H "x-api-key: $API_KEY" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" -d '{"model":"auto","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'`,
    },
    codex: {
      base_url: `${baseUrl}/v1/responses`,
      note: 'Responses 协议最小兼容；复杂事件族可能不完整',
    },
    notes: [
      '转发面使用 API_KEY；管理面板使用 ADMIN_KEY（若已分离）。',
      '默认仅监听 127.0.0.1；跨机请 SSH 隧道或自配 HOST + 防火墙。',
      'SSE 场景请关闭反代缓冲：proxy_buffering off; proxy_read_timeout 600s;',
      '流式一旦开始输出，不在中途切换账号重试。',
    ],
  });
});

/** 通知渠道配置（读写本机 notify-settings.json；env 作兜底）。 */
router.get('/notify/settings', admin, (req, res) => {
  res.json({ object: 'notify_settings', ...require('../notify/settings').getEffective() });
});

router.post('/notify/settings', admin, (req, res) => {
  try {
    const effective = require('../notify/settings').save(req.body || {});
    res.json({ object: 'notify_settings', ...effective });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 通知测试（返回逐渠道结果；绕过去重，可反复点）。 */
router.post('/notify/test', admin, async (req, res) => {
  try {
    const r = await notifyDetail('scheduler_error', {
      message: 'test notification from dashboard',
    }, '通知测试', { force: true });
    res.json({ ok: r.delivered, enabled: r.enabled, results: r.results });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 手动触发定时任务（立即签到/保活/刷余额）。 */
router.post('/scheduler/:action', admin, async (req, res) => {
  const action = req.params.action;
  try {
    if (action === 'checkin') {
      const r = await scheduler.runDailyCheckin();
      return res.json({ action, ...r });
    }
    if (action === 'keepalive') {
      await scheduler.runKeepalive();
      return res.json({ action, ok: true, ...scheduler.snapshot() });
    }
    if (action === 'balance') {
      // 手动触发不参与确定性错峰（用户期望立即执行）
      const r = await require('../upstream/balance').refreshBalanceAllEnabled({ spreadMinutes: 0 });
      for (const item of r.ok || []) pool.unfreezeIfHealthy(item.accountId);
      try {
        await require('../jobs/credit-alerts').checkCreditAlerts();
      } catch { /* 告警失败不影响余额结果 */ }
      return res.json({ action, ...r });
    }
    if (action === 'probe') {
      const r = await scheduler.runModelProbe();
      return res.json({ action, ...r });
    }
    return res.status(400).json({ error: { message: 'unknown action', type: 'invalid_request_error' } });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 定时任务可调配置（签到/保活/扫描/探活/成长中心轮询）。 */
router.get('/scheduler-settings', admin, (req, res) => {
  const ss = require('../jobs/scheduler-settings');
  res.json({ object: 'scheduler_settings', ...ss.getEffective(), schedulerEnabled: config.schedulerEnabled });
});

router.post('/scheduler-settings', admin, (req, res) => {
  try {
    const ss = require('../jobs/scheduler-settings');
    const effective = ss.save(req.body || {});
    const snap = scheduler.restart();
    res.json({ object: 'scheduler_settings', ...effective, schedulerEnabled: config.schedulerEnabled, scheduler: snap });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

// ===== 任务执行日志 =====

/** 读取任务执行日志（可按 task 过滤）。 */
router.get('/task-log', admin, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 500);
  const task = req.query.task ? String(req.query.task) : null;
  res.json({ object: 'task_log', data: require('../jobs/task-log').readTaskLog(limit, task) });
});

router.post('/task-log/clear', admin, (req, res) => {
  const ok = require('../jobs/task-log').clearTaskLog();
  res.json({ ok });
});

// ===== 余额自动刷新（可配间隔） =====

router.get('/balance-refresh', admin, (req, res) => {
  res.json({ object: 'balance_refresh', ...require('../jobs/balance-refresh').snapshot() });
});

router.post('/balance-refresh', admin, (req, res) => {
  try {
    const br = require('../jobs/balance-refresh');
    const eff = br.save(req.body || {});
    br.restart();
    res.json({ object: 'balance_refresh', ...eff, ...br.snapshot() });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

router.post('/balance-refresh/run', admin, async (req, res) => {
  try {
    const r = await require('../jobs/balance-refresh').runRefresh({ trigger: 'manual' });
    res.json({ object: 'balance_refresh_run', ...r });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

// ===== 全量备份 =====

router.get('/backup', admin, (req, res) => {
  const bk = require('../jobs/backup');
  res.json({ object: 'backup', ...bk.snapshot(), list: bk.listBackups() });
});

router.post('/backup', admin, (req, res) => {
  try {
    const bk = require('../jobs/backup');
    const eff = bk.save(req.body || {});
    bk.restart();
    res.json({ object: 'backup', ...eff, ...bk.snapshot(), list: bk.listBackups() });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 立即执行备份（可选 onProgress 逐阶段回调经 SSE 推送；此处返回完成结果）。 */
router.post('/backup/run', admin, async (req, res) => {
  try {
    const bk = require('../jobs/backup');
    const r = await bk.runBackup({ trigger: 'manual' });
    res.json({ object: 'backup_run', ...r, list: bk.listBackups() });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

router.post('/backup/verify', admin, (req, res) => {
  try {
    const p = String((req.body && req.body.path) || (req.query && req.query.path) || '');
    if (!p) return res.status(400).json({ error: { message: 'path required', type: 'invalid_request_error' } });
    res.json({ ok: true, ...require('../jobs/backup').verifyBackup(p) });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

// ===== 通知事件自定义（增/删） =====

router.get('/notify/events', admin, (req, res) => {
  const s = require('../notify/settings');
  const eff = s.getEffective();
  const keyed = Object.entries(eff.events || {}).map(([id, enabled]) => ({ id, enabled: enabled !== false }));
  res.json({ object: 'notify_events', builtin: s.EVENTS, data: keyed });
});

router.post('/notify/events', admin, (req, res) => {
  try {
    const s = require('../notify/settings');
    const id = String((req.body || {}).event || '').trim();
    const enabled = req.body?.enabled !== false;
    if (!s.addEvent(id, enabled)) {
      return res.status(400).json({ error: { message: '事件名仅允许小写字母/数字/下划线（以字母开头），长度 ≤64', type: 'invalid_request_error' } });
    }
    res.json({ ok: true, event: { id, enabled } });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 删除自定义事件（内置事件不可删）。 */
router.post('/notify/events/remove', admin, (req, res) => {
  try {
    const s = require('../notify/settings');
    const id = String((req.body || {}).event || '').trim();
    if (!id) return res.status(400).json({ error: { message: 'event required', type: 'invalid_request_error' } });
    if (s.EVENTS.includes(id)) {
      return res.status(400).json({ error: { message: '内置事件不可删除，可关闭', type: 'invalid_request_error' } });
    }
    const removed = s.removeEvent(id);
    res.json({ ok: removed, removed });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

// ===== 多账号活跃度维护（账号轮换）=====
router.get('/rotate/status', admin, async (req, res) => {
  try {
    const rotate = require('../jobs/rotate-accounts');
    const [status, accounts, st] = await Promise.all([
      rotate.checkStatus(),
      Promise.resolve(rotate.discoverAccounts()),
      Promise.resolve(rotate.readState()),
    ]);
    res.json({
      object: 'rotate_status',
      currentUid: rotate.currentUid(),
      authDir: rotate.resolveAuthDir(),
      accounts: accounts.map((a) => ({ uid: a.uid, label: a.label, backup: a.backup })),
      heatmap: status,
      lastRotateAt: st.lastRotateAt || null,
      lastRotateOk: st.lastRotateOk ?? null,
      lastRotateFailed: st.lastRotateFailed ?? null,
      scheduler: scheduler.snapshot(),
      settings: require('../jobs/rotate-settings').getEffective(),
    });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

router.post('/rotate/run', admin, async (req, res) => {
  try {
    const rotate = require('../jobs/rotate-accounts');
    // 无备份时先种入账号库备份，再执行轮换（一键免手动登录）
    const seed = rotate.seedAll();
    const r = await scheduler.runRotateAccounts();
    res.json({ object: 'rotate_run', ...r, seeded: seed });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 从账号库生成 auth 备份种子（免手动登录客户端）。 */
router.post('/rotate/seed', admin, (req, res) => {
  try {
    const rotate = require('../jobs/rotate-accounts');
    const seed = rotate.seedAll();
    res.json({ object: 'rotate_seed', ...seed });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

router.post('/rotate/switch', admin, async (req, res) => {
  try {
    const rotate = require('../jobs/rotate-accounts');
    const uid = String((req.body && req.body.uid) || '').trim();
    if (!uid) return res.status(400).json({ error: { message: 'uid required', type: 'invalid_request_error' } });
    const r = await rotate.switchAccount(uid);
    if (!r.ok && r.msg && /未找到/i.test(r.msg)) return res.status(404).json({ error: { message: r.msg, type: 'not_found' } });
    res.json({ object: 'rotate_switch', ok: r.ok, uid: r.uid || uid, label: r.label || uid, msg: r.msg });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 账号自动切换配置（读写 + 热重载重排轮换定时器）。 */
router.get('/rotate/settings', admin, (req, res) => {
  res.json({ object: 'rotate_settings', ...require('../jobs/rotate-settings').getEffective() });
});

router.post('/rotate/settings', admin, (req, res) => {
  try {
    const rs = require('../jobs/rotate-settings');
    const eff = rs.save(req.body || {});
    const snap = scheduler.restartRotate();
    res.json({ object: 'rotate_settings', ...eff, scheduler: snap });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 运行状态增强（粘性明细 + 池快照）。 */
router.get('/runtime', admin, (req, res) => {
  res.json({
    object: 'runtime',
    status: require('./status').buildStatus(),
    sticky: sticky.listSafe(),
    pool: pool.snapshot(),
    scheduler: scheduler.snapshot(),
    notify: { enabled: notifyEnabled() },
    keys: {
      adminSeparated: config.adminKey !== config.apiKey,
    },
  });
});

/** 模型探活：最小请求打上游（真实调用）。 */
router.post('/models/probe', admin, async (req, res) => {
  const model = String((req.body && req.body.model) || req.query.model || '').trim();
  if (!model) {
    return res.status(400).json({ error: { message: 'model required', type: 'invalid_request_error' } });
  }
  const { llmUtilsChat } = require('../upstream/client');
  const { normalizeTraeMessages } = require('../transform/request');
  const startedAt = Date.now();
  try {
    const { result, accountId } = await pool.run((accountId) =>
      llmUtilsChat(
        normalizeTraeMessages([{ role: 'user', content: 'ping' }]),
        model, false, { accountId },
      ), { maxSwitches: 1 });
    if (model !== 'auto') require('../models/availability').markUsable(model);
    res.json({
      ok: true,
      model,
      accountId,
      durationMs: Date.now() - startedAt,
      hasBody: !!(result && (result.data || result.body)),
    });
  } catch (err) {
    if (model !== 'auto') {
      const { isModelConfigError, isPlanLimitError } = require('../upstream/errors');
      if (isModelConfigError(err) || isPlanLimitError(err)) {
        require('../models/availability').markUnavailable(model, err.message);
      }
    }
    res.status(502).json({
      ok: false,
      model,
      message: err.message,
      durationMs: Date.now() - startedAt,
    });
  }
});

/** ===== T1 用量统计多维看板 ===== */
/** 缓存开关：STATS_CACHE=off 时回退原全量扫描路径。 */
const statsCacheEnabled = () => process.env.STATS_CACHE !== 'off';

/** 按日聚合：requests / tokens / estimatedCost（含 per-model 拆分）。 */
router.get('/stats/daily', admin, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 90);
    await loadRateMap();
    if (statsCacheEnabled()) {
      const { cachedDailyStats } = require('../log/stats-cache');
      const data = cachedDailyStats(days);
      const totalRequests = data.reduce((s, d) => s + d.requests, 0);
      return res.json({ object: 'list', days, totalRequests, data, cached: true });
    }
    const lines = readTrafficLines(days);
    const data = dailyStats(lines);
    res.json({ object: 'list', days, totalRequests: lines.length, data });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 按模型聚合：requests / tokens / avgDurationMs / estimatedCost。 */
router.get('/stats/models', admin, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '7', 10) || 7, 1), 90);
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
    const days = Math.min(Math.max(parseInt(req.query.days || '7', 10) || 7, 1), 90);
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

router.post('/stats/cache/clear', admin, (req, res) => {
  const sc = require('../log/stats-cache');
  res.json({ ok: sc.clearCache() });
});

/** ===== 客户端消耗（WorkBuddy 本机会话日志） ===== */
/**
 * 与 /stats/* 是两条独立数据源：
 *   /stats/*    —— 网关转发侧，读 logs/<date>/traffic.jsonl，覆盖经 RelayGate 的请求
 *   本端点      —— 客户端侧，读 %USERPROFILE%\.workbuddy\projects\**\*.jsonl，覆盖本机客户端全部调用
 * 两者口径不同，条数不必相等，界面上并列展示、不混算。
 */
router.get('/stats/client', admin, (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 400);
    const force = req.query.force === '1';
    const cl = require('../log/client-logs');
    const r = cl.scan({ force });

    // 按日窗口裁剪（客户端日志保留全部历史，前端只看最近 days 天）
    const cutoff = new Date(Date.now() - (days - 1) * 86400000);
    const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
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

/**
 * 官方账单接口（精确积分，仅 WorkBuddy 账号）。
 * 与快照差分的「网关转发」积分并列，作为独立对照口径；两者数值不必相等。
 * Trae 账号无此接口，界面应如实标注不支持。
 */
router.get('/stats/official-usage', admin, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 90);
    const accountId = req.query.account ? String(req.query.account) : null;
    const bu = require('../workbuddy/billing-usage');
    const result = accountId ? { object: 'official_usage', days, accounts: [await bu.scanAccount(accountId, days)] } : await bu.scanAll(days);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

router.post('/stats/official-usage/cache/clear', admin, (req, res) => {
  const bu = require('../workbuddy/billing-usage');
  res.json({ ok: bu.clearCache(), dir: bu.cacheDir() });
});

/** ===== T2 SSE 调试模式 ===== */

const SSE_DEBUG_ENABLED = () => process.env.TRAE_DEBUG_SSE === 'true';
const SSE_DEBUG_DIR = () => path.join(config.ROOT, 'logs', new Date().toISOString().slice(0, 10));
const SSE_DEBUG_FILE = () => path.join(SSE_DEBUG_DIR(), 'sse-debug.jsonl');

/** SSE 调试状态。 */
router.get('/debug/sse/status', admin, (req, res) => {
  res.json({ object: 'sse_debug_status', enabled: SSE_DEBUG_ENABLED() });
});

/** 查询某请求/某天的 SSE 事件流。 */
router.get('/debug/sse', admin, (req, res) => {
  if (!SSE_DEBUG_ENABLED()) {
    return res.json({ object: 'list', enabled: false, data: [], hint: 'SSE 调试未开启，设置 TRAE_DEBUG_SSE=true 并重启后生效' });
  }
  const days = Math.min(Math.max(parseInt(req.query.days || '1', 10) || 1, 1), 7);
  const requestId = req.query.request_id ? String(req.query.request_id) : null;
  const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10) || 200, 1), 1000);

  const rows = [];
  const base = path.join(config.ROOT, 'logs');
  for (let d = 0; d < days; d++) {
    const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    const file = path.join(base, day, 'sse-debug.jsonl');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (requestId && r.requestId !== requestId) continue;
        rows.push(r);
      } catch { /* skip bad line */ }
    }
  }
  rows.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  const total = rows.length;
  res.json({ object: 'list', enabled: true, total, data: rows.slice(0, limit) });
});

/** ===== T3 一键测试请求 ===== */

/** 自定义消息测试某模型（真实调用上游，返回完整响应）。 */
router.post('/test-chat', admin, async (req, res) => {
  const body = req.body || {};
  const model = String(body.model || 'auto').trim();
  const message = String(body.message || 'ping').trim();
  const stream = body.stream === true;
  const maxTokens = Number(body.max_tokens) || 128;

  if (!model || !message) {
    return res.status(400).json({ error: { message: 'model and message required', type: 'invalid_request_error' } });
  }
  const { llmUtilsChat } = require('../upstream/client');
  const { normalizeTraeMessages } = require('../transform/request');
  const startedAt = Date.now();
  try {
    const { result, accountId } = await pool.run((accountId) =>
      llmUtilsChat(
        normalizeTraeMessages([{ role: 'user', content: message }]),
        model, false, { accountId, max_tokens: maxTokens },
      ), { maxSwitches: 1 });
    if (model !== 'auto') require('../models/availability').markUsable(model);
    // 从非流式聚合结果中提取文本
    const choice = result && result.choices && result.choices[0];
    const content = choice && choice.message ? (choice.message.content || '') : '';
    const usage = result && result.usage ? result.usage : null;
    res.json({
      ok: true,
      model,
      accountId,
      durationMs: Date.now() - startedAt,
      content,
      usage,
      finishReason: choice ? choice.finish_reason : null,
    });
  } catch (err) {
    if (model !== 'auto') {
      const { isModelConfigError, isPlanLimitError, isModelRateLimitError } = require('../upstream/errors');
      if (isModelConfigError(err) || isPlanLimitError(err) || isModelRateLimitError(err)) {
        require('../models/availability').markUnavailable(model, err.message);
      }
    }
    res.status(502).json({
      ok: false,
      model,
      message: err.message,
      durationMs: Date.now() - startedAt,
    });
  }
});

/** ===== T4 配置热更新 ===== */

/** 查看当前生效的关键配置。 */
router.get('/config', admin, (req, res) => {
  res.json({
    object: 'runtime_config',
    port: config.port,
    host: config.host,
    poolStrategy: config.poolStrategy,
    maxInFlightPerAccount: config.maxInFlightPerAccount,
    minBalanceToUse: config.minBalanceToUse,
    ratePaceMs: config.ratePaceMs,
    rateWindowMs: config.rateWindowMs,
    rateWindowMax: config.rateWindowMax,
    rateCooldownMs: config.rateCooldownMs,
    schedulerEnabled: config.schedulerEnabled,
    checkinHour: config.checkinHour,
    checkinMinute: config.checkinMinute,
    keepaliveHour: config.keepaliveHour,
    tokenRefreshLeadHours: config.tokenRefreshLeadHours,
    modelProbeIntervalHours: config.modelProbeIntervalHours,
    upstreamFunction: config.upstreamFunction || null,
    upstreamChatPath: config.upstreamChatPath,
    toolProtocol: config.toolProtocol,
    maxRetries: config.maxRetries,
    retryBaseDelay: config.retryBaseDelay,
    requestTimeoutMs: config.requestTimeoutMs,
    statusPublic: config.statusPublic,
    adminSeparated: config.adminKey !== config.apiKey,
  });
});

/** 重新加载 model-config.json / model-fallback.json / .env 关键项。 */
router.post('/config/reload', admin, (req, res) => {
  try {
    const before = {
      modelCount: Object.keys(config.modelConfig.models || {}).length,
      poolStrategy: config.poolStrategy,
    };
    config.reload();
    const after = {
      modelCount: Object.keys(config.modelConfig.models || {}).length,
      poolStrategy: config.poolStrategy,
    };
    res.json({ object: 'config_reload', ok: true, before, after, reloadedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

module.exports = router;
