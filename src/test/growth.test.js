'use strict';
// test/growth.test.js——WorkBuddy 成长旅行（status/config/depart/claim）单元测试。
// 运行：node src/test/growth.test.js
// 使用临时 WORKSPACE_DIR，不触碰真实账号库。
const os = require('os');
const path = require('path');
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `growth-test-${Date.now()}`);
process.env.TRAE_API_ENCRYPT_KEY = 'b'.repeat(64);
process.env.API_KEY = 'test-api-key';
process.env.ADMIN_KEY = 'test-admin-key';
require('./isolation-guard')('growth');

const assert = require('assert');

let pass = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }

async function runAll() {
  for (const { name, fn } of queue) {
    try { await fn(); pass++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`FAIL  ${name}: ${e.message}`); process.exitCode = 1; }
  }
}

const { fetchStatus, fetchConfig, depart, claimTravelReward } = require('../workbuddy/cat-trip');

const sig = (code, msg, data) => async () => ({
  status: code === 0 ? 200 : 200,
  ok: true,
  text: async () => JSON.stringify({ code, msg, data }),
});
const authErr = async () => ({ status: 401, ok: false, text: async () => '' });

t('travel/status 解析 idle 与 traveling', async () => {
  const orig = global.fetch;
  global.fetch = sig(0, 'OK', { state: 'idle', buddy_id: 0, record_id: 0, location: null, depart_at: 0, arrive_at: 0, daily_limit_reached: true, duration_hours: 0, reward_credit: 0 });
  const idle = await fetchStatus({ token: 'x', uid: 'u', region: 'cn' });
  assert.strictEqual(idle.ok, true);
  assert.strictEqual(idle.state, 'idle');
  assert.strictEqual(idle.dailyLimitReached, true);

  global.fetch = sig(0, 'OK', { state: 'traveling', buddy_id: 7775236, record_id: 9160325, location: { id: 1, code: 'coffee', name: '咖啡馆', duration_hours: 4 }, depart_at: 100, arrive_at: 200, server_now: 150, reward_credit: 10 });
  const tr = await fetchStatus({ token: 'x', uid: 'u', region: 'cn' });
  assert.strictEqual(tr.ok, true);
  assert.strictEqual(tr.state, 'traveling');
  assert.strictEqual(tr.location.name, '咖啡馆');
  assert.strictEqual(tr.rewardCredit, 10);
  global.fetch = orig;
});

t('travel/config 解析地点目录', async () => {
  const orig = global.fetch;
  global.fetch = sig(0, 'OK', { locations: [{ id: 1, code: 'coffee', name: '咖啡馆', duration_hours_min: 1, duration_hours_max: 4, reward_credit_min: 5, reward_credit_max: 10 }], server_now: 100 });
  const r = await fetchConfig({ token: 'x', uid: 'u', region: 'cn' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.locations.length, 1);
  assert.strictEqual(r.locations[0].code, 'coffee');
  assert.strictEqual(r.locations[0].rewardCreditMax, 10);
  global.fetch = orig;
});

t('depart：参数校验 + 各业务态', async () => {
  const orig = global.fetch;
  const info = { token: 'x', uid: 'u', region: 'cn' };

  // 参数缺省
  const bad = await depart(info, {});
  assert.strictEqual(bad.ok, false);
  assert.match(bad.reason, /location_id/);

  // 成功
  global.fetch = sig(0, 'OK', { state: 'traveling', buddy_id: 1, record_id: 9, location: { id: 1, code: 'coffee', name: '咖啡馆', duration_hours: 2 }, depart_at: 100, arrive_at: 200, reward_credit: 9 });
  const ok = await depart(info, { location_id: 1, duration_hours: 2 });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.result, 'departed');
  assert.strictEqual(ok.rewardCredit, 9);

  // 已在途中 / 每日限制
  global.fetch = sig(400, 'already traveling', null);
  const already = await depart(info, { location_id: 1, duration_hours: 2 });
  assert.strictEqual(already.ok, false);
  assert.strictEqual(already.result, 'already_traveling');

  global.fetch = sig(400, 'daily limit reached', null);
  const daily = await depart(info, { location_id: 1, duration_hours: 2 });
  assert.strictEqual(daily.ok, false);
  assert.strictEqual(daily.result, 'daily_limit');

  // 401
  global.fetch = authErr;
  const e401 = await depart(info, { location_id: 1, duration_hours: 2 });
  assert.strictEqual(e401.ok, false);
  assert.match(e401.reason, /401/);
  global.fetch = orig;
});

