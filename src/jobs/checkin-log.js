'use strict';
/**
 * jobs/checkin-log.js — 签到链执行日志（Trae 签到 + WorkBuddy 签到 共用）。
 * 复用 task-log.jsonl，按 task='checkin' 记录每日签到批次结果，供面板「任务执行日志」查看。
 */
const { appendTaskLog } = require('./task-log');

/**
 * 汇总一次签到批次（Trae 与 WorkBuddy 合并或分别记录都适用）。
 * @param {object} opts
 * @param {string} [opts.edition] 'trae' | 'workbuddy'（跨平台批次可省略）
 * @param {object} opts.batch 含 claimed/already/disabled/failed/ok/summary
 * @param {string} opts.trigger 'scheduler' | 'manual'
 */
function appendCheckinTaskLog({ edition = null, batch, trigger = 'scheduler' }) {
  let claimed = 0;
  let already = 0;
  let disabled = 0;
  let failed = 0;
  if (batch) {
    claimed = batch.summary?.claimed ?? batch.claimed?.length ?? 0;
    already = batch.summary?.already ?? batch.already?.length ?? 0;
    disabled = batch.summary?.disabled ?? batch.disabled?.length ?? 0;
    failed = batch.summary?.failed ?? batch.failed?.length ?? 0;
  }
  const total = claimed + already + disabled + failed;
  appendTaskLog({
    task: 'checkin',
    subtask: edition || null,
    trigger,
    claimed,
    already,
    disabled,
    failed,
    total,
    ok: claimed,
  });
  return { claimed, already, disabled, failed, total };
}

module.exports = { appendCheckinTaskLog };