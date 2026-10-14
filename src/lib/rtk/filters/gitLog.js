'use strict';
/**
 * lib/rtk/filters/gitLog.js —— 压缩 `git log`。
 *
 * 到模型面前的有三种输出模式 —— 默认（commit 头 + 完整正文）、`--oneline`、`--graph`
 * —— 三种都在这里处理，因为模型没法要求调用方换一组参数重跑。留下来的信息是模型
 * 真正会用的：sha、subject、author、date，以及说明变更规模的那行 diffstat。
 * 去掉的是 commit 正文散文、graph 装饰、以及内嵌 diff —— 它们都不改变模型对这段
 * 历史能得出的结论。
 *
 * @module src/lib/rtk/filters/gitLog.js
 */

const { GIT_LOG_MAX_LINES } = require('../constants');

/**
 * @param {string} text 原始 `git log` 输出
 * @param {number} [maxLines=GIT_LOG_MAX_LINES] 输出行数上限
 * @returns {string}
 */
function gitLog(text, maxLines = GIT_LOG_MAX_LINES) {
  if (!text) return '';

  const input = String(text);
  const lines = input.split('\n');
  const out = [];
  let skipped = 0;
  let inCommit = false;
  let subjectSeen = false;

  // 三种模式都从这里过，好让上限统一生效；被丢掉的行数在末尾报出来，
  // 而不是被静默吞掉。
  function pushLine(l) {
    if (out.length < maxLines) {
      out.push(l);
      return true;
    }
    skipped++;
    return false;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const trimmed = line.trim();

    // commit <sha> 头 —— 开始一条新的 commit 记录。
    // 也匹配带 graph 装饰的形态（`*   commit abc1234...` —— 带 --graph 但不带 --oneline）
    if (/^commit [0-9a-f]{7,40}$/i.test(trimmed) || /^[*|/\\ ]+commit [0-9a-f]{7,40}/i.test(trimmed)) {
      inCommit = true;
      subjectSeen = false;
      pushLine(line);
      continue;
    }

    if (inCommit) {
      // Author / Date —— 原样保留（原文里本来就在第 0 列，或已被 commit 头匹配剥掉 graph 前缀）
      if (/^[*|/\\ ]*(Author|Date):/i.test(trimmed)) {
        pushLine(trimmed);
        continue;
      }
      // 空行 —— 跳过
      if (trimmed === '') continue;
      // 缩进的 subject（4 个空格，前面可能带 graph 装饰）—— 第一条就是 subject
      if (!subjectSeen && /^[*|/\\ ]*    \S/.test(line)) {
        pushLine('  Subject: ' + trimmed);
        subjectSeen = true;
        continue;
      }
      // stat 摘要："N file(s) changed, N insertions(+), N deletions(-)"
      if (/^\d+ file\w* changed/.test(trimmed)) {
        pushLine('  ' + trimmed);
        continue;
      }
      // 内嵌 diff 头 —— 压成一行 marker
      if (/^diff --git /.test(trimmed)) {
        pushLine('  ... diff body omitted');
        continue;
      }
      // commit 正文里其它一切 —— 丢掉
      continue;
    }

    // 不在 commit 块里（--oneline / --graph 模式）：

    // graph 装饰 + sha + subject："*|/\ <sha7> <subject>"
    const graphMatch = trimmed.match(/^[*|/\\ ]+([0-9a-f]{7,40}\s+.+)/i);
    if (graphMatch) {
      pushLine(graphMatch[1]);
      continue;
    }

    // 普通 oneline："<sha7> <subject>"
    if (/^[0-9a-f]{7,40}\s+/.test(trimmed)) {
      pushLine(trimmed);
      continue;
    }

    // 纯 graph 装饰（没有 sha）—— 丢掉
    if (/^[*|/\\ ]+$/.test(trimmed) && /[*|/\\]/.test(trimmed)) {
      continue;
    }

    // 兜底原样通过
    pushLine(trimmed);
  }

  if (skipped > 0) out.push(`... (${skipped} more lines)`);

  const result = out.join('\n');
  // 过滤器绝不能把请求变大或变空；两者都比原文更糟，所以原文胜出。
  if (!result && input) return input;
  if (result.length > input.length) return input;
  return result;
}

gitLog.filterName = 'git-log';

module.exports = { gitLog };
