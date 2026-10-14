'use strict';
/**
 * lib/rtk/filters/find.js —— 压缩 `find` 输出：一行一个路径，按目录分组。
 *
 * find 的结果就是一张路径表，而路径表的信息量在「有多少文件、在哪儿」—— 成本在于
 * 每一行都重复的那段父目录。按目录分组、只留 basename，既保住了树的形状（模型决定
 * 「接下来去哪儿看」时推理的正是这个形状），又丢掉了重复。单目录与目录总数两个上限
 * 兜住失控的目录树。
 *
 * 移植自 Rust 的 `find_wrapper`。
 *
 * @module src/lib/rtk/filters/find.js
 */

const { FIND_PER_DIR_MAX, FIND_TOTAL_DIR_MAX } = require('../constants');

/**
 * @param {string} input 原始 `find` 输出
 * @returns {string}
 */
function find(input) {
  const lines = input.split('\n').filter(l => l.trim());
  if (lines.length === 0) return input;

  const byDir = new Map();

  for (const path of lines) {
    // Unix（"/a/b"）与 Windows（"C:\a\b"）两种分隔符都接受
    const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    let dir;
    let basename;
    if (lastSep === -1) {
      dir = '.';
      basename = path;
    } else {
      // Rust：PathBuf::from(path).parent().display() + file_name().display()
      dir = path.slice(0, lastSep) || '/';
      basename = path.slice(lastSep + 1);
    }
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(basename);
  }

  // Rust：dirs.sort_by_key(|(d, _)| d.clone())
  const dirs = Array.from(byDir.keys()).sort();
  let out = `${lines.length} files in ${dirs.length} dirs:\n\n`;

  const showDirs = dirs.slice(0, FIND_TOTAL_DIR_MAX);
  for (const dir of showDirs) {
    const files = byDir.get(dir);
    // 归一化 Windows 分隔符，好让分组标签与同一份清单里的 Unix 形状标签可比。
    const dirLabel = dir.replace(/\\/g, '/');
    out += `${dirLabel}/  (${files.length})\n`;
    const showFiles = files.slice(0, FIND_PER_DIR_MAX);
    for (const f of showFiles) out += `  ${f}\n`;
    if (files.length > FIND_PER_DIR_MAX) {
      out += `  +${files.length - FIND_PER_DIR_MAX}\n`;
    }
  }
  if (dirs.length > FIND_TOTAL_DIR_MAX) {
    out += `\n+${dirs.length - FIND_TOTAL_DIR_MAX} more dirs\n`;
  }

  return out;
}

find.filterName = 'find';

module.exports = { find };
