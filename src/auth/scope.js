'use strict';
/**
 * auth/scope.js — scope 与资源路径 ACL（P1）。
 *
 * 资源语法：
 *   *                      全部
 *   model:trae/*           Trae 平台模型
 *   model:workbuddy/*      WorkBuddy 模型
 *   model:virtual:vm/*     虚拟模型前缀
 *   model:virtual:vm/x     单个虚拟模型
 *   provider:deepseek/*    通用 Provider
 */

function modelResourcePath(model, meta = {}) {
  const id = String(model == null ? '' : model);
  if (meta.virtual || meta.isVirtual) return `model:virtual/${id}`;
  if (id.startsWith('wb/') || meta.platform === 'workbuddy') return `model:workbuddy/${id.replace(/^wb\//, '')}`;
  if (meta.platform === 'openai' || meta.providerType === 'openai') {
    return `provider/${meta.providerId || 'openai'}/${id}`;
  }
  return `model:trae/${id}`;
}

/** 通配匹配：* / 前缀* / 精确 */
function resourceMatch(pattern, resource) {
  const p = String(pattern || '');
  const r = String(resource || '');
  if (p === '*' || p === '**') return true;
  if (p.endsWith('*')) return r.startsWith(p.slice(0, -1));
  return p === r;
}

function anyResourceMatch(patterns, resource) {
  const list = Array.isArray(patterns) ? patterns : [];
  return list.some((p) => resourceMatch(p, resource));
}

/**
 * 判定 scope + resource。
 * @param {{scopes?:string[], resources?:string[]}} key
 * @param {{scope:string, resource:string}} need
 * @returns {{ok:boolean, reason?:string}}
 */
function authorize(key, need) {
  if (!key) return { ok: false, reason: 'no_key' };
  const scopes = key.scopes || [];
  const resources = key.resources || [];
  if (!scopes.includes(need.scope)) {
    return { ok: false, reason: `scope_missing:${need.scope}` };
  }
  if (!anyResourceMatch(resources, need.resource)) {
    return { ok: false, reason: `resource_denied:${need.resource}` };
  }
  return { ok: true };
}

/** 便捷：校验能否 invoke 某模型 */
function canInvokeModel(key, model, meta = {}) {
  return authorize(key, {
    scope: 'models:invoke',
    resource: modelResourcePath(model, meta),
  });
}

module.exports = {
  modelResourcePath,
  resourceMatch,
  anyResourceMatch,
  authorize,
  canInvokeModel,
};
