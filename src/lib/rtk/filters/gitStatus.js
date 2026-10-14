'use strict';
/**
 * lib/rtk/filters/gitStatus.js —— 压缩 `git status`，两种方言都认。
 *
 * porcelain 输出（`--porcelain`，大多数 agent 工具用的就是它）是两列状态码加一个路径，
 * 一个文件一行；长格式输出是散文式的 `modified:   path` 分段。模型需要的只有分支、
 * 计数，以及足够认出自己那份工作的路径列表 —— 而不是上百行的逐文件仪式。两种方言都
 * 在这里解析，因为线上没有任何线索告诉你是哪一种；而一个只认 porcelain 的解析器会对
 * 长格式输入**静默地报「干净」**（这正是模型在明明有未暂存改动的情况下得出结论说
 * 没有东西可提交的原因）。
 *
 * 移植自 Rust 的 `git::format_status_output`。
 *
 * @module src/lib/rtk/filters/gitStatus.js
 */

const { STATUS_MAX_FILES, STATUS_MAX_UNTRACKED } = require('../constants');

/**
 * @param {string} input 原始 `git status` 输出（porcelain 或长格式）
 * @returns {string}
 */
function gitStatus(input) {
  const lines = input.split('\n');
  if (lines.length === 0 || (lines.length === 1 && !lines[0].trim())) {
    return 'Clean working tree';
  }

  let branch = '';
  const stagedFiles = [];
  const modifiedFiles = [];
  const untrackedFiles = [];
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicts = 0;

  for (const raw of lines) {
    if (!raw.trim()) continue;

    // 长格式的分支行（LLM 通常发这个，而不是 porcelain）
    const longBranch = raw.match(/^On branch (\S+)/);
    if (longBranch) { branch = longBranch[1]; continue; }

    // porcelain 的分支头："## main...origin/main"
    if (raw.startsWith('##')) { branch = raw.replace(/^##\s*/, ''); continue; }

    // porcelain 状态（2 个字符 + 空格 + 路径）
    if (raw.length >= 3 && /^[ MADRCU?!][ MADRCU?!] /.test(raw)) {
      const x = raw[0];
      const y = raw[1];
      const file = raw.slice(3);

      if (raw.slice(0, 2) === '??') {
        untracked++;
        untrackedFiles.push(file);
        continue;
      }

      // 第 1 列是索引区：任何能表示「已暂存」的字母都算暂存。
      if ('MADRC'.includes(x)) {
        staged++;
        stagedFiles.push(file);
      } else if (x === 'U') {
        conflicts++;
      }

      // 第 2 列是工作区：已修改或已删除但未暂存。
      if (y === 'M' || y === 'D') {
        modified++;
        modifiedFiles.push(file);
      }
      continue;
    }

    // 长格式兜底（"modified:   path"、"new file:   path" 等）
    const longMatch = raw.match(/^\s*(modified|new file|deleted|renamed|both modified):\s+(.+)$/);
    if (longMatch) {
      const kind = longMatch[1];
      const path = longMatch[2].trim();
      if (kind === 'both modified') { conflicts++; }
      else if (kind === 'modified' || kind === 'deleted') { modified++; modifiedFiles.push(path); }
      else if (kind === 'new file' || kind === 'renamed') { staged++; stagedFiles.push(path); }
      continue;
    }

    // "Untracked files:" 分段 —— 只收集该标记之后的裸路径。
    // 这里是有意不处理：没有标记的裸路径一律跳过（更安全）。
  }

  let out = '';
  if (branch) out += `* ${branch}\n`;

  if (staged > 0) {
    out += `+ Staged: ${staged} files\n`;
    for (const f of stagedFiles.slice(0, STATUS_MAX_FILES)) out += `   ${f}\n`;
    if (stagedFiles.length > STATUS_MAX_FILES) {
      out += `   ... +${stagedFiles.length - STATUS_MAX_FILES} more\n`;
    }
  }

  if (modified > 0) {
    out += `~ Modified: ${modified} files\n`;
    for (const f of modifiedFiles.slice(0, STATUS_MAX_FILES)) out += `   ${f}\n`;
    if (modifiedFiles.length > STATUS_MAX_FILES) {
      out += `   ... +${modifiedFiles.length - STATUS_MAX_FILES} more\n`;
    }
  }

  if (untracked > 0) {
    out += `? Untracked: ${untracked} files\n`;
    for (const f of untrackedFiles.slice(0, STATUS_MAX_UNTRACKED)) out += `   ${f}\n`;
    if (untrackedFiles.length > STATUS_MAX_UNTRACKED) {
      out += `   ... +${untrackedFiles.length - STATUS_MAX_UNTRACKED} more\n`;
    }
  }

  if (conflicts > 0) {
    out += `conflicts: ${conflicts} files\n`;
  }

  // 「状态为空」是一件必须被明确告知模型的事实：沉默读起来像「命令失败了」，
  // 于是模型会再跑一次 status。
  if (staged === 0 && modified === 0 && untracked === 0 && conflicts === 0) {
    out += 'clean — nothing to commit\n';
  }

  return out.replace(/\n+$/, '');
}

gitStatus.filterName = 'git-status';

module.exports = { gitStatus };
