'use strict';
/**
 * workbuddy/model-ids.js — WorkBuddy 静态模型 ID 清单（叶子模块，无任何依赖）。
 *
 * 为什么单独拆出来（2026-11-07）：
 * 这份名单要被两类模块消费——WorkBuddy 转发面（workbuddy/chat.js）与平台归属
 * 判定（models/platform-ownership.js）。后者若直接 require chat.js，就形成
 * `chat.js ↔ platform-ownership.js` 的双向依赖（chat.js 要调 platform-ownership
 * 写归属快照）。把名单本身提到零依赖的叶子模块，依赖方向恢复单向：
 *   chat.js → model-ids
 *   platform-ownership → model-ids
 *
 * 本文件是**数据**，不含行为；动态目录优先、静态兜底的口径仍在 chat.js。
 */
const WB_MODELS = [
  'auto', 'default',
  'hy3', 'hy3-x', 'hy4-preview', 'hy4-preview-x',
  'glm-5v-turbo', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5.0', 'glm-4.7', 'glm-4.6', 'glm-4.6v',
  'minimax-m3', 'minimax-m2.5',
  'kimi-k3-1', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'kimi-k2.5', 'kimi-k2-thinking',
  'deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v3-2-volc',
  'hunyuan-2.0-thinking', 'hunyuan-chat', 'hunyuan-image-v3.0',
];

module.exports = { WB_MODELS };
