'use strict';
/**
 * lib/rtk/filters/tree.js —— 压缩 `tree` 输出。
 *
 * 这里的字形与缩进**就是**信息本身 —— 它们展示了模型要推理的嵌套结构 —— 所以几乎
 * 什么都不丢。去掉的只有末尾那行 "N directories, M files" 摘要（它的计数模型自己
 * 就能从列表推出来）和空白填充。行数上限是 JS 版独有的保险，防的是对整个构建目录
 * 跑 tree；Rust 原版没有这个上限。
 *
 * @module src/lib/rtk/filters/tree.js
 */

const { TREE_MAX_LINES } = require('../constants');

/**
 * @param {string} input 原始 `tree` 输出
 * @returns {string}
 */
function tree(input) {
  const lines = input.split('\n');
  if (lines.length === 0) return input;

  const filtered = [];
  for (const line of lines) {
    // 丢掉 "X directories, Y files" 摘要
    if (line.includes('director') && line.includes('file')) continue;
    // 丢掉开头的空行
    if (line.trim() === '' && filtered.length === 0) continue;
    filtered.push(line);
  }

  // 丢掉结尾的空行
  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === '') {
    filtered.pop();
  }

  // 给过长的树加上上限（JS 独有保险；Rust 没有上限）
  if (filtered.length > TREE_MAX_LINES) {
    const cut = filtered.length - TREE_MAX_LINES;
    return filtered.slice(0, TREE_MAX_LINES).join('\n') + `\n... +${cut} more lines`;
  }

  return filtered.join('\n');
}

tree.filterName = 'tree';

module.exports = { tree };
