'use strict';
/**
 * test/growth-daily.test.js —— 成长每日汇总的归一化口径与缓存。
 * 运行：node src/test/growth-daily.test.js
 *
 * 纯函数测试（normalizeDailyProgress / createDailyProgressCache），不请求上游。
 * 重点验证三条工程纪律：
 *   1. 「没取到」不能被写成 0 或 false（todayActive/streakDays 缺省是 null）；
 *   2. 失败账号标 unavailable，不伪造 ready 空数据；
 *   3. 缓存按 TTL 命中、force 绕过、并发请求共享一次在途查询。
 */
const os = require('os');
const path = require('path');

process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `rg-growth-daily-${Date.now()}`);
process.env.TRAE_API_ENCRYPT_KEY = 'e'.repeat(64);
process.env.LOGS_DIR = path.join(process.env.WORKSPACE_DIR, 'logs');
require('./isolation-guard')('growth-daily');

const assert = require('assert');
const daily = require('../workbuddy/growth-daily');

let pass = 0;
let fail = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }

const SAMPLE_TASKS = [
  {
    task_code: 'chat_5', title: '和 Buddy 聊 5 句', accept_status: 'claimed',
    progress: { current: 5, target: 5 }, reward_credit: 100, reward_energy: 10,
  },
  {
    task_code: 'create_canvas', title: '创建画布', accept_status: 'completed',
    progress: { current: 1, target: 1 }, reward_credit: 50,
  },
  {
    task_code: 'first_buddy', title: '解锁第一个 Buddy', accept_status: 'not_accepted',
    progress: { current: 0, target: 1 }, reward_credit: 200,
  },
  {
    task_code: 'some_manual_thing', title: '去官网填问卷', accept_status: 'in_progress',
    progress: { current: 0, target: 1 }, reward_credit: 0,
  },
];

t('任务进度：claimed/completed/in_progress/not_accepted 四态归一', () => {
  const r = daily.normalizeDailyProgress(SAMPLE_TASKS, { state: 'idle' }, {});
  assert.strictEqual(r.growth.total, 4);
  // claimed 与 completed 都算「已完成」
  assert.strictEqual(r.growth.completed, 2);
  assert.strictEqual(r.growth.ratio, 0.5);
  const byCode = Object.fromEntries(r.growth.tasks.map((x) => [x.taskCode, x]));
  assert.strictEqual(byCode.chat_5.state, 'claimed');
  assert.strictEqual(byCode.create_canvas.state, 'completed');
  assert.strictEqual(byCode.first_buddy.state, 'not_accepted');
  assert.strictEqual(byCode.some_manual_thing.state, 'in_progress');
});

t('奖励口径：claimed 与 pending（已完成未领）分开计数', () => {
  const r = daily.normalizeDailyProgress(SAMPLE_TASKS, { state: 'idle' }, {});
  // 有 credit/energy 的任务共 3 个（chat_5、create_canvas、first_buddy）
  assert.strictEqual(r.rewards.total, 3);
  assert.strictEqual(r.rewards.claimed, 1, '只有 claimed 算已领');
  assert.strictEqual(r.rewards.pending, 1, 'completed 未领算待领');
});

t('自动化名单：名单外的未完成任务进 manualTasks，名单内的不进', () => {
  const r = daily.normalizeDailyProgress(SAMPLE_TASKS, { state: 'idle' }, {});
  assert.ok(r.manualTasks.includes('去官网填问卷'), '名单外未完成任务应列出');
  // first_buddy 只在「锁定集合」里，不在自动化名单：未完成时同样进 manualTasks。
  // 两个集合语义不同——锁定集合决定「Buddy 未解锁时展示哪些任务」，
  // 自动化名单决定「哪些任务可被后台推进」。混为一谈会让 first_buddy 被误标可自动化。
  assert.ok(r.manualTasks.includes('解锁第一个 Buddy'), 'first_buddy 不在自动化名单 → 需真实操作');
  const byCode = Object.fromEntries(r.growth.tasks.map((x) => [x.taskCode, x]));
  assert.strictEqual(byCode.chat_5.automatable, true);
  assert.strictEqual(byCode.first_buddy.automatable, false, 'first_buddy 不是可自动化任务');
  assert.strictEqual(byCode.some_manual_thing.automatable, false);
});

t('旅行三态：idle/traveling/arrived 的进度与 dailyLimit 判定', () => {
  const idle = daily.normalizeDailyProgress([], { state: 'idle' }, {});
  assert.strictEqual(idle.cat.state, 'idle');
  assert.strictEqual(idle.cat.progress, 0);

  const traveling = daily.normalizeDailyProgress([], { state: 'traveling', location: { name: '西湖' } }, {});
  assert.strictEqual(traveling.cat.progress, 1, '旅行中进度满');

  const arrived = daily.normalizeDailyProgress([], { state: 'arrived' }, {});
  assert.strictEqual(arrived.cat.progress, 0.72, '已到达但未领奖的中间态');

  const limited = daily.normalizeDailyProgress([], { state: 'idle', dailyLimitReached: true }, {});
  assert.strictEqual(limited.cat.dailyLimitReached, true);
  assert.strictEqual(limited.cat.progress, 1, '今日次数用完也算「已完成」');
});

