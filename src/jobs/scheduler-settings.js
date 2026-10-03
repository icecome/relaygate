'use strict';
/**
 * jobs/scheduler-settings.js — 定时任务可调配置。
 * 存储：.trae-api/scheduler-settings.json；优先级：文件 > .env > 默认值。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { writeJsonAtomic } = require('../lib/atomic-write');
const { stateFile, resolveStateFileForRead } = require('../lib/paths');

// 读：新位置优先、旧位置回退；写：一律落新位置（首次保存即完成迁移）
const FILE = stateFile('scheduler-settings.json');
const readFile = () => resolveStateFileForRead('scheduler-settings.json', fs.existsSync);

/** key -> { env, default, min, max } */
const SPECS = {
  checkinHour: { env: 'CHECKIN_HOUR', default: 9, min: 0, max: 23 },
  checkinMinute: { env: 'CHECKIN_MINUTE', default: 0, min: 0, max: 59 },
  keepaliveHour: { env: 'KEEPALIVE_HOUR', default: 22, min: 0, max: 23 },
  keepaliveMinute: { env: 'KEEPALIVE_MINUTE', default: 0, min: 0, max: 59 },
  tokenSweepMinutes: { env: 'TOKEN_SWEEP_MINUTES', default: 15, min: 1, max: 1440 },
  modelProbeIntervalHours: { env: 'MODEL_PROBE_INTERVAL_HOURS', default: 6, min: 0, max: 168 },
  modelProbeMaxPerRun: { env: 'MODEL_PROBE_MAX_PER_RUN', default: 8, min: 0, max: 100 },
  rotateEnabled: { env: 'ROTATE_ENABLED', default: 1, min: 0, max: 1 },
  rotateHour: { env: 'ROTATE_HOUR', default: 0, min: 0, max: 23 },
  rotateMinute: { env: 'ROTATE_MINUTE', default: 10, min: 0, max: 59 },
  // 成长中心独立轮询：0=关闭；与签到链解耦，用于及时领奖/补派（对齐轮询补签模型）
  growthPollEnabled: { env: 'GROWTH_POLL_ENABLED', default: 1, min: 0, max: 1 },
  growthPollIntervalHours: { env: 'GROWTH_POLL_INTERVAL_HOURS', default: 4, min: 0, max: 168 },
  // 确定性错峰窗口（分钟）：多账号签到/刷余额按 (日期,账号id) 哈希分散到窗口内，
  // 避免固定时刻批量打上游自造洪峰；0=关闭（退回原批量行为）
  checkinSpreadMinutes: { env: 'CHECKIN_SPREAD_MINUTES', default: 30, min: 0, max: 720 },
  balanceSpreadMinutes: { env: 'BALANCE_SPREAD_MINUTES', default: 15, min: 0, max: 720 },
};

const FIELDS = Object.keys(SPECS);

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return null;
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

function resolveField(key, stored) {
  const spec = SPECS[key];
  const fromFile = stored[key];
  if (fromFile != null && fromFile !== '') {
    const n = clamp(Number(fromFile), spec.min, spec.max);
    if (n != null) return n;
  }
  const fromEnv = process.env[spec.env];
  if (fromEnv != null && fromEnv !== '') {
    const n = clamp(Number(fromEnv), spec.min, spec.max);
    if (n != null) return n;
  }
  return spec.default;
}

/** 合并后的生效调度配置。 */
function getEffective() {
  const stored = readStored();
  const out = {};
  for (const key of FIELDS) out[key] = resolveField(key, stored);
  return out;
}

/** 保存传入字段；返回生效配置。 */
function save(partial) {
  const stored = readStored();
  for (const key of FIELDS) {
    if (partial[key] == null || partial[key] === '') continue;
    const n = clamp(Number(partial[key]), SPECS[key].min, SPECS[key].max);
    if (n != null) stored[key] = n;
  }
  writeJsonAtomic(FILE, stored);
  return getEffective();
}

module.exports = { FIELDS, SPECS, getEffective, save, FILE, readFile };
