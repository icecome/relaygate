'use strict';
/**
 * jobs/raccoon-keepalive.js — 小浣熊每日积分**观测与如实上报**。
 *
 * ## ⚠️ 2026-10-20 订正：本任务**不能**触发每日积分发放（早期设计前提错误）
 *
 * 早期注释写「网关侧代打 grant，等价于替用户当天开一次客户端，把 300 分从
 * 「当天作废」变成「7 天窗口」」——**这个前提是错的**。它来自一个未经
 * 验证的假设（「桌面端每次启动调 grant ⇒ grant 就是发放点」），且与同期
 * 已确认的事实（`desktop/v1/login/points/grant` 是**一次性**端点、没有
 * 每日发放端点）自相矛盾，当时未被发现。
 *
 * 2026-10-19/20 连续两天实测穷举证实：**发放载体是真实客户端登录**。
 *   - 全量账单扫描：10-19/10-20 上游未产生任何 daily_grant / daily_expire；
 *   - 所有可调端点（grant / refresh / balance / catalog / grant+Device-ID）
 *     均不能触发当日发放；
 *   - IAM `last_login_at` 不因网关调用而更新；
 *   - 10-18 两笔 daily_grant 的 `created_at`（22:46:05 / 22:42:24）与客户端
 *     本地 `mcp.system.json` 写盘时刻（22:42:15）精确同步 —— 那是客户端
 *     真实运行时产生的。
 *
 * ## 因此本任务现在的职责是「观测 + 分类上报」，不再声称能延长
 *
 * 每天执行一次，对每个账号调用 `credits.touchDailyKeepalive()`（幂等、无副作用），
 * 按事实把结果分成四类，**绝不伪造 ok**：
 *   - ok                    当日已延长到 7 天
 *   - notExtended           上游发了但仍是 1 天（真异常，告警）
 *   - upstreamSkipped       上游**未产生**当日 daily_grant —— 无可延长对象，
 *                           **不是网关故障**，不告警（10-20 实证踩坑：
 *                           连续两天被误报成「签到失败 ×2」）
 *   - failed                登录请求本身失败（告警）
 *
 * ## 时段
 *
 * 默认每天 09:05（本地时区）。放在早上是为了在 24:00 清零线之前尽早观测；
 * 若上游当日已发放且已延长，越早知道越安心。
 *
 * ## 幂等与安全
 *   - grant 幂等：已领过 `granted:false`，不会重复发分，也不会改当日已发的 expire
 *   - 观测失败不写库、不改状态；upstreamSkipped 不告警；不影响其它账号与任务
 *   - 无 Raccoon 账号 → skipped，不报错
 */
const store = require('../credentials/store');
const variant = require('../platform/variant');
const credits = require('../raccoon/credits');
const { createSettingsStore } = require('../lib/settings-store');
const { runPlanned, localDateKey } = require('../lib/util');
const { appendTaskLog } = require('./task-log');
const { notify } = require('../notify');

const NAME = 'raccoon-settings.json';

const SPECS = {
  enabled: { type: 'bool', env: 'RACCOON_KEEPALIVE_ENABLED', default: false },
  // 默认 09:05：规则 00:00 发放，但实测发放由当天首次登录态请求触发，
  // 放在早上既尽早生效、也远离 24:00 清零线。
  hour: { env: 'RACCOON_KEEPALIVE_HOUR', default: 9, min: 0, max: 23 },
  minute: { env: 'RACCOON_KEEPALIVE_MINUTE', default: 5, min: 0, max: 59 },
  // 多账号确定性错峰窗口（分钟）；0=关闭
  spreadMinutes: { env: 'RACCOON_KEEPALIVE_SPREAD_MINUTES', default: 10, min: 0, max: 240 },
  // 自校验失败后的重试次数（每次间隔 retryGapMs）；0=不重试
  retries: { env: 'RACCOON_KEEPALIVE_RETRIES', default: 1, min: 0, max: 3 },
  retryGapMs: { env: 'RACCOON_KEEPALIVE_RETRY_GAP_MS', default: 3000, min: 500, max: 60_000 },
};

const storeSettings = createSettingsStore({ name: NAME, specs: SPECS });

let timers = [];
let started = false;
const state = {
  lastRunAt: null,
  lastSummary: null,
  nextRunAt: null,
  lastError: null,
};

function getEffective() {
  return storeSettings.getEffective();
}

