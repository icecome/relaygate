'use strict';
/**
 * jobs/qoder-rewards.js — Qoder 每日积分（100 Credits）定时领取。
 *
 * 时段：每日 10:15（本地时区）执行一轮。
 *   上游规则（官方文案实证，双区域逐字一致）：
 *     「每日 10:00（UTC+8）刷新，领取后 30 天有效」
 *   服务端在 UTC+8 10:00 刷新可领状态，故本地任务排在 10:15 ——
 *   早于 10:00 会拿到「已领取/未刷新」的空列表，晚太多则错过当日。
 *   部署机时区非 UTC+8 时，时刻由用户在设置里调整（QODER_REWARD_*）。
 *
 * 每轮流程（对每个账号）：fetchCampaigns（可领列表）→ 逐个 claim → 通知。
 *
 * 幂等与安全：
 *   - 已领取：上游返回 replayed:true，按 already 计，不重复扣、不告警
 *   - 区域不可用（404/405/410）：记 skipped 并提示，不视为账号故障
 *   - 无凭据或无账号 → 记 skipped，不影响其它账号
 *   - 桌面端头缺失时上游**不报错但返回空列表**，因此空结果也要记日志，
 *     便于区分「真没活动」与「客户端头被过滤」
 */
const store = require('../credentials/store');
const variant = require('../platform/variant');
const { createSettingsStore } = require('../lib/settings-store');
const { runPlanned, localDateKey } = require('../lib/util');
const { appendTaskLog } = require('./task-log');
const { notify } = require('../notify');
const rewards = require('../qoder/rewards');
const local = require('../qoder/local');

const NAME = 'qoder-settings.json';

