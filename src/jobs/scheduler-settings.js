'use strict';
/**
 * jobs/scheduler-settings.js — 定时任务可调配置。
 * 存储：.trae-api/scheduler-settings.json；优先级：文件 > .env > 默认值。
 * 读写与夹紧由 lib/settings-store 承担，本文件只声明字段表。
 */
const { createSettingsStore } = require('../lib/settings-store');

/** 字段表：key -> { env, default, min, max } */
const SPECS = {
  checkinHour: { env: 'CHECKIN_HOUR', default: 9, min: 0, max: 23 },
  checkinMinute: { env: 'CHECKIN_MINUTE', default: 0, min: 0, max: 59 },
  keepaliveHour: { env: 'KEEPALIVE_HOUR', default: 22, min: 0, max: 23 },
  keepaliveMinute: { env: 'KEEPALIVE_MINUTE', default: 0, min: 0, max: 59 },
  tokenSweepMinutes: { env: 'TOKEN_SWEEP_MINUTES', default: 15, min: 1, max: 1440 },
  modelProbeIntervalHours: { env: 'MODEL_PROBE_INTERVAL_HOURS', default: 6, min: 0, max: 168 },
  modelProbeMaxPerRun: { env: 'MODEL_PROBE_MAX_PER_RUN', default: 8, min: 0, max: 100 },
  // rotateEnabled 已移除（m-32 根因修复）：账号轮换总开关的唯一事实源是
  // rotate-settings.enabled（状态页轮换开关）。此前两处 enabled 共用
  // ROTATE_ENABLED env，存在「面板只开其一」的语义碰撞。时刻字段仍留此处。
  rotateHour: { env: 'ROTATE_HOUR', default: 0, min: 0, max: 23 },
  rotateMinute: { env: 'ROTATE_MINUTE', default: 10, min: 0, max: 59 },
  // 成长中心独立定时（与签到链解耦）：growthPollEnabled=0 关闭。
  growthPollEnabled: { env: 'GROWTH_POLL_ENABLED', default: 1, min: 0, max: 1 },
  // 成长中心执行时刻（墙钟，每天一次）。此前只有 growthPollIntervalHours
  // （按进程启动时刻每 N 小时轮询），没有可配时刻：进程若半夜启动/重启，
  // 派猫与领奖通知会整天落在夜间，造成持续打扰。现改为固定时刻，默认早晨 8:00。
  growthHour: { env: 'GROWTH_HOUR', default: 8, min: 0, max: 23 },
  growthMinute: { env: 'GROWTH_MINUTE', default: 0, min: 0, max: 59 },
  // 确定性错峰窗口（分钟）：多账号签到与刷余额按（日期, 账号 ID）哈希分散到窗口内，
  // 避免固定时刻批量请求上游；0=关闭（退回原批量行为）
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
