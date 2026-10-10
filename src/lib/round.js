'use strict';
/**
 * lib/round.js — 数值四舍五入助手。
 *
 * 原先 log/stats、log/stats-cache、log/client-logs、jobs/credit-alerts、
 * routes/credentials、workbuddy/billing-usage 各自定义一份 round2/round4，
 * 口径容易在改动中分叉。统一到此处。
 *
 * 非有限值（null/NaN/Infinity/字符串）一律归 0：聚合场景下缺值参与求和
 * 会污染整个结果，归 0 与「未计量」的既有语义一致。
 */

/** 保留 2 位小数。 */
function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** 保留 4 位小数。 */
function round4(n) {
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0;
}

/** 保留 6 位小数（token 费率量级为 1e-5，round4 会抹掉有效位）。 */
function round6(n) {
  return Number.isFinite(n) ? Math.round(n * 1000000) / 1000000 : 0;
}

/**
 * 保留 8 位小数。
 * 用于「积分/千 token」这类跨 4 个数量级的比值：实测账单侧该值约 0.0103，
 * round6 会把末位有效数字抹掉（0.01034799 → 0.010348 尚可，但再窄就归零）。
 */
function round8(n) {
  return Number.isFinite(n) ? Math.round(n * 100000000) / 100000000 : 0;
}

module.exports = { round2, round4, round6, round8 };