t('Buddy 未解锁：available=false → state=locked，不误报 idle', () => {
  const r = daily.normalizeDailyProgress([], { state: 'idle', available: false }, { buddyKnown: true });
  assert.strictEqual(r.cat.state, 'locked');
  assert.strictEqual(r.cat.available, false);
});

t('Buddy 已知但未选：idle + 有候选但无 active → needs_selection', () => {
  const r = daily.normalizeDailyProgress([], { state: 'idle' }, {
    buddyKnown: true, activeBuddy: false, buddies: [{ instanceId: 1, name: 'A' }],
  });
  assert.strictEqual(r.cat.state, 'needs_selection');
});

t('「没取到」必须是 null 而不是 0/false（今日活跃与连登）', () => {
  const r = daily.normalizeDailyProgress([], { state: 'idle' }, {});
  assert.strictEqual(r.active.todayActive, null, '未取到活跃 → null');
  assert.strictEqual(r.active.streakDays, null, '未取到连登 → null');
  assert.strictEqual(r.checkin.source, null);
  assert.strictEqual(r.checkin.checkedIn, false, '签到默认未签（布尔口径，不是 null）');
});

t('取到活跃与连登时按上游值透出', () => {
  const r = daily.normalizeDailyProgress([], { state: 'idle' }, {
    todayActive: true, todayScore: 15, streakDays: 12, checkedIn: true, checkinSource: 'upstream',
  });
  assert.strictEqual(r.active.todayActive, true);
  assert.strictEqual(r.active.todayScore, 15);
  assert.strictEqual(r.active.streakDays, 12);
  assert.strictEqual(r.checkin.checkedIn, true);
  assert.strictEqual(r.checkin.source, 'upstream');
});

t('arriveAt 秒 → 毫秒；非法值不转成 0', () => {
  const r = daily.normalizeDailyProgress([], { state: 'traveling', arriveAt: '1700000000' }, {});
  assert.strictEqual(r.cat.arriveAt, 1700000000000);
  const bad = daily.normalizeDailyProgress([], { state: 'traveling', arriveAt: 'nope' }, {});
  assert.strictEqual(bad.cat.arriveAt, null);
});

t('缓存：TTL 内命中、force 绕过、并发共享一次加载', async () => {
  let loads = 0;
  const cache = daily.createDailyProgressCache(async (key) => {
    loads += 1;
    return { key, loads };
  }, { ttlMs: 60_000 });

  const a = await cache.get('k1');
  assert.strictEqual(a.loads, 1);
  const b = await cache.get('k1');
  assert.strictEqual(b.loads, 1, 'TTL 内第二次应命中缓存');
  assert.strictEqual(loads, 1);

  const c = await cache.get('k1', { force: true });
  assert.strictEqual(c.loads, 2, 'force 应绕过缓存');
  assert.strictEqual(loads, 2);

  // 并发：同一 key 三个请求同时进来，只应触发一次 load
  const before = loads;
  const [x, y, z] = await Promise.all([cache.get('k2'), cache.get('k2'), cache.get('k2')]);
  assert.strictEqual(loads, before + 1, '并发应合并为一次加载');
  assert.strictEqual(x.loads, y.loads);
  assert.strictEqual(y.loads, z.loads);

  assert.strictEqual(cache.size(), 2, '两个 key 各一条缓存');
  cache.clear();
  assert.strictEqual(cache.size(), 0, 'clear 应清空全部');
});

t('缓存：TTL 过期后重新加载', async () => {
  let now = 1000;
  let loads = 0;
  const cache = daily.createDailyProgressCache(async () => ({ n: ++loads }), {
    ttlMs: 5000, now: () => now,
  });
  await cache.get('k');
  now += 6000;
  const again = await cache.get('k');
  assert.strictEqual(again.n, 2, '过期后应重新加载');
});

t('自动化名单与 WorkDaddy 同源（14 个任务码）+ 锁定集合（2 个 Buddy 未解锁任务）分开', () => {
  assert.strictEqual(daily.AUTOMATABLE_TASK_CODES.size, 14);
  for (const code of ['create_canvas', 'template_5', 'chat_5', 'Library_read']) {
    assert.ok(daily.AUTOMATABLE_TASK_CODES.has(code), `${code} 应在名单内`);
  }
  assert.ok(!daily.AUTOMATABLE_TASK_CODES.has('first_buddy'), 'first_buddy 不在自动化名单（锁定集合≠自动化名单）');
  assert.strictEqual(daily.LOCKED_BUDDY_TASK_CODES.size, 2);
  assert.ok(daily.LOCKED_BUDDY_TASK_CODES.has('first_buddy'));
});