t('travel/claim 解析：成功 / 未到达 / 无待领 / 失败', async () => {
  const orig = global.fetch;
  global.fetch = sig(0, 'OK', { state: 'idle', record_id: 9159371, letter: { id: 1, text: '亲爱的铲屎官…' }, reward_credit: 10 });
  const ok = await claimTravelReward({ token: 'x', uid: 'u', region: 'cn' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.recordId, 9159371);
  assert.strictEqual(ok.rewardCredit, 10);

  global.fetch = sig(400, 'not arrived yet', null);
  const na = await claimTravelReward({ token: 'x', uid: 'u', region: 'cn' });
  assert.strictEqual(na.ok, false);
  assert.strictEqual(na.result, 'not_arrived');

  global.fetch = sig(400, 'no unclaimed travel', null);
  const nu = await claimTravelReward({ token: 'x', uid: 'u', region: 'cn' });
  assert.strictEqual(nu.ok, false);
  assert.strictEqual(nu.result, 'no_unclaimed');

  global.fetch = async () => ({ status: 500, ok: false, text: async () => 'boom' });
  const fail = await claimTravelReward({ token: 'x', uid: 'u', region: 'cn' });
  assert.strictEqual(fail.ok, false);
  global.fetch = orig;
});

t('路由可加载并暴露全部端点', () => {
  const r = require('../routes/cat-trip');
  assert.ok(r && typeof r === 'function', 'router factory');
  const methods = (r.stack || []).map((l) => (l.route ? Object.keys(l.route.methods).join(',').toUpperCase() + ' ' + l.route.path : ''));
  const expected = [
    'POST /status', 'POST /status-all', 'POST /config', 'POST /overview', 'POST /auto', 'POST /last-run',
    'POST /depart', 'POST /claim', 'POST /buddy', 'POST /buddy-open', 'POST /streak', 'POST /redeem',
    'POST /redeem-tier', 'POST /makeup', 'POST /chances', 'POST /draw', 'POST /tasks', 'POST /accept', 'POST /task-claim',
  ];
  for (const e of expected) {
    assert.ok(methods.includes(e), `缺少端点 ${e}`);
  }
});

// 新增能力契约：buddy / 任务 / 连登 / 兑换 / 抽奖

const { fetchBuddyQuota, openBuddyBox, fetchTasks, acceptTasks, claimTask, fetchStreak, fetchHeatmap, useMakeupCard, fetchRedeemSummary, redeemTier, fetchLotteryChances, drawLottery } = require('../workbuddy/cat-trip');

t('buddy/quota 与 open 解析', async () => {
  const orig = global.fetch;
  global.fetch = sig(0, 'OK', { affordable: 1, balance: 10, cost_per_open: 10, max_open_count: 5 });
  const q = await fetchBuddyQuota({ token: 'x', uid: 'u', region: 'cn' });
  assert.strictEqual(q.ok, true);
  assert.strictEqual(q.affordable, 1);
  assert.strictEqual(q.costPerOpen, 10);

  global.fetch = sig(0, 'OK', { count: 2, results: [{ instance: { name: '量子喵' } }, { instance: { name: '暴富喵' } }] });
  const ob = await openBuddyBox({ token: 'x', uid: 'u', region: 'cn' }, 2);
  assert.strictEqual(ob.ok, true);
  assert.strictEqual(ob.count, 2);
  assert.deepStrictEqual(ob.names, ['量子喵', '暴富喵']);
  global.fetch = orig;
});

t('tasks 列表 / accept / claim 解析', async () => {
  const orig = global.fetch;
  global.fetch = sig(0, 'OK', { tasks: [{ code: 'first_chat', title: '完成一次对话', status: 'available', level_name: '养虾尝试' }] });
  const tl = await fetchTasks({ token: 'x', uid: 'u', region: 'cn' });
  assert.strictEqual(tl.ok, true);
  assert.strictEqual(tl.tasks[0].code, 'first_chat');

  global.fetch = sig(0, 'OK', { results: [{ task_code: 'first_chat', status: 'error', message: 'task not found' }] });
  const ar = await acceptTasks({ token: 'x', uid: 'u', region: 'cn' }, ['first_chat']);
  assert.strictEqual(ar.ok, true);
  assert.strictEqual(ar.results[0].status, 'error');

  // 空 code 直接拒绝，不发请求
  const bad = await acceptTasks({ token: 'x', uid: 'u', region: 'cn' }, []);
  assert.strictEqual(bad.ok, false);
  assert.match(bad.reason, /task_codes/);

  global.fetch = sig(0, 'OK', { already_claimed: false, credit: 50, energy: 2 });
  const cr = await claimTask({ token: 'x', uid: 'u', region: 'cn' }, 'first_chat');
  assert.strictEqual(cr.ok, true);
  assert.strictEqual(cr.credit, 50);
  assert.strictEqual(cr.energy, 2);
  global.fetch = orig;
});

t('streak / makeup 解析（余额兼容对象与数字）', async () => {
  const orig = global.fetch;
  global.fetch = sig(0, 'OK', {
    streak: { days: 10, month_total_days: 12, next_tier: '14d', next_tier_remaining: 4, makeup_dates: ['2026-09-20'] },
    makeup_cards: { balance: 1, max: 4 },
    redemption_status: { tiers: [{ tier: '7d', days: 7, credit: 0, energy: 2 }] },
  });
  const s = await fetchStreak({ token: 'x', uid: 'u', region: 'cn' });
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.days, 10);
  assert.strictEqual(s.makeupCards, 1);
  assert.deepStrictEqual(s.makeupDates, ['2026-09-20']);

  // 兼容 makeup_cards 为纯数字
  global.fetch = sig(0, 'OK', { streak: { days: 3, makeup_dates: [] }, makeup_cards: 2 });
  const s2 = await fetchStreak({ token: 'x', uid: 'u', region: 'cn' });
  assert.strictEqual(s2.makeupCards, 2);

  global.fetch = sig(0, 'OK', { makeup_cards: { balance: 0 } });
  const mr = await useMakeupCard({ token: 'x', uid: 'u', region: 'cn' }, '2026-09-20');
  assert.strictEqual(mr.ok, true);
  assert.strictEqual(mr.cardsLeft, 0);

  const bad = await useMakeupCard({ token: 'x', uid: 'u', region: 'cn' }, '');
  assert.strictEqual(bad.ok, false);

  // 日期实际已签（streak 与校验不一致）：业务常态 not_broken，不是失败
  global.fetch = sig(400, 'date is not broken, no makeup needed', null);
  const nb = await useMakeupCard({ token: 'x', uid: 'u', region: 'cn' }, '2026-09-14');
  assert.strictEqual(nb.ok, false);
  assert.strictEqual(nb.result, 'not_broken');

  // 其它 400 归为 error
  global.fetch = sig(400, 'invalid target_date', null);
  const er = await useMakeupCard({ token: 'x', uid: 'u', region: 'cn' }, '2026-09-14');
  assert.strictEqual(er.result, 'error');
  global.fetch = orig;
});

