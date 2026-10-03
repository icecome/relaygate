'use strict';
/**
 * model-router/store.js — 虚拟模型路由配置（model-router.json）。
 *
 * 配置形态：
 * - providers：远端模型服务（builtin: trae|workbuddy / openai: 通用兼容端点）
 * - virtualModels：自定义模型 ID → 候选远端模型列表（优先级/权重/频率）
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { writeJsonAtomic } = require('../lib/atomic-write');

// model-router.json 位于工作区根（用户可直接编辑），非 .trae-api 状态目录；
// 读时回退仓库内模板，写时固定工作区，避免污染模板。
const FILE = () => path.join(config.workspaceDir || process.cwd(), 'model-router.json');
const ROOT_FILE = () => path.join(__dirname, '..', '..', 'model-router.json');

function emptyConfig() {
  return {
    version: 1,
    providers: {
      trae: { type: 'builtin', builtin: 'trae', enabled: true, label: 'Trae 内置账号池' },
      workbuddy: { type: 'builtin', builtin: 'workbuddy', enabled: true, label: 'WorkBuddy 内置账号池' },
    },
    virtualModels: {},
  };
}

function resolveFile() {
  // 写路径固定工作区；读路径工作区优先，其次项目根模板
  return FILE();
}

function readSourceFile() {
  const a = FILE();
  if (fs.existsSync(a)) return a;
  if (fs.existsSync(ROOT_FILE())) return ROOT_FILE();
  return a;
}

let cache = null;
let loadedFrom = null;

function load() {
  if (cache) return cache;
  const f = readSourceFile();
  loadedFrom = f;
  try {
    if (fs.existsSync(f)) {
      const raw = JSON.parse(fs.readFileSync(f, 'utf-8'));
      cache = normalize(raw);
      return cache;
    }
  } catch (e) {
    console.error('[model-router] load config failed:', e.message);
  }
  cache = emptyConfig();
  return cache;
}

function normalize(raw) {
  const base = emptyConfig();
  if (!raw || typeof raw !== 'object') return base;
  const out = {
    version: 1,
    providers: { ...base.providers },
    virtualModels: {},
  };
  for (const [id, p] of Object.entries(raw.providers || {})) {
    out.providers[id] = normalizeProvider(id, p);
  }
  for (const [id, vm] of Object.entries(raw.virtualModels || {})) {
    const n = normalizeVirtual(id, vm);
    if (n) out.virtualModels[id] = n;
  }
  return out;
}

function normalizeProvider(id, p) {
  const type = p && p.type === 'openai' ? 'openai' : 'builtin';
  const builtin = type === 'builtin' ? (p.builtin || id) : null;
  return {
    type,
    builtin: type === 'builtin' ? (builtin === 'trae' || builtin === 'workbuddy' ? builtin : 'trae') : null,
    label: p.label || id,
    enabled: p.enabled !== false,
    baseUrl: type === 'openai' ? String(p.baseUrl || '').replace(/\/+$/, '') : null,
    // 敏感项只存环境变量名；可选 apiKey 仅本地文件场景使用
    apiKeyEnv: p.apiKeyEnv ? String(p.apiKeyEnv) : null,
    apiKey: p.apiKey ? String(p.apiKey) : null,
    models: Array.isArray(p.models) ? p.models.map(String) : null,
    timeoutMs: Number(p.timeoutMs) > 0 ? Number(p.timeoutMs) : 600000,
  };
}

function normalizeVirtual(id, vm) {
  if (!vm || typeof vm !== 'object') return null;
  const candidates = [];
  for (const c of vm.candidates || []) {
    if (!c || !c.provider || !c.model) continue;
    candidates.push({
      id: String(c.id || `${c.provider}:${c.model}`),
      provider: String(c.provider),
      model: String(c.model),
      priority: Number.isFinite(Number(c.priority)) ? Number(c.priority) : 100,
      weight: Number.isFinite(Number(c.weight)) && Number(c.weight) > 0 ? Number(c.weight) : 1,
      maxRpm: Number.isFinite(Number(c.maxRpm)) && Number(c.maxRpm) > 0 ? Number(c.maxRpm) : null,
      enabled: c.enabled !== false,
    });
  }
  if (!candidates.length) return null;
  const failover = vm.failover || {};
  return {
    enabled: vm.enabled !== false,
    description: String(vm.description || ''),
    strategy: vm.strategy === 'weighted' ? 'weighted' : 'priority',
    candidates,
    failover: {
      maxAttempts: Number(failover.maxAttempts) > 0 ? Number(failover.maxAttempts) : 3,
      switchOn: Array.isArray(failover.switchOn) && failover.switchOn.length
        ? failover.switchOn.map(String)
        : ['rate_limit', 'model', '5xx', 'network', 'other'],
      cooldownMs: Number(failover.cooldownMs) > 0 ? Number(failover.cooldownMs) : 20000,
    },
  };
}

function save() {
  // 始终写入工作区文件，避免污染仓库内模板
  return writeJsonAtomic(FILE(), cache || emptyConfig(), { newline: false });
}

function listProviders() {
  return Object.entries(load().providers).map(([id, p]) => ({
    id,
    type: p.type,
    builtin: p.builtin,
    label: p.label,
    enabled: p.enabled,
    baseUrl: p.baseUrl,
    apiKeyEnv: p.apiKeyEnv,
    hasApiKey: !!(p.apiKey || p.apiKeyEnv),
    models: p.models,
    timeoutMs: p.timeoutMs,
  }));
}

function getProvider(id) {
  return load().providers[id] || null;
}

function upsertProvider(id, patch) {
  const c = load();
  const prev = c.providers[id] || { type: 'builtin', builtin: id, enabled: true, label: id };
  c.providers[id] = normalizeProvider(id, { ...prev, ...patch, type: patch.type || prev.type });
  cache = c;
  save();
  return listProviders().find((p) => p.id === id);
}

function removeProvider(id) {
  const c = load();
  if (c.providers[id] && c.providers[id].type === 'builtin' && (id === 'trae' || id === 'workbuddy')) {
    return { ok: false, message: '内置 Provider 不可删除' };
  }
  delete c.providers[id];
  // 清理引用该 Provider 的候选
  for (const vm of Object.values(c.virtualModels)) {
    vm.candidates = vm.candidates.filter((x) => x.provider !== id);
  }
  cache = c;
  save();
  return { ok: true };
}

function listVirtual() {
  return Object.entries(load().virtualModels).map(([id, vm]) => ({ id, ...vm }));
}

function getVirtual(id) {
  return load().virtualModels[id] || null;
}

function upsertVirtual(id, patch) {
  const c = load();
  const prev = c.virtualModels[id] || { enabled: true, description: '', strategy: 'priority', candidates: [], failover: {} };
  const merged = normalizeVirtual(id, {
    ...prev,
    ...patch,
    failover: { ...(prev.failover || {}), ...(patch.failover || {}) },
  });
  if (!merged) return { ok: false, message: 'candidates 不能为空，且每项需含 provider+model' };
  c.virtualModels[id] = merged;
  cache = c;
  save();
  return { ok: true, data: { id, ...merged } };
}

function removeVirtual(id) {
  const c = load();
  delete c.virtualModels[id];
  cache = c;
  save();
  return { ok: true };
}

function reload() {
  cache = null;
  return load();
}

module.exports = {
  load,
  save,
  reload,
  listProviders,
  getProvider,
  upsertProvider,
  removeProvider,
  listVirtual,
  getVirtual,
  upsertVirtual,
  removeVirtual,
  normalizeVirtual,
  normalizeProvider,
};
