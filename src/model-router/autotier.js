'use strict';
/**
 * model-router/autotier.js — 虚拟模型自动分层（按上下文窗口划分候选）。
 *
 * 设计（对齐 2026-10-06 模型参数探测报告）：
 * - 层级按「真实上下文窗口」静态定义（窗口值是分层键，也是虚拟模型 contextWindow 声明）：
 *     vm/unified-chat   116,000 —— 全量池：所有对外可见的对话模型
 *     vm/large-context  200,000 —— 窗口 ≥ 200K 的模型
 *     vm/long-context  1,000,000 —— 窗口 ≥ 1M 的模型（Trae 走 @max 档 / WorkBuddy 原生 1M）
 * - 候选生成规则：窗口 ∈ [层窗口, 下一层窗口) 的模型进入该层；层内不做手动增删，
 *   只保留候选级 enabled 开关（禁用后路由跳过，但下次重同步不会恢复或删除它）。
 * - 排序：sort=rate 时按倍率升序（免费/低成本优先），rate 缺失者排后；sort=window 时窗口大优先。
 * - Trae 模型带 maxTier（__max 档）时，long-context 层自动映射为 `<id>@max`
 *   （client.js 把 @max 翻译为上游 __max 模型名 + prompt_max_tokens=936000）。
 * - 账号维度调度不在本模块：账号池 pool.js 已按「临期积分 → 成本层 → 余额大优先」选号，
 *   天然满足「优先按账号剩余积分调用」。
 */
const store = require('./store');
const health = require('./health');
const { estimatePromptTokens } = require('../lib/token-estimate');

const CONTEXT_INPUT_HEADROOM_RATIO = 0.75;

/** 静态分层定义：minWindow 为该层准入窗口（也是对外声明窗口）。 */
const TIERS = [
  { id: 'vm/unified-chat', minWindow: 116_000, description: '统一对话入口（自动分层：窗口 ≥ 116K 全量池）' },
  { id: 'vm/large-context', minWindow: 200_000, description: '大窗口入口（自动分层：窗口 ≥ 200K）' },
  { id: 'vm/long-context', minWindow: 1_000_000, description: '超长上下文入口（自动分层：窗口 ≥ 1M，Trae 自动走 @max 档）' },
];

const DEFAULTS = () => ({
  enabled: true,
  strategy: 'priority',
  // 轮转池大小：取倍率升序前 N 个候选做加权轮转。
  // 取 4 是「常见的低成本模型都有机会被选中、同时不把请求摊到高倍率模型上」的折中；
  // 置 1 即退化为固定命中倍率最低者，置 0 或不声明则完全关闭轮转。
  rotateTopN: 4,
  failover: { maxAttempts: 3, switchOn: ['rate_limit', 'model', '5xx', 'network', 'other'], cooldownMs: 20000 },
});

/** 已知的平台模型目录（由 catalog 与 wbChat 提供）。 */
let _dirProvider = null;

/** 注入目录提供者（避免与 routes 循环依赖；启动时调用一次）。 */
function setCatalogProvider(fn) {
  _dirProvider = fn;
}

/**
 * 拉取两平台目录并归一为候选描述。
 * @returns {Promise<Array<{provider, model, window, promptMax, maxOut, rate, displayName, maxTier}>>}
 */
async function fetchAllModels() {
  const out = [];
  // Trae：动态目录（失败回退本地 model-config，无窗口字段则跳过）
  try {
    const catalog = require('../models/catalog');
    const cat = await catalog.listWithStatus({ force: true, includeCustom: false });
    for (const m of cat.models || []) {
      if (m.custom) continue;
      if (m.id === 'auto' || m.id === 'fast_apply_new') continue;
      if (!Number.isFinite(Number(m.contextWindow)) || Number(m.contextWindow) <= 0) continue;
      out.push({
        provider: 'trae',
        model: m.id,
        window: Number(m.contextWindow),
        promptMax: Number.isFinite(Number(m.promptMaxTokens)) ? Number(m.promptMaxTokens) : null,
        maxOut: Number.isFinite(Number(m.maxOutputTokens)) ? Number(m.maxOutputTokens) : null,
        rate: Number.isFinite(Number(m.rate)) ? Number(m.rate) : null,
        displayName: m.display_name || m.id,
        maxTier: m.maxTier || null,
      });
      // 带长上下文档（__max）的模型：额外以 `<id>@max` 形态参与高层分配
      //（窗口 = context_window_tokens.max，输出/输入上限取 maxTier 实测值）
      if (m.maxTier && Number.isFinite(Number(m.contextWindowMax)) && Number(m.contextWindowMax) > Number(m.contextWindow)) {
        out.push({
          provider: 'trae',
          model: m.id + '@max',
          window: Number(m.contextWindowMax),
          promptMax: Number.isFinite(Number(m.maxTier.promptMaxTokens)) ? Number(m.maxTier.promptMaxTokens) : null,
          maxOut: Number.isFinite(Number(m.maxTier.maxOutputTokens)) ? Number(m.maxTier.maxOutputTokens) : null,
          rate: Number.isFinite(Number(m.rate)) ? Number(m.rate) : null,
          displayName: (m.display_name || m.id) + '（长上下文档）',
          maxTier: null,
        });
      }
    }
  } catch (e) {
    console.warn('[autotier] trae catalog failed:', e.message);
  }
  // WorkBuddy：动态目录（失败回退静态 WB_MODELS，无窗口字段 → 窗口按 null 跳过）
  try {
    const wbChat = require('../workbuddy/chat');
    const cat = await wbChat.modelCatalog(true);
    for (const m of cat || []) {
      if (m.id === 'auto' || m.id === 'default' || m.id === 'hunyuan-image-alpha') continue;
      const win = Number(m.maxInputTokens);
      if (!Number.isFinite(win) || win <= 0) continue;
      out.push({
        provider: 'workbuddy',
        model: 'wb/' + m.id,
        window: win,
        promptMax: null,
        maxOut: Number.isFinite(Number(m.maxOutputTokens)) ? Number(m.maxOutputTokens) : null,
        rate: Number.isFinite(Number(m.rate)) ? Number(m.rate) : null,
        displayName: m.name || m.id,
        maxTier: null,
      });
    }
  } catch (e) {
    console.warn('[autotier] workbuddy catalog failed:', e.message);
  }
  return out;
}

