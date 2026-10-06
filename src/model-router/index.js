'use strict';
/**
 * model-router/index.js — 虚拟模型请求管理入口。
 *
 * 能力对照需求：
 * 1. 自定义模型 ID（virtualModels）
 * 2. 远端模型集成（providers：builtin + openai 兼容）
 * 3. 请求分发（按虚拟 ID 选候选）
 * 4. 启用控制（enabled 开关，配置/管理端双入口）
 * 5. 限流自动切换（健康度冷却 + failover.switchOn）
 * 6. 故障恢复重试（maxAttempts + 候选轮换）
 * 7. 状态监控（health.snapshot + traffic 日志）
 * 8. 优先级/权重/最大频率（priority / weight / maxRpm）
 * 9. 上下文窗口守门（contextWindow：粗估输入超窗口 75% 时显式 400，
 *    防止客户端按虚高窗口堆积历史后被上游静默截断 → 记忆错乱/幻觉）
 */
const store = require('./store');
const health = require('./health');
const dispatch = require('./dispatch');
const { classifyError } = require('../upstream/errors');
const { logRequest } = require('../log/traffic');
const { estimateCost } = require('../models/rates');
const { estimateTokensOfText } = require('../lib/token-precise');
const config = require('../config');
const { providerAllowedForKey } = require('../middleware/model-access');
const { estimatePromptTokens } = require('../lib/token-estimate');
const autotier = require('./autotier');
const { runWithContinuation } = require('../transform/continue');

const VIRTUAL_PREFIX = 'vm/';

function hasVirtualModel(model) {
  const id = String(model == null ? '' : model);
  return !!store.getVirtual(id);
}

function isVirtualId(id) {
  return String(id || '').startsWith(VIRTUAL_PREFIX) || !!store.getVirtual(id);
}

/**
 * 加权随机抽序：按 weight 抽签决定先后，抽样过程用累减而非每次重算总和，
 * 保证「抽到的排在前面」这一分布与 pool 顺序无关（避免首个候选天然占优）。
 */
function weightedShuffle(list) {
  const pool = list.map((c) => ({ c, w: Math.max(1, Number(c.weight) || 1) }));
  const ordered = [];
  while (pool.length) {
    const total = pool.reduce((s, x) => s + x.w, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].w;
      if (r <= 0) { idx = i; break; }
    }
    ordered.push(pool[idx].c);
    pool.splice(idx, 1);
  }
  return ordered;
}

/** 候选倍率：未知/非法倍率排到成本序末尾（Infinity）。 */
function candRate(c) {
  return (Number.isFinite(Number(c.rate)) && Number(c.rate) >= 0 ? Number(c.rate) : Infinity);
}

/** 候选上下文窗口：未声明按 0 计（sort=window 时排后）。 */
function candWindow(c) {
  return (Number.isFinite(Number(c.contextWindow)) ? Number(c.contextWindow) : 0);
}

/**
 * 上游 usage → 日志字段。无 usage 或全 0 时返回空对象，
 * 让统计层把该请求记为「未计量」而不是「消耗 0 token」。
 * 兼容 OpenAI 蛇形与 Trae 驼峰两种键名。
 */
function usageToLogFields(u) {
  if (!u || typeof u !== 'object') return {};
  const pt = Number(u.prompt_tokens ?? u.inputTokens) || 0;
  const ct = Number(u.completion_tokens ?? u.outputTokens) || 0;
  const tt = Number(u.total_tokens ?? u.totalTokens) || (pt + ct);
  if (!pt && !ct && !tt) return {};
  return { promptTokens: pt, completionTokens: ct, totalTokens: tt };
}

/**
 * 候选排序：priority 策略按 priority 升序；weighted 按权重随机加权。
 * 过滤：Provider 启用、候选启用、密钥平台允许、非冷却、本地 maxRpm。
 *
 * 自动分层 VM（auto + sort）先按 sort 确定成本序，再取前 rotateTopN 个构成
 * 「轮转池」做加权轮转：既保留低成本优先的意图，又不会恒定命中同一个模型。
 * rotateTopN 未声明或池内只剩一个候选时退化为原有优先级语义。
 * 池外候选仍保留在序列尾部，失败重试（failover）时可继续向下切换。
 *
 * @param {string} keyPlatform trae|workbuddy|all
 */
