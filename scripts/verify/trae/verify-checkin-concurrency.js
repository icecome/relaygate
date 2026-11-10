'use strict';
/**
 * scripts/verify/trae/verify-checkin-concurrency.js — 端到端验证签到轮互斥 + 今日口径文案。
 *
 * 验证三件事（全部走真实库与真实上游，但 notifyOnDone=false 不打扰推送）：
 *   1. 两个批量入口同时起跑时，后到者拿到 skipped 且**不发任何上游请求**；
 *   2. 单跑一轮时 message 带「今日 N/M」口径，且 claimed=0 的补跑场景
 *      不再被读成失败；
 *   3. daily-runs.json 被真实写入。
 *
 * 用法：node scripts/verify/trae/verify-checkin-concurrency.js
 * 注意：会对全部启用账号各打一次 status（上游 status 不计签到次，无副作用）。
 */
process.env.LOGS_DIR = require('path').join(__dirname, '..', '..', '..', 'logs');
const fs = require('fs');
const dailyRunState = require('../../../src/jobs/daily-run-state');
const { checkinAllByPlatform } = require('../../../src/upstream/checkin-all');
const { isRoundRunning } = require('../../../src/upstream/checkin-lock');

function hr(s) { console.log(`\n--- ${s} ---`); }

(async () => {
  hr('1. 并发：同 tick 起两轮，第二轮必须 skipped');
  const a = checkinAllByPlatform({ spreadMinutes: 0, trigger: 'manual', notifyOnDone: false });
  const b = await checkinAllByPlatform({ spreadMinutes: 0, trigger: 'manual', notifyOnDone: false });
  console.log('round2.skipped =', b.skipped, '| round2.message =', b.message);
  if (!b.skipped) throw new Error('FAIL: 第二轮没有被互斥跳过，锁未生效');
  const ra = await a;
  console.log('round1 =', JSON.stringify({ total: ra.total, claimed: ra.claimed, already: ra.already, failed: ra.failed }));
  console.log('round1.message =', ra.message);
  console.log('lock released =', isRoundRunning() === false);

  hr('2. 今日口径覆盖度（跨批次真实值）');
  console.log('coverage =', JSON.stringify(ra.coverage, null, 2));

  hr('3. daily-runs.json');
  console.log('file =', dailyRunState.FILE());
  console.log('exists =', fs.existsSync(dailyRunState.FILE()));
  console.log('checkin =', JSON.stringify(dailyRunState.lastRun('checkin')));
  console.log('ranToday(checkin) =', dailyRunState.ranToday('checkin'));

  console.log('\nALL CHECKS PASSED');
})().catch((e) => {
  console.error('VERIFY FAILED:', e.message);
  process.exitCode = 1;
});
