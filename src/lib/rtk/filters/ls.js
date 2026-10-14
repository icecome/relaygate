'use strict';
/**
 * lib/rtk/filters/ls.js —— 压缩 `ls -la` 输出。
 *
 * 一份长列表里全是模型用不到的列 —— 权限、链接数、属主、属组、一个精确值纯属噪声的
 * 日期 —— 而且每条都重复一遍。模型需要的是名字、哪些是目录，以及文件大概多大。
 * 末尾的扩展名直方图还顺带充当一个廉价的「这是个什么项目」信号，即使条目本身被截断
 * 也依然存在。
 *
 * 移植自 Rust 的 `compact_ls`。
 *
 * @module src/lib/rtk/filters/ls.js
 */

const { LS_EXT_SUMMARY_TOP, LS_NOISE_DIRS } = require('../constants');

// Rust LS_DATE_RE：月份 + 日 + （年份 | HH:MM）
const LS_DATE_RE = /\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(\d{4}|\d{2}:\d{2})\s+/;

function humanSize(bytes) {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}

/**
 * 以日期列为锚点解析一行 `ls -l`。
 *
 * 锚定日期而不是从左边切分，是它能扛住「文件名带空格」和「ls 变体多出几列」的原因：
 * 日期之后的一切都是文件名，而大小是紧挨日期之前最右边那个纯数字。不是列表条目的行
 * （表头、空行、"total N" 由调用方过滤）返回 null。
 */
function parseLsLine(line) {
  const m = LS_DATE_RE.exec(line);
  if (!m) return null;
  const name = line.slice(m.index + m[0].length);
  const beforeDate = line.slice(0, m.index);
  const beforeParts = beforeDate.split(/\s+/).filter(Boolean);
  if (beforeParts.length < 4) return null;

  const perms = beforeParts[0];
  const fileType = perms.charAt(0);

  // size = 日期之前最右边那个可解析的数字
  let size = 0;
  for (let i = beforeParts.length - 1; i >= 0; i--) {
    const n = Number(beforeParts[i]);
    if (Number.isInteger(n) && String(n) === beforeParts[i]) { size = n; break; }
  }
  return { fileType, size, name };
}

/**
 * @param {string} input 原始 `ls -la` 输出
 * @returns {string} 压缩后的清单；认不出任何列表条目时原样返回
 */
function ls(input) {
  const dirs = [];
  const files = []; // [name, sizeStr]
  const byExt = new Map();

  for (const line of input.split('\n')) {
    if (line.startsWith('total ') || line.length === 0) continue;
    const parsed = parseLsLine(line);
    if (!parsed) continue;
    if (parsed.name === '.' || parsed.name === '..') continue;

    // Rust ls.rs：尊重 show_all 标志 —— 面向 LLM 上下文时一律跳过噪声目录
    if (LS_NOISE_DIRS.includes(parsed.name)) continue;

    if (parsed.fileType === 'd') {
      dirs.push(parsed.name);
    } else if (parsed.fileType === '-' || parsed.fileType === 'l') {
      const dot = parsed.name.lastIndexOf('.');
      // dot > 0 而不是 >= 0：开头的点是 dotfile，不是扩展名。
      const ext = dot > 0 ? parsed.name.slice(dot) : 'no ext';
      byExt.set(ext, (byExt.get(ext) || 0) + 1);
      files.push([parsed.name, humanSize(parsed.size)]);
    }
  }

  // 认不出任何东西：这就不是一份 `ls -l` 列表，原样放过，而不是用一份空的或
  // 误导性的压缩结果作答。
  if (dirs.length === 0 && files.length === 0) return input;

  let out = '';
  for (const d of dirs) out += `${d}/\n`;
  for (const [name, size] of files) out += `${name}  ${size}\n`;

  // 摘要行（Rust 移植）
  let summary = `\nSummary: ${files.length} files, ${dirs.length} dirs`;
  if (byExt.size > 0) {
    const ext = Array.from(byExt.entries()).sort((a, b) => b[1] - a[1]);
    const parts = ext.slice(0, LS_EXT_SUMMARY_TOP).map(([e, c]) => `${c} ${e}`);
    summary += ` (${parts.join(', ')}`;
    if (ext.length > LS_EXT_SUMMARY_TOP) {
      summary += `, +${ext.length - LS_EXT_SUMMARY_TOP} more`;
    }
    summary += ')';
  }

  return out + summary;
}

ls.filterName = 'ls';

module.exports = { ls };
