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
const config = require('../config');
const { writeJsonAtomic } = require('../lib/atomic-write');
const { stateFile, resolveStateFileForRead } = require('../lib/paths');

const FILE = () => process.env.ROTATE_SETTINGS_FILE
  ? path.resolve(process.env.ROTATE_SETTINGS_FILE)
  : stateFile('rotate-settings.json');
const readFile = () => (process.env.ROTATE_SETTINGS_FILE
  ? path.resolve(process.env.ROTATE_SETTINGS_FILE)
  : resolveStateFileForRead('rotate-settings.json', fs.existsSync));

const DEFAULTS = {
  enabled: true,
  intervalMinutes: 240,
  stayMs: 60000,
  authDir: '',
  excludeUids: '',
  switchBack: true,
};

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.round(n), min), max);
}

function readStored() {
  try {
    const raw = JSON.parse(fs.readFileSync(readFile(), 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** 生效配置：文件 > env（ROTATE_ENABLED / ROTATE_INTERVAL_MINUTES / ROTATE_STAY_MS / ROTATE_AUTH_DIR / ROTATE_EXCLUDE_UIDS / ROTATE_SWITCH_BACK）> 默认。 */
function getEffective() {
  const st = readStored();
  const envBool = (name, dflt) => {
    const v = process.env[name];
    if (v == null || v === '') return dflt;
    return v !== 'false' && v !== '0' && v !== 'off';
  };
  const enabled = st.enabled != null ? !!st.enabled : envBool('ROTATE_ENABLED', DEFAULTS.enabled);
  const intervalMinutes = st.intervalMinutes != null && st.intervalMinutes !== ''
    ? clampInt(st.intervalMinutes, 30, 10080, DEFAULTS.intervalMinutes)
    : clampInt(process.env.ROTATE_INTERVAL_MINUTES, 30, 10080, DEFAULTS.intervalMinutes);
  const stayMs = st.stayMs != null && st.stayMs !== ''
    ? clampInt(st.stayMs, 10000, 3600000, DEFAULTS.stayMs)
    : clampInt(process.env.ROTATE_STAY_MS, 10000, 3600000, DEFAULTS.stayMs);
  const authDir = st.authDir && String(st.authDir).trim()
    ? String(st.authDir).trim()
    : (process.env.ROTATE_AUTH_DIR ? String(process.env.ROTATE_AUTH_DIR).trim() : '');
  const excludeUids = st.excludeUids != null
    ? String(st.excludeUids)
    : (process.env.ROTATE_EXCLUDE_UIDS || '');
  const switchBack = st.switchBack != null ? !!st.switchBack : envBool('ROTATE_SWITCH_BACK', DEFAULTS.switchBack);
  return { enabled, intervalMinutes, stayMs, authDir, excludeUids, switchBack };
}

/** 保存传入字段（白名单），返回生效配置。 */
function save(partial) {
  const st = readStored();
  if (typeof partial.enabled === 'boolean') st.enabled = partial.enabled;
  if (partial.intervalMinutes != null && partial.intervalMinutes !== '') st.intervalMinutes = clampInt(partial.intervalMinutes, 30, 10080, DEFAULTS.intervalMinutes);
  if (partial.stayMs != null && partial.stayMs !== '') st.stayMs = clampInt(partial.stayMs, 10000, 3600000, DEFAULTS.stayMs);
  if (partial.authDir != null) st.authDir = String(partial.authDir).trim();
  if (partial.excludeUids != null) st.excludeUids = String(partial.excludeUids).trim();
  if (typeof partial.switchBack === 'boolean') st.switchBack = partial.switchBack;
  writeJsonAtomic(FILE(), st);
  return getEffective();
}

module.exports = { getEffective, save, FILE, DEFAULTS };