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
    // 敏感项只存环境变量名（M-S6 根因修复）：明文 apiKey 曾被原样持久化到
    // model-router.json，与账号 token 的 AES-256-GCM 口径不一致。
    // 现统一为 apiKeyEnv 单源，normalize 时一律剥离明文字段（含存量文件）。
    apiKeyEnv: p.apiKeyEnv ? String(p.apiKeyEnv) : null,
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
      // 置顶：无视成本排名强制进入轮转池，用于「只要高性能模型」的场景。
      // 与 enabled 正交：置顶的候选仍可被单独禁用。
      pinned: c.pinned === true,
      // —— 自动分层字段（autotier 写入；手动 VM 亦可声明）——
      // 候选侧真实窗口/输出上限：声明后路由按「请求输入 ≤ 该候选窗口」择优，不依赖虚拟级单一声明
      contextWindow: Number.isFinite(Number(c.contextWindow)) && Number(c.contextWindow) > 0 ? Number(c.contextWindow) : null,
      promptMaxTokens: Number.isFinite(Number(c.promptMaxTokens)) && Number(c.promptMaxTokens) > 0 ? Number(c.promptMaxTokens) : null,
      maxOutputTokens: Number.isFinite(Number(c.maxOutputTokens)) && Number(c.maxOutputTokens) > 0 ? Number(c.maxOutputTokens) : null,
      rate: Number.isFinite(Number(c.rate)) && Number(c.rate) >= 0 ? Number(c.rate) : null,
    });
  }
  if (!candidates.length) return null;
  // 自动分层虚拟模型：候选由 autotier 按平台目录窗口层生成，面板只读候选、
  // 仅保留候选级禁用开关；contextWindow 声明值 = 分层窗口（硬约束）。
  // sort：候选自动排序策略 rate=倍率低优先 | window=窗口大优先 | null=按 priority
  // rotateTopN：轮转池大小（取排序后前 N 个候选做加权轮转）。缺省 0 表示不轮转，
  // 沿用「固定取第一个候选」的优先级语义；手动 VM 未声明时同样不轮转。
  const auto = vm.auto === true;
  const sort = vm.sort === 'rate' ? 'rate' : (vm.sort === 'window' ? 'window' : null);
  const failover = vm.failover || {};
  const rotateTopN = Number(vm.rotateTopN);
  return {
    enabled: vm.enabled !== false,
    description: String(vm.description || ''),
    strategy: vm.strategy === 'weighted' ? 'weighted' : 'priority',
    auto,
    sort,
    rotateTopN: Number.isFinite(rotateTopN) && rotateTopN > 0 ? Math.floor(rotateTopN) : 0,
    // 对外声明的上下文窗口（token）。应取候选模型真实窗口的最小值：
    // 客户端按该值规划历史长度，超限由网关显式拦截，而非上游静默截断。
    // 仅接受 number 类型（字符串数字由前端保存前归一，避免 true→1 这类误归一）。
    contextWindow: typeof vm.contextWindow === 'number' && Number.isFinite(vm.contextWindow) && vm.contextWindow > 0
      ? vm.contextWindow
      : null,
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
    // M-S6：明文字段已剥离，hasApiKey 仅依据 env 名；实际可解析性由
    // dispatch.resolveApiKey 在运行时校验（env 可能未注入）
    hasApiKey: !!p.apiKeyEnv,
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
  const prev = c.virtualModels[id] || { enabled: true, description: '', strategy: 'priority', contextWindow: null, candidates: [], failover: {} };
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

/** 更新单个虚拟模型的候选列表与排序（autotier 专用；不改动其余配置）。 */
function setVirtualCandidates(id, candidates, extra = {}) {
  const c = load();
  const vm = c.virtualModels[id];
  if (!vm) return { ok: false, message: 'virtual model not found: ' + id };
  const merged = normalizeVirtual(id, {
    ...vm,
    ...extra,
    candidates,
  });
  if (!merged) return { ok: false, message: 'candidates 不能为空' };
  c.virtualModels[id] = merged;
  cache = c;
  save();
  return { ok: true, data: { id, ...merged } };
}

module.exports = {
  load,
  save,
  reload,
  setVirtualCandidates,
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
