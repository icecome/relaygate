'use strict';
/**
 * routes/cat-trip.js —— WorkBuddy 成长中心端点。
 * 挂载前缀：/v1/workbuddy/growth（见 index.js），管理鉴权。
 *
 * 全部直连上游真实接口（见 src/workbuddy/cat-trip.js）：
 *   只读：status / status-all / config / buddy / streak / redeem / chances / tasks
 *   写  ：depart / claim / accept / task-claim / makeup / redeem / draw / buddy-open
 *   编排：auto（旅行 + 任务 + 补登 + 兑换 + 抽奖 + 盲盒一次完成）
 */
const { Router } = require('express');
const g = require('../workbuddy/cat-trip');
const daily = require('../workbuddy/growth-daily');
const store = require('../credentials/store');
const auth = require('../auth');
const wbAuth = require('../workbuddy/auth');
const { notify } = require('../notify');
const { sleep } = require('../lib/util');
const { authenticateAdmin } = require('../middleware/auth');

const router = Router();
const admin = (req, res, next) => authenticateAdmin(req, res, next);

/** 账号 → 上游 info（ensureAuth 已按 edition 刷新 token）。 */
async function toInfo(accountId) {
  const stored = store.get(accountId);
  if (!stored) throw new Error(`account not found: ${accountId}`);
  if (stored.edition !== 'workbuddy') throw new Error('not a workbuddy account');
  const ensured = await auth.ensureAuth(accountId);
  return {
    accessToken: ensured.token || stored.token,
    refreshToken: ensured.refreshToken || stored.refreshToken,
    uid: ensured.userId || stored.userId,
    region: wbAuth.regionOf(ensured.host || stored.host),
  };
}

/**
 * 成长每日汇总缓存（单账号 60s TTL + 在途合并），见 growth-daily.js#createDailyProgressCache。
 * load 闭包按 accountId 取 info，便于测试用同一模块实例替换。
 */
const dailyCache = daily.createDailyProgressCache(async (accountId, detail = {}) => {
  const info = await toInfo(accountId);
  return daily.fetchDailyProgress(info, { force: detail.force });
});
function dailyCacheSize() {
  return dailyCache.size();
}

/** 提取 body.accountId；缺失时回 400 并返回 null。 */
function requireAccount(req, res) {
  const accountId = String((req.body || {}).accountId || '').trim();
  if (!accountId) {
    res.status(400).json({ error: { message: 'accountId required', type: 'invalid_request_error' } });
    return null;
  }
  return accountId;
}

/** 统一的单账号只读/写处理包装。 */
function handle(name, fn) {
  router.post('/' + name, admin, async (req, res) => {
    const accountId = requireAccount(req, res);
    if (!accountId) return;
    try {
      const info = await toInfo(accountId);
      const r = await fn(info, req.body || {}, accountId);
      if (r && r.ok) {
        const msg = r.rewardCredit != null ? `成长奖励/兑换到账（+${r.rewardCredit}）`
          : r.credit != null ? `连登兑换到账（credit ${r.credit}）`
          : r.prize ? `开盲盒获得 ${r.prize}` : null;
        if (msg && ['claim', 'redeem', 'lottery'].includes(name)) {
          notify('growth_claimed', { accountId, message: msg }, 'WorkBuddy 成长奖励').catch(() => {});
        }
      }
      res.json({ object: 'growth_' + name, accountId, ...r });
    } catch (err) {
      res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
    }
  });
}

/** 全部启用账号的旅行状态（只读，有界并发：每账号仍间隔 300ms，避免触发上游限流）。 */
router.post('/status-all', admin, async (req, res) => {
  const accounts = store.list().filter((a) => a.enabled && a.edition === 'workbuddy');
  const data = await mapWithConcurrency(accounts, async (a) => {
    const info = await toInfo(a.id);
    const r = await g.fetchStatus(info);
    return {
      accountId: a.id, label: a.label || a.id, ok: r.ok,
      state: r.ok ? r.state : undefined,
      location: r.ok ? r.location : undefined,
      departAt: r.ok ? r.departAt : undefined,
      arriveAt: r.ok ? r.arriveAt : undefined,
      serverNow: r.ok ? r.serverNow : undefined,
      rewardCredit: r.ok ? r.rewardCredit : undefined,
      dailyLimitReached: r.ok ? r.dailyLimitReached : undefined,
      reason: r.ok ? undefined : r.reason,
    };
  }, 2);
  res.json({ object: 'list', total: accounts.length, data });
});

/** 全部启用账号的成长汇总（只读，有界并发；buddy/能量/连登/抽奖/今日活跃）。 */
router.post('/overview', admin, async (req, res) => {
  const accounts = store.list().filter((a) => a.enabled && a.edition === 'workbuddy');
  const data = await mapWithConcurrency(accounts, async (a) => {
    const info = await toInfo(a.id);
    const [buddy, quota, streak, chances, heatmap] = await Promise.all([
      g.fetchBuddyInfo(info), g.fetchBuddyQuota(info), g.fetchStreak(info), g.fetchLotteryChances(info),
      // 今日活跃是 WorkDaddy 成长面板的核心只读字段（data.today.is_active），
      // 与连登天数并列：连登讲历史连续，is_active 讲今天是否已点亮。
      g.fetchHeatmap(info).catch(() => null),
    ]);
    return {
      accountId: a.id, label: a.label || a.id, ok: true,
      buddyName: buddy.ok ? buddy.name : null,
      rarity: buddy.ok ? buddy.rarity : null,
      energy: quota.ok ? quota.balance : null,
      affordable: quota.ok ? quota.affordable : null,
      streakDays: streak.ok ? streak.days : null,
      makeupCards: streak.ok ? streak.makeupCards : null,
      lotteryChances: chances.ok ? chances.balance : null,
      todayActive: heatmap && heatmap.ok ? !!(heatmap.today && heatmap.today.isActive) : null,
      todayScore: heatmap && heatmap.ok && heatmap.today ? heatmap.today.score : null,
    };
  }, 2);
  res.json({ object: 'list', total: accounts.length, data });
});

