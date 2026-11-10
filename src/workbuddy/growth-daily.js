'use strict';
/**
 * workbuddy/growth-daily.js —— 成长中心「每日只读汇总」（对标 WorkDaddy growth-daily.js）。
 *
 * WorkDaddy 的账号页把六类上游只读接口折成一张卡片：
 *   成长任务进度 · 当日签到 · 今日活跃 · 连续活跃天数 · Buddy 解锁 · 旅行状态
 * 本项目原本只有 status-all / overview 两块，缺「任务进度」与「当日签到/活跃」的
 * 合并视图。这里补齐，并保持 WorkDaddy 的三条工程纪律：
 *
 *   1. **只读**：不调任何写接口（不派猫、不领奖、不用补登卡）。写动作仍归
 *      jobs/growth-auto.js 与 /growth/auto。
 *   2. **按账号 TTL 缓存 + 并发合并**：面板每次打开都会拉全池，无缓存时
 *      N 账号 × 6 端点会把上游打满；同一账号的并发请求共享一次在途查询。
 *   3. **失败如实降级为 unavailable**：某账号查询失败只标 unavailable，
 *      不把「没查到」写成 0 分或「未签到」——那会被读成事实。
 *
 * 归一化口径（normalizeDailyProgress）对齐 WorkDaddy：completed/total/ratio、
 * 奖励 claimed/pending、旅行三态 + 进度、可自动化 vs 需真实操作的任务名单。
 */
const g = require('./cat-trip');
const wbAuth = require('./auth');

/**
 * 可被程序推进的成长任务码（与 WorkDaddy AUTOMATABLE_TASK_CODES 同源）。
 * 名单外的未完成任务需要用户在客户端真实操作，界面据此分组，
 * 避免「一键完成」的承诺落在一堆做不到的任务上。
 */
const AUTOMATABLE_TASK_CODES = new Set([
  'create_canvas', 'template_5', 'expert_5', 'Expert_team_use_3',
  'automation_1', 'playbook_prompt', 'Expert_lighthouse', 'Buddy_App',
  'Buddy_App_QQ', 'Hp_Appearance', 'chat_5', 'Model_chat_GLM5.2',
  'black_cat', 'Library_read',
]);

const TASK_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,96}$/;
/** Buddy 未解锁时只应看到这两个任务（其余任务对未解锁账号无意义）。 */
const LOCKED_BUDDY_TASK_CODES = new Set(['first_buddy', 'RichMeow_Chat']);

function ratio(value, total) {
  return total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
}