function save(partial) {
  const eff = storeSettings.save(partial);
  // ⚠️ 不能只判 started：进程启动时 enabled=false 会走到 start() 的提前 return，
  // started 恒为 false；此时用户在面板上首次开启，若只判 started 定时器永不排程，
  // 表现为「开关打开了但每天都不执行」。正确语义：配置保存后按「当前应生效状态」
  // 重排 —— enabled=false 时 stop()，true 时 schedule()。
  if (eff.enabled) {
    started = true;
    schedule();
  } else {
    stop();
  }
  return eff;
}

/** Raccoon 账号列表（enabled 且 edition=raccoon，经 store.get 取全量）。 */
function raccoonAccounts() {
  const ids = store.list()
    .filter((a) => a.enabled && variant.isEdition(a.edition, variant.RACCOON))
    .map((a) => a.id);
  return ids.map((id) => store.get(id)).filter(Boolean);
}

/**
 * 对单个账号做一次保活（含有限重试）。
 *
 * ## 策略（2026-10-20 订正后）
 *
 * 每日积分由**真实登录**触发发放（grant/refresh/balance/catalog 实测均无效）。
 * 因此本任务按优先级尝试：
 *
 * 1. **密码真实登录**（有 `raccoonPassword` 的账号）：`auth.loginWithPassword`
 *    → 触发发放 → 再读当日账单确认有效期。
 * 2. **观测模式**（无密码，如仅扫码/本地导入的账号）：打 grant + 读账单如实上报
 *    （`upstream_not_granted` / `not_extended`），**不伪造成功**。
 *
 * @returns {Promise<{accountId:string,label:string,ok:boolean,reason?:string,
 *                    validityDays?:number|null,expireAt?:string,attempts:number,
 *                    mode?:'password-login'|'observe',message:string}>}
 */
async function keepaliveOne(a, { retries, retryGapMs }) {
  const { sleep } = require('../lib/util');
  let last = null;
  let attempts = 0;
  let mode = 'observe';
  const max = 1 + Math.max(0, Number(retries) || 0);
  // 有密码 = 走密码真实登录（唯一能触发发放的可编程入口）；否则只能观测
  const hasPassword = typeof a.raccoonPassword === 'string' && a.raccoonPassword.length > 0;
  mode = hasPassword ? 'password-login' : 'observe';
  // eslint-disable-next-line no-await-in-loop
  for (let i = 0; i < max; i += 1) {
    if (i > 0) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(Math.max(500, Number(retryGapMs) || 3000));
    }
    attempts = i + 1;
    // eslint-disable-next-line no-await-in-loop
    last = await credits.touchDailyKeepalive(a);
    if (last.ok) break;
    // 幂等：重试无副作用（grant 已领过回 granted:false，密码登录成功才换 token）
  }
  return {
    accountId: a.id,
    label: a.label || a.id,
    ok: !!last.ok,
    reason: last.reason,
    validityDays: last.validityDays,
    expireAt: last.expireAt,
    attempts,
    mode,
    message: last.message,
  };
}

/**
 * 跑一轮保活（全部 enabled 的 Raccoon 账号）。
 * @param {{trigger?:'manual'|'scheduler', spreadMinutes?:number}} [opts]
 */
