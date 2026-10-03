'use strict';
/**
 * lib/paths.js — 运行期状态文件路径的统一解析。
 *
 * 背景：`.trae-api/` 下的状态文件此前路径规则分裂——model-status.json、
 * model-router.json 用 config.workspaceDir，而 scheduler-settings.json、
 * notify-settings.json、task-log.jsonl、encrypt.key 等 12 处写死 config.ROOT。
 * 后果有二：
 *   1. 测试无法隔离：把 WORKSPACE_DIR 指到临时目录也拦不住这些写入，
 *      测试会污染真实运行配置（已实际发生过一次：冒烟测试改写了真实
 *      的 scheduler-settings.json）。
 *   2. 部署不可移植：搬迁项目目录会丢掉签到时刻、通知渠道等用户设置。
 *
 * 统一规则：状态目录 = <workspaceDir>/.trae-api。
 * 读取时回退到旧位置 <ROOT>/.trae-api，保证既有部署升级后配置不丢；
 * 写入一律落新位置，首次保存即完成迁移。
 *
 * 说明：不做「读哪写哪」的兼容，否则两处并存会长期分叉。
 * 若需回退到旧版本代码，应先把 .trae-api 目录从 workspaceDir 拷回 ROOT。
 */
const path = require('path');
const config = require('../config');

/** 新位置：随工作区走（WORKSPACE_DIR 可覆盖，测试与部署均可隔离）。 */
function stateDir() {
  return path.join(config.workspaceDir || config.ROOT, '.trae-api');
}

/** 旧位置：仓库根下的 .trae-api，仅用于读取回退。 */
function legacyStateDir() {
  return path.join(config.ROOT, '.trae-api');
}

/**
 * 状态文件的目标写入路径。
 * @param {string} name 相对 .trae-api 的文件名或子路径
 * @returns {string}
 */
function stateFile(name) {
  return path.join(stateDir(), name);
}

/**
 * 状态文件的读取路径候选（新位置优先，旧位置兜底）。
 * 调用方按顺序探测存在性即可。
 * @param {string} name
 * @returns {string[]}
 */
function stateFileCandidates(name) {
  const primary = stateFile(name);
  const legacy = path.join(legacyStateDir(), name);
  return primary === legacy ? [primary] : [primary, legacy];
}

/**
 * 解析实际存在的读取路径；都不存在时返回新位置（调用方据此走默认值）。
 * @param {string} name
 * @param {(p:string)=>boolean} exists 注入 fs.existsSync 便于测试
 * @returns {string}
 */
function resolveStateFileForRead(name, exists) {
  const candidates = stateFileCandidates(name);
  if (typeof exists !== 'function') return candidates[0];
  return candidates.find((p) => exists(p)) || candidates[0];
}

module.exports = { stateDir, legacyStateDir, stateFile, stateFileCandidates, resolveStateFileForRead };