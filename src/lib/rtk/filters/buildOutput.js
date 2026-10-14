'use strict';
/**
 * lib/rtk/filters/buildOutput.js —— 压缩构建工具输出（npm、yarn、cargo、rustc、
 * maven、gradle）。
 *
 * 构建日志大部分是进度："Compiling X" 每个 crate 一次、"Downloading X" 每个包一次、
 * 弃用告警刷屏。模型能据此行动的部分只有错误（含 rustc 的续行，它们带着文件、span
 * 和 note）、有界的少量告警，以及最终摘要。其余全部换成计数，这样模型仍然知道「干了
 * 活」，却不必为其中每一行付钱。
 *
 * @module src/lib/rtk/filters/buildOutput.js
 */

// cargo/rustc 错误续行：" --> file:line"、"  |"、"N | code"、"  = note: ..."
const RE_CARGO_ERR_CONT = /^\s*(-->|\||\d+\s*\||=)/;
const DEPRECATION_KEEP = 3;

/**
 * @param {string} input
 * @returns {string} 压缩后的构建日志；全是进度噪声时原样返回
 */
function buildOutput(input) {
  const lines = input.split('\n');
  if (lines.length === 0) return input;

  const errors = [];
  const warnings = [];
  const deprecations = [];
  let summary = null;
  let compilingCount = 0;
  let downloadingCount = 0;
  let inCargoError = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // cargo 错误块的续行：在块内原样保留
    if (inCargoError) {
      if (!trimmed) { inCargoError = false; continue; }
      if (RE_CARGO_ERR_CONT.test(line)) { errors.push(line); continue; }
      inCargoError = false;
    }

    if (!trimmed) continue;

    if (/^npm (ERR!|error)/i.test(trimmed) || /^yarn error/i.test(trimmed)) {
      errors.push(line);
      continue;
    }

    // 弃用告警是按依赖各重复一次的包名噪声；前几条足以告诉模型这棵树在变老。
    if (/^npm warn deprecated/i.test(trimmed)) {
      deprecations.push(line);
      continue;
    }
    if (/^npm warn/i.test(trimmed) || /^yarn warn/i.test(trimmed)) {
      warnings.push(line);
      continue;
    }

    if (/^error(\[|:)/i.test(trimmed) || trimmed.startsWith('error -->')) {
      errors.push(line);
      inCargoError = true;
      continue;
    }

    if (/^warning(\[|:)/i.test(trimmed) || trimmed.startsWith('warning -->')) {
      warnings.push(line);
      inCargoError = true;
      continue;
    }

    if (/^ERROR:/i.test(trimmed)) {
      errors.push(line);
      continue;
    }

    if (/^\[ERROR\]/i.test(trimmed) || /^BUILD FAILED/i.test(trimmed)) {
      errors.push(line);
      continue;
    }

    if (/^\[WARNING\]/i.test(trimmed)) {
      warnings.push(line);
      continue;
    }

    if (/^\s*Compiling\s+\S+/i.test(trimmed)) {
      compilingCount++;
      continue;
    }
    if (/^\s*Downloading\s+\S+/i.test(trimmed) || /^Fetching\s+/i.test(trimmed)) {
      downloadingCount++;
      continue;
    }

    // 摘要行就是结论；凡是匹配的一律保留。
    if (
      /^(added|removed|changed|audited|installed)\s+\d+\s+package/i.test(trimmed) ||
      /^\s*Finished\s+/i.test(trimmed) ||
      /^BUILD SUCCESS/i.test(trimmed) ||
      /^\d+\s+(vulnerabilities|packages?|warnings?|errors?)/i.test(trimmed) ||
      /^Successfully (installed|built)/i.test(trimmed) ||
      /^To address .* issues/i.test(trimmed) ||
      /^Run `npm (audit|fund)`/i.test(trimmed) ||
      /packages are looking for funding/i.test(trimmed)
    ) {
      summary = summary ? `${summary}\n${line}` : line;
      continue;
    }
  }

  let out = '';

  // 前 N 条弃用告警原样保留（包名 + 原因），其余只报计数
  const keepDep = deprecations.slice(0, DEPRECATION_KEEP);
  for (const d of keepDep) out += `${d}\n`;
  if (deprecations.length > DEPRECATION_KEEP) {
    out += `... +${deprecations.length - DEPRECATION_KEEP} more deprecated packages\n`;
  }

  if (compilingCount > 0) {
    out += `Compiled ${compilingCount} packages\n`;
  }
  if (downloadingCount > 0) {
    out += `Downloaded ${downloadingCount} packages\n`;
  }

  for (const e of errors) out += `${e}\n`;

  const keepWarnings = warnings.slice(0, 5);
  for (const w of keepWarnings) out += `${w}\n`;
  if (warnings.length > 5) {
    out += `... +${warnings.length - 5} more warnings\n`;
  }

  if (summary) out += `${summary}\n`;

  // 如果每一行都是进度噪声，那就没什么可说的；原文比空字符串更诚实
  // （空字符串读起来像「构建什么都没打印」）。
  return out.replace(/\n+$/, '') || input;
}

buildOutput.filterName = 'build-output';

module.exports = { buildOutput };
