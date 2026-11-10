'use strict';
/**
 * jobs/daily-run-state.js — 「某个每日任务本自然日是否已执行」的落盘判据。
 *
 * 为什么需要（关机错过 08:45 当天永不补跑）：
 *   scheduler 的排程只算墙钟时刻（nextAt：已过点就 +1 天），而
 *   state.lastCheckinAt 是**进程内变量**，重启即失忆。于是「关机跨过签到时刻
 *   → 开机」这条路径上，当天既不会补跑，也没有任何地方知道「今天还没签」。
 *   实测 2026-10-31 / 11-01 两天 task-log 里完全没有 checkin 记录，
 *   16 个号的每日积分整天漏领。
 *
 * 为什么落盘而不是复用既有数据：
 *   - task-log.jsonl：MAX_ENTRIES=500 环形裁剪，且手动触发写的是同一个 task，
 *     判据会被手动记录污染或被裁掉 → 会把「跑过但全号失败」读成「没跑」，
 *     或反之。
 *   - accounts.last_checkin_at：整轮抛错时一行都没写，能反映「没跑」，
 *     但反映不了「跑过且失败」，补跑判据要能区分这两者。
 *   故独立一个小文件，语义单一：task → 最近一次执行的本地日期与时刻。
 *
 * 写入时机：**起跑即标记**（mark 在真正开始执行前调用），不是成功后才标。
 *   否则一轮失败会让当天反复重试打上游；补跑与失败重试的区分交给
 *   lastResult / failed 字段，而不是靠「没标记」表达。
 */
const fs = require('fs');
const path = require('path');
const { stateFile } = require('../lib/paths');
const { writeJsonAtomic } = require('../lib/atomic-write');
const { localDateKey } = require('../lib/util');

/** 状态文件：与 scheduler.lock / task-log.jsonl 同目录，备份与清理一并覆盖。 */
function FILE() {
  return process.env.DAILY_RUN_STATE_FILE
    ? path.resolve(process.env.DAILY_RUN_STATE_FILE)
    : stateFile('daily-runs.json');
}

function readStored() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/**
 * 某任务最近一次执行的本地日期（YYYY-MM-DD）；从未执行返回 null。
 * @param {string} task 'checkin' | 'keepalive' | 'rotate' | 'growth' …
 * @returns {string|null}
 */
function lastRunDate(task) {
  const rec = readStored()[task];
  return rec && typeof rec.date === 'string' ? rec.date : null;
}

/** 某任务最近一次执行的完整记录（含 at / trigger / pid）。 */
function lastRun(task) {
  return readStored()[task] || null;
}

/** 今天（本地自然日）是否已执行过该任务。 */
function ranToday(task) {
  return lastRunDate(task) === localDateKey();
}

/**
 * 标记一次执行。写入失败不抛错（判据缺失的后果是「可能重复跑一轮」，
 * 上游已签到业务码兜底；比让签到本身因写文件失败而中断要好）。
 * @param {string} task
 * @param {{trigger?:string, ok?:number, failed?:number, note?:string}} [info]
 * @returns {object|null} 写入的记录
 */
function mark(task, info = {}) {
  const now = new Date();
  const stored = readStored();
  const rec = {
    date: localDateKey(now),
    at: now.toISOString(),
    trigger: info.trigger || 'scheduler',
    ok: Number.isFinite(Number(info.ok)) ? Number(info.ok) : null,
    failed: Number.isFinite(Number(info.failed)) ? Number(info.failed) : null,
    note: info.note || null,
    pid: process.pid,
  };
  stored[task] = rec;
  // writeJsonAtomic 自身不抛错（失败返回 false 并已打日志），这里据返回值记录一次
  const ok = writeJsonAtomic(FILE(), stored);
  if (!ok) console.error('[daily-run-state] 写入失败（不影响本次执行）');
  return ok ? rec : null;
}

module.exports = { FILE, lastRunDate, lastRun, ranToday, mark };