function orderCandidates(virtualId, vm, keyPlatform = 'all') {
  const list = (vm.candidates || []).filter((c) => {
    if (!c.enabled) return false;
    const p = store.getProvider(c.provider);
    if (!p || !p.enabled) return false;
    if (!providerAllowedForKey(p, keyPlatform)) return false;
    if (health.isCooling(virtualId, c.id)) return false;
    if (!health.allowRpm(virtualId, c.id, c.maxRpm)) return false;
    return true;
  });

  // 自动分层 VM：sort=rate 按倍率升序（未知倍率排后），sort=window 按窗口大优先；
  // 平局回退 priority。手动 VM（sort=null）维持 priority 排序不变。
  if (vm.auto && vm.sort) {
    // 成本序基于「当前可用」候选（已过滤禁用/停用/冷却/超限频）：
    // rotateTopN 表示「从可用模型里轮转 N 个」，已禁用的模型不占名额，
    // 应由其后的候选递补。否则用户禁用几个低价模型后，轮转池会缩水甚至空转。
    const ranked = list.slice().sort((a, b) => {
      if (vm.sort === 'window') {
        const dw = candWindow(b) - candWindow(a);
        if (dw) return dw;
      } else {
        const dr = candRate(a) - candRate(b);
        if (dr) return dr;
      }
      return (a.priority - b.priority) || String(a.id).localeCompare(String(b.id));
    });
    const topN = Number(vm.rotateTopN);
    const poolSize = Number.isFinite(topN) && topN > 0 ? Math.floor(topN) : 0;
    // 置顶候选额外强制入池，且不占用 rotateTopN 的名额——
    // 否则「置顶一个高性能模型」会把等量的低成本候选挤出池，
    // 反而抬高整体成本，与置顶意图相反。
    const pinned = ranked.filter((c) => c.pinned);
    const pinnedIds = new Set(pinned.map((c) => c.id));
    const byRank = ranked.filter((c) => !pinnedIds.has(c.id)).slice(0, poolSize);
    const pool = pinned.concat(byRank);
    // 不轮转（poolSize=0）且无置顶：退化为固定取成本序首选
    if (poolSize === 0 && pinned.length === 0) return ranked;
    const poolKeyed = new Set(pool.map((c) => c.id));
    const rest = ranked.filter((c) => !poolKeyed.has(c.id));
    // 池内 ≥2 个才需要轮转；仅 1 个时固定用它，池外仍作 failover 兜底
    if (pool.length >= 2) return weightedShuffle(pool).concat(rest);
    return pool.concat(rest);
  }

  if (vm.strategy === 'weighted') {
    return weightedShuffle(list);
  }

  return list.slice().sort((a, b) => (a.priority - b.priority) || String(a.id).localeCompare(String(b.id)));
}

/** 被冷却/禁用/平台不允许的候选说明（诊断用）。 */
function explainCandidates(virtualId, keyPlatform = 'all') {
  const vm = store.getVirtual(virtualId);
  if (!vm) return [];
  return (vm.candidates || []).map((c) => {
    const p = store.getProvider(c.provider);
    const reasons = [];
    if (!c.enabled) reasons.push('candidate_disabled');
    if (!p) reasons.push('provider_missing');
    else if (!p.enabled) reasons.push('provider_disabled');
    if (p && !providerAllowedForKey(p, keyPlatform)) reasons.push('platform_denied');
    if (health.isCooling(virtualId, c.id)) reasons.push('rate_limited');
    return {
      ...c,
      providerType: p ? p.type : null,
      providerLabel: p ? p.label : null,
      usable: reasons.length === 0,
      reasons,
      cooldownRemainingMs: health.cooldownRemaining(virtualId, c.id),
    };
  });
}

function shouldSwitch(kind, vm) {
  const set = new Set((vm.failover && vm.failover.switchOn) || ['rate_limit', 'model', '5xx', 'network', 'other']);
  return set.has(kind);
}

/** 输入超限（相对声明窗口）时预留的比例，保证留有回复空间。 */
const CONTEXT_INPUT_HEADROOM_RATIO = 0.75;

/**
 * 声明了 contextWindow 的虚拟模型：分发前粗估输入 token，
 * 超过窗口 75% 显式 400，让客户端走自己的压缩逻辑。
 * 不拦截则上游会静默截断头部，system 与早期记忆丢失 → 幻觉。
 */
function checkContextLimit(vm, messages) {
  if (!vm || !vm.contextWindow) return null;
  const estimated = estimatePromptTokens(messages);
  const limit = Math.floor(vm.contextWindow * CONTEXT_INPUT_HEADROOM_RATIO);
  if (estimated <= limit) return null;
  const e = new Error(
    `context length exceeded: estimated ${estimated} tokens exceeds input limit ${limit} (contextWindow ${vm.contextWindow} of "${vm.description || 'virtual model'}"). Reduce conversation history before retrying.`,
  );
  e.status = 400;
  e.code = 'context_length_exceeded';
  return e;
}

