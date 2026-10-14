'use strict';
/**
 * lib/rtk/autodetect.js —— 按 blob 头部的长相挑压缩器。
 *
 * 下面这串检查的**顺序就是算法本身**，不可互换：
 *
 * - `git log`/`git diff`/`git status` 排在最前，因为它们的形状最具体，而它们的行
 *   内容换一种解释可以像任何东西。
 * - 构建输出检查放在 porcelain 启发式**之前**：cargo 会打印 "Compiling foo" 这类
 *   行，其行首的 `C`/空格列恰好满足 porcelain 的字符类，一份被误读成 `git status`
 *   的 cargo 日志会被概括成一份没人要过的状态。
 * - grep（前五行里有像样的命中，且**整份输出**的每一非空行都可解析）排在 find
 *   （所有行都像路径）之前：grep 的结果是「像路径的行」的子集，先测 find 会把每份
 *   grep 结果都抢走。
 * - 编号转储检查跑在通用兜底之前，否则兜底会吃掉它并丢掉行号。
 * - dedupLog 在 smartTruncate 之前，于是一份带重复的长日志会被去重，而不是被盲目截断。
 *
 * 什么都不匹配的 blob 返回 null 并原样放过 —— 错误的压缩比不压缩更糟。
 *
 * 移植自 Rust 的 `auto_detect_filter`（pipe_cmd.rs）外加 JS 独有的几条。
 *
 * @module src/lib/rtk/autodetect.js
 */

const { DETECT_WINDOW, READ_NUMBERED_MIN_HIT_RATIO, SMART_TRUNCATE_MIN_LINES } = require('./constants');
const { gitDiff } = require('./filters/gitDiff');
const { gitStatus } = require('./filters/gitStatus');
const { gitLog } = require('./filters/gitLog');
const { buildOutput } = require('./filters/buildOutput');
const { grep } = require('./filters/grep');
const { find } = require('./filters/find');
const { dedupLog } = require('./filters/dedupLog');
const { ls } = require('./filters/ls');
const { tree } = require('./filters/tree');
const { smartTruncate } = require('./filters/smartTruncate');
const { readNumbered, READ_NUMBERED_LINE_RE } = require('./filters/readNumbered');
const { searchList, SEARCH_LIST_HEADER_RE } = require('./filters/searchList');
const { isGrepHit, splitGrepHit, parseGrepOutput } = require('./hitLine');

const RE_GIT_DIFF = /^diff --git /m;
const RE_GIT_DIFF_HUNK = /^@@ /m;
const RE_GIT_STATUS = /^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:/m;
const RE_GIT_LOG = /^[*|/\\ ]*commit [0-9a-f]{7,40}$/m;
const RE_PORCELAIN = /^[ MADRCU?!][ MADRCU?!] \S/m;
const RE_BUILD_OUTPUT = /^(npm (warn|error|ERR!)|yarn (warn|error)|\s*Compiling\s+\S+|\s*Downloading\s+\S+|added \d+ package|\[ERROR\]|BUILD (SUCCESS|FAILED)|\s*Finished\s+|Successfully (installed|built)|ERROR:)/im;
const RE_TREE_GLYPH = /[├└]──|│  /;
const RE_LS_ROW = /^[-dlbcps][rwx-]{9}/m;
const RE_LS_TOTAL = /^total \d+$/m;

/**
 * @param {string} text 候选 blob
 * @returns {Function|null} 过滤器（带 `filterName`），或 null（原样放过）
 */
