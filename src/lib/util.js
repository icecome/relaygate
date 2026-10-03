'use strict';
/**
 * lib/util.js — 极简公共工具。
 * sleep：统一的 Promise 延时，供调度/重试/签到等复用。
 * hashDeviceId：与 Trae telemetry deviceId 同规则的稳定哈希（JDK String.hashCode 形态 + 19 位补零）。
 * stableHash32 / deterministicOffsetMs：确定性错峰用（同一输入恒得同一结果，跨进程重启不变）。
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hashDeviceId(machineId) {
  if (!machineId) return '';
  let hash = 0;
  for (let i = 0; i < machineId.length; i++) {
    const char = machineId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString().padStart(19, '0');
}

/**
 * FNV-1a 32 位哈希，返回无符号整数。
 * 选 FNV-1a 而非 hashCode：对短字符串的雪崩性更好，账号 id 这种
 * 前缀高度相似（同一前缀 + 序号）的输入不易被映射到相邻桶。
 *
 * @param {string} str
 * @returns {number} [0, 2^32)
 */
function stableHash32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV 素数 16777619 的移位实现，避免 32 位乘法溢出丢精度
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * 把任意键确定性映射到 [0, windowMs) 内的偏移量。
 *
 * 用途：多账号批量任务（签到、刷余额）按 (本地日期, 账号id) 分散到时间窗内，
 * 避免自造上游洪峰；同一键在任何进程、任何重启后都得到同一偏移。
 *
 * @param {string} key 通常为 `${localDateKey}:${accountId}`
 * @param {number} windowMs 时间窗长度；<=0 时返回 0（等价于关闭错峰）
 * @returns {number} 毫秒偏移
 */
function deterministicOffsetMs(key, windowMs) {
  const w = Number(windowMs);
  if (!Number.isFinite(w) || w <= 0) return 0;
  return stableHash32(key) % Math.floor(w);
}

/**
 * 把一组条目按「确定性哈希」分散到时间窗内，返回带绝对目标时刻的排序结果。
 *
 * 与「随机打散」的区别：窗口内的偏移只由 (salt, 条目键) 决定，与调用时刻、
 * 进程重启无关——因此可重放、可幂等重试，不会每次抖动到新位置。
 *
 * @template T
 * @param {T[]} items
 * @param {{keyOf:(item:T)=>string, windowStartMs:number, windowMs:number, salt?:string}} opts
 *   salt 通常传本地日期（同日多次运行结果一致）；windowMs<=0 时全部目标为 windowStartMs
 * @returns {{item:T, targetMs:number}[]} 按目标时刻升序
 */
function planSpread(items, opts) {
  const windowMs = Number(opts.windowMs);
  const start = Number(opts.windowStartMs);
  const base = Number.isFinite(start) ? start : Date.now();
  const salt = opts.salt == null ? '' : String(opts.salt);
  const list = Array.isArray(items) ? items : [];
  const spread = Number.isFinite(windowMs) && windowMs > 0;

  return list
    .map((item) => ({
      item,
      targetMs: spread
        ? base + deterministicOffsetMs(`${salt}:${opts.keyOf(item)}`, windowMs)
        : base,
    }))
    .sort((a, b) => a.targetMs - b.targetMs);
}

/** 本地日期键 YYYY-MM-DD（错峰 salt；按本地时区而非 UTC，避免跨零点错位）。 */
function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 等到指定绝对时刻；目标已过则立即返回。 */
async function sleepUntil(targetMs) {
  const wait = Number(targetMs) - Date.now();
  if (Number.isFinite(wait) && wait > 0) await sleep(wait);
}

/**
 * 按确定性计划串行执行一批任务。
 *
 * 每项等到自己的目标时刻再执行，项间保留 gapMs 保底间隔（上游串行要求）。
 * 目标时刻由 planSpread 决定，因此同一 (salt, 键) 在任何重启后都落在同一位置：
 * 既分散了上游压力，又不会因重跑而改变顺序或重复执行。
 *
 * @template T
 * @param {T[]} items
 * @param {{
 *   keyOf:(item:T)=>string,
 *   run:(item:T)=>Promise<void>,
 *   salt?:string,
 *   windowStartMs?:number,
 *   windowMs?:number,
 *   gapMs?:number,
 * }} opts
 */
async function runPlanned(items, opts) {
  const plan = planSpread(items, {
    keyOf: opts.keyOf,
    salt: opts.salt,
    windowStartMs: Number(opts.windowStartMs) || Date.now(),
    windowMs: Number(opts.windowMs) || 0,
  });
  const gapMs = Number(opts.gapMs) > 0 ? Number(opts.gapMs) : 0;
  for (const { item, targetMs } of plan) {
    await sleepUntil(targetMs);
    await opts.run(item);
    if (gapMs) await sleep(gapMs);
  }
  return plan;
}

module.exports = {
  sleep,
  sleepUntil,
  hashDeviceId,
  stableHash32,
  deterministicOffsetMs,
  planSpread,
  runPlanned,
  localDateKey,
};
