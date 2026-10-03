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

let cache = null;

function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(FILE())) {
      cache = JSON.parse(fs.readFileSync(FILE(), 'utf-8'));
    }
  } catch { /* ignore */ }
  if (!cache || typeof cache !== 'object') cache = {};
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