/** 有界并发 map：并发度 limit，每个 item 执行 fn 后固定间隔 gapMs 再取下一个。 */
async function mapWithConcurrency(items, fn, limit = 2, gapMs = 300) {
  const out = new Array(items.length);
  let idx = 0;
  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i]);
      } catch (e) {
        out[i] = { accountId: items[i] && items[i].id, label: items[i] && (items[i].label || items[i].id), ok: false, reason: e.message };
      }
      if (gapMs > 0) await sleep(gapMs);
    }
  };
  const workers = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let w = 0; w < n; w++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

/** 上次自动化运行结果（供前端 last_run 展示）。 */
router.post('/last-run', admin, (req, res) => {
  const { readLastRun } = require('../jobs/growth-auto');
  res.json({ object: 'growth_last_run', ...(readLastRun() || { ranAt: null }) });
});

/**
 * 成长每日汇总（只读）：成长任务进度 + 当日签到 + 今日活跃 + 连续活跃 + Buddy + 旅行。
 *
 * 与 WorkDaddy 的 `/api/growth/daily-progress` 同形态：一次请求返回全池视图，
 * 单账号失败只标 unavailable，不把「没查到」写成事实值。查询走 TTL 缓存，
 * 面板每次打开不会把上游打满。
 */
router.post('/daily-progress', admin, async (req, res) => {
  const accounts = store.list().filter((a) => a.enabled && a.edition === 'workbuddy');
  const force = !!(req.body || {}).force;
  const data = await mapWithConcurrency(accounts, async (a) => {
    try {
      const r = await dailyCache.get(a.id, { force });
      return { accountId: a.id, label: a.label || a.id, ...r };
    } catch (e) {
      return { accountId: a.id, label: a.label || a.id, status: 'unavailable', fetchedAt: Date.now(), reason: e.message };
    }
  }, 2);
  res.json({ object: 'list', total: accounts.length, data });
});

/** 缓存状态与清理（面板「刷新」时传 force 即可，不需要手动清缓存）。 */
router.get('/daily-progress/cache', admin, (_req, res) => {
  res.json({ object: 'growth_daily_cache', size: dailyCacheSize() });
});

router.post('/daily-progress/cache/clear', admin, (_req, res) => {
  dailyCache.clear();
  res.json({ ok: true });
});

/** 自动化流程（旅行 + 任务 + 补登 + 兑换 + 抽奖 + 盲盒）。body {accountId?} 缺省处理全部启用账号。
 *  改为后台任务：立即返回 taskId，前端轮询 /progress 获取进度。 */
router.post('/auto', admin, async (req, res) => {
  try {
    const gp = require('../jobs/growth-progress');
    const opts = req.body || {};
    const { taskId } = gp.startAuto(opts);
    res.json({ object: 'growth_auto_task', taskId, startedAt: new Date().toISOString(), progressUrl: `/v1/workbuddy/growth/progress?taskId=${taskId}` });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: { message: err.message, type: status === 409 ? 'conflict_error' : 'internal_error' } });
  }
});

/** 后台任务进度轮询。 */
router.post('/progress', admin, (req, res) => {
  const taskId = String((req.query && req.query.taskId) || (req.body && req.body.taskId) || '').trim();
  if (!taskId) return res.status(400).json({ error: { message: 'taskId required', type: 'invalid_request_error' } });
  const gp = require('../jobs/growth-progress');
  const p = gp.getProgress(taskId);
  if (!p) return res.status(404).json({ error: { message: 'task not found or expired', type: 'not_found' } });
  res.json({ object: 'growth_progress', ...p });
});

/** 最近自动化任务列表。 */
router.post('/progress-list', admin, (req, res) => {
  res.json({ object: 'list', data: require('../jobs/growth-progress').listTasks() });
});

// 只读端点
handle('status', (info) => g.fetchStatus(info));
handle('config', (info) => g.fetchConfig(info));
handle('buddy', (info) => g.fetchBuddyInfo(info));
handle('streak', (info) => g.fetchStreak(info));
handle('redeem', (info) => g.fetchRedeemSummary(info));
handle('chances', (info) => g.fetchLotteryChances(info));
handle('tasks', (info) => g.fetchTasks(info));

// 写端点
handle('depart', (info, body) => g.depart(info, body));
handle('claim', (info) => g.claimTravelReward(info));
handle('buddy-open', (info, body) => g.openBuddyBox(info, body.count || 1));
handle('draw', (info) => g.drawLottery(info));
handle('accept', (info, body) => g.acceptTasks(info, body.task_codes));
handle('task-claim', (info, body) => g.claimTask(info, body.task_code));
handle('makeup', (info, body) => g.useMakeupCard(info, body.target_date));
handle('redeem-tier', (info, body) => g.redeemTier(info, body.tier));

module.exports = router;