/* ---------- 回归：M-R2 成长任务必须走 v2（完整字段），v1 仅作回退 ---------- */

/** 造一个只响应对应 URL 的 fetch 桩；各端点默认回空 data。 */
function growthStub({ v2, v1, buddyInfo }) {
  return async (url) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data }) });
    const notFound = { ok: false, status: 404, text: async () => 'not found' };
    if (u.includes('/v2/activity/growth/tasks')) return v2 ? ok({ tasks: v2 }) : notFound;
    if (u.endsWith('/activity/growth/tasks')) return v1 ? ok({ tasks: v1 }) : notFound;
    if (u.includes('/buddy/info')) return buddyInfo ? ok({ buddy: buddyInfo }) : notFound;
    return ok({});
  };
}

t('[M-R2] v2 可用时：taskCode / 奖励 / automatable 全部有值（此前恒空）', async () => {
  const prev = global.fetch;
  global.fetch = growthStub({
    v2: [
      { task_code: 'chat_5', title: '和 Buddy 聊 5 句', accept_status: 'claimed', progress: { current: 5, target: 5 }, reward_credit: 100, reward_energy: 10, description: '去聊天', valid_end: '2026-12-01' },
      { task_code: 'create_canvas', title: '创建画布', accept_status: 'completed', progress: { current: 1, target: 1 }, reward_credit: 50 },
      { task_code: 'manual_survey', title: '填问卷', accept_status: 'in_progress', progress: { current: 0, target: 1 } },
    ],
    buddyInfo: { name: '喵', rarity: 'R' },
  });
  try {
    const r = await daily.fetchDailyProgress({ accessToken: 't', uid: 'u', region: 'cn' });
    assert.strictEqual(r.taskSource, 'v2');
    assert.deepStrictEqual(r.growth.tasks.map((t) => t.taskCode), ['chat_5', 'create_canvas', 'manual_survey']);
    assert.deepStrictEqual(r.growth.tasks.map((t) => t.automatable), [true, true, false]);
    assert.strictEqual(r.growth.completed, 2);
    assert.deepStrictEqual(r.rewards, { claimed: 1, total: 2, pending: 1, ratio: 0.5 });
    assert.deepStrictEqual(r.manualTasks, ['填问卷']);
    assert.strictEqual(r.growth.tasks[0].guide, '去聊天', 'description 应透出为引导文案');
    assert.strictEqual(r.growth.tasks[0].deadline, '2026-12-01');
  } finally {
    global.fetch = prev;
  }
});

t('[M-R2] v2 不可用时回退 v1：字段映射正确，且如实标注 source=v1 + v2Error', async () => {
  const prev = global.fetch;
  global.fetch = growthStub({
    v1: [
      { code: 'first_chat', title: '完成一次对话', status: 'available' },
      { code: 'daily_5', title: '今日活跃', status: 'completed' },
    ],
  });
  try {
    const r = await daily.fetchDailyProgress({ accessToken: 't', uid: 'u', region: 'cn' });
    assert.strictEqual(r.taskSource, 'v1', '回退必须如实标注来源');
    assert.ok(r.taskV2Error, '应带出 v2 的失败原因供界面提示');
    assert.deepStrictEqual(r.growth.tasks.map((t) => t.taskCode), ['first_chat', 'daily_5'], 'v1 的 code 必须映射成 taskCode');
    assert.strictEqual(r.growth.completed, 1, 'v1 的 status 也能判完成');
    // v1 无奖励字段：计数为 0（不伪造），manualTasks 仍按「未完成 + 不在自动化名单」列出
    assert.strictEqual(r.rewards.total, 0);
    assert.deepStrictEqual(r.manualTasks, ['完成一次对话']);
  } finally {
    global.fetch = prev;
  }
});

t('[M-R2] v2 与 v1 都失败：整账号 unavailable（不返回 ready 空数据）', async () => {
  const prev = global.fetch;
  global.fetch = growthStub({});
  try {
    const r = await daily.fetchDailyProgress({ accessToken: 't', uid: 'u', region: 'cn' });
    assert.strictEqual(r.status, 'unavailable');
    assert.ok(r.reason, '应带失败原因');
  } finally {
    global.fetch = prev;
  }
});

t('[M-R2] 归一化兜底：上游混用 task.code 命名时仍能取出任务码', () => {
  const r = daily.normalizeDailyProgress(
    [{ code: 'chat_5', title: '聊天', status: 'available' }],
    { state: 'idle' },
    {},
  );
  assert.strictEqual(r.growth.tasks[0].taskCode, 'chat_5', 'task_code 缺失时应回退 task.code');
  assert.strictEqual(r.growth.tasks[0].automatable, true, '兜底后仍能命中自动化名单');
});

async function main() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      pass++;
      console.log(`  ok  ${name}`);
    } catch (e) {
      fail++;
      console.error(`FAIL  ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (process.exitCode) process.exit(process.exitCode);
}

main();
