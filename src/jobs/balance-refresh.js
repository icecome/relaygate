'use strict';
/**
 * jobs/balance-refresh.js — 余额自动刷新调度（可配置间隔 + 状态反馈）。
 *
 * 独立于每日签到链：面板可设置刷新间隔（分钟），进程内 setInterval 周期执行，
 * 与签到后的手动刷新互斥（running 标志），刷新过程不阻塞任何请求（不占用账号池租约）。
 */
const fs = require('fs');
const config = require('../config');
const pool = require('../credentials/pool');
const { refreshBalanceAllEnabled } = require('../upstream/balance');
const { checkCreditAlerts } = require('./credit-alerts');
const { appendTaskLog } = require('./task-log');
const { writeJsonAtomic } = require('../lib/atomic-write');
const { stateFile, resolveStateFileForRead } = require('../lib/paths');

const FILE = () => stateFile('balance-refresh-settings.json');
const readFile = () => resolveStateFileForRead('balance-refresh-settings.json', require('fs').existsSync);

const DEFAULTS = {
  enabled: false,
  intervalMinutes: 30,
};

let timer = null;
let running = false;
const state = {
  lastRunAt: null,
  lastOk: null,
  lastFailed: null,
  lastSummary: null,
  running: false,
};

function clampMinutes(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.min(Math.max(Math.round(v), 5), 1440);
}

function readStored() {
  try {
    const raw = JSON.parse(fs.readFileSync(readFile(), 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** 生效配置：文件 > env（BALANCE_REFRESH_ENABLED / BALANCE_REFRESH_INTERVAL_MINUTES）> 默认。 */
function getEffective() {
  const stored = readStored();
  let enabled = stored.enabled;
  if (enabled == null) {
    enabled = process.env.BALANCE_REFRESH_ENABLED != null
      ? process.env.BALANCE_REFRESH_ENABLED !== 'false' && process.env.BALANCE_REFRESH_ENABLED !== '0'
      : DEFAULTS.enabled;
  }
  let intervalMinutes = DEFAULTS.intervalMinutes;
  const fromEnv = process.env.BALANCE_REFRESH_INTERVAL_MINUTES;
  const src = stored.intervalMinutes != null && stored.intervalMinutes !== '' ? stored.intervalMinutes : fromEnv;
  if (src != null && src !== '') {
    const n = clampMinutes(src);
    if (n != null) intervalMinutes = n;
  }
  return { enabled: !!enabled, intervalMinutes };
}

/** 保存配置，返回生效值。 */
function save(partial) {
  const stored = readStored();
  if (typeof partial.enabled === 'boolean') stored.enabled = partial.enabled;
  if (partial.intervalMinutes != null && partial.intervalMinutes !== '') {
    const n = clampMinutes(partial.intervalMinutes);
    if (n != null) stored.intervalMinutes = n;
  }
  writeJsonAtomic(FILE(), stored);
  return getEffective();
}

/**
 * 执行一轮全账号余额刷新（互斥）。
 * @param {object} [opts] {trigger:'timer'|'manual', skipAlerts?:boolean}
 */
async function runRefresh(opts = {}) {
  if (running) return { skipped: true, running: true };
  running = true;
  state.running = true;
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
    running = false;
    state.running = false;
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
