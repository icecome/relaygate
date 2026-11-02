'use strict';
/**
 * jobs/growth-auto.js — WorkBuddy 成长中心全自动编排。
 *
 * 对每个启用的 WorkBuddy 账号按顺序执行（各段独立 try，一段失败不影响其余）：
 *   1. 旅行：state 权威三态 → arrived 领奖 / traveling 等待 / idle 派出发 / 已达次数收工
 *   2. 任务：available 接单 → completed 领奖
 *   3. 补登：补到「最低未领档位的要求天数」为止；候选日以 heatmap 0 分日为准
 *      （/streak 的 makeup_dates 会残留已补日期、漏掉真缺口，仅作兜底）；
 *      每张卡按「账号+目标日期」独立幂等键，同日重跑去重、不同日互不吞掉
 *   4. 连登兑换：非 claimed/locked 的档位尝试兑换（403 未解锁、409 已兑换均为业务常态）
 *   5. 抽奖：有次数才抽（每轮最多 1 次，写路径不可逆）
 *   6. Buddy 盲盒：能量够 cost_per_open 才开
 * 所有写接口带 client_token 幂等键；结果汇总返回，供路由与通知使用。
 */
const store = require('../credentials/store');
const auth = require('../auth');
const wbAuth = require('../workbuddy/auth');
const g = require('../workbuddy/cat-trip');
const { sleep, localDateKey } = require('../lib/util');
const { notify } = require('../notify');
const { writeJsonAtomic } = require('../lib/atomic-write');
const fs = require('fs');
const { stateFile, resolveStateFileForRead } = require('../lib/paths');

const GAP_MS = 400;
// 单账号单轮最多消耗的补登卡数。此前为 1，两个原因叠加导致补不上缺口：
//   1) 幂等键按「账号+当天」派生，同日第二次用卡被上游去重静默吞掉（现在
//      种子改为「账号+目标日期」，见下方补登段，同轮多张互不吞掉）；
//   2) 28 天档位按连登天数判定，孤立断登段起点之前往往连着好几天都缺，
//      一轮只补 1 张追不上。上限取 8（上游 makeup_cards.max 实测 4，留余量）。
const MAKEUP_MAX_PER_RUN = 8;
const RUN_LOG = () => stateFile('growth-last-run.json');
const readRunLog = () => resolveStateFileForRead('growth-last-run.json', fs.existsSync);

/** 记录上次运行结果（供前端 last_run 展示）。 */
function saveLastRun(summary) {
  writeJsonAtomic(RUN_LOG(), summary);
}

