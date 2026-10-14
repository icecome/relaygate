'use strict';
/**
 * lib/rtk/registry.js —— 名字到过滤器的查找表，给「已经知道这个 blob 是什么」的调用方。
 *
 * 自动检测器靠猜；自己跑了工具的调用方不必猜。这个注册表就是那扇门，同时也是 Rust
 * 版工具别名的所在地（`rg` 指 grep、`fd` 指 find）—— agent 报的是现代工具的名字，
 * 而压缩器是同一个。
 *
 * `build-output` 刻意缺席：它只由自动检测器按形状选中，因为「npm 输出」没有一个调用方
 * 能传进来的单一命令名 —— npm、yarn、cargo、rustc 都落到那儿。
 *
 * @module src/lib/rtk/registry.js
 */

const { FILTERS } = require('./constants');
const { gitDiff } = require('./filters/gitDiff');
const { gitStatus } = require('./filters/gitStatus');
const { gitLog } = require('./filters/gitLog');
const { grep } = require('./filters/grep');
const { find } = require('./filters/find');
const { dedupLog } = require('./filters/dedupLog');
const { ls } = require('./filters/ls');
const { tree } = require('./filters/tree');
const { smartTruncate } = require('./filters/smartTruncate');
const { readNumbered } = require('./filters/readNumbered');
const { searchList } = require('./filters/searchList');

const REGISTRY = {
  [FILTERS.GIT_DIFF]: gitDiff,
  [FILTERS.GIT_STATUS]: gitStatus,
  [FILTERS.GIT_LOG]: gitLog,
  [FILTERS.GREP]: grep,
  [FILTERS.FIND]: find,
  [FILTERS.DEDUP_LOG]: dedupLog,
  [FILTERS.LS]: ls,
  [FILTERS.TREE]: tree,
  [FILTERS.SMART_TRUNCATE]: smartTruncate,
  [FILTERS.READ_NUMBERED]: readNumbered,
  [FILTERS.SEARCH_LIST]: searchList,
};

// Rust resolve_filter 的别名（pipe_cmd.rs）：grep|rg、find|fd
const ALIASES = {
  rg: grep,
  fd: find,
};

/**
 * 按名字或别名解析过滤器；名字未知时返回 null。
 * @param {string} name
 * @returns {Function|null}
 */
function resolveFilter(name) {
  return REGISTRY[name] || ALIASES[name] || null;
}

/**
 * 全部具名过滤器，以各自的 `filterName` 为键。
 *
 * 返回的是内部对象本身（与源实现一致）：调用方应当只读它。
 * @returns {Object<string, Function>}
 */
function allFilters() {
  return REGISTRY;
}

module.exports = { resolveFilter, allFilters };