t('redeem：tier 白名单 + 403/409 业务态', async () => {
  const orig = global.fetch;
  const info = { token: 'x', uid: 'u', region: 'cn' };

  // 非法 tier 直接拒绝
  const bad = await redeemTier(info, 14);
  assert.strictEqual(bad.ok, false);
  assert.match(bad.reason, /7d\/14d\/28d/);

  global.fetch = sig(403, '连续登录天数不足，请继续打卡或使用补签卡', null);
  const locked = await redeemTier(info, '14d');
  assert.strictEqual(locked.ok, false);
  assert.strictEqual(locked.result, 'tier_locked');

  global.fetch = sig(409, '该档位本月已兑换', null);
  const dup = await redeemTier(info, '7d');
  assert.strictEqual(dup.ok, false);
  assert.strictEqual(dup.result, 'already_redeemed');

  global.fetch = sig(0, 'OK', { starter_status: 'claimed', advanced_status: 'locked', legendary_status: 'locked', remaining_days: 10 });
  const rs = await fetchRedeemSummary(info);
  assert.strictEqual(rs.ok, true);
  assert.strictEqual(rs.tiers[0].tier, '7d');
  assert.strictEqual(rs.tiers[0].status, 'claimed');
  assert.strictEqual(rs.tiers[1].status, 'locked');
  global.fetch = orig;
});

t('lottery：次数与抽奖（无机会为业务常态）', async () => {
  const orig = global.fetch;
  const info = { token: 'x', uid: 'u', region: 'cn' };
  global.fetch = sig(0, 'OK', { balance: 3 });
  const ch = await fetchLotteryChances(info);
  assert.strictEqual(ch.ok, true);
  assert.strictEqual(ch.balance, 3);

  global.fetch = sig(0, 'OK', { prize_name: '冰箱贴', need_address: true });
  const dr = await drawLottery(info);
  assert.strictEqual(dr.ok, true);
  assert.strictEqual(dr.prize, '冰箱贴');
  assert.strictEqual(dr.needAddress, true);

  global.fetch = sig(400, 'insufficient lottery chance balance', null);
  const no = await drawLottery(info);
  assert.strictEqual(no.ok, false);
  assert.strictEqual(no.result, 'no_chance');
  global.fetch = orig;
});