/** 读取上次运行结果。 */
function readLastRun() {
  try {
    const raw = JSON.parse(fs.readFileSync(readRunLog(), 'utf-8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/** 账号 → 上游 info（ensureAuth 按 edition 刷新 token）。 */
async function toInfo(accountId) {
  const stored = store.get(accountId);
  const ensured = await auth.ensureAuth(accountId);
  return {
    accessToken: ensured.token || stored.token,
    refreshToken: ensured.refreshToken || stored.refreshToken,
    uid: ensured.userId || stored.userId,
    region: wbAuth.regionOf(ensured.host || stored.host),
  };
}

/** 单个账号的完整成长中心自动化。返回该账号的动作清单。 */
async function runAccount(a, opts = {}) {
  const locationId = Number(opts.location_id) > 0 ? Number(opts.location_id) : 1;
  const durationHours = Number(opts.duration_hours) > 0 ? Number(opts.duration_hours) : 4;
  const actions = [];
  const label = a.label || a.id;
  const info = await toInfo(a.id);

  // 幂等键种子：同一账号 + 同一天内稳定，跨进程重启/重跑不变
  // （见 workbuddy/cat-trip.js#clientToken）。这些写动作上游本就按日限次，
  // 用稳定键重放不会让用户少拿东西，却能避免「补跑一轮 → 重复入账」。
  const seed = `${a.id}|${localDateKey()}`;

  // 1) 旅行
  // 派猫出发（含通知）收敛为一处：idle 分支与「领奖后补派」共用，避免两处文案/通知分叉。
  async function tryDepart() {
    const d = await g.depart(info, { location_id: locationId, duration_hours: durationHours });
    if (d.ok) {
      actions.push({ seg: 'travel', ok: true, msg: `派猫出发 ${d.location ? d.location.name : ''}（预计 +${d.rewardCredit ?? 0}）` });
      notify('growth_departed', { accountId: a.id, label, message: `已派猫出发（${d.location ? d.location.name : ''}）` }, 'WorkBuddy 派猫出发').catch(() => {});
      return true;
    }
    if (d.result === 'daily_limit') {
      actions.push({ seg: 'travel', ok: true, skip: true, msg: '今日旅行次数已达上限' });
      return true;
    }
    actions.push({ seg: 'travel', ok: false, msg: `出发失败：${d.reason || d.result}` });
    return false;
  }

  try {
    const st = await g.fetchStatus(info);
    if (!st.ok) {
      actions.push({ seg: 'travel', ok: false, msg: st.reason || 'status fail' });
    } else if (st.state === 'arrived') {
      const c = await g.claimTravelReward(info);
      if (c.ok) {
        actions.push({ seg: 'travel', ok: true, msg: `领取旅行奖励 +${c.rewardCredit ?? 0}` });
        notify('growth_claimed', { accountId: a.id, label, message: `旅行奖励已领取 +${c.rewardCredit ?? 0}` }, 'WorkBuddy 旅行奖励已领取').catch(() => {});
        // 领奖后同日补派一次：定时改为每天墙钟执行一次后，若只领不派，当天剩余的上游
        // 旅行次数会整天空转（旧版靠每 4 小时轮询在下一轮自动补派）。
        const st2 = await g.fetchStatus(info).catch(() => null);
        if (st2 && st2.ok && st2.state === 'idle' && !st2.dailyLimitReached) {
          await tryDepart();
        }
      } else {
        actions.push({ seg: 'travel', ok: false, msg: `领奖失败：${c.reason || c.result}` });
      }
    } else if (st.state === 'traveling') {
      actions.push({ seg: 'travel', ok: true, skip: true, msg: `旅行中（${st.location ? st.location.name : ''}）` });
    } else if (st.state === 'idle' && !st.dailyLimitReached) {
      await tryDepart();
    } else {
      actions.push({ seg: 'travel', ok: true, skip: true, msg: '今日旅行已完成' });
    }
  } catch (e) { actions.push({ seg: 'travel', ok: false, msg: e.message }); }

  // 2) 任务：available 接单 + completed 领奖
  try {
    const t = await g.fetchTasks(info);
    if (!t.ok) {
      actions.push({ seg: 'tasks', ok: false, msg: t.reason || 'tasks fail' });
    } else {
      const pending = t.tasks.filter((x) => x.status === 'available' && x.code).map((x) => x.code);
      if (pending.length) {
        const ar = await g.acceptTasks(info, pending, { seed });
        if (ar.ok) {
          const bad = ar.results.filter((r) => r.status === 'error');
          actions.push({ seg: 'tasks', ok: true, msg: `接单 ${ar.results.length - bad.length}/${ar.results.length}${bad.length ? `（${bad.length} 项未就绪）` : ''}` });
        } else {
          actions.push({ seg: 'tasks', ok: false, msg: `接单失败：${ar.reason}` });
        }
      }
      // 领奖只针对 status=completed 且 code 存在的真实任务；不对未完成任务上报伪造事件
      let claimed = 0;
      let skippedPending = 0;
      for (const task of t.tasks) {
        if (task.status !== 'completed' || !task.code) continue;
        const cr = await g.claimTask(info, task.code);
        if (cr.ok && !cr.alreadyClaimed) claimed += 1;
        await sleep(200);
      }
      // 未完成任务（available、processing 等）如实标注「需真实操作」，不做 best-effort 上报
      for (const task of t.tasks) {
        if (task.status === 'completed' || task.status === 'available') continue;
        skippedPending += 1;
      }
      if (claimed) actions.push({ seg: 'tasks', ok: true, msg: `任务领奖 ×${claimed}` });
      if (skippedPending) {
        actions.push({ seg: 'tasks', ok: true, skip: true, msg: `${skippedPending} 项任务待真实操作（仅领取已完成）` });
      }
    }
  } catch (e) { actions.push({ seg: 'tasks', ok: false, msg: e.message }); }

  // 3) 补登卡：补到「最低未领档位的要求天数」为止。
  //    - 候选日以 heatmap 的 0 分日为准：/streak 的 makeup_dates 会残留已补日期、
  //      又漏掉真正断登日（2026-10-30 实测，八个账号全被它误导成「无需补登」），
  //      只在 heatmap 查询失败时作兜底。not_broken 上游不扣卡，假候选代价为零。
  //    - 从新到旧补（最新 0 分日就是当前连登段起点的前一天，最能延长连登）；
  //      窗口只看到 target 天前——再早的断登日补上也进不了这 28 个连续格子。
  //    - 幂等键按「账号+目标日期」派生：同日重跑去重，不同日期互不吞掉
  //      （此前共用「账号+当天」的 seed，一天用多张卡只有第一张生效）。
  try {
    const s = await g.fetchStreak(info);
    if (s.ok && s.makeupCards > 0) {
      const TIER_DAYS = { '7d': 7, '14d': 14, '28d': 28 };
      const rs = await g.fetchRedeemSummary(info);
      if (!rs.ok) {
        actions.push({ seg: 'makeup', ok: false, msg: `兑换档位查询失败：${rs.reason}（判不了缺口，本轮不用卡）` });
      } else {
        let target = null;
        for (const t of rs.tiers) {
          if (!t.status || t.status === 'claimed') continue;
          const req = TIER_DAYS[t.tier];
          if (req && s.days != null && s.days < req && (target == null || req < target)) target = req;
        }
        if (target == null) {
          actions.push({ seg: 'makeup', ok: true, skip: true, msg: `连登 ${s.days} 天，无待解锁档位，不耗卡` });
        } else {
          const now = new Date();
          const today = localDateKey();
          // 今天刻意不补：当天还能靠真实活跃点亮，用卡补今天纯浪费。
          const windowStart = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - target));
          let dates = [];
          const hm = await g.fetchHeatmap(info);
          if (hm.ok) {
            dates = hm.cells
              .filter((c) => c.date && c.date >= windowStart && c.date < today && c.score <= 0)
              .map((c) => c.date)
              .sort()
              .reverse();
          }
          if (!dates.length && hm.ok) {
            actions.push({ seg: 'makeup', ok: true, skip: true, msg: `连登 ${s.days}/${target} 天，但热力墙窗口内无断登日可补` });
          } else {
            if (!dates.length) dates = (s.makeupDates || []).slice().sort().reverse();
            let done = 0;
            let stale = 0;
            let lastDays = s.days;
            let errMsg = null;
            for (const date of dates) {
              if (done >= MAKEUP_MAX_PER_RUN) break;
              const cur = await g.fetchStreak(info);
              if (!cur.ok) { errMsg = `重读连登失败：${cur.reason}`; break; }
              if (cur.days != null) lastDays = cur.days;
              if (cur.makeupCards <= 0 || (cur.days != null && cur.days >= target)) break;
              const mr = await g.useMakeupCard(info, date, { seed: `${a.id}|makeup|${date}` });
              if (mr.ok) {
                done += 1;
                actions.push({ seg: 'makeup', ok: true, msg: `补登 ${date}（剩 ${mr.cardsLeft ?? '?'} 张）` });
              } else if (mr.result === 'not_broken') {
                stale += 1;
              } else {
                errMsg = `补登失败：${mr.reason}`;
                break;
              }
              await sleep(200);
            }
            if (errMsg) {
              actions.push({ seg: 'makeup', ok: false, msg: errMsg });
            } else {
              if (stale && !done) actions.push({ seg: 'makeup', ok: true, skip: true, msg: `${stale} 个候选日本就已签，无需补登` });
              if (lastDays != null && lastDays < target) {
                actions.push({ seg: 'makeup', ok: true, skip: true, msg: `连登 ${lastDays}/${target} 天，候选日或补登卡已用尽` });
              }
            }
          }
        }
      }
    }
  } catch (e) { actions.push({ seg: 'makeup', ok: false, msg: e.message }); }

  // 4) 连登兑换
  try {
    const rs = await g.fetchRedeemSummary(info);
    if (rs.ok) {
      for (const t of rs.tiers) {
        if (!t.status || t.status === 'claimed' || t.status === 'locked') continue;
        const rr = await g.redeemTier(info, t.tier, { seed });
        if (rr.ok) {
          actions.push({ seg: 'redeem', ok: true, msg: `兑换 ${t.tier}（+credit${rr.credit ?? 0} +energy${rr.energy ?? 0}）` });
          notify('growth_claimed', { accountId: a.id, label, message: `连登兑换 ${t.tier} 成功` }, 'WorkBuddy 连登兑换').catch(() => {});
        } else if (rr.result === 'tier_locked' || rr.result === 'already_redeemed') {
          actions.push({ seg: 'redeem', ok: true, skip: true, msg: `${t.tier} ${rr.result}` });
        } else {
          actions.push({ seg: 'redeem', ok: false, msg: `${t.tier} 失败：${rr.reason}` });
        }
        await sleep(300);
      }
    }
  } catch (e) { actions.push({ seg: 'redeem', ok: false, msg: e.message }); }

  // 5) 抽奖（每轮最多 1 次）
  try {
    const lc = await g.fetchLotteryChances(info);
    if (lc.ok && lc.balance > 0) {
      const dr = await g.drawLottery(info, { seed });
      if (dr.ok) {
        const extra = dr.needAddress ? '（实物奖，需到成长中心填收件信息）' : '';
        actions.push({ seg: 'lottery', ok: true, msg: `开盲盒获得：${dr.prize || '未知'}${extra}` });
        if (lc.balance > 1) actions.push({ seg: 'lottery', ok: true, skip: true, msg: `还剩 ${lc.balance - 1} 次，下轮继续` });
      } else if (dr.result === 'no_chance') {
        actions.push({ seg: 'lottery', ok: true, skip: true, msg: '无抽奖机会' });
      } else {
        actions.push({ seg: 'lottery', ok: false, msg: `抽奖失败：${dr.reason}` });
      }
    }
  } catch (e) { actions.push({ seg: 'lottery', ok: false, msg: e.message }); }

  // 6) Buddy 盲盒（能量足够才开）
  try {
    const q = await g.fetchBuddyQuota(info);
    if (q.ok && q.affordable > 0) {
      const count = Math.min(q.affordable, q.maxOpenCount || 1);
      const ob = await g.openBuddyBox(info, count, { seed });
      if (ob.ok) actions.push({ seg: 'buddy', ok: true, msg: `开 Buddy 盲盒 ×${ob.count}${ob.names.length ? `（${ob.names.join('、')}）` : ''}` });
      else actions.push({ seg: 'buddy', ok: false, msg: `开箱失败：${ob.reason}` });
    }
  } catch (e) { actions.push({ seg: 'buddy', ok: false, msg: e.message }); }

  const okAll = actions.every((x) => x.ok);
  return { accountId: a.id, label, ok: okAll, actions };
}

/**
 * 遍历启用账号执行成长中心自动化。
 * @param {object} [opts] {location_id, duration_hours}
 */
async function autoRunGrowth(opts = {}) {
  const accounts = store.list().filter((a) => a.enabled && a.edition === 'workbuddy');
  const results = [];
  for (const a of accounts) {
    try {
      results.push(await runAccount(a, opts));
    } catch (e) {
      results.push({ accountId: a.id, label: a.label || a.id, ok: false, actions: [{ seg: 'account', ok: false, msg: e.message }] });
    }
    await sleep(GAP_MS);
  }
  const failed = results.filter((r) => !r.ok);
  const summary = {
    total: accounts.length,
    ranAt: new Date().toISOString(),
    okCount: results.length - failed.length,
    failCount: failed.length,
    actions: results.flatMap((r) => r.actions.filter((x) => x.ok && !x.skip).map((x) => `${r.label}: ${x.msg}`)),
    results,
  };
  saveLastRun(summary);
  return summary;
}

module.exports = { autoRunGrowth, runAccount, readLastRun };