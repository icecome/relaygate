'use strict';
/**
 * lib/rtk/filters/grep.js —— 压缩 `grep -rn` 输出（"file:lineno:content"）。
 *
 * 原始形态会在每一条匹配上重复完整路径，所以一个符号在同一个文件里出现 40 次就要
 * 花掉 40 份路径。这个过滤器按文件分组，保留每个文件前 10 条匹配及其行号，并说明
 * 丢掉了多少条。看到 "+30" 的模型知道这个符号在那个文件里很密集、可以去读文件；
 * 而被展示全部 40 行的模型多学不到任何东西，却要为路径付钱。
 *
 * 移植自 Rust 的 `grep_wrapper`（splitn(3, ':') 语义）。
 *
 * @module src/lib/rtk/filters/grep.js
 */

const { GREP_PER_FILE_MAX } = require('../constants');
const { parseGrepOutput } = require('../hitLine');

/**
 * @param {string} input 原始搜索输出
 * @returns {string} 压缩后的清单；整份输出无法解析时原样返回
 */
function grep(input) {
  // 直接调用方也需要和自动检测同等强度的整份输出安全校验。
  const hits = parseGrepOutput(input);
  if (hits === null) return input;
  const byFile = new Map();
  const total = hits.length;
  for (const { file, line: lineNumStr, content } of hits) {
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push([lineNumStr, content]);
  }

  // Rust：files.sort_by_key(|(f, _)| *f) —— 稳定排序很重要，同一次搜索必须两次
  // 产出同样的 prompt 字节（否则上游 prompt cache 全丢）。
  const files = Array.from(byFile.keys()).sort();
  let out = `${total} matches in ${files.length}F:\n\n`;

  for (const file of files) {
    const matches = byFile.get(file);
    out += `[file] ${file} (${matches.length}):\n`;
    const show = matches.slice(0, GREP_PER_FILE_MAX);
    for (const [lineNum, content] of show) {
      // Rust：format!("  {:>4}: {}", line_num, content.trim())
      out += `  ${lineNum.padStart(4)}: ${content.trim()}\n`;
    }
    if (matches.length > GREP_PER_FILE_MAX) {
      out += `  +${matches.length - GREP_PER_FILE_MAX}\n`;
    }
    out += '\n';
  }

  return out;
}

grep.filterName = 'grep';

module.exports = { grep };
