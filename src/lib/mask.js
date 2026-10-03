'use strict';
/**
 * lib/mask.js — 敏感串的统一脱敏口径。
 *
 * 原先 log/traffic.js 的 mask（首 6 + 内容哈希前 8）与 routes/workbuddy.js 的
 * maskToken（首 8 + 尾 6）是两套独立实现，同一个 token 在两处呈现不同，
 * 排查时容易误以为是不同的值。此处收敛为一份。
 *
 * 取值口径：保留首 6 与尾 4。前缀足以区分「哪一把」，后缀足以与上游记录对照；
 * 中间部分一律不落。过短的串直接整串隐去——长度不足时任何切片都接近原文。
 */

/** @param {unknown} value @returns {string|null} */
function maskSecret(value) {
  if (value == null) return null;
  const s = String(value);
  if (s.length <= 12) return '***';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

module.exports = { maskSecret };