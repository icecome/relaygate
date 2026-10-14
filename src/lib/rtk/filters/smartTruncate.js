'use strict';
/**
 * lib/rtk/filters/smartTruncate.js —— 无结构 blob 的最后兜底：只留头尾。
 *
 * 当没有任何形状被认出来时，最诚实的假设是「有用的行在开头」（命令的头、最初的失败）
 * 和「结尾」（最终状态、最后一个错误），中间换成一个计数。这与 Rust `filter::
 * smart_truncate` 用的是同一策略，也正是 marker 必须说明缺了多少行的原因：模型必须
 * 知道自己看的是一扇窗口，而不是整份输出。
 *
 * @module src/lib/rtk/filters/smartTruncate.js
 */

const { SMART_TRUNCATE_HEAD, SMART_TRUNCATE_TAIL, SMART_TRUNCATE_MIN_LINES } = require('../constants');

/**
 * @param {string} input
 * @returns {string}
 */
function smartTruncate(input) {
  const lines = input.split('\n');
  // 低于下限时，头+尾+marker 并不比输入更小。
  if (lines.length < SMART_TRUNCATE_MIN_LINES) return input;

  const head = lines.slice(0, SMART_TRUNCATE_HEAD);
  const tail = lines.slice(lines.length - SMART_TRUNCATE_TAIL);
  const cut = lines.length - head.length - tail.length;
  return [...head, `... +${cut} lines truncated`, ...tail].join('\n');
}

smartTruncate.filterName = 'smart-truncate';

module.exports = { smartTruncate };
