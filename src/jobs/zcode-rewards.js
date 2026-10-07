'use strict';
/**
 * jobs/zcode-rewards.js — ZCode 限时套餐（赠送额度）定时探测与领取。
 *
 * 时段：每日 00:30 与 21:30（本地时区）各探测一轮。
 *   - 00:30：上游日切后新批次投放（官方权益 period=daily 于 00:00 刷新）
 *   - 21:30：晚间补投窗口（活动包常在晚间二次下发）
 * 时刻可在 .trae-api/zcode-settings.json 或 env 调整（ZCODE_REWARD_*）。
 *
 * 每轮流程（对每账号）：
 *   reportActivation（激活上报，资格信号）→ preview（可领列表）
 *   → 逐个 claim（无感验证码现解）→ 结果落任务日志 + 通知
 *
 * 幂等与安全：
 *   - 已领取（1003）按 already 计，不重复扣、不告警
 *   - 风控（3012）立即中止该账号并通知（不再继续领取）
 *   - 无凭据/无求解器 → 记 failed，不影响其它账号
 */
const store = require('../credentials/store');
const variant = require('../platform/variant');
const { createSettingsStore } = require('../lib/settings-store');
const { runPlanned, localDateKey } = require('../lib/util');
const { appendTaskLog } = require('./task-log');
const { notify } = require('../notify');
const rewards = require('../zcode/rewards');
const captcha = require('../zcode/captcha');

const NAME = 'zcode-settings.json';

