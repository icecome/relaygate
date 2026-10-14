'use strict';
/**
 * model-router/window-calibration.js — 候选真实窗口校准。
 *
 * 为什么需要：上游目录（WorkBuddy /console/enterprises/personal/models 的
 * maxInputTokens）与实际强制上限并不总是相符。实测反例：
 *   - wb/hy3：目录 maxIn=192000，但上游在 100001 token 返回 11115
 *     （"prompt is too long: 100001 tokens > 100000 maximum"），真实硬上限 100000；
 *   - wb/space-bunny：目录 maxIn=1000000，但 toolsIn 较大（如 27）的请求在
 *     100001 被拒，而 >100K 的缓存命中请求成功——真实输入上限同样约 100000
 *     （非缓存请求按 100000 计）。
 *
 * 盲信目录值会让候选级 / 虚拟级守门按虚高窗口放行，超长输入绕过本地拦截
 * 直接撞上游 11115，表现为「某些请求突然全部 400」。
 *
 * 校准表以 `${provider}/${model}` 为键，存放经日志实证（或官方文档）的真实窗口；
 * 命中校准值时优先于目录值，未命中则回退目录 / 配置声明值。
 *
 * 维护约定：每当 traffic 日志出现某模型 11115 报文时，把报文里的真实上限
 * 补进本表，使守门始终基于实测天花板而非目录承诺。
 */

/**
 * 实测真实窗口（token）。
 * 键格式与候选 id 一致：`${provider}/${model}`（workbuddy 侧 model 带 wb/ 前缀）。
 */
const CALIBRATED_WINDOW = {
  'workbuddy/wb/hy3': 100000,
  'workbuddy/wb/hy3-x': 100000, // 同系 hunyuan 模型，保守按 hy3 实测上限
  'workbuddy/wb/space-bunny': 100000, // 非缓存请求按 100000 计（>100K 仅缓存命中成功）
};

/**
 * 取候选真实窗口：校准值优先，其次配置声明值，再次上游目录值，最后 null。
 * @param {{provider:string, model:string, contextWindow?:number}} candidate
 * @param {number|null} [catalogWindow] 上游目录给出的 maxInputTokens
 * @returns {number|null}
 */
function calibratedWindow(candidate, catalogWindow) {
  if (!candidate) return null;
  const key = `${candidate.provider}/${candidate.model}`;
  const cal = CALIBRATED_WINDOW[key];
  if (Number.isFinite(Number(cal)) && Number(cal) > 0) return Number(cal);
  const declared = Number(candidate.contextWindow);
  if (Number.isFinite(declared) && declared > 0) return declared;
  if (Number.isFinite(Number(catalogWindow)) && Number(catalogWindow) > 0) return Number(catalogWindow);
  return null;
}

/**
 * 按候选 id 查询校准窗口（供测试与管理端诊断用）。
 * @param {string} id 形如 workbuddy/wb/hy3
 * @returns {number|null}
 */
function calibratedWindowOf(id) {
  const v = CALIBRATED_WINDOW[id];
  return Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
}

module.exports = {
  CALIBRATED_WINDOW,
  calibratedWindow,
  calibratedWindowOf,
};