function autoDetectFilter(text) {
  // Rust：floor_char_boundary 以避免切断 UTF-8 —— JS 的 .slice() 按字符切，天然安全
  const head = text.length > DETECT_WINDOW ? text.slice(0, DETECT_WINDOW) : text;

  if (RE_GIT_LOG.test(head)) return gitLog;
  if (RE_GIT_DIFF.test(head) || RE_GIT_DIFF_HUNK.test(head)) return gitDiff;
  if (RE_GIT_STATUS.test(head)) return gitStatus;

  // 构建输出在 porcelain 检查之前：防止 cargo 的 "Compiling" 被误判成 git-status
  if (RE_BUILD_OUTPUT.test(head)) return buildOutput;

  if (isMostlyPorcelain(head)) return gitStatus;

  const lines = head.split('\n');
  const nonEmpty = lines.filter(l => l.trim().length > 0);

  // 看整行，而不是被 DETECT_WINDOW 切断的半行。候选可能是网页时间戳或源码引用；
  // 若整个 blob 是混合内容，立刻返回 null：另一个有损兜底不得认领它的散文。
  // 采样在第 5 个非空行处停止；只有出现候选时才需要下面的整份输出校验。
  const first5 = [];
  for (let start = 0; start < text.length && first5.length < 5;) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(start, end);
    if (line.trim()) first5.push(line);
    start = end + 1;
  }
  const hasCandidate = first5.some(line => {
    const hit = splitGrepHit(line);
    return hit !== null && /^\d+$/.test(hit.line);
  });
  if (hasCandidate) {
    return first5.some(isGrepHit) && parseGrepOutput(text) !== null ? grep : null;
  }

  // Rust 的 find 规则：所有非空行都像路径（不含 ':'），且 >= 3 行
  if (nonEmpty.length >= 3 && nonEmpty.every(isPathLike)) return find;

  // tree：含有 `tree` 命令典型的制表符字形
  if (RE_TREE_GLYPH.test(head)) return tree;

  // ls -la：有 "total N" 头，或有 >=3 行以权限串开头
  if (RE_LS_TOTAL.test(head) || countMatches(head, RE_LS_ROW) >= 3) return ls;

  // Cursor Glob 搜索结果清单的头部
  if (SEARCH_LIST_HEADER_RE.test(head)) return searchList;

  // 带行号的整文件转储（"  N|content"）—— 只有大量行匹配时才生效
  if (lines.length >= SMART_TRUNCATE_MIN_LINES && isLineNumbered(lines)) {
    return readNumbered;
  }

  // 兜底：通用多行噪声，带重复
  if (nonEmpty.length >= 5) return dedupLog;

  // 最后手段：没有结构的大 blob —— 智能截断
  if (text.split('\n').length >= SMART_TRUNCATE_MIN_LINES) return smartTruncate;

  return null;
}

/**
 * 一行「可能是文件系统路径」，且不含会把它变成 grep 命中的冒号。
 *
 * 盘符前缀（例如 "C:\Users\me" 或 "C:/Users/me"）标记的是 Windows 绝对路径，于是整行
 * 都按类路径处理。结尾的冒号（例如 "C:\path\file.js:10"）是容忍的，这与 Windows
 * 转储上的 grep 风格后缀一致。
 */
function isPathLike(line) {
  const t = line.trim();
  if (t.length === 0) return false;
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (t.includes(':')) return false;
  return t.startsWith('.') || t.startsWith('/') || t.includes('/');
}

/**
 * porcelain 没有可以充当钥匙的头行，所以按密度识别：至少 60% 的非空行带两列状态前缀。
 */
function isMostlyPorcelain(head) {
  const lines = head.split('\n').filter(l => l.trim());
  if (lines.length < 3) return false;
  const hits = lines.filter(l => RE_PORCELAIN.test(l)).length;
  return hits / lines.length >= 0.6;
}

/**
 * 前 100 个非空行里 `N|` 行的比例。
 *
 * 这里把「只有空白字符的行」也算作非空（`length > 0`），与 Rust 移植一致：编号转储是
 * 稠密的，其中夹一个空行不该让比例左右摇摆。
 */
function isLineNumbered(lines) {
  let hits = 0;
  let nonEmpty = 0;
  const sample = lines.slice(0, 100);
  for (const l of sample) {
    if (l.length === 0) continue;
    nonEmpty++;
    if (READ_NUMBERED_LINE_RE.test(l)) hits++;
  }
  if (nonEmpty < 5) return false;
  return hits / nonEmpty >= READ_NUMBERED_MIN_HIT_RATIO;
}

function countMatches(text, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  return (text.match(g) || []).length;
}

module.exports = { autoDetectFilter };
