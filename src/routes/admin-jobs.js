'use strict';
/**
 * routes/admin-jobs.js — 定时任务、余额刷新、备份与账号轮换端点。
 * 挂载前缀：/v1/admin（见 index.js）。
 */
const { Router } = require('express');
const config = require('../config');
const pool = require('../credentials/pool');
const scheduler = require('../jobs/scheduler');
const { authenticateAdmin } = require('../middleware/auth');

const router = Router();
const admin = (req, res, next) => authenticateAdmin(req, res, next);

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

/** 余额自动刷新（可配间隔）。 */
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

/** 全量备份。 */
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

/** 多账号活跃度维护（账号轮换）。 */
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
    // manual:true —— 用户点「立即轮换一遍」不受自动调度开关限制
    const r = await scheduler.runRotateAccounts({ manual: true });
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

module.exports = router;