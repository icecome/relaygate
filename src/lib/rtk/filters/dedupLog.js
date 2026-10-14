'use strict';
/**
 * lib/rtk/filters/dedupLog.js —— 通用兜底压缩器：合并重复段、限制行数。
 *
 * 这是 blob 不匹配任何已知工具形状时跑的东西。它对格式不作任何假设 —— 一行日志重复
 * 500 次，就是 500 次让模型把它误读成进度信号的机会；而一行加一句 "500 duplicate
 * lines" 承载的是同一个事实。硬行数上限则防止一次失控循环灌满上下文。
 *
 * @module src/lib/rtk/filters/dedupLog.js
 */

const { DEDUP_LINE_MAX } = require('../constants');

/**
 * @param {string} input
 * @returns {string}
 */
function dedupLog(input) {
  const lines = input.split('\n');
  const out = [];
  let prev = null;
  let runCount = 0;
  let blankStreak = 0;

  // 延迟发射：重复段要等到「另一行出现」或「输入结束」才能确认它已经结束，
  // 这样 marker 才会出现在那段重复所在的位置。
  const flushRun = () => {
    if (prev !== null && runCount > 1) {
      out.push(`  ... (${runCount - 1} duplicate lines)`);
    }
  };

  for (const line of lines) {
    if (line.trim() === '') {
      // 连续空行压成一个空行：段落结构活下来，但一整页的填充不会。
      if (blankStreak < 1) out.push(line);
      blankStreak += 1;
      flushRun();
      prev = null;
      runCount = 0;
      continue;
    }
    blankStreak = 0;
    if (line === prev) {
      runCount += 1;
      continue;
    }
    flushRun();
    out.push(line);
    prev = line;
    runCount = 1;
    if (out.length >= DEDUP_LINE_MAX) {
      out.push(`... (truncated at ${DEDUP_LINE_MAX} lines)`);
      return out.join('\n');
    }
  }
  flushRun();
  return out.join('\n');
}

dedupLog.filterName = 'dedup-log';

module.exports = { dedupLog };
