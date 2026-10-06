'use strict';
/**
 * jobs/balance-refresh.js — 余额自动刷新调度（可配置间隔 + 状态反馈）。
 *
 * 独立于每日签到链：面板可设置刷新间隔（分钟），进程内 setInterval 周期执行，
 * 与签到后的手动刷新互斥（running 标志），刷新过程不阻塞任何请求（不占用账号池租约）。
 */
const pool = require('../credentials/pool');
const { refreshBalanceAllEnabled, isBatchRunning } = require('../upstream/balance');
const { checkCreditAlerts } = require('./credit-alerts');
const { appendTaskLog } = require('./task-log');
const { createSettingsStore } = require('../lib/settings-store');

const NAME = 'balance-refresh-settings.json';

const SPECS = {
  enabled: { type: 'bool', env: 'BALANCE_REFRESH_ENABLED', default: false },
  intervalMinutes: { env: 'BALANCE_REFRESH_INTERVAL_MINUTES', default: 30, min: 5, max: 1440 },
};

const store = createSettingsStore({ name: NAME, specs: SPECS });

const FILE = () => store.FILE();

let timer = null;
const state = {
  lastRunAt: null,
  lastOk: null,
  lastFailed: null,
  lastSummary: null,
  running: false,
};

/** 生效配置：文件 > env > 默认。 */
function getEffective() {
  return store.getEffective();
}

/** 保存配置，返回生效值。 */
function save(partial) {
  return store.save(partial);
}

/**
 * 执行一轮全账号余额刷新。
 *
 * 互斥由 upstream/balance.js 的批量锁统一提供（与签到链共用），
 * 此处不再维护独立 running标志，避免两把锁互不知情导致并发。
 *
 * @param {object} [opts] {trigger:'timer'|'manual', skipAlerts?:boolean}
 */
async function runRefresh(opts = {}) {
  const trigger = opts.trigger || 'timer';
  const startedAt = new Date().toISOString();
  let result;
  try {
    // 定时触发按账号确定性错峰，避免同刻打上游；手动触发立即执行。
    // 窗口夹紧到刷新间隔的一半，防止一轮还没跑完下一轮就到点。
    let spreadMinutes = 0;
    if (trigger === 'timer') {
      const eff = getEffective();
      const wanted = Number(require('./scheduler-settings').getEffective().balanceSpreadMinutes) || 0;
      spreadMinutes = Math.max(0, Math.min(wanted, Math.floor(eff.intervalMinutes / 2)));
    }
    const r = await refreshBalanceAllEnabled({ spreadMinutes });
    // 被互斥跳过：不算失败，也不写告警与任务日志
    if (r && r.skipped) {
      state.lastSummary = { ...(state.lastSummary || {}), skippedAt: new Date().toISOString() };
      console.log(`[balance-refresh] ${trigger} skipped: 另一轮批量刷新进行中`);
      return r;
    }
    // 余额健康账号解冻（与签到后逻辑一致）
    for (const item of r.ok || []) pool.unfreezeIfHealthy(item.accountId);
    if (!opts.skipAlerts) {
      try {
        await checkCreditAlerts();
      } catch (e) {
        console.error('[balance-refresh] credit alerts error', e.message);
      }
    }
    result = { ok: r.ok.length, failed: r.failed.length, total: r.total, failedItems: r.failed };
    state.lastOk = r.ok.length;
    state.lastFailed = r.failed.length;
    state.lastSummary = {
      ok: r.ok.length,
      failed: r.failed.length,
      total: r.total,
      ranAt: startedAt,
      trigger,
    };
    console.log(`[balance-refresh] ${trigger} done ok=${r.ok.length} failed=${r.failed.length} total=${r.total}`);
    // 追加任务执行日志（供面板查询）
    try {
      appendTaskLog({
        task: 'balance-refresh',
        trigger,
        ok: r.ok.length,
        failed: r.failed.length,
        total: r.total,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    } catch { /* 日志失败不影响刷新 */ }
    return r;
  } catch (e) {
    result = { ok: 0, failed: 1, total: 0, error: e.message };
    state.lastError = e.message;
    state.lastSummary = { ok: 0, failed: 1, total: 0, ranAt: startedAt, trigger, error: e.message };
    console.error(`[balance-refresh] ${trigger} error: ${e.message}`);
    try {
      appendTaskLog({
        task: 'balance-refresh',
        trigger,
        ok: 0,
        failed: 1,
        total: 0,
        error: e.message,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    } catch { /* ignore */ }
    return result;
  } finally {
    state.lastRunAt = new Date().toISOString();
    // 锁已在本轮结束时释放，running 恒为 false；真实在跑状态由 isBatchRunning() 按需查询
    state.running = isBatchRunning();
  }
}

function start() {
  stop();
  const eff = getEffective();
  if (!eff.enabled) {
    console.log('[balance-refresh] auto refresh disabled');
    return;
  }
  const ms = Math.max(5, eff.intervalMinutes) * 60 * 1000;
  // 启动后 60 秒先跑第一轮，避开冷启动
  const first = setTimeout(async () => {
    await runRefresh({ trigger: 'timer' }).catch(() => {});
    if (getEffective().enabled) {
      timer = setInterval(() => runRefresh({ trigger: 'timer' }).catch(() => {}), ms);
      timer.unref?.();
    }
  }, 60 * 1000);
  first.unref?.();
  state.timer = { intervalMinutes: eff.intervalMinutes, nextRunAt: new Date(Date.now() + 60 * 1000).toISOString() };
  console.log(`[balance-refresh] auto refresh every ${eff.intervalMinutes}min (first in 60s)`);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  state.timer = null;
}

/** 配置变更后重排（保留 running 中的本轮）。 */
function restart() {
  stop();
  start();
  return snapshot();
}

function snapshot() {
  const eff = getEffective();
  return { ...eff, ...state, timer: state.timer };
}

module.exports = {
  getEffective,
  save,
  runRefresh,
  start,
  stop,
  restart,
  snapshot,
  FILE,
};
