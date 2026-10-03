'use strict';
/**
 * jobs/scheduler-settings.js — 定时任务可调配置。
 * 存储：.trae-api/scheduler-settings.json；优先级：文件 > .env > 默认值。
 * 读写与夹紧由 lib/settings-store 承担，本文件只声明字段表。
 */
const { createSettingsStore } = require('../lib/settings-store');

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

// 读：新位置优先、旧位置回退；写：一律落新位置（首次保存即完成迁移）
const store = createSettingsStore({ name: 'scheduler-settings.json', specs: SPECS });

module.exports = {
  FIELDS,
  SPECS,
  getEffective: store.getEffective,
  save: store.save,
  FILE: store.FILE(),
  readFile: store.readFile,
};
