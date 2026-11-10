'use strict';
/**
 * test/checkin-scheduling.test.js —— 签到调度根因回归（2026-11-03）。
 * 运行：node src/test/checkin-scheduling.test.js
 *
 * 覆盖三条根因，全部是「面板看不出、日志里静默」的那类：
 *   1. 关机跨过签到时刻 → 当天永不补跑（10-31 / 11-01 实测漏签两天）；
 *      判据落盘 daily-runs.json，且必须区分「没跑」与「跑过」。
 *   2. 自动轮与手动轮并发跑同一批账号 → 通知把「今日已签满」报成
 *      「签到 3 · 已签 5」。锁必须覆盖三个批量入口，跳过方如实返回。
 *   3. Raccoon 的 refreshBalance 返回账号对象（键 id）而非批量契约（键 accountId）
 *      → unfreezeIfHealthy(undefined) → node:sqlite 抛绑定错误，
 *      解冻与低额告警静默中断。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const WORKSPACE = path.join(os.tmpdir(), `rg-checkin-${Date.now()}`);
fs.mkdirSync(WORKSPACE, { recursive: true });
process.env.WORKSPACE_DIR = WORKSPACE;
process.env.TRAE_API_ENCRYPT_KEY = 'a'.repeat(64);
process.env.TASK_LOG_FILE = path.join(WORKSPACE, 'task-log.jsonl');
require('./isolation-guard')('checkin-scheduling');

const assert = require('assert');
const { stateFile } = require('../lib/paths');
const dailyRunState = require('../jobs/daily-run-state');
const { withCheckinRound, isRoundRunning } = require('../upstream/checkin-lock');
const { todayCoverage, coverageText } = require('../upstream/checkin-today');
const store = require('../credentials/store');
const pool = require('../credentials/pool');
const { localDateKey } = require('../lib/util');

let pass = 0;
let fail = 0;
const queue = [];
function t(name, fn) {
  queue.push({ name, fn });
}
async function run() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      pass += 1;
      console.log(`  ok  ${name}`);
    } catch (e) {
      fail += 1;
      console.log(`FAIL  ${name}\n      ${e.stack || e.message}`);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

// ---------------------------------------------------------------- daily-run-state

t('daily-runs.json 落在状态目录，且 mark 后 ranToday 为真', () => {
  assert.strictEqual(dailyRunState.FILE(), stateFile('daily-runs.json'));
  assert.strictEqual(dailyRunState.ranToday('checkin'), false, '初始应为未执行');
  assert.strictEqual(dailyRunState.lastRunDate('checkin'), null);
  const rec = dailyRunState.mark('checkin', { trigger: 'catchup', ok: 8, failed: 0 });
  assert.strictEqual(rec.date, localDateKey());
  assert.strictEqual(rec.trigger, 'catchup');
  assert.strictEqual(rec.ok, 8);
  assert.strictEqual(dailyRunState.ranToday('checkin'), true);
  assert.ok(fs.existsSync(dailyRunState.FILE()), '必须落盘：进程内变量正是漏签的成因');
});

t('判据按任务隔离，且跨进程可读（重新解析文件）', () => {
  dailyRunState.mark('growth', { trigger: 'scheduler' });
  assert.strictEqual(dailyRunState.ranToday('growth'), true);
  const raw = JSON.parse(fs.readFileSync(dailyRunState.FILE(), 'utf-8'));
  assert.ok(raw.checkin && raw.growth, '两个任务都要在文件里');
  assert.ok(raw.checkin.pid === process.pid && raw.growth.pid === process.pid);
});

t('文件损坏时按「未执行」处理（宁可补跑一轮，不可整天不签）', () => {
  fs.writeFileSync(dailyRunState.FILE(), '{ not json', 'utf-8');
  assert.strictEqual(dailyRunState.ranToday('checkin'), false);
  assert.strictEqual(dailyRunState.lastRun('checkin'), null);
});

// ---------------------------------------------------------------- checkin-lock

t('并发签到轮：后到者被跳过且不执行，锁随后释放', async () => {
  let inner = 0;
  const slow = withCheckinRound(async () => {
    inner += 1;
    await new Promise((r) => setTimeout(r, 30));
    return { claimed: 3 };
  }, { label: 'test:auto' });
  // 同一 tick 起第二轮：必须拿到 skipped，而不是真的再跑一遍
  const second = await withCheckinRound(async () => {
    throw new Error('不该被执行');
  }, { label: 'test:manual' });
  assert.strictEqual(second.skipped, true, '第二轮应被跳过');
  assert.strictEqual(second.running, true);
  assert.strictEqual(isRoundRunning(), true, '第一轮仍在跑');
  const first = await slow;
  assert.deepStrictEqual(first, { claimed: 3 });
  assert.strictEqual(inner, 1, '被跳过方不得执行任何上游动作');
  assert.strictEqual(isRoundRunning(), false, 'finally 必须释放');
});

t('执行体抛错后锁仍释放（否则一次失败会永久卡死签到）', async () => {
  await assert.rejects(
    withCheckinRound(async () => { throw new Error('upstream 500'); }),
    /upstream 500/,
  );
  assert.strictEqual(isRoundRunning(), false);
  const r = await withCheckinRound(async () => ({ ok: 1 }));
  assert.deepStrictEqual(r, { ok: 1 }, '锁释放后下一轮要能正常起跑');
});

// ---------------------------------------------------------------- checkin-today

t('todayCoverage：只认今日 + 履约结果，失败标记不计', () => {
  const nowIso = new Date().toISOString();
  const a = store.add({ label: 'cov-claimed', edition: 'cn', token: 'x'.repeat(40), enabled: true }, 'test');
  const b = store.add({ label: 'cov-already', edition: 'cn', token: 'y'.repeat(40), enabled: true }, 'test');
  const c = store.add({ label: 'cov-fail', edition: 'cn', token: 'z'.repeat(40), enabled: true }, 'test');
  const d = store.add({ label: 'cov-stale', edition: 'cn', token: 'w'.repeat(40), enabled: true }, 'test');
  store.update(a.id, { lastCheckinAt: nowIso, lastCheckinResult: 'claimed' });
  store.update(b.id, { lastCheckinAt: nowIso, lastCheckinResult: 'device_already' });
  store.update(c.id, { lastCheckinAt: nowIso, lastCheckinResult: 'claim_code_9074' });
  // 昨天的 claimed：不计入今日
  store.update(d.id, { lastCheckinAt: new Date(Date.now() - 26 * 3600 * 1000).toISOString(), lastCheckinResult: 'claimed' });

  const cov = todayCoverage(['trae']);
  const trae = cov.trae;
  assert.ok(trae.total >= 4, `total 至少含这 4 个测试号，实得 ${trae.total}`);
  // a(claimed) + b(device_already) 计入；c(失败) 与 d(昨天) 不计
  assert.ok(trae.unsigned.includes('cov-fail'), 'claim_code_* 是失败，不能算已签');
  assert.ok(trae.unsigned.includes('cov-stale'), '昨日签到不能算今日');
  assert.ok(!trae.unsigned.includes('cov-claimed'));
  assert.ok(!trae.unsigned.includes('cov-already'));
  assert.ok(/今日 \d+\/\d+/.test(coverageText(cov, 'trae')), `文案应含今日口径，实得 ${coverageText(cov, 'trae')}`);
});

// ---------------------------------------------------------------- unfreeze 防御

t('unfreezeIfHealthy(undefined/null) 返回 false 且不抛 SQLite 绑定错误', () => {
  // 回归点：修复前这里抛「Provided value cannot be bound to SQLite parameter 1」，
  // 把 balance-refresh 整轮带崩（实测 549 次）
  assert.strictEqual(pool.unfreezeIfHealthy(undefined), false);
  assert.strictEqual(pool.unfreezeIfHealthy(null), false);
  assert.strictEqual(pool.unfreezeIfHealthy(''), false);
  assert.strictEqual(pool.unfreezeIfHealthy('acct_not_exist_zzz'), false);
});

t('store.get(undefined) 在 node:sqlite 下确实抛错（证明防御点选对了）', () => {
  assert.throws(() => store.get(undefined), /cannot be bound to SQLite parameter 1/);
});

// ---------------------------------------------------------------- scheduleCatchup

t('scheduleCatchup：已过点且今日未跑 → 排补跑；已跑 → 不排', async () => {
  const scheduler = require('../jobs/scheduler');
  // 清掉判据，模拟「关机一天后开机」
  fs.rmSync(dailyRunState.FILE(), { force: true });
  const now = new Date();
  // 取一个必然已过的时刻（今天 00:00），delayMs 用 10ms 便于等待
  const decided = scheduler.scheduleCatchup(0, 0, 'checkin', async (opts) => {
    assert.strictEqual(opts.trigger, 'catchup', '补跑必须带 catchup 触发标记');
    dailyRunState.mark('checkin', { trigger: opts.trigger });
    return { ok: true };
  }, { delayMs: 10 });
  assert.strictEqual(decided.scheduled, true, `应排补跑，实得 ${JSON.stringify(decided)}`);
  assert.ok(decided.lagMinutes > 0);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(dailyRunState.ranToday('checkin'), true, '补跑执行体应真的跑过并落标记');

  // 第二次调用：今日已跑 → 不再补
  const again = scheduler.scheduleCatchup(0, 0, 'checkin', async () => {
    throw new Error('不该再跑');
  }, { delayMs: 10 });
  assert.strictEqual(again.scheduled, false);
  assert.strictEqual(again.reason, 'already_ran_today');
  assert.ok(now instanceof Date);
});

t('scheduleCatchup：延迟窗口内已被别的链路跑过 → 到点取消（补跑不重复）', async () => {
  const scheduler = require('../jobs/scheduler');
  fs.rmSync(dailyRunState.FILE(), { force: true });
  let executed = 0;
  const decided = scheduler.scheduleCatchup(0, 0, 'growth', async () => {
    executed += 1;
    return {};
  }, { delayMs: 40 });
  assert.strictEqual(decided.scheduled, true);
  // 排程后、执行前，签到链尾把 growth 标记为已跑（模拟真实并发路径）
  dailyRunState.mark('growth', { trigger: 'manual-chain' });
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(executed, 0, '到点时必须重判，不能重复起一轮');
});

t('scheduleCatchup：未到点不排（交给正常墙钟）', () => {
  const scheduler = require('../jobs/scheduler');
  const h = new Date().getHours();
  // 下一个小时（23 点时退回 0 点会立刻「已过点」，故用 +1 分钟必未到点的写法不可靠，
  // 这里用「今天剩余小时」：当前分钟 < 59 时，取当前小时 + 59 分必然未到点）
  const now = new Date();
  if (now.getHours() === 23 && now.getMinutes() >= 58) return; // 极端时刻跳过
  const decided = scheduler.scheduleCatchup(now.getHours(), 59, 'checkin', async () => ({}));
  assert.strictEqual(decided.scheduled, false);
  assert.strictEqual(decided.reason, 'not_due_yet');
});

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