/**
 * 按层窗口给模型定层：window ∈ [tier.minWindow, nextTier.minWindow)。
 * 返回 tierId → 候选列表。
 */
function assignTiers(models) {
  const result = new Map(TIERS.map((t) => [t.id, []]));
  for (const m of models) {
    for (let i = 0; i < TIERS.length; i++) {
      const tier = TIERS[i];
      const upper = i + 1 < TIERS.length ? TIERS[i + 1].minWindow : Infinity;
      if (m.window >= tier.minWindow && m.window < upper) {
        result.get(tier.id).push(m);
        break;
      }
    }
  }
  return result;
}

/** 层内排序：rate 升序（null 排后）或 window 降序；平局按 provider/model 稳定排序。 */
function sortCandidates(list, sort) {
  const s = list.slice();
  if (sort === 'window') {
    s.sort((a, b) => b.window - a.window || String(a.provider).localeCompare(b.provider) || String(a.model).localeCompare(b.model));
  } else {
    // rate：null 视为 Infinity（未知倍率排最后）
    s.sort((a, b) => {
      const ra = a.rate == null ? Infinity : a.rate;
      const rb = b.rate == null ? Infinity : b.rate;
      if (ra !== rb) return ra - rb;
      return String(a.provider).localeCompare(b.provider) || String(a.model).localeCompare(b.model);
    });
  }
  return s;
}

/**
 * 按倍率反推候选权重（输入需为 sortCandidates 排序后的顺序：倍率升序）。
 *
 * 轮转池内靠权重表达「便宜的模型多承担一些、更贵的少承担一些」，
 * 权重取倍率区间的反比并夹在 [MIN, MAX]，避免倍率 0（免费）产生无穷大权重，
 * 也避免倍率很高时权重被压到 0 而彻底退出轮转。
 * 未知倍率（null）按最贵处理，给出基础权重 1。
 */
const WEIGHT_MIN = 1;
const WEIGHT_MAX = 8;

/**
 * 解析候选倍率。`Number(null) === 0`，直接 Number() 会把「未知倍率」误判为
 * 「免费」，故先按原始值判空。返回 null 表示倍率未知。
 */
function rateOf(model) {
  const raw = model && model.rate;
  if (raw == null || raw === '') return null;
  const r = Number(raw);
  return Number.isFinite(r) && r >= 0 ? r : null;
}

function deriveWeights(sortedModels) {
  const known = sortedModels.map(rateOf);
  const maxRate = known.reduce((m, r) => (r != null && r > m ? r : m), 0);
  return known.map((r) => {
    if (r == null) return WEIGHT_MIN;
    // 全部候选倍率均为 0（全免费）时统一给最高权重；
    // 仅当存在正倍率时才在其区间内插值。
    if (maxRate <= 0) return WEIGHT_MAX;
    const w = Math.round(WEIGHT_MAX - (r / maxRate) * (WEIGHT_MAX - WEIGHT_MIN));
    return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w));
  });
}

/**
 * 重算全部自动分层虚拟模型（幂等）。
 * @param {{force?:boolean}} opts
 * @returns {Promise<{ok:boolean, tiers:Array<{id, candidates:number, declaredWindow:number}>, errors:string[]}>}
 */
