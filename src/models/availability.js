'use strict';
/**
 * models/availability.js — 模型可用性学习与持久化。
 * 状态：unknown | usable | unavailable
 * 规则（对齐 muskke/trae-api-proxy 思路）：
 * - 真实成功调用 → usable
 * - 最小标准请求明确 4001 / 不可用 → unavailable（带 TTL）
 * - 复杂请求（带 tools）收到 4001 不拉黑模型
 */
const fs = require('fs');
const { writeJsonAtomic } = require('../lib/atomic-write');
const { stateFile } = require('../lib/paths');

const TTL_MS = 7 * 24 * 3600 * 1000;
const FILE = () => stateFile('model-status.json');

/**
 * 一次性数据修复：清除被误判的可用性记录。
 *
 * 背景（2026-10-06 19:24 事故）：admin-debug 的 wb/ 探测分支漏传
 * pool.run 的 edition，wb 模型被发给 Trae 上游，上游回
 * "the param is invalid"（即 4001 模型配置错），被写成本地不可用。
 * 实际转发链路正常，属纯粹的错误结论。受影响记录的共同特征：
 *   wb/ 前缀 + 该上游文案 —— 两条件同时成立才删，避免误伤真实的模型下线记录。
 *
 * 修复后正常探测即可让 wb/* 自行回到 usable，无需人工干预；
 * 此处只做一次性清污，不改判任何模型的可用性语义。
 * 直接删除条目而非置 unknown：条目消失即回到「未探测」，与从未探测过等价，
 * 且 reason 里的错误文案一并清除，避免面板继续显示误导性原因。
 * 用标记文件保证跨进程只执行一次。
 */
const BOGUS_UNAVAILABLE = /the param is invalid/i;
const REPAIR_FLAG = () => stateFile('model-status-repaired.json');

/**
 * 清除误判记录。
 * @param {object} c 已载入的状态表（由 load 传入，避免重入 load 造成隐式递归）
 * @returns {string[]} 被清理的模型 id
 */
function repairBogusUnavailable(c) {
  const cleared = [];
  for (const [k, v] of Object.entries(c)) {
    if (!k.startsWith('wb/')) continue;
    if (v.status !== 'unavailable') continue;
    if (!BOGUS_UNAVAILABLE.test(String(v.reason || ''))) continue;
    delete c[k];
    cleared.push(k);
  }
  if (cleared.length) {
    save();
    console.log(`[models] repaired ${cleared.length} bogus unavailable entries: ${cleared.join(', ')}`);
  }
  return cleared;
}

/** 一次性清污入口（幂等：标记文件存在即跳过）。 */
function repairOnce() {
  if (fs.existsSync(REPAIR_FLAG())) return [];
  const cleared = repairBogusUnavailable(cache);
  try { fs.writeFileSync(REPAIR_FLAG(), JSON.stringify({ at: Date.now(), cleared })); } catch { /* ignore */ }
  return cleared;
}

let cache = null;

function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(FILE())) {
      cache = JSON.parse(fs.readFileSync(FILE(), 'utf-8'));
    }
  } catch { /* ignore */ }
  if (!cache || typeof cache !== 'object') cache = {};
  // 首次载入后执行一次性清污；失败不阻断可用性读取
  try { repairOnce(); } catch { /* ignore */ }
  return cache;
}

function save() {
  writeJsonAtomic(FILE(), cache || {}, { newline: false });
}

function prune() {
  const c = load();
  const now = Date.now();
  let dirty = false;
  for (const [k, v] of Object.entries(c)) {
    if (v.status === 'unavailable' && v.expireAt && v.expireAt < now) {
      delete c[k];
      dirty = true;
    }
  }
  if (dirty) save();
}

function statusOf(model) {
  prune();
  const c = load();
  const e = c[String(model || '').toLowerCase()];
  return e ? e.status : 'unknown';
}

/** 取模型可用性条目（含 status/reason/at），无记录返回 null。 */
function entryOf(model) {
  prune();
  const c = load();
  const e = c[String(model || '').toLowerCase()];
  return e ? { status: e.status, reason: e.reason || null, at: e.at || null } : null;
}

function markUsable(model) {
  const key = String(model || '').toLowerCase();
  if (!key || key === 'auto') return;
  const c = load();
  if (c[key] && c[key].status === 'usable') return;
  c[key] = { status: 'usable', at: Date.now() };
  save();
}

function markUnavailable(model, reason) {
  const key = String(model || '').toLowerCase();
  if (!key || key === 'auto') return;
  const c = load();
  c[key] = {
    status: 'unavailable',
    at: Date.now(),
    expireAt: Date.now() + TTL_MS,
    reason: String(reason || '').slice(0, 200),
  };
  save();
}

function reset(model) {
  const c = load();
  if (model) delete c[String(model).toLowerCase()];
  else {
    for (const k of Object.keys(c)) delete c[k];
  }
  save();
}

function snapshot() {
  prune();
  const c = load();
  return Object.entries(c).map(([id, v]) => ({
    id,
    status: v.status,
    at: v.at,
    reason: v.reason || null,
  }));
}

/** 是否应从 /v1/models 默认列表隐藏。 */
function isHidden(model) {
  return statusOf(model) === 'unavailable';
}

module.exports = {
  statusOf,
  entryOf,
  markUsable,
  markUnavailable,
  reset,
  snapshot,
  isHidden,
};