const SPECS = {
  enabled: { type: 'bool', env: 'QODER_REWARDS_ENABLED', default: false },
  // 每日执行时刻（本地时区）。默认 10:15：上游 UTC+8 10:00 刷新后留 15 分钟余量
  hour: { env: 'QODER_REWARD_HOUR', default: 10, min: 0, max: 23 },
  minute: { env: 'QODER_REWARD_MINUTE', default: 15, min: 0, max: 59 },
  // 多账号确定性错峰窗口（分钟）；0=关闭（单账号场景保持原样）
  spreadMinutes: { env: 'QODER_REWARD_SPREAD_MINUTES', default: 10, min: 0, max: 240 },
  // 自动领取开关：关闭时只探测并通知「有可领」，不实际 claim
  autoClaim: { type: 'bool', env: 'QODER_REWARD_AUTO_CLAIM', default: true },
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
 * Qoder 账号列表（enabled 且 edition=qoder）。
 *
 * 必须经 store.get() 取全量：store.list() 的返回值被 safeTok 剥掉了
 * token（对外脱敏），拿它去发上游请求会一律「缺少访问凭据」。
 */
function qoderAccounts() {
  const ids = store.list()
    .filter((a) => a.enabled && variant.isEdition(a.edition, variant.QODER))
    .map((a) => a.id);
  return ids.map((id) => store.get(id)).filter(Boolean);
}

/** 本机客户端探测状态（供面板展示能否一键导入）。 */
function localClientStatus() {
  const p = local.probeAll();
  return {
    windows: p.windows,
    installed: p.cn.installed || p.intl.installed,
    cn: { installed: p.cn.installed, appDir: p.cn.appDir, version: p.cn.clientVersion, loggedIn: p.cn.loggedIn, error: p.cn.error || null },
    intl: { installed: p.intl.installed, appDir: p.intl.appDir, version: p.intl.clientVersion, loggedIn: p.intl.loggedIn, error: p.intl.error || null },
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
  const accounts = qoderAccounts();
  const startedAt = new Date().toISOString();

  const summary = {
    total: accounts.length, probed: 0, claimed: 0, already: 0, alreadyToday: 0,
    failed: 0, skipped: 0, emptyList: 0,
    claimedDetails: [], failedDetails: [],
  };

  if (!accounts.length) {
    state.lastRunAt = new Date().toISOString();
    state.lastSummary = { ...summary, ranAt: startedAt, trigger };
    console.log(`[qoder-rewards] ${trigger}: 无 Qoder 账号，跳过`);
    return { ...summary, ranAt: startedAt, trigger };
  }

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
      // 上游返回空活动列表：可能是真没活动，也可能是桌面端头被过滤
      // （最难排查的一类失败，必须单独计数）
      if (!r.campaigns.length) summary.emptyList += 1;
      // 列表级「今日已领」：当日积分活动已是 CLAIMED，无需再调 claim
      summary.alreadyToday += (r.alreadyToday || []).length;
      if (!doClaim) {
        summary.skipped += r.claimableCampaigns.length;
        return;
      }
      for (const c of r.claimed || []) {
        summary.claimed += 1;
        summary.claimedDetails.push({
          accountId: r.accountId, label: r.label, realm: r.realm,
          campaignKey: c.campaignKey, amount: c.amount,
          grantId: c.grantId, expiresAt: c.expiresAt,
        });
      }
      summary.already += (r.already || []).length;
      summary.failed += (r.failed || []).length;
      for (const f of r.failed || []) {
        summary.failedDetails.push({ accountId: r.accountId, label: r.label, message: f.message });
      }
    } catch (e) {
      summary.failed += 1;
      summary.failedDetails.push({ accountId: a.id, label: a.label || a.id, message: e.message });
    }
  };

  const isManual = trigger === 'manual';
  const spreadMinutes = isManual
    ? 0  // 手动触发不参与错峰（用户点「立即领取」期望立刻执行）
    : (opts.spreadMinutes != null ? Number(opts.spreadMinutes) : Number(eff.spreadMinutes) || 0);
  const windowMs = spreadMinutes > 0 ? spreadMinutes * 60 * 1000 : 0;
  const salt = localDateKey();

  console.log(`[qoder-rewards] ${trigger} start: accounts=${accounts.length} claim=${doClaim} spread=${spreadMinutes}min`);
  await runPlanned(accounts, {
    keyOf: (a) => a.id,
    run: runOne,
    salt,
    windowStartMs: Date.now(),
    windowMs,
    gapMs: 2000, // 账号间最小间隔，避免同一时刻连续请求
  });

  state.lastRunAt = new Date().toISOString();
  state.lastSummary = { ...summary, ranAt: startedAt, trigger, claim: doClaim };
  state.lastError = summary.failed ? `${summary.failed} 项失败` : null;

  console.log(`[qoder-rewards] ${trigger} done: probed=${summary.probed} claimed=${summary.claimed} `
    + `already=${summary.already} alreadyToday=${summary.alreadyToday} failed=${summary.failed} `
    + `emptyList=${summary.emptyList}`);

  // 任务日志（面板「任务日志」可见）
  appendTaskLog({
    task: 'qoder-rewards',
    trigger,
    ok: summary.claimed,
    failed: summary.failed,
    total: summary.total,
    already: summary.already,
    alreadyToday: summary.alreadyToday,
    skipped: summary.skipped,
    emptyList: summary.emptyList,
    claim: doClaim,
    startedAt,
    finishedAt: state.lastRunAt,
    detail: summary.claimedDetails,
  });

  // 通知：领取成功、失败、今日已领、空列表分别用不同措辞，避免「点了没反应」
  if (summary.claimed) {
    const lines = summary.claimedDetails
      .map((c) => `${c.label}（${c.realm}）: ${c.campaignKey} +${c.amount} credits`)
      .join('\n');
    notify('qoder_reward_claimed', {
      ok: summary.claimed,
      message: lines,
    }, `Qoder 积分领取成功 ×${summary.claimed}`).catch(() => {});
  } else if (summary.failed) {
    const first = summary.failedDetails[0];
    notify('qoder_reward_failed', {
      accountId: first && first.accountId,
      message: first ? first.message : '领取失败',
    }, 'Qoder 积分领取部分失败').catch(() => {});
  } else if (summary.emptyList && summary.probed) {
    // 空列表单独提醒：可能是真没活动，也可能是桌面端头被上游过滤
    notify('qoder_reward_empty', {
      total: summary.probed,
      message: '上游返回空活动列表。若客户端内可见「每天领 100 Credits」，'
        + '请检查桌面端请求头是否被过滤（国际版在服务器部署时可能看不到活动）。',
    }, 'Qoder 未发现可领活动').catch(() => {});
  } else if (summary.alreadyToday && summary.probed) {
    notify('qoder_reward_already', {
      total: summary.alreadyToday,
      message: `今日积分已领取（${summary.alreadyToday}/${summary.probed} 个账号），下次刷新为 UTC+8 明日 10:00。`,
    }, 'Qoder 今日积分已领').catch(() => {});
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
      await runRewards({ trigger: 'scheduler' });
    } catch { /* logged inside */ }
    if (started) scheduleOnce(hour, minute);
  }, delay);
  t.unref?.();
  timers.push(t);
  console.log(`[qoder-rewards] next run at ${at.toISOString()} (in ${Math.round(delay / 1000)}s)`);
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
    console.log('[qoder-rewards] disabled (QODER_REWARDS_ENABLED=false 或未配置)');
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
    accounts: qoderAccounts().length,
    localClient: localClientStatus(),
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
  qoderAccounts,
  localClientStatus,
  FILE: () => storeSettings.FILE(),
};
