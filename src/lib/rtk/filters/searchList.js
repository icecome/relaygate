'use strict';
/**
 * lib/rtk/filters/searchList.js —— 压缩 Cursor 的 Glob 结果清单。
 *
 * 形状：一行 "Result of search in '...' (total N files):" 头，后面跟 `- path` 行。
 * 即使正文被截断，头部里的总数也保留着，这样模型仍然知道一共有多少匹配，可以去收窄
 * glob，而不是把一份不完整的清单当真。按父目录分组与 find 压缩器同构，理由也一样：
 * 重复是成本，树的形状是信息。
 *
 * @module src/lib/rtk/filters/searchList.js
 */

const { SEARCH_LIST_PER_DIR_MAX, SEARCH_LIST_TOTAL_DIR_MAX } = require('../constants');

const HEADER_RE = /^Result of search in '[^']*' \(total (\d+) files?\):/;

/**
 * @param {string} input
 * @returns {string}
 */
function searchList(input) {
  const lines = input.split('\n');
  if (lines.length === 0) return input;

  // 第一行必须是那个头（autodetect 也校验过）
  const header = lines[0] || '';
  const rest = lines.slice(1);

  const paths = [];
  for (const raw of rest) {
    const t = raw.trim();
    if (!t.startsWith('- ')) continue;
    paths.push(t.slice(2));
  }
  // 只有头、没有清单，就不是这个形状；改写它只会把它搞坏。
  if (paths.length === 0) return input;

  const byDir = new Map();
  for (const p of paths) {
    const slash = p.lastIndexOf('/');
    const dir = slash === -1 ? '.' : (p.slice(0, slash) || '/');
    const name = slash === -1 ? p : p.slice(slash + 1);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(name);
  }

  const dirs = Array.from(byDir.keys()).sort();
  let out = `${header}\n${paths.length} files in ${dirs.length} dirs:\n\n`;

  for (const dir of dirs.slice(0, SEARCH_LIST_TOTAL_DIR_MAX)) {
    const names = byDir.get(dir);
    out += `${dir}/ (${names.length}):\n`;
    for (const n of names.slice(0, SEARCH_LIST_PER_DIR_MAX)) out += `  ${n}\n`;
    if (names.length > SEARCH_LIST_PER_DIR_MAX) {
      out += `  +${names.length - SEARCH_LIST_PER_DIR_MAX}\n`;
    }
    out += '\n';
  }
  if (dirs.length > SEARCH_LIST_TOTAL_DIR_MAX) {
    out += `+${dirs.length - SEARCH_LIST_TOTAL_DIR_MAX} more dirs\n`;
  }

  return out.replace(/\n+$/, '');
}

searchList.filterName = 'search-list';

module.exports = {
  searchList,
  SEARCH_LIST_HEADER_RE: HEADER_RE,
};