const SPECS = {
  enabled: { type: 'bool', env: 'ZCODE_REWARDS_ENABLED', default: false },
  hour1: { env: 'ZCODE_REWARD_HOUR_1', default: 0, min: 0, max: 23 },
  minute1: { env: 'ZCODE_REWARD_MINUTE_1', default: 30, min: 0, max: 59 },
  hour2: { env: 'ZCODE_REWARD_HOUR_2', default: 21, min: 0, max: 23 },
  minute2: { env: 'ZCODE_REWARD_MINUTE_2', default: 30, min: 0, max: 59 },
  // 多账号确定性错峰窗口（分钟）；0=关闭（单账号场景保持原样）
  spreadMinutes: { env: 'ZCODE_REWARD_SPREAD_MINUTES', default: 10, min: 0, max: 240 },
  // 自动领取开关：关闭时只探测并通知「有可领」，不实际 claim
  autoClaim: { type: 'bool', env: 'ZCODE_REWARD_AUTO_CLAIM', default: true },
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

/** 生效配置：文件 > env > 默认。 */
function getEffective() {
  return storeSettings.getEffective();
}

/** 保存配置（白名单 + 夹紧）。 */
function save(partial) {
  const eff = storeSettings.save(partial);
  if (started) schedule();
  return eff;
}

/**
 * ZCode 账号列表（enabled 且 edition=zcode）。
 *
 * 必须经 store.get() 取全量：store.list() 的返回值被 safeTok 剥掉了
 * token/apiKey（对外脱敏），拿它去发上游请求会一律「缺少 JWT 凭据」。
 */
function zcodeAccounts() {
  const ids = store.list()
    .filter((a) => a.enabled && variant.isEdition(a.edition, variant.ZCODE))
    .map((a) => a.id);
  return ids.map((id) => store.get(id)).filter(Boolean);
}

/** 求解器可用性（供面板/路由展示）。 */
function solverStatus() {
  return {
    available: captcha.solverAvailable(),
    dir: captcha.solverDir(),
  };
}

/**
 * 执行一轮「探测 + （可选）领取」。
 * @param {{trigger?:string, claim?:boolean, spreadMinutes?:number}} [opts]
 */
async function runRewards(opts = {}) {
  const trigger = opts.trigger || 'scheduler';
  const eff = getEffective();
  const doClaim = opts.claim != null ? opts.claim : eff.autoClaim;
  const accounts = zcodeAccounts();
  const startedAt = new Date().toISOString();

  if (!accounts.length) {
    const summary = { total: 0, probed: 0, withPlans: 0, claimed: 0, already: 0, failed: 0, risk: 0, skipped: 0 };
    state.lastRunAt = new Date().toISOString();
    state.lastSummary = { ...summary, ranAt: startedAt, trigger };
    console.log(`[zcode-rewards] ${trigger}: 无 ZCode 账号，跳过`);
    return { ...summary, ranAt: startedAt, trigger };
  }

  const summary = {
    total: accounts.length, probed: 0, withPlans: 0,
    claimed: 0, already: 0, failed: 0, risk: 0, skipped: 0,
    claimedPlans: [], failedDetails: [], activationFailures: [],
  };

  const runOne = async (a) => {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await rewards.runForAccount(a, { claim: doClaim });
      summary.probed += 1;
      if (r.error) {
        summary.failed += 1;
        summary.failedDetails.push({ accountId: r.accountId, label: r.label, message: r.error });
        return;
      }
      if (r.plans.length) summary.withPlans += 1;
      if (r.activation && Array.isArray(r.activation.failed) && r.activation.failed.length) {
        summary.activationFailures.push({ accountId: r.accountId, label: r.label, detail: r.activation.failed.join('; ') });
      }
      // 未启用领取时：有可领即计入「skipped」（实际未 claim）
      if (!doClaim) {
        summary.skipped += r.plans.length;
        return;
      }
      for (const c of r.claimed || []) {
        summary.claimed += 1;
        summary.claimedPlans.push({
          accountId: r.accountId, label: r.label,
          planId: c.planId, planName: c.planName,
          grants: (c.grants || []).map((g) => `${g.name} ${g.units} ${g.period}`),
        });
      }
      summary.already += (r.already || []).length;
      summary.failed += (r.failed || []).length;
      for (const f of r.failed || []) {
        summary.failedDetails.push({ accountId: r.accountId, label: r.label, message: f.message });
      }
      if (r.risk) {
        summary.risk += 1;
        summary.failedDetails.push({ accountId: r.accountId, label: r.label, message: r.risk.message, risk: true });
      }
    } catch (e) {
      summary.failed += 1;
      summary.failedDetails.push({ accountId: a.id, label: a.label || a.id, message: e.message });
    }
  };

  const isManual = trigger === 'manual' || trigger === 'manual-e2e';
  const spreadMinutes = isManual
    // 手动触发不参与错峰（用户点「立即领取」期望立刻执行）
    ? 0
    : (opts.spreadMinutes != null ? Number(opts.spreadMinutes) : Number(eff.spreadMinutes) || 0);
  const windowMs = spreadMinutes > 0 ? spreadMinutes * 60 * 1000 : 0;
  const salt = localDateKey();

  console.log(`[zcode-rewards] ${trigger} start: accounts=${accounts.length} claim=${doClaim} spread=${spreadMinutes}min`);
  await runPlanned(accounts, {
    keyOf: (a) => a.id,
    run: runOne,
    salt,
    windowStartMs: Date.now(),
    windowMs,
    gapMs: 2000, // 账号间保底间隔，避免同刻连击
  });

  state.lastRunAt = new Date().toISOString();
  state.lastSummary = { ...summary, ranAt: startedAt, trigger, claim: doClaim };
  state.lastError = summary.failed ? `${summary.failed} 项失败` : null;

  console.log(`[zcode-rewards] ${trigger} done: probed=${summary.probed} withPlans=${summary.withPlans} `
    + `claimed=${summary.claimed} already=${summary.already} failed=${summary.failed} risk=${summary.risk}`);

  // 任务日志（面板「任务日志」可见）
  appendTaskLog({
    task: 'zcode-rewards',
    trigger,
    ok: summary.claimed,
    failed: summary.failed,
    total: summary.total,
    withPlans: summary.withPlans,
    already: summary.already,
    risk: summary.risk,
    claim: doClaim,
    startedAt,
    finishedAt: state.lastRunAt,
    detail: summary.claimedPlans,
  });

  // 通知：领取成功 / 风控 / 失败
  if (summary.claimed) {
    const lines = summary.claimedPlans
      .map((c) => `${c.label}: ${c.planName || c.planId}${c.grants && c.grants.length ? `（${c.grants.join('、')}）` : ''}`)
      .join('\n');
    notify('zcode_reward_claimed', {
      ok: summary.claimed,
      message: lines,
    }, `ZCode 套餐领取成功 ×${summary.claimed}`).catch(() => {});
  }
  if (summary.risk) {
    const first = summary.failedDetails.find((d) => d.risk);
    notify('zcode_reward_risk', {
      accountId: first && first.accountId,
      message: first ? first.message : '账号触发风控',
    }, 'ZCode 账号风控告警').catch(() => {});
  } else if (summary.failed) {
    const first = summary.failedDetails[0];
    notify('zcode_reward_failed', {
      accountId: first && first.accountId,
      message: first ? first.message : '领取失败',
    }, 'ZCode 套餐领取部分失败').catch(() => {});
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

function scheduleOnce(hour, minute, label) {
  const at = nextAt(hour, minute);
  if (!state.nextRunAt || at.getTime() < new Date(state.nextRunAt).getTime()) {
    state.nextRunAt = at.toISOString();
  }
  const delay = Math.max(1000, at.getTime() - Date.now());
  const t = setTimeout(async () => {
    state.nextRunAt = null;
    try {
      await runRewards({ trigger: 'scheduler' });
    } catch { /* logged inside */ }
    if (started) {
      const eff = getEffective();
      scheduleOnce(hour, minute, label);
      void eff;
    }
  }, delay);
  t.unref?.();
  timers.push(t);
  console.log(`[zcode-rewards] next ${label} at ${at.toISOString()} (in ${Math.round(delay / 1000)}s)`);
}

/** 注册每日两个时段（restart 会先清空重排）。 */
function schedule() {
  for (const t of timers) clearTimeout(t);
  timers = [];
  state.nextRunAt = null;
  const eff = getEffective();
  scheduleOnce(eff.hour1, eff.minute1, 'slot-1');
  scheduleOnce(eff.hour2, eff.minute2, 'slot-2');
}

function start() {
  stop();
  const eff = getEffective();
  if (!eff.enabled) {
    console.log('[zcode-rewards] disabled (ZCODE_REWARDS_ENABLED=false 或未配置)');
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
    solver: solverStatus(),
    accounts: zcodeAccounts().length,
  };
}

module.exports = {
  SPECS,
  getEffective,
  save,
  runRewards,
  start,
  stop,
  restart,
  snapshot,
  zcodeAccounts,
  solverStatus,
  FILE: () => storeSettings.FILE(),
};