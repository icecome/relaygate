'use strict';
/**
 * scripts/ops/growth-auto-dryrun.js — 用真实上游只读数据空跑一遍自动编排，
 * 拦截全部写接口（补登/兑换/抽奖/开箱/派猫/领奖/接单），只打印「本会提交什么」。
 *
 * 用途：改了 jobs/growth-auto.js 的补登或兑换逻辑后，先用它核对真实 8 个账号上
 * 的决策是否合理（补哪天、耗几张、该不该停），确认无误再交给调度器实跑。
 * 不消耗任何补登卡、不改动任何账号状态。
 *
 * 用法：node scripts/ops/growth-auto-dryrun.js [--account 18630893389]
 */
const path = require('path');
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || path.resolve(__dirname, '..', '..', 'output');
const store = require('../../src/credentials/store');
const g = require('../../src/workbuddy/cat-trip');
const { runAccount } = require('../../src/jobs/growth-auto');

const argv = process.argv.slice(2);
const ONLY = argv.includes('--account') ? argv[argv.indexOf('--account') + 1] : null;

// 拦写：记录并返回业务常态，绝不落到上游
const writes = [];
const orig = {
  useMakeupCard: g.useMakeupCard,
  redeemTier: g.redeemTier,
  drawLottery: g.drawLottery,
  openBuddyBox: g.openBuddyBox,
  depart: g.depart,
  claimTravelReward: g.claimTravelReward,
  acceptTasks: g.acceptTasks,
};
const DRY = { ok: false, code: 0, result: 'dry_run', reason: 'dry-run 未执行' };
// 幂等键必须真的算出来，才能核对「补登是否已改用「账号+目标日期」派生」。
const { clientToken } = g;
g.useMakeupCard = async (_info, date, opts) => {
  const token = clientToken('makeup', opts && opts.seed);
  writes.push({ api: 'makeup', date, seed: (opts && opts.seed) || null, token });
  return { ...DRY };
};
g.redeemTier = async (_info, tier) => { writes.push({ api: 'redeem', tier }); return { ...DRY }; };
g.drawLottery = async () => { writes.push({ api: 'draw' }); return { ...DRY }; };
g.openBuddyBox = async () => { writes.push({ api: 'open' }); return { ...DRY }; };
g.depart = async () => { writes.push({ api: 'depart' }); return { ...DRY }; };
g.claimTravelReward = async () => { writes.push({ api: 'claim' }); return { ...DRY }; };
// 接单：模拟上游「未就绪」响应（任务需真实操作，dry-run 不应伪装成接单成功）
g.acceptTasks = async (_info, codes) => { writes.push({ api: 'accept', codes }); return { ok: true, results: (codes || []).map((c) => ({ task_code: c, status: 'error', message: 'dry-run' })) }; };

(async () => {
  let accounts = store.list().filter((a) => a.enabled && a.edition === 'workbuddy');
  if (ONLY) accounts = accounts.filter((a) => a.id === ONLY || a.label === ONLY);
  if (!accounts.length) { console.error('没有匹配的启用 WorkBuddy 账号'); process.exit(1); }
  console.log(`dry-run（写接口全部拦截），共 ${accounts.length} 个账号\n`);
  for (const a of accounts) {
    writes.length = 0;
    let r;
    try {
      r = await runAccount(a, {});
    } catch (e) {
      console.log(`\n=== ${a.label}: 异常 ${e.message}`);
      continue;
    }
    const mk = r.actions.filter((x) => x.seg === 'makeup');
    const mkWrites = writes.filter((w) => w.api === 'makeup');
    console.log(`\n=== ${a.label} (${a.id})`);
    console.log(`  本会使用的补登卡：${mkWrites.length ? mkWrites.map((w) => `${w.date}（seed=${w.seed}）`).join('、') : '无'}`);
    console.log(`  makeup 段结论：${mk.length ? mk.map((x) => `[${x.ok ? 'ok' : 'skip'}] ${x.msg}`).join(' ; ') : '（无动作）'}`);
    const others = writes.filter((w) => w.api !== 'makeup').map((w) => w.tier || w.api);
    console.log(`  其余写操作：${others.length ? others.join('、') : '无'}`);
    await new Promise((res) => setTimeout(res, 400));
  }
  Object.assign(g, orig);
  require('../../src/credentials/db').close();
})().catch((e) => { console.error(e); process.exit(1); });