/**
 * 处理虚拟模型 chat 请求（在 openai 路由最前调用）。
 * 成功则直接写响应；失败耗尽候选时抛出/写出最后错误。
 */
async function handleChat(req, res, ctx) {
  const virtualId = ctx.model;
  const vm = store.getVirtual(virtualId);
  if (!vm) {
    const e = new Error(`unknown virtual model: ${virtualId}`);
    e.status = 404;
    throw e;
  }
  if (!vm.enabled) {
    const e = new Error(`virtual model disabled: ${virtualId}`);
    e.status = 403;
    throw e;
  }

  // 窗口守门：声明了 contextWindow 且输入超限时直接拒绝，不做候选切换
  // （换候选解决不了超限——超限是输入与窗口的关系，不是候选健康度问题）。
  // 日志不在此处记：handleChat 唯一调用点 openai.js 的 catch 统一落 traffic 日志。
  const tooLong = checkContextLimit(vm, ctx.messages);
  if (tooLong) throw tooLong;
  // 候选级窗口守门（autotier）：候选声明了 contextWindow 且输入超该候选 75% → 跳过该候选，
  // 让请求落到窗口更大的候选上；全部候选装不下时在循环内显式 400。
  const { estimated: estTokens, list: fittingAll } = autotier.filterCandidatesByInput(vm, ctx.messages);
  const hasCandidateWindows = (vm.candidates || []).some((c) => Number(c.contextWindow) > 0);

  const startedAt = ctx.startedAt || Date.now();
  const keyPlatform = ctx.keyPlatform || 'all';
  const maxAttempts = Math.max(1, vm.failover.maxAttempts || 3);
  const tried = new Set();
  const attempts = [];
  let lastErr = null;

  for (let i = 0; i < maxAttempts; i++) {
    let candidates = orderCandidates(virtualId, vm, keyPlatform).filter((c) => !tried.has(c.id));
    // 候选级窗口守门：只把「装得下当前输入」的候选视为可用（有候选声明窗口时才启用）
    if (hasCandidateWindows) candidates = candidates.filter((c) => fittingAll.some((f) => f.id === c.id));
    if (!candidates.length) {
      if (!lastErr) {
        const windowBlocked = hasCandidateWindows && estTokens > 0;
        const e = new Error(
          windowBlocked
            ? `virtual model "${virtualId}": no candidate can fit estimated input ${estTokens} tokens (all candidates below 75% of their context window, or disabled/cooling)`
            : `virtual model "${virtualId}": no available candidate (platform=${keyPlatform}; disabled/cooling/rate-limited or not in platform scope)`,
        );
        e.status = windowBlocked ? 400 : 429;
        e.code = windowBlocked ? 'context_length_exceeded' : 'VIRTUAL_NO_CANDIDATE';
        lastErr = e;
      }
      break;
    }
    const cand = candidates[0];
    tried.add(cand.id);
    const provider = store.getProvider(cand.provider);
    const t0 = Date.now();
    attempts.push({ candidateId: cand.id, provider: cand.provider, model: cand.model });

    try {
      const body = {
        model: cand.model,
        messages: ctx.messages,
        temperature: ctx.temperature,
        top_p: ctx.top_p,
        max_tokens: autotier.clampMaxTokens(cand, ctx.max_tokens),
        stop: ctx.stop,
        tools: ctx.tools || undefined,
        tool_choice: ctx.tool_choice || undefined,
      };
      let result;
      if (ctx.stream !== false) {
        result = await dispatch.dispatchStream(provider, cand.model, body, res, {
          startedAt: t0,
          stickyKey: ctx.stickyKey,
          stickyAccountId: ctx.stickyAccountId,
          echoModel: virtualId,
        });
      } else {
        result = await dispatch.dispatchNonStream(provider, cand.model, body, {
          stickyKey: ctx.stickyKey,
          stickyAccountId: ctx.stickyAccountId,
        });
        if (result && typeof result === 'object') {
          // 回写请求中的虚拟模型 ID，便于客户端校验 model 字段
          result.model = virtualId;
          if (result.usage) result.usage = dispatch.sanitizeUsage(result.usage) || result.usage;
        }
        if (!res.writableEnded) res.json(result);
      }
      health.markOk(virtualId, cand.id, Date.now() - t0);
      // 结束原因可观测性：truncated=true 表示上游截断（客户端会走续写/提示超长）
      const fr = (result && result.finishReason)
        || (result && result.choices && result.choices[0] && result.choices[0].finish_reason)
        || null;
      // usage 提取：流式来自 dispatch 返回值（末帧合并前已捕获），
      // 非流式来自 completion 对象的 usage 字段（上面已 sanitizeUsage）。
      // 无 usage 时不写字段，统计层据此区分「未计量」与「消耗 0」。
      let usageFields = usageToLogFields(result && result.usage);
      // 上游未回传 usage 时用真实分词器补算（结果仍属估算，日志标 tokensEstimated）。
      // 补算口径见 lib/token-precise.js：分词器与上游不完全一致，只作趋势参考。
      let tokensEstimated = false;
      if (!usageFields.totalTokens && config.estimateMissingTokens) {
        const outText = (result && result.outputText)
          || (result && result.choices && result.choices[0]
            && result.choices[0].message && result.choices[0].message.content)
          || '';
        const est = estimateTokensOfText(ctx.messages, outText);
        if (est.totalTokens > 0) {
          usageFields = est;
          tokensEstimated = true;
        }
      }
      // 费率按真实命中的上游模型（cand.model）计，而不是虚拟 ID——
      // 虚拟 ID 在费率表里没有条目，曾导致估算恒为 null。
      const estCost = usageFields.totalTokens
        ? estimateCost(cand.model, usageFields.promptTokens, usageFields.completionTokens)
        : null;
      logRequest({
        endpoint: '/v1/chat/completions',
        method: 'POST',
        model: virtualId,
        account: cand.id,
        status: 200,
        toolCalls: 0,
        toolsIn: ctx.tools ? ctx.tools.length : 0,
        durationMs: Date.now() - startedAt,
        error: null,
        platform: provider.type === 'openai' ? `openai:${cand.provider}` : provider.builtin,
        virtualModel: virtualId,
        routedTo: `${cand.provider}/${cand.model}`,
        ...usageFields,
        ...(tokensEstimated ? { tokensEstimated: true } : {}),
        ...(estCost != null ? { estimatedCost: estCost } : {}),
        ...(fr ? { finishReason: fr, truncated: dispatch.isTruncatedFinish(fr) } : {}),
      });
      return { ok: true, candidate: cand, attempts };
    } catch (err) {
      lastErr = err;
      const kind = classifyError(err);
      const cooled = health.markFail(virtualId, cand.id, kind, err, vm.failover.cooldownMs);
      logRequest({
        endpoint: '/v1/chat/completions',
        method: 'POST',
        model: virtualId,
        account: cand.id,
        status: err.status && err.status >= 400 ? err.status : 500,
        toolCalls: 0,
        toolsIn: ctx.tools ? ctx.tools.length : 0,
        durationMs: Date.now() - t0,
        error: err.message,
        platform: provider.type === 'openai' ? `openai:${cand.provider}` : provider.builtin,
        virtualModel: virtualId,
        routedTo: `${cand.provider}/${cand.model}`,
      });
      const canSwitch = shouldSwitch(kind, vm) && i < maxAttempts - 1
        && !(ctx.stream !== false && res.headersSent);
      if (!canSwitch) break;
      console.log(`[model-router] ${kind} on ${cand.provider}/${cand.model}, switching (attempt ${i + 1}/${maxAttempts}, cool ${cooled.cooledForMs}ms)`);
    }
  }

  // 全部失败：统一错误出口（流已开始则尽量补错误帧，否则 JSON）
  const err = lastErr || new Error(`virtual model "${virtualId}": all candidates failed`);
  if (res.writableEnded) return { ok: false, error: err.message, attempts };
  if (res.headersSent) {
    try {
      res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'upstream_error', code: err.upstreamCode ?? (err.status === 429 ? 429 : null) } })}\n\n`);
      res.write('data: [DONE]\n\n');
    } catch { /* ignore */ }
    if (!res.writableEnded) res.end();
    return { ok: false, error: err.message, attempts };
  }
  res.status(err.status && err.status >= 400 ? err.status : 500).json({
    error: { message: err.message, type: 'upstream_error' },
  });
  return { ok: false, error: err.message, attempts };
}

module.exports = {
  hasVirtualModel,
  isVirtualId,
  autotier,
  orderCandidates,
  explainCandidates,
  handleChat,
  checkContextLimit,
  usageToLogFields,
  store,
  health,
  dispatch,
  clearCooldown: health.clearAllCooldowns,
  snapshot: () => ({
    providers: store.listProviders(),
    virtualModels: store.listVirtual().map((vm) => ({
      ...vm,
      candidates: explainCandidates(vm.id),
    })),
    health: health.snapshot(),
  }),
};
