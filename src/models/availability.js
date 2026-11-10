'use strict';
/**
 * models/availability.js — 模型可用性学习与持久化。
 * 状态：unknown | usable | unavailable。
 * 规则（与 muskke/trae-api-proxy 的思路一致）：
 * - 真实成功调用 → usable
 * - 最小标准请求明确 4001 或不可用 → unavailable（带 TTL）
 * - 复杂请求（带 tools）收到 4001 时不拉黑模型
 */
const fs = require('fs');
const { writeJsonAtomic } = require('../lib/atomic-write');
const { stateFile } = require('../lib/paths');

const TTL_MS = 7 * 24 * 3600 * 1000;
const FILE = () => stateFile('model-status.json');

/**
 * 一次性数据修复：清除被误判的可用性记录。
 *
 * 2026-10-06 19:24 事故：admin-debug 的 wb/ 探测分支漏传 pool.run 的 edition，
 * wb 模型被发给 Trae 上游，上游回 "the param is invalid"（即 4001 模型配置错），
 * 被写成本地不可用；实际转发链路正常，属错误结论。
 * 受影响记录的共同特征是 wb/ 前缀与该上游文案，二者同时成立才删，避免误伤真实的模型下线记录。
 *
 * 修复后正常探测即可让 wb/* 回到 usable，无需人工干预。直接删除条目而非置 unknown：
 * 条目消失即回到「未探测」，与从未探测过等价，并一并清除 reason 里的误导性文案。
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

/** 一次性清理入口（幂等：标记文件存在即跳过）。 */
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
  // 首次载入后执行一次性清理；失败不阻断可用性读取
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

/**
 * 标记不可用。
 *
 * @param {string} model
 * @param {string} reason
 * @param {{ttlMs?:number}} [opts] 覆盖默认 TTL。
 *   默认 7 天适用于「模型在平台侧确实下线」这类稳定结论；
 *   账号级/套餐级这类**可能随权益变化**的结论要给短 TTL（见 scheduler 的
 *   PlanLimit 分支），否则会在面板上长期隐藏一个其实换个号就能用的模型。
 */
function markUnavailable(model, reason, opts = {}) {
  const key = String(model || '').toLowerCase();
  if (!key || key === 'auto') return;
  const ttl = Number(opts && opts.ttlMs) > 0 ? Number(opts.ttlMs) : TTL_MS;
  const c = load();
  c[key] = {
    status: 'unavailable',
    at: Date.now(),
    expireAt: Date.now() + ttl,
    reason: String(reason || '').slice(0, 200),
  };
  save();
}

/**
 * 目录对账：某前缀下、**不在** `keepIds` 里的可用性条目一律清除。
 *
 * 为什么需要：平台目录是模型存在性的权威来源。模型从目录消失后，旧的可用性
 * 记录（哪怕是 usable）会一直留着——面板上出现「早就不在目录里、却仍显示可用」
 * 的条目（2026-11-08 现场：wb/hy4-preview、wb/glm-5v-turbo、wb/minimax-m3）。
 *
 * 只对**目录可信**的前缀调用（WorkBuddy 动态目录是权威的；Trae 目录含
 * hidden 项且不等于可调用集合，不能用来做删除判据）。
 *
 * @param {string} prefix 例如 'wb/'
 * @param {Iterable<string>} keepIds 完整 id 列表（**含**前缀）
 * @returns {string[]} 被清除的 id
 */
function reconcile(prefix, keepIds) {
  const p = String(prefix || '');
  if (!p) return [];
  const keep = new Set([...keepIds].map((x) => String(x).toLowerCase()));
  const c = load();
  const removed = [];
  for (const k of Object.keys(c)) {
    if (!k.startsWith(p)) continue;
    if (keep.has(k)) continue;
    delete c[k];
    removed.push(k);
  }
  if (removed.length) save();
  return removed;
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
  reconcile,
  reset,
  snapshot,
  isHidden,
};