async function runKeepalive(opts = {}) {
  const trigger = opts.trigger || 'scheduler';
  const eff = getEffective();
  const accounts = raccoonAccounts();
  const startedAt = new Date().toISOString();

  const summary = {
    // skipped 已移除：它从未被任何分支自增，也没被快照/前端消费（面板用的是
    // ok / notExtended / failed / upstreamSkipped 四项）。留着一个恒为 0 的
    // 计数会让读快照的人以为「有跳过逻辑」。
    total: accounts.length, ok: 0, notExtended: 0, failed: 0, upstreamSkipped: 0,
    details: [],
  };
  if (!accounts.length) {
    state.lastRunAt = new Date().toISOString();
    state.lastSummary = { ...summary, ranAt: startedAt, trigger };
    console.log(`[raccoon-keepalive] ${trigger}: 无 Raccoon 账号，跳过`);
    return { ...summary, ranAt: startedAt, trigger };
  }

  const runOne = async (a) => {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await keepaliveOne(a, eff);
      summary.details.push(r);
      if (r.ok) summary.ok += 1;
      else if (r.reason === 'not_extended') summary.notExtended += 1;
      // 上游没发今日 daily_grant：不是失败、也不是我们没延长，而是**无可延长对象**。
      // 单独归类为 upstreamSkipped，不触发告警（见 runKeepalive 末尾通知逻辑）。
      else if (r.reason === 'upstream_not_granted' || r.reason === 'no_daily_grant_today') summary.upstreamSkipped += 1;
      else summary.failed += 1;
    } catch (e) {
      summary.failed += 1;
      summary.details.push({ accountId: a.id, label: a.label || a.id, ok: false, message: e.message });
    }
  };

  const isManual = trigger === 'manual';
  const spreadMinutes = isManual
    ? 0
    : (opts.spreadMinutes != null ? Number(opts.spreadMinutes) : Number(eff.spreadMinutes) || 0);
  const windowMs = spreadMinutes > 0 ? spreadMinutes * 60 * 1000 : 0;
  const salt = localDateKey();

  console.log(`[raccoon-keepalive] ${trigger} start: accounts=${accounts.length} spread=${spreadMinutes}min`);
  await runPlanned(accounts, {
    keyOf: (a) => a.id,
    run: runOne,
    salt,
    windowStartMs: Date.now(),
    windowMs,
    gapMs: 2000,
  });

  state.lastRunAt = new Date().toISOString();
  state.lastSummary = { ...summary, ranAt: startedAt, trigger };
  // ⚠️ 只有「我们该做而没做成」才算异常；上游没发（upstreamSkipped）是上游状态，
  // 不计入 lastError。
  state.lastError = (summary.failed + summary.notExtended) ? `${summary.failed + summary.notExtended} 项未延长/失败` : null;

  console.log(`[raccoon-keepalive] ${trigger} done: ok=${summary.ok} notExtended=${summary.notExtended} upstreamSkipped=${summary.upstreamSkipped} failed=${summary.failed} total=${summary.total}`);

  appendTaskLog({
    task: 'raccoon-keepalive',
    trigger,
    ok: summary.ok,
    failed: summary.failed + summary.notExtended,
    total: summary.total,
    startedAt,
    finishedAt: state.lastRunAt,
    detail: summary.details,
  });

  // 通知策略：只有「我们该做而没做成」才响 —— notExtended / failed 才发。
  // upstreamSkipped（上游未发今日 daily_grant）**不发告警**：那是上游状态，
  // 网关无法干预，每天发一条只会造成「签到坏了」的误判（2026-10-20 实证踩坑）。
  const bad = summary.details.filter((d) => !d.ok && d.reason !== 'upstream_not_granted' && d.reason !== 'no_daily_grant_today');
  if (bad.length) {
    const lines = bad.map((d) => `${d.label}: ${d.message}`).join('\n');
    notify('raccoon_keepalive_fail', {
      failed: bad.length,
      ok: summary.ok,
      message: lines,
    }, `小浣熊每日积分未延长 ×${bad.length}`).catch(() => {});
  }

  return { ...summary, ranAt: startedAt, trigger };
}

/** 计算「今天/明天 HH:mm」的下一时刻。 */
function nextAt(hour, minute) {
  const now = new Date();
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

function scheduleOnce(hour, minute) {
  const at = nextAt(hour, minute);
  if (!state.nextRunAt || at.getTime() < new Date(state.nextRunAt).getTime()) {
    state.nextRunAt = at.toISOString();
  }
  const delay = Math.max(1000, at.getTime() - Date.now());
  const t = setTimeout(async () => {
    state.nextRunAt = null;
    try {
      await runKeepalive({ trigger: 'scheduler' });
    } catch { /* logged inside */ }
    if (started) scheduleOnce(hour, minute);
  }, delay);
  t.unref?.();
  timers.push(t);
  console.log(`[raccoon-keepalive] next run at ${at.toISOString()} (in ${Math.round(delay / 1000)}s)`);
}

/** 注册每日时刻（restart 会先清空重排）。 */
function schedule() {
  for (const t of timers) clearTimeout(t);
  timers = [];
  state.nextRunAt = null;
  const eff = getEffective();
  scheduleOnce(eff.hour, eff.minute);
}

function start() {
  stop();
  const eff = getEffective();
  if (!eff.enabled) {
    console.log('[raccoon-keepalive] disabled (RACCOON_KEEPALIVE_ENABLED=false 或未配置)');
    return;
  }
  started = true;
  schedule();
}

function stop() {
  started = false;
  for (const t of timers) clearTimeout(t);
  timers = [];
  state.nextRunAt = null;
}

/** 配置变更后重排。 */
function restart() {
  stop();
  start();
  return snapshot();
}

function snapshot() {
  return {
    ...getEffective(),
    ...state,
    accounts: raccoonAccounts().length,
  };
}

module.exports = {
  SPECS,
  getEffective,
  save,
  runKeepalive,
  keepaliveOne,
  start,
  stop,
  restart,
  snapshot,
  raccoonAccounts,
  FILE: () => storeSettings.FILE(),
};
