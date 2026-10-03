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
 */
const store = require('./store');
const health = require('./health');
const dispatch = require('./dispatch');
const { classifyError } = require('../upstream/errors');
const { logRequest } = require('../log/traffic');
const { providerAllowedForKey } = require('../middleware/model-access');

const VIRTUAL_PREFIX = 'vm/';

function hasVirtualModel(model) {
  const id = String(model == null ? '' : model);
  return !!store.getVirtual(id);
}

function isVirtualId(id) {
  return String(id || '').startsWith(VIRTUAL_PREFIX) || !!store.getVirtual(id);
}

/**
 * 候选排序：priority 策略按 priority 升序；weighted 按权重随机加权。
 * 过滤：Provider 启用、候选启用、密钥平台允许、非冷却、本地 maxRpm。
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

  if (vm.strategy === 'weighted') {
    // 加权随机：先按 weight 抽序，再按 priority 稳定排序作为平局裁决
    const pool = list.map((c) => ({ c, w: Math.max(1, c.weight || 1) }));
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

  const startedAt = ctx.startedAt || Date.now();
  const keyPlatform = ctx.keyPlatform || 'all';
  const maxAttempts = Math.max(1, vm.failover.maxAttempts || 3);
  const tried = new Set();
  const attempts = [];
  let lastErr = null;

  for (let i = 0; i < maxAttempts; i++) {
    const candidates = orderCandidates(virtualId, vm, keyPlatform).filter((c) => !tried.has(c.id));
    if (!candidates.length) {
      if (!lastErr) {
        const e = new Error(
          `virtual model "${virtualId}": no available candidate (platform=${keyPlatform}; disabled/cooling/rate-limited or not in platform scope)`,
        );
        e.status = 429;
        e.code = 'VIRTUAL_NO_CANDIDATE';
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
        max_tokens: ctx.max_tokens,
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
  orderCandidates,
  explainCandidates,
  handleChat,
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