async function syncAutoTiers(opts = {}) {
  const errors = [];
  const models = await fetchAllModels().catch((e) => {
    errors.push(e.message);
    return [];
  });
  if (!models.length) {
    return { ok: false, tiers: [], errors: errors.length ? errors : ['no models fetched from any platform'] };
  }

  // 既有候选的手工调整跨重同步保留（键 = provider/model）：
  // enabled=是否参与调度、pinned=是否强制入池。
  // 缺此保留则定时任务会把用户在面板上的禁用/置顶操作整体抹掉。
  const keepEnabled = new Map();
  const keepPinned = new Map();
  for (const tier of TIERS) {
    const prev = store.getVirtual(tier.id);
    for (const c of (prev && prev.candidates) || []) {
      keepEnabled.set(c.provider + '/' + c.model, c.enabled !== false);
      keepPinned.set(c.provider + '/' + c.model, c.pinned === true);
    }
  }

  const grouped = assignTiers(models);
  const summary = [];
  for (const tier of TIERS) {
    const list = sortCandidates(grouped.get(tier.id) || [], 'rate');
    // 权重按倍率反推：低成本候选在轮转池内承担更多份额。
    // 置顶候选按用户意图给最高权重，不受倍率影响。
    const weights = deriveWeights(list);
    const candidates = list.map((m, i) => {
      const key = m.provider + '/' + m.model;
      const pinned = keepPinned.get(key) === true;
      return {
        id: key,
        provider: m.provider,
        model: m.model,
        priority: i + 1,
        weight: pinned ? WEIGHT_MAX : weights[i],
        maxRpm: null,
        enabled: keepEnabled.get(key) !== false,
        pinned,
        contextWindow: m.window,
        promptMaxTokens: m.promptMax,
        maxOutputTokens: m.maxOut,
        rate: m.rate,
      };
    });
    if (!candidates.length) {
      // 层内无模型：声明层窗口但不建/不更新（保留既有配置，避免空候选）
      summary.push({ id: tier.id, candidates: 0, declaredWindow: tier.minWindow, skipped: 'empty' });
      continue;
    }
    const prev = store.getVirtual(tier.id);
    const r = store.upsertVirtual(tier.id, {
      ...DEFAULTS(),
      auto: true,
      sort: 'rate',
      description: tier.description,
      // 轮转池大小沿用用户已保存的值；首次分层（prev 为空）才用默认档。
      // 否则每次定时同步都会把面板上的调整重置回默认。
      rotateTopN: Number(prev && prev.rotateTopN) > 0 ? Number(prev.rotateTopN) : DEFAULTS().rotateTopN,
      // 对外声明窗口 = 层窗口；网关按此守门（输入 ≤ 75% 窗口）
      contextWindow: tier.minWindow,
      candidates,
    });
    if (!r.ok) {
      errors.push(`${tier.id}: ${r.message}`);
      summary.push({ id: tier.id, candidates: candidates.length, declaredWindow: tier.minWindow, error: r.message });
    } else {
      summary.push({ id: tier.id, candidates: candidates.length, declaredWindow: tier.minWindow });
    }
  }
  return { ok: errors.length === 0, tiers: summary, errors };
}

/**
 * 按候选守门 + 择优：返回该虚拟模型下能容纳当前输入的候选排序。
 * - 候选声明了 contextWindow 时：估算输入 > 75% 窗口的候选被跳过；
 * - 无任何候选声明（旧配置）：全部放行（保持既有行为）。
 */
function filterCandidatesByInput(vm, messages) {
  const estimated = estimatePromptTokens(messages);
  const list = (vm.candidates || []).filter((c) => {
    if (!c.enabled) return false;
    if (!c.contextWindow) return true; // 未声明窗口的候选不参与窗口过滤
    return estimated <= Math.floor(c.contextWindow * CONTEXT_INPUT_HEADROOM_RATIO);
  });
  return { estimated, list };
}

/** 单候选输出上限钳制：max_tokens 超过候选 maxOutputTokens 时收紧。 */
function clampMaxTokens(candidate, maxTokens) {
  if (typeof maxTokens !== 'number' || !(maxTokens > 0)) return undefined;
  if (candidate && Number.isFinite(Number(candidate.maxOutputTokens)) && Number(candidate.maxOutputTokens) > 0) {
    return Math.min(maxTokens, Number(candidate.maxOutputTokens));
  }
  return maxTokens;
}

/** 是否为自动分层虚拟模型。 */
function isAutoVm(vm) {
  return !!(vm && vm.auto === true);
}

module.exports = {
  TIERS,
  DEFAULTS,
  setCatalogProvider,
  fetchAllModels,
  assignTiers,
  sortCandidates,
  deriveWeights,
  syncAutoTiers,
  filterCandidatesByInput,
  clampMaxTokens,
  isAutoVm,
  CONTEXT_INPUT_HEADROOM_RATIO,
};
