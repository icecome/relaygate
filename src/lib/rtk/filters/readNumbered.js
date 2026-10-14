'use strict';
/**
 * lib/rtk/filters/readNumbered.js —— 压缩带行号的整文件转储（`  1|content`，例如
 * Cursor 的 read_file）。
 *
 * 行号必须保留：模型引用位置靠的就是它。头+尾窗口是刻意选的 —— 文件的 import 与顶层
 * 声明在上方，一个 diff 或末尾的调用点在下方。marker 会报出缺失的行数，好让模型知道
 * 文件还有下文，从而去要一个具体区间，而不是当成自己已经读完了整份文件。
 *
 * @module src/lib/rtk/filters/readNumbered.js
 */

const { SMART_TRUNCATE_HEAD, SMART_TRUNCATE_TAIL, SMART_TRUNCATE_MIN_LINES } = require('../constants');

const LINE_RE = /^\s*\d+\|/;

/**
 * @param {string} input
 * @returns {string}
 */
function readNumbered(input) {
  const lines = input.split('\n');
  if (lines.length < SMART_TRUNCATE_MIN_LINES) return input;

  // 这里不数 "N|content" 的命中比例来复核形状（比例检查已经在 autodetect 做过），
  // 到这里只负责截断。
  const head = lines.slice(0, SMART_TRUNCATE_HEAD);
  const tail = lines.slice(lines.length - SMART_TRUNCATE_TAIL);
  const cut = lines.length - head.length - tail.length;

  return [
    ...head,
    `... +${cut} lines truncated (file continues)`,
    ...tail
  ].join('\n');
}

readNumbered.filterName = 'read-numbered';

module.exports = {
  readNumbered,
  // 暴露给 autodetect
  READ_NUMBERED_LINE_RE: LINE_RE,
};
