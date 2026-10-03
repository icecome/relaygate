'use strict';
/**
 * jobs/scheduler.js — 进程内定时：Token 预刷新 / 每日签到 / 签到后刷余额 / 保活 / 模型探活。
 *
 * 时刻与间隔优先读 .trae-api/scheduler-settings.json，其次 .env，最后默认值。
 * 对齐 trae2api-web 与 Sliverkiss 的「预刷新 + 定时签到 + 保活」模型。
 */
const config = require('../config');
const scheduleSettings = require('./scheduler-settings');
const store = require('../credentials/store');
const auth = require('../auth');
const legacy = require('../lib/auth');
const { checkinAllEnabled } = require('../upstream/checkin');
const { wbCheckinAllEnabled } = require('../upstream/wb-checkin');
const { refreshBalanceAllEnabled } = require('../upstream/balance');
const { llmUtilsChat } = require('../upstream/client');
const { isModelConfigError, isPlanLimitError } = require('../upstream/errors');
const { normalizeTraeMessages } = require('../transform/request');
const { sleep } = require('../lib/util');
const pool = require('../credentials/pool');
const availability = require('../models/availability');
const catalog = require('../models/catalog');
const { notify } = require('../notify');
const { checkCreditAlerts } = require('./credit-alerts');
const { appendTaskLog } = require('./task-log');
const { appendCheckinTaskLog } = require('./checkin-log');

let timers = [];
let started = false;
const state = {
  lastRefreshAt: null,
  lastCheckinAt: null,
  lastKeepaliveAt: null,
  lastProbeAt: null,
  lastProbeSummary: null,
  lastError: null,
  nextCheckinAt: null,
  nextKeepaliveAt: null,
  nextProbeAt: null,
  lastRotateAt: null,
  nextRotateAt: null,
};