t('claim 中 403 不再被误判为登录失效', async () => {
  const orig = global.fetch;
  // 403 是业务语义，不能当成 auth 错误吞掉
  global.fetch = async () => ({ status: 403, ok: false, text: async () => JSON.stringify({ code: 403, msg: '天数不足' }) });
  const r = await redeemTier({ token: 'x', uid: 'u', region: 'cn' }, '7d');
  assert.strictEqual(r.result, 'tier_locked');
  assert.strictEqual(r.reason, '天数不足');
  global.fetch = orig;
});

// ── 补登自动化（jobs/growth-auto.js 的 makeup 段）──
// 2026-10-30 实测教训固化为契约：
//   1) 候选日必须取 heatmap 的 0 分日——/streak 的 makeup_dates 会残留已补日期、
//      又漏掉真正断登日，八个账号全被它误导成「无需补登」；
//   2) 每张卡的幂等键按「账号+目标日期」派生——此前共用「账号+当天」的 seed，
//      同日第二张卡被上游去重静默吞掉；
//   3) 无待解锁档位时不耗卡。

function makeupMocks(h) {
  const now = new Date();
  const dk = (i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const y = d.getFullYear();
    return `${y}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const json = (code, msg, data) => ({ status: 200, ok: true, text: async () => JSON.stringify({ code, msg, data }) });
  const state = { used: 0, makeupBodies: [], cardStart: 1, daysStart: 27, ...h };
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/buddy/travel/status')) return json(0, 'OK', { state: 'traveling', location: { name: '咖啡馆' } });
    if (u.endsWith('/tasks')) return json(0, 'OK', { tasks: [] });
    if (u.endsWith('/heatmap')) {
      if (state.heatmapFail) return json(500, 'upstream boom', null);
      return json(0, 'OK', {
        cells: [
          { date: dk(1), score: 0 }, { date: dk(2), score: 0 },
          { date: '2026-01-01', score: 0 }, // 窗口外的老断登日：补了也进不了连登段
          { date: dk(3), score: 5 },
        ],
        today: { date: dk(0), score: 0, is_active: false },
      });
    }
    if (u.endsWith('/streak')) {
      return json(0, 'OK', {
        streak: { days: state.daysStart + state.used, month_total_days: state.daysStart + state.used, makeup_dates: state.streakDates || [] },
        makeup_cards: { balance: Math.max(0, state.cardStart - state.used) },
        redemption_status: {},
      });
    }
    if (u.endsWith('/redeem/summary')) {
      return json(0, 'OK', {
        starter_status: 'claimed', advanced_status: 'claimed',
        legendary_status: state.legendary || 'locked', remaining_days: state.daysStart + state.used,
      });
    }
    if (u.endsWith('/makeup-cards/use')) {
      const b = JSON.parse(opts.body);
      state.makeupBodies.push(b);
      if ((state.acceptDates || [dk(1)]).includes(b.target_date) && state.used < (state.maxUse || 1)) {
        state.used += 1;
        return json(0, 'OK', { makeup_cards: { balance: Math.max(0, state.cardStart - state.used) } });
      }
      return json(400, 'date is not broken, no makeup needed', null);
    }
    if (u.endsWith('/lottery/chances')) return json(0, 'OK', { balance: 0 });
    if (u.endsWith('/buddy/quota')) return json(0, 'OK', { balance: 0, affordable: 0 });
    throw new Error('unmocked url: ' + u);
  };
  return state;
}

async function runMakeupCase(h) {
  const g = require('../workbuddy/cat-trip');
  const authMod = require('../auth');
  const storeMod = require('../credentials/store');
  const { runAccount } = require('../jobs/growth-auto');
  const origFetch = global.fetch;
  const origGet = storeMod.get;
  const origEnsure = authMod.ensureAuth;
  storeMod.get = () => ({ id: 'acct_mk', token: 't', refreshToken: 'r', userId: 'u', host: 'https://copilot.tencent.com' });
  authMod.ensureAuth = async () => ({ token: 't', refreshToken: 'r', userId: 'u', host: 'https://copilot.tencent.com' });
  try {
    const state = makeupMocks(h);
    const r = await runAccount({ id: 'acct_mk', label: 'mk' }, {});
    return { r, state, g };
  } finally {
    global.fetch = origFetch;
    storeMod.get = origGet;
    authMod.ensureAuth = origEnsure;
  }
}

t('makeup 段：候选日取 heatmap 断登日而非 makeup_dates；卡按目标日期独立幂等键', async () => {
  const { localDateKey } = require('../lib/util');
  const now = new Date();
  const d1 = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const { r, state, g } = await runMakeupCase({
    // 上游候选里只有 stale（假候选），真缺口（heatmap 的 0 分日）不在里面
    streakDates: ['2025-12-31'],
    acceptDates: [d1],
  });
  const mk = r.actions.filter((x) => x.seg === 'makeup');
  assert.ok(mk.some((x) => x.ok && !x.skip && x.msg.includes(d1)), `应补登 heatmap 缺口 ${d1}，实际：${JSON.stringify(mk)}`);
  assert.strictEqual(state.makeupBodies.length, 1, '达标即停，不多耗卡');
  assert.strictEqual(state.makeupBodies[0].target_date, d1);
  assert.strictEqual(
    state.makeupBodies[0].client_token,
    g.clientToken('makeup', `acct_mk|makeup|${d1}`),
    '幂等键必须按「账号+目标日期」派生（同日两张卡互不吞掉）',
  );
  assert.notStrictEqual(
    state.makeupBodies[0].client_token,
    g.clientToken('makeup', `acct_mk|${localDateKey()}`),
    '不得再共用「账号+当天」的种子',
  );
});

t('makeup 段：heatmap 查询失败时退回 makeup_dates 兜底候选', async () => {
  const { r, state } = await runMakeupCase({
    heatmapFail: true,
    streakDates: ['2025-12-31'],
    acceptDates: ['2025-12-31'],
  });
  const mk = r.actions.filter((x) => x.seg === 'makeup');
  assert.ok(mk.some((x) => x.ok && !x.skip && x.msg.includes('2025-12-31')), `兜底应补 makeup_dates，实际：${JSON.stringify(mk)}`);
  assert.strictEqual(state.makeupBodies.length, 1);
});

t('makeup 段：无待解锁档位时不耗卡', async () => {
  const { r, state } = await runMakeupCase({ legendary: 'claimed' });
  assert.strictEqual(state.makeupBodies.length, 0, '三档全 claimed 却补登 = 浪费卡');
  const mk = r.actions.filter((x) => x.seg === 'makeup');
  assert.ok(mk.some((x) => x.skip && /不耗卡/.test(x.msg)), `应记录跳过，实际：${JSON.stringify(mk)}`);
});

t('makeup 段：同日连补两张卡幂等键互不相同（旧 seed 会被上游去重吞掉）', async () => {
  const { localDateKey } = require('../lib/util');
  const now = new Date();
  const dk = (i) => localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
  const g = require('../workbuddy/cat-trip');
  const { r, state } = await runMakeupCase({
    cardStart: 2, daysStart: 26, // 差 2 天才到 28 档
    acceptDates: [dk(1), dk(2)], maxUse: 2,
  });
  assert.strictEqual(state.makeupBodies.length, 2, '应连用两张卡补到 28 天');
  const dates = state.makeupBodies.map((b) => b.target_date);
  assert.deepStrictEqual(dates, [dk(1), dk(2)], '从最近的断登日补起（延长连登段）');
  const tokens = state.makeupBodies.map((b) => b.client_token);
  assert.notStrictEqual(tokens[0], tokens[1], '不同目标日期必须拿到不同幂等键');
  assert.strictEqual(tokens[0], g.clientToken('makeup', `acct_mk|makeup|${dk(1)}`), '键仍按「账号+目标日期」稳定派生（重跑同一天去重）');
  const mk = r.actions.filter((x) => x.seg === 'makeup' && x.ok && !x.skip);
  assert.strictEqual(mk.length, 2);
});

t('fetchHeatmap 解析热力墙 cells 与 today', async () => {
  const orig = global.fetch;
  global.fetch = sig(0, 'OK', {
    cells: [{ date: '2026-10-30', score: 2, has_new_buddy: true }, { date: '2026-10-29', score: 0 }],
    today: { date: '2026-10-30', score: 2, is_active: true, status_text: '今日已活跃' },
    updated_at: '2026-10-30T22:00:00+08:00',
  });
  const h = await fetchHeatmap({ token: 'x', uid: 'u', region: 'cn' });
  assert.strictEqual(h.ok, true);
  assert.strictEqual(h.cells.length, 2);
  assert.strictEqual(h.cells[0].score, 2);
  assert.strictEqual(h.cells[0].hasNewBuddy, true);
  assert.strictEqual(h.cells[1].score, 0);
  assert.strictEqual(h.today.isActive, true);
  global.fetch = orig;
});

async function main() {
  await runAll();
  console.log(`\n${pass} passed`);
  if (process.exitCode) process.exit(process.exitCode);
}

main();