'use strict';
/**
 * middleware/model-access.js — 访问密钥对模型的调用权限。
 * 权限口径：
 * - platform 密钥（trae|workbuddy）：只能调本平台模型
 * - 通用密钥（platform=all）：可调虚拟模型 + 全部平台 + 通用 Provider
 */
const apiKeys = require('../credentials/api-keys');
const mrStore = require('../model-router/store');

/**
 * 是否为虚拟模型。
 *
 * 直接查 model-router/store 而非 model-router/index：后者在加载期 require
 * 本模块的 providerAllowedForKey，经 index 取会形成 model-router 与 model-access
 * 的循环依赖。store 是无依赖的叶子模块，依赖方向单向。
 */
function isVirtualModel(model) {
  const id = String(model == null ? '' : model);
  try {
    return !!mrStore.getVirtual(id);
  } catch {
    return false;
  }
}

function isWorkBuddyOnlyModel(model) {
  try {
    const wb = require('../workbuddy/chat');
    const lower = String(model || '').toLowerCase().replace(/^wb\//, '');
    return wb.WB_MODELS.includes(lower) && lower !== 'auto' && lower !== 'default';
  } catch {
    return false;
  }
}

/**
 * 是否为 Qoder 国际版对话面的模型。
 *
 * 依据 src/qoder/chat.js 的 CALLABLE_INTL_MODELS（实测可调用集合）。
 * 用 require 懒加载而非顶层导入：chat.js → transform/* → 无环，
 * 但本模块被 routes/openai 等在启动早期加载，懒加载可避免无谓的启动依赖。
 */
function isQoderOnlyModel(model) {
  try {
    const qoderChat = require('../qoder/chat');
    const lower = String(model || '').toLowerCase().trim();
    return qoderChat.CALLABLE_INTL_MODELS.includes(lower);
  } catch {
    return false;
  }
}

/**
 * 平台密钥的资源 ACL 关卡（M-S5 根因修复）。
 *
 * 此前 resources 校验只散布在虚拟模型分支与 all 分支，trae/workbuddy
 * 分支直接放行——按分支散布的 if 式校验，新增分支必然遗漏。现收口为统一关卡：
 * 平台过滤通过后一律经 canInvokeModel 校验 authKey.resources。
 * - authKey 为空（内部调用或旧路径）：保持原有放行语义，避免回归；
 * - resources 为空数组：与既有分支口径一致，跳过校验（normalizeResources
 *   实际不会产出空数组，此处仅为防御）。
 * meta 原样传给下游 scope.modelResourcePath：workbuddy 平台密钥调裸模型 ID 时必须
 * 传 { platform: 'workbuddy' }，否则会被映射成 model:trae/<id> 造成误拒。
 */
function platformResourceGate(authKey, model, meta = {}) {
  if (!authKey) return { ok: true };
  if (!Array.isArray(authKey.resources) || !authKey.resources.length) return { ok: true };
  const { canInvokeModel } = require('../auth/scope');
  const chk = canInvokeModel(authKey, model, meta);
  if (!chk.ok) {
    return { ok: false, message: `access denied: ${chk.reason || 'resource_denied'}`, reason: chk.reason };
  }
  return { ok: true };
}

/**
 * 判断密钥能否调用该模型（平台规则 + scope/资源 ACL）。
 *
 * 虚拟模型不在这里整单拒绝：平台密钥只调度本平台候选，通用密钥走全部候选
 * （与「平台密钥调本平台模型、通用密钥调所有模型」一致）。
 */
function canUseModel(keyPlatform, model, authKey = null) {
  const raw = String(model == null ? '' : model);
  const platform = keyPlatform || 'trae';

  if (isVirtualModel(raw)) {
    if (authKey && Array.isArray(authKey.resources) && authKey.resources.length) {
      const { canInvokeModel } = require('../auth/scope');
      const chk = canInvokeModel(authKey, raw, { virtual: true });
      // 通用密钥（resources=*）放行；平台密钥默认 resources 为 model:trae/* 等，
      // 对虚拟模型允许进入路由层做候选过滤，不在此返回 403
      if (!chk.ok && platform === 'all') {
        return { ok: false, message: `access denied: ${chk.reason || 'resource_denied'}`, reason: chk.reason };
      }
    }
    return { ok: true };
  }

  if (platform === 'all' || platform === 'universal') {
    if (authKey && Array.isArray(authKey.resources) && authKey.resources.length) {
      const { canInvokeModel } = require('../auth/scope');
      // Qoder 模型走独立资源前缀 model:qoder/*，不能归到 trae/workbuddy 前缀下
      const meta = { platform: isQoderOnlyModel(raw) ? 'qoder' : (raw.startsWith('wb/') ? 'workbuddy' : 'trae') };
      const chk = canInvokeModel(authKey, raw, meta);
      if (!chk.ok) {
        return { ok: false, message: `access denied: ${chk.reason || 'resource_denied'}`, reason: chk.reason };
      }
    }
    return { ok: true };
  }

  // Qoder 模型：只有通用密钥可调。平台密钥（trae|workbuddy）一律拒绝。
  //
  // 必须放在 platform==='workbuddy' 分支**之前**：那个分支直接 return，
  // 会把 Qoder 模型当成 WB 模型放行（等于让 wb 密钥越界消耗 Qoder 积分）。
  //
  // 也不能复用下面的「trae 平台密钥」分支：那里的口径是「非 WorkBuddy 独有
  // 模型就放行」，而 Qoder 的模型名（qmodel / kmodel / gmodel…）不在
  // WorkBuddy 独有清单里，会被当成 Trae 模型放行。
  // Qoder 是独立账号池，密钥边界必须按平台显式收口。
  if (isQoderOnlyModel(raw)) {
    return {
      ok: false,
      message: `model "${raw}" is a Qoder model. Use the Qoder endpoint (/v1/qoder/chat/completions) with a universal key (platform=all).`,
      reason: 'platform_mismatch',
    };
  }

  if (platform === 'workbuddy') {
    return platformResourceGate(authKey, raw, { platform: 'workbuddy' });
  }

  // trae 平台密钥
  if (raw.startsWith('wb/')) {
    return {
      ok: false,
      message: `model "${raw}" is WorkBuddy-only. 请使用 workbuddy 访问密钥或通用密钥（platform=all）。`,
      reason: 'platform_mismatch',
    };
  }
  if (isWorkBuddyOnlyModel(raw)) {
    return {
      ok: false,
      message: `model "${raw}" is a WorkBuddy model. 请使用 workbuddy 访问密钥或通用密钥（platform=all）。`,
      reason: 'platform_mismatch',
    };
  }
  return platformResourceGate(authKey, raw);
}

/** Provider 是否允许在该密钥平台下被虚拟路由选中。 */
function providerAllowedForKey(provider, keyPlatform) {
  const platform = keyPlatform || 'trae';
  if (platform === 'all' || platform === 'universal') return true;
  if (!provider) return false;
  if (provider.type === 'openai') return false; // 通用 OpenAI 端点仅允许通用密钥
  return provider.builtin === platform;
}

module.exports = {
  canUseModel,
  isVirtualModel,
  isWorkBuddyOnlyModel,
  isQoderOnlyModel,
  providerAllowedForKey,
  PLATFORM_LABELS: apiKeys.PLATFORM_LABELS,
};
