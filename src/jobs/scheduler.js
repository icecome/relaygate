'use strict';
/**
 * jobs/scheduler.js — 进程内定时：Token 预刷新、每日签到、签到后刷余额、保活、模型探活。
 *
 * 时刻与间隔优先读 .trae-api/scheduler-settings.json，其次 .env，最后默认值。
 * 沿用 trae2api-web 与 Sliverkiss 的「预刷新 + 定时签到 + 保活」模型。
 */
const config = require('../config');
const scheduleSettings = require('./scheduler-settings');
const store = require('../credentials/store');
const auth = require('../auth');
const legacy = require('../lib/auth');
const { checkinAllEnabled } = require('../upstream/checkin');
const { withCheckinRound } = require('../upstream/checkin-lock');
const { wbCheckinAllEnabled } = require('../upstream/wb-checkin');
const { refreshBalanceAllEnabled } = require('../upstream/balance');
const { llmUtilsChat } = require('../upstream/client');
const { isModelConfigError, isPlanLimitError, isModelRateLimitError } = require('../upstream/errors');
const { normalizeTraeMessages } = require('../transform/request');
const wbChat = require('../workbuddy/chat');
const { sleep } = require('../lib/util');
const dailyRunState = require('./daily-run-state');
const pool = require('../credentials/pool');
const availability = require('../models/availability');
const catalog = require('../models/catalog');
const { notify } = require('../notify');
const variant = require('../platform/variant');
const { checkCreditAlerts } = require('./credit-alerts');
const { appendTaskLog } = require('./task-log');
const { appendCheckinTaskLog } = require('./checkin-log');
const schedulerLock = require('./scheduler-lock');

/**
 * 「套餐额度不足」类结论的 TTL（6 小时）。
 *
 * 与模型下线类结论（默认 7 天）分开：PlanLimit（1005）是账号/套餐维度的状态，
 * 换个号或升级套餐立刻可用，按 7 天隐藏会让面板长期看不到一个其实还能用的模型。
 */
const PLAN_LIMIT_TTL_MS = 6 * 3600 * 1000;

let timers = [];
let started = false;
/**
 * 调度代次：每次 stop() 递增。scheduleOnce 的 setTimeout 回调闭包持有注册时的
 * 代次，重排前先比对；不一致说明该次排程属于上一代（stop 前注册、回调已触发但在途），
 * 必须丢弃。否则 restart()（面板保存设置或恢复备份触发）后旧回调复活并与新排程
 * 并存，同一任务每天被触发两次（m-39：日志实测 15 个进程周期出现重复的
 * next checkin/keepalive 排程）。
 */
let scheduleEpoch = 0;
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
  lastGrowthAt: null,
  nextGrowthAt: null,
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

/**
 * 扫描并刷新临期账号 token。
 *
 * 平台判据用 **`tokenRefresh` 能力位**，不再复用 `oauthLogin`。
 * 此前用 oauthLogin 兼作「可续期」，对 Trae / WorkBuddy 恰好成立，但
 * Raccoon 既不是 OAuth 换票（它是扫码登录会话）又**必须**续期
 * （access_token 只有约 3 小时且有 refresh 端点）—— 继续复用会让它的
 * 凭据悄悄过期、续期从不触发，而这类失效没有任何报错。
 * ZCode 两侧都为 false：它的 JWT 无 exp、也不返回 refresh_token。
 */
