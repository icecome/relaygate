'use strict';
/**
 * lib/rtk/filters/gitDiff.js —— 把 unified diff 压成模型能读的形状。
 *
 * diff 是唯一种「形状与内容一样有信息量」的工具输出：哪些文件变了、每个 hunk 动了
 * 多少、改动行说了什么。真正花钱的是每个 hunk 逐行的正文，所以这个过滤器保留文件名、
 * hunk 头和每个 hunk 的有界窗口，其余部分换成一个明确的计数。计数本身很重要 ——
 * 一个不知道自己看的是截断 diff 的模型，会当成它看完了整个变更来推理。
 *
 * 移植自 Rust 的 `git::compact_diff`；输出里的 marker 是**移植契约**的一部分，因为
 * 它们正是模型被训练来读的东西。
 *
 * @module src/lib/rtk/filters/gitDiff.js
 */

const { GIT_DIFF_HUNK_MAX_LINES } = require('../constants');

/**
 * @param {string} diff 原始 `git diff` 输出
 * @param {number} [maxLines=500] 输出行数上限；撞到上限时会追加尾部 marker，
 *   调用方据此区分「完整压缩」与「被截断的压缩」
 * @returns {string}
 */
function gitDiff(diff, maxLines = 500) {
  const result = [];
  let currentFile = '';
  let added = 0;
  let removed = 0;
  let inHunk = false;
  let hunkShown = 0;
  let hunkSkipped = 0;
  let wasTruncated = false;
  const maxHunkLines = GIT_DIFF_HUNK_MAX_LINES;

  const lines = diff.split('\n');

  // 上限一到就在 diff 中途停下循环；退出后的收尾仍然会跑，所以最后那个不完整的
  // hunk 依旧会报出它跳过了多少行。
  // （源实现这里写的是带标签的 `break outer`，因为那段 break 未必是循环体最后一句；
  // 本移植把判断留在同一位置，于是普通 break 语义完全相同，也省掉一个无用标签。）
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (hunkSkipped > 0) {
        result.push(`  ... (${hunkSkipped} lines truncated)`);
        wasTruncated = true;
        hunkSkipped = 0;
      }
      // 开新文件之前，先把上一个文件的增删计数结算掉。
      if (currentFile && (added > 0 || removed > 0)) {
        result.push(`  +${added} -${removed}`);
      }
      // "diff --git a/x b/y" —— 取第一个 " b/" 之后的全部内容，这样路径自身
      // 含有 " b/" 时也不会被截短。
      const parts = line.split(' b/');
      currentFile = parts.length > 1 ? parts.slice(1).join(' b/') : 'unknown';
      result.push(`\n${currentFile}`);
      added = 0;
      removed = 0;
      inHunk = false;
      hunkShown = 0;
    } else if (line.startsWith('@@')) {
      if (hunkSkipped > 0) {
        result.push(`  ... (${hunkSkipped} lines truncated)`);
        wasTruncated = true;
        hunkSkipped = 0;
      }
      inHunk = true;
      hunkShown = 0;
      result.push(`  ${line}`);
    } else if (inHunk) {
      // `+++`/`---` 是文件头而不是内容：把它们算成改动，会抬高每个文件的 +N -M，
      // 让模型对规模产生错误判断。
      if (line.startsWith('+') && !line.startsWith('+++')) {
        added += 1;
        if (hunkShown < maxHunkLines) {
          result.push(`  ${line}`);
          hunkShown += 1;
        } else {
          hunkSkipped += 1;
        }
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        removed += 1;
        if (hunkShown < maxHunkLines) {
          result.push(`  ${line}`);
          hunkShown += 1;
        } else {
          hunkSkipped += 1;
        }
      } else if (hunkShown < maxHunkLines && !line.startsWith('\\')) {
        // 上下文行只有在紧挨着一个被显示出来的改动时才有意义：一个前 100 行全是
        // 上下文的 hunk，否则只会以噪声的形式到达。
        if (hunkShown > 0) {
          result.push(`  ${line}`);
          hunkShown += 1;
        }
      }
    }

    if (result.length >= maxLines) {
      result.push('\n... (more changes truncated)');
      wasTruncated = true;
      break;
    }
  }

  if (hunkSkipped > 0) {
    result.push(`  ... (${hunkSkipped} lines truncated)`);
    wasTruncated = true;
  }

  if (currentFile && (added > 0 || removed > 0)) {
    result.push(`  +${added} -${removed}`);
  }

  // 告诉模型去哪儿拿完整版本，而不是让它以为压缩后的 diff 就是全部。
  if (wasTruncated) {
    result.push('[full diff: rtk git diff --no-compact]');
  }

  return result.join('\n');
}

gitDiff.filterName = 'git-diff';

module.exports = { gitDiff };
