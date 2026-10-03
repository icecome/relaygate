'use strict';
/**
 * jobs/rotate-settings.js — 账号自动切换（轮换）可调配置与热重载。
 *
 * 存储：.trae-api/rotate-settings.json（文件值优先于 env）。
 * 字段：
 *   enabled             是否启用自动切换
 *   intervalMinutes     自动切换间隔（默认 240 分钟，min 30）
 *   stayMs              每个账号停留时长（默认 60s，min 10s）—— 轮换单遍时账号停留
 *   authDir             客户端 auth 目录（空 = 默认 LOCALAPPDATA 探测）
 *   excludeUids         不参与轮换的 uid 列表（逗号分隔）
 *   switchBack          轮换结束后是否切回起始账号（默认 true）
 * 热重载：save() 写盘后返回生效配置；调度侧调用 restart()（stop→start）按新配置重排定时器。
 */
const fs = require('fs');
const path = require('path');
const { createSettingsStore } = require('../lib/settings-store');
const { stateFile, resolveStateFileForRead } = require('../lib/paths');

const NAME = 'rotate-settings.json';
const fromEnvFile = () => (process.env.ROTATE_SETTINGS_FILE || '').trim();

const SPECS = {
  enabled: { type: 'bool', env: 'ROTATE_ENABLED', default: true },
  // 与旧实现等价：save 收到非法数值时写默认值而非跳过；空串是有效值（清空该字段）
  intervalMinutes: { env: 'ROTATE_INTERVAL_MINUTES', default: 240, min: 30, max: 10080, invalidToDefault: true },
  stayMs: { env: 'ROTATE_STAY_MS', default: 60000, min: 10000, max: 3600000, invalidToDefault: true },
  // authDir 的 env 为 ROTATE_AUTH_DIR（与字段名不同）；文件空串视为未设置（回落 env）
  authDir: { env: 'ROTATE_AUTH_DIR', default: '', saveEmpty: true },
  // excludeUids 与 authDir 不同：文件空串是有效值（空列表），不再回落 env
  excludeUids: { env: 'ROTATE_EXCLUDE_UIDS', default: '', saveEmpty: true, keepEmpty: true },
  switchBack: { type: 'bool', env: 'ROTATE_SWITCH_BACK', default: true },
};

const store = createSettingsStore({
  name: NAME,
  specs: SPECS,
  fileOf: () => (fromEnvFile() ? path.resolve(fromEnvFile()) : stateFile(NAME)),
  readFileOf: () => (fromEnvFile() ? path.resolve(fromEnvFile()) : resolveStateFileForRead(NAME, fs.existsSync)),
});

module.exports = {
  getEffective: store.getEffective,
  save: store.save,
  FILE: () => store.FILE(),
  DEFAULTS: Object.fromEntries(Object.entries(SPECS).map(([k, s]) => [k, s.default])),
};