/** 计算「今天/明天 HH:mm」的 Date。 */
function nextAt(hour, minute) {
  const now = new Date();
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

function leadMs() {
  const h = Number(config.tokenRefreshLeadHours);
  return (Number.isFinite(h) && h >= 0 ? h : 24) * 3600 * 1000;
}

function isExpiringSoon(acct) {
  if (!acct.expiredAt) return true;
  const t = new Date(acct.expiredAt).getTime();
  if (isNaN(t)) return true;
  return t - Date.now() < leadMs();
}

/** 扫描并刷新临期账号 token。 */
async function refreshExpiringTokens() {
  const accounts = store.list().filter((a) => a.enabled);
  let refreshed = 0;
  let failed = 0;
  for (const a of accounts) {
    const full = store.get(a.id);
    if (!full || !full.token) continue;
    if (!isExpiringSoon(full)) continue;
    if (!full.refreshToken) continue;
    try {
      // WorkBuddy 与 Trae 刷新端点不同，统一走 ensureAuth（按 edition 分支）
      if (full.edition === 'workbuddy') {
        await auth.ensureAuth(full.id);
        refreshed += 1;
        console.log(`[scheduler] refreshed workbuddy token for ${full.label || full.id}`);
        continue;
      }
      // OAuth 账号必须用自身 ClientID/authHost 换新，否则会打到全局默认主机
      const refreshedTok = await legacy.exchangeToken(full.refreshToken, {
        clientId: full.authClientId || undefined,
        host: full.authHost || undefined,
      });
      if (refreshedTok && refreshedTok.token) {
        store.update(a.id, {
          token: refreshedTok.token,
          refreshToken: refreshedTok.refreshToken || full.refreshToken,
          expiredAt: refreshedTok.expiredAt || full.expiredAt,
          refreshExpiredAt: refreshedTok.refreshExpiredAt || full.refreshExpiredAt,
          tokenReleaseAt: refreshedTok.tokenReleaseAt || full.tokenReleaseAt,
        });
        refreshed += 1;
        console.log(`[scheduler] refreshed token for ${a.label || a.id}`);
      }
    } catch (e) {
      failed += 1;
      console.error(`[scheduler] refresh fail ${a.id}: ${e.message}`);
      store.update(a.id, {
        errorCount: Math.min((full.errorCount || 0) + 1, 50),
      });
      notify('refresh_fail', {
        accountId: a.id,
        label: a.label,
        message: e.message,
      }).catch(() => {});
    }
    await sleep(300);
  }
  state.lastRefreshAt = new Date().toISOString();
  state.lastError = failed ? `${failed} failed` : null;
  return { refreshed, failed };
}

/** 每日任务：Trae 签到 + WorkBuddy 签到 → 刷余额 → 解冻。
 *  多账号按 (日期,账号id) 确定性错峰分散，避免固定时刻批量打上游自造洪峰；
 *  窗口由 scheduler-settings 的 checkinSpreadMinutes / balanceSpreadMinutes 控制（0=关闭）。 */
async function runDailyCheckin() {
  console.log('[scheduler] daily checkin start');
  const eff = scheduleSettings.getEffective();
  const checkinSpread = Number(eff.checkinSpreadMinutes) || 0;
  const balanceSpread = Number(eff.balanceSpreadMinutes) || 0;
  // 两侧共用同一窗口起点，保证 Trae 与 WorkBuddy 的分散区间对齐
  const windowStartMs = Date.now();
  try {
    const r = await checkinAllEnabled({ spreadMinutes: checkinSpread, windowStartMs });
    let wb = { ok: [], failed: [], total: 0 };
    try {
      wb = await wbCheckinAllEnabled({ spreadMinutes: checkinSpread, windowStartMs });
    } catch (e) {
      console.error('[scheduler] workbuddy checkin error', e.message);
      wb.failed.push({ reason: e.message });
    }
    // WorkBuddy 成长中心自动化：旅行（领奖/派猫）+ 任务 + 补登 + 兑换 + 抽奖 + 盲盒
    try {
      const { autoRunGrowth } = require('./growth-auto');
      const ga = await autoRunGrowth();
      const acted = ga.results.reduce((n, r) => n + r.actions.filter((x) => x.ok && !x.skip).length, 0);
      if (acted || ga.failCount) {
        console.log(`[scheduler] growth auto: accounts=${ga.total} acted=${acted} failed=${ga.failCount}`);
      }
      if (ga.total > 0) {
        appendTaskLog({
          task: 'growth-auto',
          trigger: 'checkin-chain',
          ok: ga.okCount,
          failed: ga.failCount,
          total: ga.total,
          acted,
        });
      }
      if (ga.failCount) {
        const first = ga.results.find((r) => !r.ok);
        const bad = first && first.actions.find((x) => !x.ok);
        notify('checkin_fail', {
          accountId: first && first.accountId,
          label: first && first.label,
          message: `成长中心 ${ga.failCount} 个账号有失败：${bad ? bad.msg : ''}`,
        }, '成长中心部分失败').catch(() => {});
      }
    } catch (e) {
      console.error('[scheduler] growth auto error', e.message);
    }
    state.lastCheckinAt = new Date().toISOString();
    const okCount = (r.ok?.length || 0) + (wb.ok?.length || 0);
    const failedCount = (r.failed?.length || 0) + (wb.failed?.length || 0);
    console.log(`[scheduler] checkin trae ok=${r.ok.length} failed=${r.failed.length} | wb ok=${wb.ok?.length || 0} failed=${wb.failed?.length || 0}`);
    // 签到链写入任务日志（Trae / WorkBuddy 分批）
    if (r.total || r.claimed?.length) appendCheckinTaskLog({ edition: 'trae', batch: r, trigger: 'checkin-chain' });
    if (wb.total || wb.claimed?.length || wb.failed?.length) appendCheckinTaskLog({ edition: 'workbuddy', batch: wb, trigger: 'checkin-chain' });
    // 签到完成即推送汇总（成功/失败均通知）
    if (okCount || failedCount) {
      const first = (r.failed && r.failed[0]) || (wb.failed && wb.failed[0]) || {};
      const event = failedCount ? 'checkin_fail' : 'checkin_ok';
      const title = failedCount ? '签到部分失败' : '签到完成';
      const message = failedCount
        ? (first.error || first.message || first.reason || `${failedCount} accounts failed`)
        : `全部 ${okCount} 个账号签到成功`;
      notify(event, {
        ok: okCount,
        failed: failedCount,
        accountId: first.accountId || first.id,
        message,
      }, title).catch(() => {});
    }
    if (config.schedulerEnabled) {
      const b = await refreshBalanceAllEnabled({ spreadMinutes: balanceSpread, windowStartMs });
      for (const item of b.ok) pool.unfreezeIfHealthy(item.accountId);
      console.log(`[scheduler] balance ok=${b.ok.length} failed=${b.failed.length}`);
      try {
        appendTaskLog({
          task: 'balance-refresh',
          trigger: 'checkin-chain',
          ok: b.ok.length,
          failed: b.failed.length,
          total: b.total,
        });
      } catch { /* 日志失败不影响签到链 */ }
      try {
        await checkCreditAlerts();
      } catch (e) {
        console.error('[scheduler] credit alerts error', e.message);
      }
    }
    return {
      ...r,
      workbuddy: {
        ok: wb.ok || [],
        failed: wb.failed || [],
        total: wb.total || 0,
        summary: wb.summary || null,
      },
    };
  } catch (e) {
    state.lastError = e.message;
    console.error('[scheduler] checkin error', e.message);
    throw e;
  }
}

async function runKeepalive() {
  console.log('[scheduler] keepalive token refresh start');
  try {
    // 无论是否临期，全部 enabled 账号尝试 ensureAuth（内部会按需 refresh）
    const accounts = store.list().filter((a) => a.enabled);
    for (const a of accounts) {
      try {
        await auth.ensureAuth(a.id);
      } catch (e) {
        console.error(`[scheduler] keepalive fail ${a.id}: ${e.message}`);
        notify('refresh_fail', {
          accountId: a.id,
          label: a.label,
          message: `keepalive: ${e.message}`,
        }).catch(() => {});
      }
      await sleep(200);
    }
    state.lastKeepaliveAt = new Date().toISOString();
  } catch (e) {
    state.lastError = e.message;
  }
}

/** 多账号活跃度维护：轮换 auth 文件触发热加载。
 *  由 rotate-settings.json 热重载控制启停与间隔；intervalMinutes 间隔轮询占位。 */
let rotateTimer = null;
async function runRotateAccounts() {
  const rs = require('./rotate-settings').getEffective();
  if (!rs.enabled) return { ok: 0, failed: 0, skipped: 1 };
  const schedEff = scheduleSettings.getEffective();
  if (!schedEff.rotateEnabled) return { ok: 0, failed: 0, skipped: 1 };
  console.log('[scheduler] account rotate start');
  try {
    const rotate = require('./rotate-accounts');
    const r = await rotate.rotateAll();
    state.lastRotateAt = new Date().toISOString();
    console.log(`[scheduler] account rotate done: ok=${r.ok} failed=${r.failed}`);
    try {
      appendTaskLog({ task: 'account-rotate', trigger: 'scheduler', ok: r.ok, failed: r.failed, total: (r.results || []).length });
    } catch { /* ignore */ }
    if (r.failed) {
      notify('rotate_fail', {
        message: `账号轮换 ${r.failed} 个失败`,
      }, '账号轮换部分失败').catch(() => {});
    }
    return r;
  } catch (e) {
    state.lastError = e.message;
    console.error('[scheduler] account rotate error', e.message);
    return { ok: 0, failed: 1, error: e.message };
  }
}

/** 周期自动切换调度：按 rotate-settings 的 intervalMinutes 触发一整遍轮换，支持热重载。 */
function scheduleRotatePoll() {
  if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
  const rs = require('./rotate-settings').getEffective();
  if (!rs.enabled) {
    console.log('[scheduler] account rotate auto disabled');
    return;
  }
  const ms = Math.max(30, rs.intervalMinutes) * 60 * 1000;
  const firstDelay = 2 * 60 * 1000; // 启动后 2 分钟首圈，避开冷启动
  const first = setTimeout(async () => {
    await runRotateAccounts().catch(() => {});
    if (started && require('./rotate-settings').getEffective().enabled) {
      rotateTimer = setInterval(() => runRotateAccounts().catch(() => {}), ms);
      rotateTimer.unref?.();
    }
  }, firstDelay);
  first.unref?.();
  timers.push(first);
  state.nextRotateAt = new Date(Date.now() + firstDelay).toISOString();
  console.log(`[scheduler] account rotate auto every ${rs.intervalMinutes}min (first in ${firstDelay / 1000}s)`);
}

/**
 * 定时模型探活：对 unknown 模型发最小请求，更新可用性。
 * 跳过 auto / 自定义模型；每轮最多 modelProbeMaxPerRun 个。
 */
async function runModelProbe() {
  const maxPerRun = Number(scheduleSettings.getEffective().modelProbeMaxPerRun) || 8;
  if (maxPerRun <= 0) return { probed: 0, usable: 0, unavailable: 0, skipped: 0 };
  console.log(`[scheduler] model probe start (max ${maxPerRun})`);
  try {
    const cat = await catalog.listWithStatus({ force: false });
    const targets = cat.models
      .filter((m) => m.id && m.id !== 'auto' && !m.custom)
      .filter((m) => availability.statusOf(m.id) === 'unknown')
      .slice(0, maxPerRun);

    let usable = 0;
    let unavailable = 0;
    for (const m of targets) {
      try {
        // maxSwitches:2 — PlanLimit 等账号级错误应换号再试
        await pool.run(
          (accountId) => llmUtilsChat(
            normalizeTraeMessages([{ role: 'user', content: 'ping' }]),
            m.id, false, { accountId },
          ),
          { maxSwitches: 2 },
        );
        availability.markUsable(m.id);
        usable += 1;
        console.log(`[scheduler] probe ok ${m.id}`);
      } catch (e) {
        if (isModelConfigError(e)) {
          availability.markUnavailable(m.id, e.message);
          unavailable += 1;
          console.log(`[scheduler] probe unavailable ${m.id}: ${e.message}`);
        } else if (isPlanLimitError(e)) {
          // 套餐额度不足：对当前池确实不可用，标明原因（7 天 TTL 后自动重探）
          availability.markUnavailable(m.id, e.message);
          unavailable += 1;
          console.log(`[scheduler] probe plan-limit ${m.id}: ${e.message}`);
        } else {
          // 网络/限流等非模型配置错误：不标记，留待下次
          console.warn(`[scheduler] probe skip ${m.id}: ${e.message}`);
        }
      }
      await sleep(1500);
    }
    state.lastProbeAt = new Date().toISOString();
    state.lastProbeSummary = {
      targets: targets.length,
      usable,
      unavailable,
      unknownLeft: Math.max(0, targets.length - usable - unavailable),
    };
    console.log(`[scheduler] model probe done ${JSON.stringify(state.lastProbeSummary)}`);
    return state.lastProbeSummary;
  } catch (e) {
    state.lastError = e.message;
    console.error('[scheduler] model probe error', e.message);
    return { probed: 0, usable: 0, unavailable: 0, skipped: 1, error: e.message };
  }
}

function scheduleOnce(hour, minute, label, fn) {
  const at = nextAt(hour, minute);
  if (label === 'checkin') state.nextCheckinAt = at.toISOString();
  if (label === 'keepalive') state.nextKeepaliveAt = at.toISOString();
  if (label === 'rotate') state.nextRotateAt = at.toISOString();
  const delay = Math.max(1000, at.getTime() - Date.now());
  const t = setTimeout(async () => {
    try {
      await fn();
    } catch { /* logged inside */ }
    if (started) scheduleOnce(hour, minute, label, fn);
  }, delay);
  t.unref?.();
  timers.push(t);
  console.log(`[scheduler] next ${label} at ${at.toISOString()} (in ${Math.round(delay / 1000)}s)`);
}

/** 周期扫临期 token（默认 15 分钟，可配）。 */
function scheduleTokenSweep(minutes) {
  const mins = Number(minutes) > 0 ? Number(minutes) : 15;
  const run = () => refreshExpiringTokens().catch(() => {});
  run();
  const t = setInterval(run, mins * 60 * 1000);
  t.unref?.();
  timers.push(t);
}

/** 定时模型探活（intervalHours 小时一轮；0=关闭）。 */
function scheduleModelProbe(eff) {
  const hours = Number(eff.modelProbeIntervalHours) || 0;
  const maxPerRun = Number(eff.modelProbeMaxPerRun) || 0;
  if (hours <= 0) {
    console.log('[scheduler] model probe disabled (modelProbeIntervalHours=0)');
    return;
  }
  const intervalMs = hours * 3600 * 1000;
  state.nextProbeAt = new Date(Date.now() + intervalMs).toISOString();
  // 启动后延迟 2 分钟再探，避开冷启动
  const firstDelay = 2 * 60 * 1000;
  const first = setTimeout(async () => {
    await runModelProbe().catch(() => {});
    if (started) {
      const t = setInterval(() => runModelProbe().catch(() => {}), intervalMs);
      t.unref?.();
      timers.push(t);
      state.nextProbeAt = new Date(Date.now() + intervalMs).toISOString();
    }
  }, firstDelay);
  first.unref?.();
  timers.push(first);
  console.log(`[scheduler] model probe every ${hours}h (max ${maxPerRun}/run, first in ${firstDelay / 1000}s)`);
}

async function runGrowthAuto() {
  console.log('[scheduler] growth auto start');
  try {
    const { autoRunGrowth } = require('./growth-auto');
    const ga = await autoRunGrowth();
    const acted = ga.results.reduce((n, r) => n + r.actions.filter((x) => x.ok && !x.skip).length, 0);
    state.lastGrowthAt = new Date().toISOString();
    if (ga.total > 0) {
      appendTaskLog({
        task: 'growth-auto',
        trigger: 'scheduler',
        ok: ga.okCount,
        failed: ga.failCount,
        total: ga.total,
        acted,
      });
    }
    if (ga.failCount) {
      const first = ga.results.find((r) => !r.ok);
      const bad = first && first.actions.find((x) => !x.ok);
      notify('checkin_fail', {
        accountId: first && first.accountId,
        label: first && first.label,
        message: `成长中心 ${ga.failCount} 个账号有失败：${bad ? bad.msg : ''}`,
      }, '成长中心部分失败').catch(() => {});
    }
    return ga;
  } catch (e) {
    state.lastError = e.message;
    console.error('[scheduler] growth auto error', e.message);
    return { total: 0, okCount: 0, failCount: 1, error: e.message };
  }
}

/** 成长中心独立定时：轮询补签成长活动（可配 interval 小时）。 */
let growthTimer = null;
function scheduleGrowthPoll(eff) {
  if (growthTimer) { clearInterval(growthTimer); growthTimer = null; }
  // 独立开关 GreenCtrl：growthPollEnabled；时长 30 分~168 小时
  const hours = Number(eff.growthPollIntervalHours) || 0;
  const enabled = eff.growthPollEnabled !== false && hours > 0;
  if (!enabled) {
    console.log('[scheduler] growth poll disabled');
    return;
  }
  const intervalMs = hours * 3600 * 1000;
  state.nextGrowthAt = new Date(Date.now() + intervalMs).toISOString();
  // 首轮延迟 45 秒，避开冷启动与签到链
  const firstDelay = 45 * 1000;
  const first = setTimeout(async () => {
    await runGrowthAuto().catch(() => {});
    if (started && eff.growthPollEnabled !== false) {
      growthTimer = setInterval(() => runGrowthAuto().catch(() => {}), intervalMs);
      growthTimer.unref?.();
      state.nextGrowthAt = new Date(Date.now() + intervalMs).toISOString();
    }
  }, firstDelay);
  first.unref?.();
  timers.push(first);
  console.log(`[scheduler] growth poll every ${hours}h (first in ${firstDelay / 1000}s)`);
}

function start() {
  if (started || !config.schedulerEnabled) {
    if (!config.schedulerEnabled) console.log('[scheduler] disabled');
    return;
  }
  started = true;
  const eff = scheduleSettings.getEffective();
  state.schedule = { ...eff };

  // 启动后立刻尝试一次临期刷新
  scheduleTokenSweep(eff.tokenSweepMinutes);

  scheduleOnce(eff.checkinHour, eff.checkinMinute, 'checkin', runDailyCheckin);
  scheduleOnce(eff.keepaliveHour, eff.keepaliveMinute, 'keepalive', runKeepalive);
  if (eff.rotateEnabled) {
    scheduleOnce(eff.rotateHour, eff.rotateMinute, 'rotate', runRotateAccounts);
  }
  scheduleModelProbe(eff);
  scheduleGrowthPoll(eff);
  scheduleRotatePoll();

  console.log('[scheduler] started (checkin + keepalive + token sweep + model probe + rotate + growth poll + account rotate auto)');
}

function stop() {
  started = false;
  if (growthTimer) {
    clearInterval(growthTimer);
    growthTimer = null;
  }
  if (rotateTimer) {
    clearInterval(rotateTimer);
    rotateTimer = null;
  }
  for (const t of timers) {
    clearTimeout(t);
    clearInterval(t);
  }
  timers = [];
}

/** 配置变更后重排定时（保留 started 状态）。 */
function restart() {
  const was = started || config.schedulerEnabled;
  stop();
  if (was) start();
  return snapshot();
}

/** 账号轮换配置热重载：仅重排轮换定时器（保留其它调度）。 */
function restartRotate() {
  if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
  const eff = scheduleSettings.getEffective();
  // 每日时刻任务仍在（若启用），立即重排
  if (started && config.schedulerEnabled) {
    scheduleRotatePoll();
  }
  return snapshot();
}

function snapshot() {
  const eff = scheduleSettings.getEffective();
  let rotateSettings = null;
  let nextRotateAutoAt = null;
  try { rotateSettings = require('./rotate-settings').getEffective(); } catch { /* ignore */ }
  return {
    enabled: config.schedulerEnabled && started,
    checkinHour: eff.checkinHour,
    checkinMinute: eff.checkinMinute,
    keepaliveHour: eff.keepaliveHour,
    keepaliveMinute: eff.keepaliveMinute,
    tokenSweepMinutes: eff.tokenSweepMinutes,
    modelProbeIntervalHours: eff.modelProbeIntervalHours,
    modelProbeMaxPerRun: eff.modelProbeMaxPerRun,
    rotateEnabled: eff.rotateEnabled,
    rotateHour: eff.rotateHour,
    rotateMinute: eff.rotateMinute,
    growthPollEnabled: eff.growthPollEnabled,
    growthPollIntervalHours: eff.growthPollIntervalHours,
    rotateSettings,
    ...state,
  };
}

module.exports = {
  start,
  stop,
  restart,
  restartRotate,
  snapshot,
  refreshExpiringTokens,
  runDailyCheckin,
  runKeepalive,
  runModelProbe,
  runRotateAccounts,
  runGrowthAuto,
};
