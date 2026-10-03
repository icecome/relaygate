'use strict';
/**
 * jobs/growth-progress.js — 成长中心一键自动化的后台任务与进度跟踪。
 *
 * 面板「成长中心自动化」触发后，请求立即返回 taskId；后台串行执行各账号，
 * 进度（分账号/分阶段）写入内存 + 磁盘快照，前端轮询 /v1/admin/growth-auto/progress?taskId=…。
 * 仅保留最近 N 个任务；旧任务在 TTL 后清理。所有执行细节复用 jobs/growth-auto.js。
 */
const store = require('../credentials/store');
const { autoRunGrowth, runAccount } = require('./growth-auto');
const { appendTaskLog } = require('./task-log');
const { sleep } = require('../lib/util');
const { writeJsonAtomic } = require('../lib/atomic-write');
const { stateFile } = require('../lib/paths');

const PROGRESS_FILE = () => stateFile('growth-progress.json');
const MAX_TASKS = 20;
const TTL_MS = 30 * 60 * 1000;

const tasks = new Map();
let seq = 0;
let running = false;

function readDisk() {
  try {
    const raw = JSON.parse(require('fs').readFileSync(PROGRESS_FILE(), 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeDisk() {
  try {
    const dump = {};
    for (const [id, t] of tasks) dump[id] = t;
    writeJsonAtomic(PROGRESS_FILE(), dump);
  } catch { /* 快照失败不影响进度 */ }
}

function prune() {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if (now - t.startedAt > TTL_MS && !t.running) tasks.delete(id);
  }
  if (tasks.size > MAX_TASKS) {
    const oldest = Array.from(tasks.entries())
      .filter(([, t]) => !t.running)
      .sort((a, b) => a[1].startedAt - b[1].startedAt);
    while (tasks.size > MAX_TASKS && oldest.length) {
      const [id] = oldest.shift();
      tasks.delete(id);
    }
  }
  writeDisk();
}

/**
 * 启动后台自动化任务。
 * @param {object} [opts] {accountId?, location_id?, duration_hours?}
 * @returns {{taskId:string}}
 */
function startAuto(opts = {}) {
  if (running) {
    const err = new Error('已有自动化任务在运行，请等待完成');
    err.status = 409;
    throw err;
  }
  running = true;
  seq += 1;
  const taskId = `growth_${Date.now().toString(36)}_${seq}`;
  const task = {
    taskId,
    startedAt: Date.now(),
    running: true,
    accountIds: opts.accountId ? [String(opts.accountId)] : store.list().filter((a) => a.enabled && a.edition === 'workbuddy').map((a) => a.id),
    results: [],
    okCount: 0,
    failCount: 0,
    stage: 'starting',
  };
  tasks.set(taskId, task);
  writeDisk();

  (async () => {
    try {
      const targets = opts.accountId ? [store.get(String(opts.accountId))].filter(Boolean) : store.list().filter((a) => a.enabled && a.edition === 'workbuddy');
      task.stage = 'running';
      for (const a of targets) {
        task.currentAccount = a.label || a.id;
        let r;
        try {
          r = await runAccount(a, opts);
        } catch (e) {
          r = { accountId: a.id, label: a.label || a.id, ok: false, actions: [{ seg: 'account', ok: false, msg: e.message }] };
        }
        task.results.push(r);
        if (r.ok) task.okCount += 1;
        else task.failCount += 1;
        writeDisk();
        await sleep(400);
      }
      task.stage = 'done';
      task.finishedAt = Date.now();
      const acted = task.results.reduce((n, r) => n + r.actions.filter((x) => x.ok && !x.skip).length, 0);
      try {
        appendTaskLog({
          task: 'growth-auto',
          trigger: 'manual',
          ok: task.okCount,
          failed: task.failCount,
          total: targets.length,
          acted,
        });
      } catch { /* ignore */ }
    } catch (e) {
      task.stage = 'failed';
      task.error = e.message;
      task.finishedAt = Date.now();
    } finally {
      task.running = false;
      running = false;
      writeDisk();
    }
  })();

  return { taskId };
}

/** 查询任务进度。@param {string} taskId */
function getProgress(taskId) {
  prune();
  const t = tasks.get(taskId);
  if (!t) return null;
  return {
    taskId: t.taskId,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt || null,
    running: t.running,
    stage: t.stage,
    error: t.error || null,
    currentAccount: t.currentAccount || null,
    total: t.accountIds.length,
    doneCount: t.results.length,
    okCount: t.okCount,
    failCount: t.failCount,
    results: t.results,
  };
}

/** 最近任务列表（新→旧）。 */
function listTasks() {
  prune();
  return Array.from(tasks.values())
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((t) => ({
      taskId: t.taskId,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt || null,
      running: t.running,
      stage: t.stage,
      total: t.accountIds.length,
      doneCount: t.results.length,
      okCount: t.okCount,
      failCount: t.failCount,
    }));
}

module.exports = { startAuto, getProgress, listTasks, running: () => running };