async function refreshExpiringTokens() {
  // 与每日兜底轮 runKeepalive 共用 keepaliveCandidates()：两处各写一遍过滤
  // 条件正是口径分叉的成因（Raccoon 曾被每日轮整号漏掉）。
  const accounts = keepaliveCandidates();
  let refreshed = 0;
  let failed = 0;
  for (const a of accounts) {
    const full = store.get(a.id);
    if (!full || !full.token) continue;
    if (!isExpiringSoon(full)) continue;
    if (!full.refreshToken) continue;
    try {
      // Raccoon：自有 refresh 端点（POST /api/web/auth/v1/refresh）
      if (variant.isEdition(full.edition, variant.RACCOON)) {
        await require('../raccoon/auth').refreshAccount(full);
        refreshed += 1;
        console.log(`[scheduler] refreshed raccoon token for ${full.label || full.id}`);
        continue;
      }
      // WorkBuddy 与 Trae 刷新端点不同，统一走 ensureAuth（按 edition 分支）。
      //
      // 2026-10-18：variant 已为 WorkBuddy 声明 tokenRefresh，本分支从不可达变为
      // 可达——WB 账号自此同时进入本函数与 runKeepalive 两条续期链路。
      if (full.edition === 'workbuddy') {
        await auth.ensureAuth(full.id);
        refreshed += 1;
        console.log(`[scheduler] refreshed workbuddy token for ${full.label || full.id}`);
        continue;
      }
      // OAuth 账号必须用自身 ClientID/authHost 换新，否则会请求全局默认主机。
      // 账号没记（历史导入账号）时走换票面默认值：authHost 已由
      // lib/auth.getAuthHost() 收敛到变体表 oauthExchange；clientId 仍按
      // lib/auth.exchangeToken 内的默认取 SOLO 线值（与 Trae SOLO 账号绑定）。
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
    // 账号间随机间隔，替代固定 300ms 的整齐节奏
    await sleep(600 + Math.floor(Math.random() * 1600));
  }
  state.lastRefreshAt = new Date().toISOString();
  state.lastError = failed ? `${failed} failed` : null;
  return { refreshed, failed };
}

/**
 * 每日任务：Trae 签到 + WorkBuddy 签到 → 刷余额 → 解冻。
 * 多账号按（日期, 账号 ID）确定性错峰分散，避免固定时刻批量请求上游。
 *
 * 外层套 withCheckinRound：与手动「全部签到」（routes/credentials.js →
 * checkin-all）共用同一把轮级互斥锁。此前两方可同时在跑同一批账号，
 * 各自只看见自己那半边，通知把「今日已全部签完」报成「签到 3 · 已签 5」
 * （2026-11-03 实测，见 upstream/checkin-lock.js 的文件头）。
 *
 * @param {{trigger?:string}} [opts] trigger 用于任务日志与补跑标记
 */
async function runDailyCheckin(opts = {}) {
  const trigger = opts.trigger || 'checkin-chain';
  const out = await withCheckinRound(() => runDailyCheckinInner(trigger), { label: `scheduler:${trigger}` });
  if (out && out.skipped) {
    // 被跳过不算失败，也不标记「今日已跑」：真实那一轮结束时自己会标。
    // 但要写任务日志——否则面板只见成功，看不出这轮没跑。
    console.log('[scheduler] daily checkin skipped: 另一轮签到正在进行');
    appendTaskLog({ task: 'checkin', trigger, ok: 0, failed: 0, total: 0, skipped: 1, reason: 'checkin_round_busy' });
  }
  return out;
}

async function runDailyCheckinInner(trigger) {
  console.log(`[scheduler] daily checkin start (${trigger})`);
  // 起跑即标记本自然日已执行（落盘），供重启后的补跑判据读取。
  // 刻意在真正开始执行时标记、而不是成功后：否则一轮上游故障会让当天反复重试打上游。
  dailyRunState.mark('checkin', { trigger });
  const eff = scheduleSettings.getEffective();
  const checkinSpread = Number(eff.checkinSpreadMinutes) || 0;
  const balanceSpread = Number(eff.balanceSpreadMinutes) || 0;
  // 两侧共用同一窗口起点，保证 Trae 与 WorkBuddy 的分散区间一致
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
    // WorkBuddy 成长中心自动化：旅行（领奖或派猫）、任务、补登、兑换、抽奖、盲盒
    try {
      const { autoRunGrowth } = require('./growth-auto');
      const ga = await autoRunGrowth();
      // 签到链自带一轮成长中心：把 'growth' 一并标记，否则开机时 checkin 与 growth
      // 两条补跑会在同一时刻各起一遍（runGrowthAuto 的幂等靠 client_token 日粒度
      // 种子兜住，不重复入账，但白打一轮上游 + 重复通知）。
      dailyRunState.mark('growth', { trigger: `${trigger}-chain`, ok: ga.okCount, failed: ga.failCount });
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
      appendTaskLog({ task: 'growth-auto', trigger: 'checkin-chain', ok: 0, failed: 1, total: 0, error: e.message });
    }
    state.lastCheckinAt = new Date().toISOString();
    const okCount = (r.ok?.length || 0) + (wb.ok?.length || 0);
    const failedCount = (r.failed?.length || 0) + (wb.failed?.length || 0);
    console.log(`[scheduler] checkin trae ok=${r.ok.length} failed=${r.failed.length} | wb ok=${wb.ok?.length || 0} failed=${wb.failed?.length || 0}`);
    // 签到流程写入任务日志（Trae 与 WorkBuddy 分批）
    if (r.total || r.claimed?.length) appendCheckinTaskLog({ edition: 'trae', batch: r, trigger });
    if (wb.total || wb.claimed?.length || wb.failed?.length) appendCheckinTaskLog({ edition: 'workbuddy', batch: wb, trigger });
    // 签到完成即推送汇总（成功与失败均通知）
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
      // 批量锁被占用（定时刷新正在跑）时会被跳过：此时没有 ok/failed 可读，
      // 直接访问会抛错。跳过不算失败，也不写任务日志与告警。
      if (b && b.skipped) {
        console.log('[scheduler] balance skipped: 另一轮批量刷新进行中');
      } else {
        // item.accountId || item.id：Raccoon 分支历史上返回 store.update() 的账号对象
        // （键是 id 不是 accountId），undefined 传进 unfreezeIfHealthy → store.get(undefined)
        // 会让 node:sqlite 抛「cannot be bound to SQLite parameter 1」，整条解冻+告警链
        // 静默中断 19 天。balance.js 侧已归一形状，这里再兜一层并跳过空值。
        for (const item of b.ok) {
          const id = item.accountId || item.id;
          if (!id) continue;
          pool.unfreezeIfHealthy(id);
        }
        console.log(`[scheduler] balance ok=${b.ok.length} failed=${b.failed.length}`);
        try {
          appendTaskLog({
            task: 'balance-refresh',
            trigger: 'checkin-chain',
            ok: b.ok.length,
            failed: b.failed.length,
            total: b.total,
          });
        } catch { /* 日志失败不影响签到流程 */ }
        try {
          await checkCreditAlerts();
        } catch (e) {
          console.error('[scheduler] credit alerts error', e.message);
        }
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
    state.lastError = `checkin: ${e.message}`;
    console.error('[scheduler] checkin error', e.message);
    throw e;
  }
}

/**
 * 保活候选账号（两条链路的唯一判据，避免口径分叉）。
 *
 * tokenRefresh || oauthLogin：
 * - Trae 两位皆 true；
 * - Raccoon 只有 tokenRefresh（扫码登录会话、非 OAuth，但 access_token
 *   约 3 小时且必须续期）—— 此前 runKeepalive 单独用 oauthLogin 过滤，
 *   把 Raccoon 整号漏掉，每天一次的兜底轮从不覆盖它，也不写保活记录；
 * - WorkBuddy 只有 tokenRefresh（2026-10-18 起。此前两位皆 false，WB 账号
 *   从未被任何续期链路覆盖，上游作废会话时表现为「签到部分账号 401」且无法自愈）；
 * - Qoder / ZCode 两位皆 false（当前不参与定时保活，
 *   判据与刷新端点实证见 platform/variant.js 各 capability 注释）。
 */
function keepaliveCandidates() {
  return store.list().filter((a) => a.enabled
    && (variant.can(a.edition, 'tokenRefresh') || variant.can(a.edition, 'oauthLogin')));
}

async function runKeepalive() {
  console.log('[scheduler] keepalive token refresh start');
  let failed = 0;
  try {
    // 无论是否临期，全部保活候选账号尝试续期（内部按需 refresh）。
    const accounts = keepaliveCandidates();
    // 账号间加随机间隔：固定 200ms 的整齐节奏是上游易识别的机器化特征
    const gapMin = 800;
    const gapMax = 2500;
    for (const a of accounts) {
      try {
        // Raccoon：必须走它自己的续期端点（POST /api/web/auth/v1/refresh）。
        // ensureAuth 没有 raccoon 分支，落到通用 Trae 换票链路会打到
        // api.trae.cn —— 请求错误端点、还把失败记进保活结果，属假信号。
        // 临期判据与 refreshExpiringTokens 同用 isExpiringSoon（24h 前置量）；
        // raccoon 的 access_token 约 3 小时，因此这里实际恒为「临期」。
        if (variant.isEdition(a.edition, variant.RACCOON)) {
          const full = store.get(a.id);
          if (!full) throw new Error('account vanished during keepalive');
          if (isExpiringSoon(full)) {
            await require('../raccoon/auth').refreshAccount(full);
          }
          store.update(a.id, {
            lastKeepaliveAt: new Date().toISOString(),
            lastKeepaliveResult: 'ok',
          });
          continue;
        }
        // ensureAuth 不抛「续期失败」：它吞掉错误后照常返回旧凭据（保证业务可用）。
        // 因此以返回值里的 _refreshError 判定保活结果；只凭「没抛错」记 ok 会把
        // 刷新失败伪装成保活成功（m-35 回归正是这样掩盖了 3 天）。
        const ensured = await auth.ensureAuth(a.id);
        const refreshError = ensured && ensured._refreshError;
        if (refreshError) failed += 1;
        // 保活结果逐账号写入数据库：面板「保活时间」列据此回答
        // 「该账号上次刷新的时间与结果」，而非只有一个全局时间戳
        store.update(a.id, {
          lastKeepaliveAt: new Date().toISOString(),
          lastKeepaliveResult: refreshError
            ? `fail: ${String(refreshError).slice(0, 112)}`
            : 'ok',
        });
        if (refreshError) {
          console.error(`[scheduler] keepalive fail ${a.id}: ${refreshError}`);
          notify('refresh_fail', {
            accountId: a.id,
            label: a.label,
            message: `keepalive: ${refreshError}`,
          }).catch(() => {});
        }
      } catch (e) {
        failed += 1;
        store.update(a.id, {
          lastKeepaliveAt: new Date().toISOString(),
          lastKeepaliveResult: e.message ? `fail: ${e.message}`.slice(0, 120) : 'fail',
        });
        console.error(`[scheduler] keepalive fail ${a.id}: ${e.message}`);
        notify('refresh_fail', {
          accountId: a.id,
          label: a.label,
          message: `keepalive: ${e.message}`,
        }).catch(() => {});
      }
      await sleep(gapMin + Math.floor(Math.random() * (gapMax - gapMin)));
    }
    state.lastKeepaliveAt = new Date().toISOString();
    // 与签到、轮换同一处理方式：结果写任务日志，面板「任务日志」才看得到保活失败
    appendTaskLog({ task: 'keepalive', trigger: 'scheduler', ok: accounts.length - failed, failed, total: accounts.length });
    if (failed) {
      state.lastError = `keepalive: ${failed}/${accounts.length} 个账号刷新失败`;
    }
    return { total: accounts.length, failed };
  } catch (e) {
    state.lastError = `keepalive: ${e.message}`;
    console.error('[scheduler] keepalive error', e.message);
    // catch 中无法取得账号总数（accounts 在 try 内声明），total 用 0 表示未知，与其它任务 catch 约定一致
    appendTaskLog({ task: 'keepalive', trigger: 'scheduler', ok: 0, failed: failed || 1, total: 0, error: e.message });
    return { total: 0, failed: failed || 1, error: e.message };
  }
}

/**
 * 账号轮换：自动部分仅按每日定时（scheduleOnce 的 rotate 时刻）触发，
 * 总开关唯一事实源为 rotate-settings.enabled（m-32 收敛，scheduler-settings
 * 的 rotateEnabled 镜像已移除）。
 * 手动触发（面板「立即轮换一遍」或 POST /rotate/run）传 { manual: true }，
 * 不受任何开关限制：用户点了按钮就是明确意图，开关只约束自动调度。
 */
let rotateTimer = null;
async function runRotateAccounts(opts = {}) {
  const manual = !!(opts && opts.manual);
  if (!manual) {
    const rs = require('./rotate-settings').getEffective();
    if (!rs.enabled) {
      // 跳过也写入任务日志：否则面板「任务日志」只见成功记录，开关被关无从知晓
      appendTaskLog({ task: 'account-rotate', trigger: 'scheduler', ok: 0, failed: 0, total: 0, skipped: 1, reason: 'rotate_disabled' });
      return { ok: 0, failed: 0, skipped: 1, reason: 'rotate_disabled' };
    }
  }
  console.log('[scheduler] account rotate start' + (manual ? ' (manual)' : ''));
  try {
    const rotate = require('./rotate-accounts');
    const r = await rotate.rotateAll();
    state.lastRotateAt = new Date().toISOString();
    console.log(`[scheduler] account rotate done: ok=${r.ok} failed=${r.failed}`);
    try {
      appendTaskLog({ task: 'account-rotate', trigger: manual ? 'manual' : 'scheduler', ok: r.ok, failed: r.failed, total: (r.results || []).length });
    } catch { /* ignore */ }
    /*
     * 轮换结果通知：成功与失败**互斥**地各发一条。
     *
     * 此前的缺口（2026-11-10 修复）：只有 `failed > 0` 才发 rotate_fail，
     * 只有存在 0 分账号才发 rotate_inactive。于是「全部成功 + 所有账号活跃」
     * 这一最理想的情况一条通知都没有，用户无法区分「跑完且正常」与「没跑」。
     *
     * 现在：
     *   failed > 0  → rotate_fail（带失败数与逐账号原因）
     *   failed == 0 → rotate_done（带成功数；不含「是否切回起始号」——
     *                  该状态由 rotate-accounts 内部回滚分支表达，未作为返回值透出）
     * 两者都不与下面的 rotate_inactive 冲突：那条是「活跃度」维度，独立事件。
     */
    if (r.failed) {
      const fails = (r.results || [])
        .filter((x) => x && x.ok === false)
        .map((x) => `${x.label || String(x.uid || '').slice(0, 8)}：${x.msg || '未知原因'}`)
        .slice(0, 5);
      notify('rotate_fail', {
        ok: r.ok,
        failed: r.failed,
        accounts: fails,
        message: `账号轮换 ${r.ok} 个成功 / ${r.failed} 个失败${fails.length ? `；${fails.join('；')}` : ''}`,
      }, '账号轮换部分失败').catch(() => {});
    } else {
      /*
       * 成功路径。
       *
       * ⚠️ 只使用 `rotateAll()` 真实返回的字段：`{ ok, failed, results, skippedUids }`
       * （见 src/jobs/rotate-accounts.js 的 rotateAllInner 末尾）。
       * 这里刻意不渲染「是否已切回起始账号」——那个状态由 rotate-accounts 内部的
       * 回滚分支表达，没有作为返回值透出；凭猜写一个 `r.restored` 会永远显示
       * 「停留在最后一个账号」，比不说更糟。要展示它，先让 rotateAll 返回该字段。
       *
       * `busy:true` 是互斥锁生效时的返回（ok=0 failed=0），它不是「完成」，
       * 必须单列出来，否则会推一条「轮换完成：0 个账号」的误导消息。
       *
       * dedupe:false：每日一次的结论类通知，同一天手动多跑几次时每次都该发出，
       * 被 1 小时去重窗口吞掉就等于「今天没有报告」。
       */
      const skipped = Array.isArray(r.skippedUids) ? r.skippedUids.length : 0;
      if (r.busy) {
        notify('rotate_done', {
          message: '本次触发被跳过：另一轮账号轮换正在进行中。',
        }, '账号轮换未执行（已被另一轮占用）').catch(() => {});
      } else {
        require('../notify').notifyDetail('rotate_done', {
          ok: r.ok,
          failed: 0,
          message:
            `账号轮换完成：${r.ok} 个账号已切换` +
            (skipped ? `，${skipped} 个按排除规则跳过` : '') +
            (r.ok === 0 ? '（未切换任何账号：可能没有可轮换的备份账号）' : ''),
        }, `账号轮换完成：${r.ok} 个账号`, { dedupe: false }).catch(() => {});
      }
    }
    // 轮换跑完后核对当日活跃度：活跃度靠真实使用产生，轮换只负责把客户端
    // 登上去，所以「轮换完成但仍 0 分」的号通常是当天没人用——值得提醒一次。
    // 放在轮换之后而不是别处，是因为此刻客户端刚被逐个登过，数据最新。
    //
    // ⚠️ 这一段**不能阻塞**结果通知：checkStatus 对每个账号打一次上游（15s 超时），
    // 8 个号最坏 120s。实测后果：`rotate_done` 已经发过了没问题，但**活跃度报告**
    // 会把整个 runRotateAccounts 拖长，而调用方（/rotate/run）等的是这个 Promise。
    // 因此这里不 await 它，改为后台跑并把结果写进任务日志与通知。
    // 失败只记 warn，不影响已经确定的轮换结论。
    runRotateHeatmapCheck({ rotate, manual }).catch((e) => {
      console.warn('[scheduler] rotate heatmap check failed:', String(e.message || e).slice(0, 120));
    });
    return r;
  } catch (e) {
    state.lastError = `account-rotate: ${e.message}`;
    console.error('[scheduler] account rotate error', e.message);
    appendTaskLog({ task: 'account-rotate', trigger: manual ? 'manual' : 'scheduler', ok: 0, failed: 1, total: 0, error: e.message });
    return { ok: 0, failed: 1, error: e.message };
  }
}

/**
 * 轮换后的活跃度核对（独立函数，从 runRotateAccounts 里拆出来）。
 *
 * 拆出来的理由有两个，都是实测踩出来的：
 *
 * 1. **不能阻塞轮换结论**：checkStatus 对每个 WorkBuddy 账号打一次
 *    `/activity/growth/heatmap`（15s 超时）。8 个账号最坏 120s。此前它 await 在
 *    runRotateAccounts 里，导致「轮换完成」这个结论要等两分钟才返回，
 *    而 /v1/admin/rotate/run 是同步等这个 Promise 的——面板上表现为长时间无响应。
 * 2. **通知与核对解耦**：rotate_done 描述的是「轮换本身跑完了」，这个事实在
 *    rotateAll() 返回那一刻就已经确定，没有任何理由被下游的网络检查推迟。
 *
 * 判据保持原样：`!isActive && !error` —— 有 error 的账号是「没查到」不是
 * 「0 分」，不能混为一谈（否则上游抖动会推一批假告警）。
 *
 * @param {{rotate:object, manual:boolean}} args
 */
async function runRotateHeatmapCheck({ rotate, manual }) {
  const status = await rotate.checkStatus();
  const inactive = status.filter((s) => !s.isActive && !s.error);
  if (inactive.length) {
    // accounts 必须是数组：notify 的 buildText 对 accounts 做 join（传字符串会抛错）
    const labels = inactive.map((s) => s.label || String(s.uid || '').slice(0, 8));
    const list = labels.join('、');
    console.log(`[scheduler] rotate heatmap: ${status.length - inactive.length}/${status.length} 个账号今日活跃，0 分：${list}`);
    // 每日一次的报告用 dedupe:false：否则同一小时内手动触发过轮换就会把
    // 真正的报告吞进合并桶，用户当天收不到活跃度提醒。
    await require('../notify').notifyDetail('rotate_inactive', {
      total: status.length,
      inactive: inactive.length,
      accounts: labels,
      message: `轮换已跑完，今日活跃度仍为 0 的账号（${inactive.length}/${status.length}）：${list}。活跃度需真实使用客户端产生，建议抽空用这些号聊一句。`,
    }, `轮换后 ${inactive.length} 个账号活跃度为 0`, { dedupe: false });
    appendTaskLog({ task: 'rotate-heatmap', trigger: manual ? 'manual' : 'scheduler', ok: status.length - inactive.length, failed: inactive.length, total: status.length });
  } else if (status.length) {
    console.log(`[scheduler] rotate heatmap: ${status.length}/${status.length} 个账号今日活跃`);
  }
  return { total: status.length, inactive: inactive.length };
}

/** 兼容保留的空实现：旧调用点（restartRotate 与设置保存后的重排）不再需要
 *  重排间隔定时；轮换唯一入口是每日 scheduleOnce('rotate')，由 restart() 统一重排。 */
function scheduleRotatePoll() {
  if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
}

/**
 * 定时模型探活：对 unknown 模型发最小请求，更新可用性。
 *
 * 覆盖两个平台：Trae 目录（裸 ID，走 llmUtilsChat）与 WorkBuddy 目录
 * （wb/ 前缀 ID，走 wbChat 聚合）。此前只探 Trae 目录，导致 wb/* 的 unknown
 * 永远无法自动收敛：一旦被手动探测误标 unavailable，只能等 7 天 TTL 或人工清理。
 *
 * 平台必须显式传给 pool.run：edition 缺省时 pool 只选非 workbuddy 账号，
 * 把 wb 模型发给 Trae 上游只会拿到 PARAM_INVALID 这类「模型不存在」的假结论。
 * 跳过 auto（Trae 虚拟档）；每轮最多 modelProbeMaxPerRun 个（两平台共享额度）。
 */
async function runModelProbe() {
  const maxPerRun = Number(scheduleSettings.getEffective().modelProbeMaxPerRun) || 8;
  if (maxPerRun <= 0) return { probed: 0, usable: 0, unavailable: 0, skipped: 0 };
  console.log(`[scheduler] model probe start (max ${maxPerRun})`);
  try {
    // 无启用账号时整轮跳过：探测会因池空失败，任何错误归类都没有参考价值。
    // 双平台分别判定：只有 Trae 账号时不该探 wb，反之亦然。
    const enabledEditions = new Set(
      store.list().filter((a) => a.enabled).map((a) => variant.normalizeEdition(a.edition)),
    );

    const cat = await catalog.listWithStatus({ force: false });
    const targets = enabledEditions.has('trae')
      ? cat.models
        .filter((m) => m.id && m.id !== 'auto' && !m.custom)
        .filter((m) => availability.statusOf(m.id) === 'unknown')
        .map((m) => ({ id: m.id, platform: 'trae' }))
      : [];

    // WorkBuddy 目录：存在 wb 账号时才纳入探活
    if (enabledEditions.has('workbuddy')) {
      try {
        let wbModels = await wbChat.modelCatalog(false);
        let fromUpstream = wbModels.some((m) => typeof m.chat === 'boolean');
        if (!wbModels.length) {
          wbModels = wbChat.WB_MODELS.map((id) => ({ id, name: id }));
          fromUpstream = false;
        }

        // 目录对账（仅当目录来自上游时）：模型从目录消失后，旧的可用性记录
        // （哪怕是 usable）会一直留着，面板上出现「早不在目录里却仍显示可用」
        // 的僵尸条目（2026-11-08 现场：wb/hy4-preview、wb/glm-5v-turbo、wb/minimax-m3）。
        // Trae 侧**不做**这种对账：get_detail_param 含 hidden 项、且不等于可调用
        // 集合，拿它当存在性权威会误删仍然可用的记录。
        //
        // 安全闸：目录条目过少时跳过对账。上游偶发返回截断列表（部分账号权限不同、
        // 或中间层限流返回残缺 JSON）时，照单对账会把整片记录删光——宁可留着
        // 僵尸条目等下一轮，也不要做一次不可逆的误删。
        const MIN_RECONCILE_SIZE = 10;
        if (fromUpstream && wbModels.length >= MIN_RECONCILE_SIZE) {
          const removed = availability.reconcile('wb/', wbModels.map((m) => 'wb/' + m.id));
          if (removed.length) console.log(`[scheduler] availability reconcile: dropped ${removed.length} stale wb entries: ${removed.join(', ')}`);
        } else if (fromUpstream) {
          console.warn(`[scheduler] availability reconcile skipped: catalog only ${wbModels.length} entries (< ${MIN_RECONCILE_SIZE}), looks truncated`);
        }

        for (const m of wbModels) {
          // 只探对话模型：目录里的图片/视频生成模型（tag = text-to-image /
          // text-to-video，或带 videoGeneration 块）走的是另一套后端，没有 chat
          // 端点。拿 chat 打它们必然 11103「Backend [x] is not supported」，
          // 那是**探活方式错**，不是模型不可用——此前会把它们写进可用性表并
          // 在面板上长期挂红（2026-11-08 现场 4 个）。
          const isChat = typeof m.chat === 'boolean' ? m.chat : wbChat.isChatModel(m);
          if (!isChat) {
            // 媒体模型的历史错误结论一并清掉：它们本就不该有 chat 可用性记录。
            const mediaId = 'wb/' + m.id;
            if (availability.entryOf(mediaId)) {
              availability.reset(mediaId);
              console.log(`[scheduler] availability cleanup: ${mediaId} is a media model (no chat endpoint), dropped stale verdict`);
            }
            continue;
          }
          const id = 'wb/' + m.id;
          if (availability.statusOf(id) !== 'unknown') continue;
          targets.push({ id, platform: 'workbuddy' });
        }
      } catch (e) {
        console.warn('[scheduler] wb catalog unavailable, skip wb probe:', e.message);
      }
    }

    const picked = targets.slice(0, maxPerRun);
    let usable = 0;
    let unavailable = 0;
    for (const t of picked) {
      try {
        if (t.platform === 'workbuddy') {
          await pool.run(async (accountId) => {
            const acct = await auth.ensureAuth(accountId);
            return wbChat.chatAggregate(acct, {
              model: t.id.replace(/^wb\//, ''),
              messages: [{ role: 'user', content: 'ping' }],
              stream: true,
            });
          }, { maxSwitches: 2, edition: 'workbuddy' });
        } else {
          // maxSwitches:2 —— PlanLimit 等账号级错误应换号再试
          await pool.run(
            (accountId) => llmUtilsChat(
              normalizeTraeMessages([{ role: 'user', content: 'ping' }]),
              t.id, false, { accountId },
            ),
            { maxSwitches: 2, edition: 'trae' },
          );
        }
        availability.markUsable(t.id);
        // 平台归属证据：探活结果同时喂给 platform-ownership。
        // 「这个模型 Trae 到底服务不服务」的判定必须有实测证据，不能只靠
        // 会过期的硬编码名单（2026-11-07 事故：WB 静态名单里的 glm-5.3 等
        // 名字 Trae 实测也能调，却被判 WB 独占 → 平台密钥调单个模型全 403）。
        try {
          require('../models/platform-ownership').recordProbe(
            t.id, true, { platform: t.platform === 'workbuddy' ? 'workbuddy' : 'trae' },
          );
        } catch { /* 证据写入失败不影响探活结论 */ }
        usable += 1;
        console.log(`[scheduler] probe ok ${t.id}`);
      } catch (e) {
        // 池空/限流/网络属「本次没探成」，不是模型结论：不写状态表
        if (isModelRateLimitError(e) || e.code === 'POOL_UNAVAILABLE') {
          console.warn(`[scheduler] probe skip ${t.id}: ${e.message}`);
        } else if (isModelConfigError(e)) {
          availability.markUnavailable(t.id, e.message);
          // 模型配置类错误 = 「这个平台确实不服务它」的强证据，同样入归属表
          try {
            require('../models/platform-ownership').recordProbe(
              t.id, false,
              { platform: t.platform === 'workbuddy' ? 'workbuddy' : 'trae', note: e.message },
            );
          } catch { /* ignore */ }
          unavailable += 1;
          console.log(`[scheduler] probe unavailable ${t.id}: ${e.message}`);
        } else if (isPlanLimitError(e)) {
          // 套餐额度不足（1005）是**账号/套餐级**结论，不是模型级结论：
          // 同池其它账号、或该账号升级套餐后就能用。此前按默认 7 天 TTL 写成
          // 不可用并隐藏该模型（2026-11-08 现场：Trae 的 kimi-k3.1-pro 因为一次
          // PlanLimit 被隐藏了一周）。这里给短 TTL，且 reason 前缀标明是「套餐」，
          // 让面板能区分「模型下线」与「当前套餐不含该模型」。
          availability.markUnavailable(t.id, `[套餐层] ${e.message}`, { ttlMs: PLAN_LIMIT_TTL_MS });
          unavailable += 1;
          console.log(`[scheduler] probe plan-limit ${t.id}: ${e.message}`);
        } else {
          // 网络/限流等非模型配置错误：不标记，留待下次
          console.warn(`[scheduler] probe skip ${t.id}: ${e.message}`);
        }
      }
      await sleep(1500);
    }
    state.lastProbeAt = new Date().toISOString();
    state.lastProbeSummary = {
      targets: picked.length,
      usable,
      unavailable,
      unknownLeft: Math.max(0, picked.length - usable - unavailable),
    };
    console.log(`[scheduler] model probe done ${JSON.stringify(state.lastProbeSummary)}`);

    // 自动分层重算：目录或探活状态变化后，自动虚拟模型（vm/*-context）候选随之刷新。
    // 失败不影响探活结果，仅告警。
    try {
      const autotier = require('../model-router/autotier');
      const sync = await autotier.syncAutoTiers({});
      console.log('[scheduler] autotier sync ' + (sync.ok ? 'ok' : 'degraded') + ' ' + JSON.stringify(sync.tiers));
    } catch (e2) {
      console.warn('[scheduler] autotier sync failed:', e2.message);
    }
    return state.lastProbeSummary;
  } catch (e) {
    state.lastError = `model-probe: ${e.message}`;
    console.error('[scheduler] model probe error', e.message);
    appendTaskLog({ task: 'model-probe', trigger: 'scheduler', ok: 0, failed: 1, total: 0, error: e.message });
    return { probed: 0, usable: 0, unavailable: 0, skipped: 1, error: e.message };
  }
}

/**
 * 错过时刻的补跑（关机跨过签到点 → 开机当天必须补上）。
 *
 * 此前的失败模式：nextAt() 只算「今天/明天 HH:mm」，已过点就 +1 天；
 * state.lastCheckinAt 又是进程内变量，重启即失忆。于是「关机 → 次日开机」
 * 这条路径上当天**永远不会**跑签到。实测 2026-10-31 / 11-01 两天
 * task-log 里没有任何 checkin 记录，16 个号的每日积分整天漏领。
 *
 * 判据用落盘的 daily-runs.json（不是 task-log：500 行环形裁剪 + 手动触发写同一
 * task 会污染判据；不是 last_checkin_at：整轮抛错时一行都没写，区分不了
 * 「没跑」与「跑过且失败」）。
 *
 * 只给**有当日价值**的任务补跑：
 *   - checkin：漏一天=少一天积分，必须补。
 *   - growth：派猫旅行/任务奖励同样是当日额度，必须补。
 *   - keepalive / rotate 不补：前者是凭据安全网，scheduleTokenSweep 每 15 分钟
 *     已在扫临期 token，错过 22:00 那一轮不损失任何额度；后者只是把客户端
 *     登上去，补跑没有收益还会在刚开机时抢事件循环。
 *
 * @param {number} hour 计划时刻（本地）
 * @param {number} minute 计划时刻（本地）
 * @param {'checkin'|'growth'} label 任务名，同时作为 daily-runs.json 的键
 * @param {(opts:{trigger:string}) => Promise<any>} fn 实际执行体
 * @param {{delayMs?:number}} [options] delayMs 覆盖开机延迟（测试用；生产默认 60s）
 * @returns {{scheduled:boolean, reason?:string, lagMinutes?:number}} 决策结果（供测试与日志）
 */
function scheduleCatchup(hour, minute, label, fn, options = {}) {
  const due = new Date();
  due.setHours(hour, minute, 0, 0);
  const dueMs = due.getTime();
  if (Date.now() <= dueMs) return { scheduled: false, reason: 'not_due_yet' }; // 还没到点：正常墙钟排程会跑，不补
  if (dailyRunState.ranToday(label)) {
    const last = dailyRunState.lastRun(label);
    console.log(`[scheduler] ${label} 今日已执行（${last.at}），不补跑`);
    return { scheduled: false, reason: 'already_ran_today', lagMinutes: Math.round((Date.now() - dueMs) / 60000) };
  }
  const lagMin = Math.round((Date.now() - dueMs) / 60000);
  // 开机后默认延迟 60s：让 token 预扫与 auth-sync 先把凭据落定，避免拿旧 token 打签到
  const delayMs = Number(options.delayMs) > 0 ? Number(options.delayMs) : 60 * 1000;
  const epoch = scheduleEpoch;
  const t = setTimeout(async () => {
    // 只看代次：stop()/restart() 会递增 scheduleEpoch，本回调随即作废。
    // 刻意不再附加 `started` 条件——本函数唯一的生产调用点在 start() 内，
    // 那时 started 恒为真，加上它只会让这条判据在测试里不可达。
    if (epoch !== scheduleEpoch) return;
    // 到点再判一次：延迟窗口内可能已有别的链路把这件事做了
    //（checkin 补跑链尾就包含成长中心；或用户在这几分钟里手动跑过）。
    // 只在排程时判过一次的话，两条补跑会各跑一遍。
    if (dailyRunState.ranToday(label)) {
      console.log(`[scheduler] ${label} 补跑取消：延迟窗口内今日已执行`);
      return;
    }
    console.log(`[scheduler] ${label} 补跑：计划时刻已过 ${lagMin}min 且今日未执行`);
    try {
      await fn({ trigger: 'catchup' });
    } catch (e) {
      console.error(`[scheduler] ${label} catchup failed: ${e.message}`);
    }
  }, delayMs);
  t.unref?.();
  timers.push(t);
  console.log(`[scheduler] ${label} 已过点 ${lagMin}min 且今日未跑，${delayMs / 1000}s 后补跑`);
  return { scheduled: true, reason: 'catchup_scheduled', lagMinutes: lagMin };
}

function scheduleOnce(hour, minute, label, fn) {
  const at = nextAt(hour, minute);
  if (label === 'checkin') state.nextCheckinAt = at.toISOString();
  if (label === 'keepalive') state.nextKeepaliveAt = at.toISOString();
  if (label === 'rotate') state.nextRotateAt = at.toISOString();
  if (label === 'growth') state.nextGrowthAt = at.toISOString();
  const delay = Math.max(1000, at.getTime() - Date.now());
  const epoch = scheduleEpoch;
  const t = setTimeout(async () => {
    try {
      await fn();
    } catch { /* logged inside */ }
    // 代次不符：本回调属于 stop() 之前的那一代调度，不得复活
    if (started && epoch === scheduleEpoch) scheduleOnce(hour, minute, label, fn);
  }, delay);
  t.unref?.();
  timers.push(t);
  console.log(`[scheduler] next ${label} at ${at.toISOString()} (in ${Math.round(delay / 1000)}s)`);
}

/** 周期扫临期 token（默认 15 分钟，可配）。 */
function scheduleTokenSweep(minutes) {
  const mins = Number(minutes) > 0 ? Number(minutes) : 15;
  const run = () => {
    // 顺带清理到期的访问密钥：rotateKey 的宽限期约定依赖它把 enabled 置 0，
    // 否则面板会把已过期密钥一直显示为启用。鉴权侧 isUsableRow 仍会拒绝，故非阻塞项。
    try { require('../credentials/api-keys').sweepExpired(); } catch (e) {
      console.error('[scheduler] sweep expired keys failed:', e.message);
    }
    refreshExpiringTokens().catch(() => {});
  };
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

async function runGrowthAuto(opts = {}) {
  const trigger = opts.trigger || 'scheduler';
  console.log(`[scheduler] growth auto start (${trigger})`);
  // 起跑即标记今日已执行（与 checkin 同一判据文件），供补跑逻辑读取
  dailyRunState.mark('growth', { trigger });
  try {
    const { autoRunGrowth } = require('./growth-auto');
    const ga = await autoRunGrowth();
    const acted = ga.results.reduce((n, r) => n + r.actions.filter((x) => x.ok && !x.skip).length, 0);
    state.lastGrowthAt = new Date().toISOString();
    if (ga.total > 0) {
      appendTaskLog({
        task: 'growth-auto',
        trigger,
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
    state.lastError = `growth-auto: ${e.message}`;
    console.error('[scheduler] growth auto error', e.message);
    // 整轮抛错时也要落任务日志：否则面板「任务日志」里这条任务永远只有成功记录
    appendTaskLog({ task: 'growth-auto', trigger, ok: 0, failed: 1, total: 0, error: e.message });
    notify('checkin_fail', { message: `成长中心自动化失败：${e.message}` }, '成长中心自动化失败').catch(() => {});
    return { total: 0, okCount: 0, failCount: 1, error: e.message };
  }
}

/**
 * 成长中心独立定时：每天在 growthHour:growthMinute 执行一次
 * （派猫出发 / 领取旅行奖励 / 任务 / 补登 / 兑换 / 抽奖 / 盲盒）。
 *
 * 此前这里是「按进程启动时刻 setInterval 每 N 小时轮询」：间隔锚定在启动时间，
 * 没有任何墙钟时刻可配（面板只有开关 + 间隔），因此进程一旦在夜里启动或夜间被
 * 拉起重启，全天所有轮询都落在半夜，派猫与领奖通知连续打扰。现与 checkin /
 * keepalive / rotate 统一为 scheduleOnce 墙钟排程，时刻可在前台配置（默认 08:00）。
 * 幂等性由 growth-auto 的 client_token 日粒度种子保证，restart 当天重排不会重复入账。
 */
function scheduleGrowthPoll(eff) {
  const enabled = eff.growthPollEnabled !== false && Number(eff.growthPollEnabled) !== 0;
  if (!enabled) {
    console.log('[scheduler] growth poll disabled');
    return;
  }
  scheduleOnce(eff.growthHour, eff.growthMinute, 'growth', runGrowthAuto);
  // 成长中心同样是当日额度（派猫旅行/任务奖励），错过要补
  scheduleCatchup(eff.growthHour, eff.growthMinute, 'growth', runGrowthAuto);
}

function start() {
  if (started || !config.schedulerEnabled) {
    if (!config.schedulerEnabled) console.log('[scheduler] disabled');
    return;
  }
  // 跨进程单实例：两个进程并行调度会让非幂等任务（备份、轮换）重复执行。
  // 拿不到锁时本进程不排程，但 HTTP 服务继续提供（避免整机不可用）。
  const lock = schedulerLock.acquire();
  if (!lock.acquired) {
    console.warn(
      `[scheduler] 另一个实例持有调度锁（pid=${lock.holderPid ?? '?'}，${lock.reason || 'held'}），` +
        '本进程不启动定时任务。若确认那个进程已异常退出，请删除 .trae-api/scheduler.lock 后重启。',
    );
    return;
  }
  started = true;
  const eff = scheduleSettings.getEffective();
  state.schedule = { ...eff };

  // 启动后立刻尝试一次临期刷新
  scheduleTokenSweep(eff.tokenSweepMinutes);

  scheduleOnce(eff.checkinHour, eff.checkinMinute, 'checkin', runDailyCheckin);
  // 关机跨过签到时刻 → 开机补跑（判据见 daily-run-state.js）。
  // 放在 scheduleOnce 之后：两者互不冲突——scheduleOnce 排的是**下一次**到点，
  // 补跑处理的是**今天这一次**已错过且未执行的到点。
  scheduleCatchup(eff.checkinHour, eff.checkinMinute, 'checkin', runDailyCheckin);
  scheduleOnce(eff.keepaliveHour, eff.keepaliveMinute, 'keepalive', runKeepalive);
  // 轮换定时仅看时刻是否排上；执行与否由 runRotateAccounts 内部的
  // rotate-settings.enabled 唯一开关判定（m-32）
  scheduleOnce(eff.rotateHour, eff.rotateMinute, 'rotate', () => runRotateAccounts());
  // 客户端凭据自动同步：用户在客户端登录/续期后，把新 token 自动写回账号池，
  // 免去「解密 + 导入」人工步骤（refreshToken 单次使用，不同步就会拿旧值轮换）。
  try {
    require('./auth-sync').start(config.wbAuthSyncIntervalSec);
  } catch (e) {
    console.warn('[scheduler] auth-sync 启动失败:', String(e.message || e).slice(0, 120));
  }
  scheduleModelProbe(eff);
  // 成长中心（WorkBuddy 派猫旅行等）：每天 growthHour:growthMinute 墙钟一次（默认 08:00）
  scheduleGrowthPoll(eff);
  // ZCode 限时套餐探测与领取由 jobs/zcode-rewards.js 自管两个时段
  // （00:30 与 21:30），此处不重复排程，避免两处时刻定义分叉。
  // Qoder 每日积分（100 Credits）同样由 jobs/qoder-rewards.js 自管时段
  // （默认 10:15，对应上游 UTC+8 10:00 刷新），且 Qoder 未声明
  // capability.checkin，本就不会进入下方 runDailyCheckin 的平台枚举。

  console.log('[scheduler] started (checkin + keepalive + token sweep + model probe + rotate + growth poll)');
}

function stop() {
  started = false;
  // 递增代次：所有已注册排程（含回调已触发、仍在 await 的在途排程）就此作废
  scheduleEpoch += 1;
  if (rotateTimer) {
    clearInterval(rotateTimer);
    rotateTimer = null;
  }
  for (const t of timers) {
    clearTimeout(t);
    clearInterval(t);
  }
  timers = [];
  // 释放跨进程锁：让其它实例可以接管调度
  try {
    schedulerLock.release();
  } catch (e) {
    console.error('[scheduler] lock release failed:', e.message);
  }
}

/** 配置变更后重排定时（保留 started 状态）。 */
function restart() {
  const was = started || config.schedulerEnabled;
  stop();
  if (was) start();
  return snapshot();
}

/** 账号轮换配置热重载：间隔定时已移除，轮换时刻变更需由 restart() 整体重排每日定时。 */
function restartRotate() {
  if (started && config.schedulerEnabled) {
    return restart();
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
    // m-32：rotateEnabled 唯一事实源为 rotate-settings.enabled（下方 rotateSettings
    // 字段），此处不再镜像 scheduler-settings 的同名字段。保留键并指向真实
    // 开关，StatusPage 无需改取值路径。
    rotateEnabled: rotateSettings ? (rotateSettings.enabled ? 1 : 0) : eff.rotateEnabled ?? 1,
    rotateHour: eff.rotateHour,
    rotateMinute: eff.rotateMinute,
    growthPollEnabled: eff.growthPollEnabled,
    growthHour: eff.growthHour,
    growthMinute: eff.growthMinute,
    rotateSettings,
    // 签到轮互斥状态 + 今日执行判据：面板据此回答「今天这一轮到底跑没跑」，
    // 不再只能看进程内 lastCheckinAt（重启即失忆，正是漏签的成因）
    checkinRoundRunning: require('../upstream/checkin-lock').isRoundRunning(),
    dailyRuns: { checkin: dailyRunState.lastRun('checkin'), growth: dailyRunState.lastRun('growth') },
    ...state,
  };
}

module.exports = {
  start,
  stop,
  restart,
  restartRotate,
  snapshot,
  // 导出给测试与面板：补跑决策本身是纯判据（不依赖真实定时器），
  // 不导出的话「关机错过 08:45 会不会补」这条根因就没有可回归的验证面。
  scheduleCatchup,
  dailyRunState,
  refreshExpiringTokens,
  runDailyCheckin,
  runKeepalive,
  runModelProbe,
  runRotateAccounts,
  runGrowthAuto,
};
