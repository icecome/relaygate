'use strict';
/**
 * middleware/model-access.js — 访问密钥对模型的调用权限。
 *
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
 * 本模块的 providerAllowedForKey，经 index 取会形成 model-router ⇄ model-access
 * 循环依赖。store 是无依赖的叶子模块，方向单向。
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
      // 对虚拟模型允许进入路由层做候选过滤，不在此 403
      if (!chk.ok && platform === 'all') {
        return { ok: false, message: `access denied: ${chk.reason || 'resource_denied'}`, reason: chk.reason };
      }
    }
    return { ok: true };
  }

  if (platform === 'all' || platform === 'universal') {
    if (authKey && Array.isArray(authKey.resources) && authKey.resources.length) {
      const { canInvokeModel } = require('../auth/scope');
      const meta = { platform: raw.startsWith('wb/') ? 'workbuddy' : 'trae' };
      const chk = canInvokeModel(authKey, raw, meta);
      if (!chk.ok) {
        return { ok: false, message: `access denied: ${chk.reason || 'resource_denied'}`, reason: chk.reason };
      }
    }
    return { ok: true };
  }

  if (platform === 'workbuddy') {
    return { ok: true };
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
  return { ok: true };
}

/** Provider 是否允许在该密钥平台下被虚拟路由选中。 */
function providerAllowedForKey(provider, keyPlatform) {
  const platform = keyPlatform || 'trae';
  if (platform === 'all' || platform === 'universal') return true;
  if (!provider) return false;
  if (provider.type === 'openai') return false; // 通用 OpenAI 端点仅通用密钥
  return provider.builtin === platform;
}

module.exports = {
  canUseModel,
  isVirtualModel,
  isWorkBuddyOnlyModel,
  providerAllowedForKey,
  PLATFORM_LABELS: apiKeys.PLATFORM_LABELS,
};