function nonNegativeNumber(input, fallback = null) {
  const n = Number(input);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function boundedText(input, maxLength) {
  return typeof input === 'string' ? input.trim().slice(0, maxLength) : '';
}

/**
 * 把上游 tasks + travel/status 折成每日进度视图。
 * @param {Array} tasks 上游 data.tasks
 * @param {object} travel 归一化后的 fetchStatus 结果
 * @param {object} options { buddyKnown, activeBuddy, buddies, gacha, lottery, checkedIn, streak, todayActive, fetchedAt }
 */
function normalizeDailyProgress(tasks, travel, options = {}) {
  const list = Array.isArray(tasks) ? tasks.filter((t) => t && typeof t === 'object') : [];
  let completed = 0;
  let rewardTotal = 0;
  let rewardClaimed = 0;
  let rewardPending = 0;
  const manualTasks = [];
  const taskDetails = [];

  for (const task of list) {
    const status = String(task.accept_status || task.status || 'not_accepted');
    const progress = task.progress && typeof task.progress === 'object' ? task.progress : {};
    const current = Math.max(0, Number(progress.current) || 0);
    const target = Math.max(1, Number(progress.target) || 1);
    const isComplete = status === 'completed' || status === 'claimed' || current >= target;
    const state = status === 'claimed' ? 'claimed'
      : isComplete ? 'completed'
        : status === 'not_accepted' ? 'not_accepted'
          : 'in_progress';
    // task_code 是 v2 字段；v1 回退路径由 fetchTasksForProgress 映射成 task_code，
    // 这里再兜一层 task.code 防止上游两代命名混用（字段缺失时归一为 ''，界面不显示假码）。
    const taskCode = String(task.task_code || task.code || '');
    const validCode = TASK_CODE_PATTERN.test(taskCode) ? taskCode : '';
    taskDetails.push({
      taskCode: validCode,
      title: String(task.title || task.task_desc || taskCode || '未识别任务').slice(0, 80),
      guide: boundedText(task.description, 360) || boundedText(task.task_desc, 360),
      tag: boundedText(task.tag, 24),
      deadline: boundedText(task.valid_end, 64) || null,
      reward: {
        credits: nonNegativeNumber(task.reward_credit, 0),
        energy: nonNegativeNumber(task.reward_energy, 0),
        buddy: task.reward_buddy === true,
      },
      current,
      target,
      state,
      automatable: AUTOMATABLE_TASK_CODES.has(validCode),
    });
    if (isComplete) completed++;
    if (Number(task.reward_credit) > 0 || Number(task.reward_energy) > 0) {
      rewardTotal++;
      if (status === 'claimed') rewardClaimed++;
      else if (isComplete) rewardPending++;
    }
    if (!AUTOMATABLE_TASK_CODES.has(validCode) && !isComplete) {
      manualTasks.push(String(task.title || task.task_desc || taskCode || '未识别任务').slice(0, 60));
    }
  }

  const value = travel && typeof travel === 'object' ? travel : {};
  const available = value.available !== false;
  const buddies = Array.isArray(options.buddies) ? options.buddies : [];
  const rawState = String(value.state || 'unknown');
  const state = !available ? 'locked'
    : options.buddyKnown === false ? 'unknown'
      : (options.activeBuddy === false && buddies.length && rawState === 'idle') ? 'needs_selection'
        : rawState;
  const dailyLimitReached = value.dailyLimitReached === true;
  let catProgress = 0;
  if (dailyLimitReached || state === 'traveling') catProgress = 1;
  else if (state === 'arrived') catProgress = 0.72;
  const arriveAtSeconds = Number(value.arriveAt);
  const arriveAt = Number.isFinite(arriveAtSeconds) && arriveAtSeconds > 0
    ? arriveAtSeconds * 1000
    : null;
  const gacha = options.gacha && typeof options.gacha === 'object' ? options.gacha : null;
  const lottery = options.lottery && typeof options.lottery === 'object' ? options.lottery : null;

  return {
    status: 'ready',
    fetchedAt: Number(options.fetchedAt) || Date.now(),
    growth: { completed, total: list.length, ratio: ratio(completed, list.length), tasks: taskDetails.slice(0, 50) },
    rewards: { claimed: rewardClaimed, total: rewardTotal, pending: rewardPending, ratio: ratio(rewardClaimed, rewardTotal) },
    cat: {
      state,
      progress: catProgress,
      arriveAt,
      dailyLimitReached,
      available,
      activeBuddy: options.activeBuddy === true,
      buddies,
      reward: {
        credits: nonNegativeNumber(value.rewardCredit, 0),
        energy: nonNegativeNumber(value.rewardEnergy, 0),
      },
    },
    actions: {
      gacha: {
        available: gacha !== null,
        count: gacha ? nonNegativeNumber(gacha.affordable) : null,
        energy: gacha ? nonNegativeNumber(gacha.balance) : null,
        cost: gacha ? nonNegativeNumber(gacha.cost_per_open) : null,
      },
      lottery: {
        available: lottery !== null,
        count: lottery ? nonNegativeNumber(lottery.balance) : null,
      },
    },
    manualTasks: manualTasks.slice(0, 8),
    // 本项目独有补充：当日签到 + 今日活跃 + 连续活跃（WorkDaddy 账号页同三项）
    checkin: {
      checkedIn: options.checkedIn === true,
      source: options.checkinSource || null,
    },
    active: {
      todayActive: options.todayActive == null ? null : !!options.todayActive,
      todayScore: options.todayScore == null ? null : Number(options.todayScore) || 0,
      streakDays: options.streakDays == null ? null : Number(options.streakDays) || 0,
    },
    // 任务数据来源：v2 = 完整进度与奖励；v1 = 旧端点回退（taskCode 有值但
    // progress/reward 字段上游未提供，计数如实为 0 而非伪造）。界面据此提示。
    taskSource: options.taskSource || null,
    taskV2Error: options.taskV2Error || null,
  };
}

/**
 * 单账号每日进度（只读，六端点并发）。
 * @param {object} info {accessToken, uid, region}
 * @param {{force?:boolean}} [opts]
 */
async function fetchDailyProgress(info, opts = {}) {
  const [tasksR, statusR, quotaR, chancesR, buddyR, checkinR, heatmapR] = await Promise.all([
    // 任务用 v2（任务中心完整字段）；v2 不可用时自动回退 v1 并带 source 标记。
    // 直接用 v1 会拿到 {code,title,status}，task_code/reward_* 全空 —— 进度与奖励恒为 0。
    g.fetchTasksForProgress(info).catch(() => ({ ok: false, reason: 'tasks fail' })),
    g.fetchStatus(info).catch(() => ({ ok: false, reason: 'status fail' })),
    g.fetchBuddyQuota(info).catch(() => null),
    g.fetchLotteryChances(info).catch(() => null),
    g.fetchBuddyInfo(info).catch(() => null),
    wbAuth.checkinStatus(info).catch(() => ({ ok: false, reason: 'checkin status fail' })),
    g.fetchHeatmap(info).catch(() => null),
  ]);

  if (!tasksR.ok) {
    return { status: 'unavailable', fetchedAt: Date.now(), reason: tasksR.reason || '任务查询失败' };
  }

  // Buddy 未解锁的账号只展示解锁相关任务（与 WorkDaddy 同一过滤规则）
  const buddyKnown = !!(buddyR && buddyR.ok);
  const hasBuddy = buddyKnown && !!(buddyR && buddyR.name);
  const allTasks = Array.isArray(tasksR.tasks) ? tasksR.tasks : [];
  const hasVersionedCodes = allTasks.some((t) => t && typeof t.task_code === 'string');
  const visibleTasks = (buddyKnown && !hasBuddy && hasVersionedCodes)
    ? allTasks.filter((t) => LOCKED_BUDDY_TASK_CODES.has(String((t && t.task_code) || '')))
    : allTasks;

  return normalizeDailyProgress(visibleTasks, {
    ...(statusR.ok ? statusR : {}),
    available: buddyKnown ? hasBuddy : undefined,
  }, {
    fetchedAt: Date.now(),
    buddyKnown,
    activeBuddy: hasBuddy,
    buddies: [],
    gacha: quotaR && quotaR.ok ? quotaR : null,
    lottery: chancesR && chancesR.ok ? chancesR : null,
    checkedIn: !!(checkinR && checkinR.ok && checkinR.checkedIn),
    checkinSource: checkinR && checkinR.ok ? 'upstream' : 'unavailable',
    todayActive: heatmapR && heatmapR.ok && heatmapR.today ? heatmapR.today.isActive : null,
    todayScore: heatmapR && heatmapR.ok && heatmapR.today ? heatmapR.today.score : null,
    streakDays: checkinR && checkinR.ok ? (checkinR.streakDays ?? null) : null,
    // 任务数据来源：v2 才有完整进度与奖励；回退 v1 时如实标注，界面据此提示字段缺失。
    taskSource: tasksR.source || null,
    taskV2Error: tasksR.v2Error || null,
    force: !!opts.force,
  });
}

/**
 * 按账号 TTL 缓存 + 在途合并。
 * 与 WorkDaddy createDailyProgressCache 同构，但 load 是异步函数而非 uid→loader 表，
 * 因此 load 由调用方注入（便于测试替换上游）。
 */
function createDailyProgressCache(load, options = {}) {
  const now = options.now || Date.now;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 60000;
  const entries = new Map();
  const pending = new Map();
  const get = (key, detail = {}) => {
    const hit = entries.get(key);
    if (!detail.force && hit && now() < hit.expiresAt) return Promise.resolve(hit.value);
    if (pending.has(key)) return pending.get(key);
    const request = Promise.resolve()
      .then(() => load(key, detail))
      .then((value) => {
        entries.set(key, { value, expiresAt: now() + ttlMs });
        if (entries.size > 500) entries.delete(entries.keys().next().value);
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  };
  return {
    get,
    peek: (key) => (entries.get(key) && entries.get(key).value) || null,
    clear: (key) => (key ? entries.delete(key) : entries.clear()),
    /** 当前缓存条目数（诊断端点用；in-flight 不计入）。 */
    size: () => entries.size,
  };
}

module.exports = {
  AUTOMATABLE_TASK_CODES,
  LOCKED_BUDDY_TASK_CODES,
  normalizeDailyProgress,
  fetchDailyProgress,
  createDailyProgressCache,
};
