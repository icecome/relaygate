'use strict';
/**
 * notify/settings.js — 通知渠道配置读写。
 * 存储：.trae-api/notify-settings.json（本机文件，不进代码库）。
 * 优先级：配置文件非空值 > .env 环境变量 > 空（渠道关闭）。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { writeJsonAtomic } = require('../lib/atomic-write');
const { stateFile, resolveStateFileForRead } = require('../lib/paths');

const FILE = stateFile('notify-settings.json');
const readFile = () => resolveStateFileForRead('notify-settings.json', fs.existsSync);

const FIELDS = [
  'webhookUrl',
  'webhookMethod',
  'webhookHeaders',
  'webhookTitleKey',
  'webhookContentKey',
  'serverChanSendKey',
  'pushPlusToken',
  'telegramBotToken',
  'telegramChatId',
];

/** 可开关的事件类型；未显式保存时默认全部开启。 */
const EVENTS = [
  'checkin_ok',
  'checkin_fail',
  'credits_expiring',
  'balance_low',
  'refresh_fail',
  'pool_empty',
  'growth_claimed',
  'growth_departed',
  'backup_done',
  'backup_failed',
];

const ENV_MAP = {
  webhookUrl: 'NOTIFY_WEBHOOK_URL',
  webhookMethod: 'NOTIFY_WEBHOOK_METHOD',
  webhookHeaders: 'NOTIFY_WEBHOOK_HEADERS',
  webhookTitleKey: 'NOTIFY_WEBHOOK_TITLE_KEY',
  webhookContentKey: 'NOTIFY_WEBHOOK_CONTENT_KEY',
  serverChanSendKey: 'SERVERCHAN_SEND_KEY',
  pushPlusToken: 'PUSHPLUS_TOKEN',
  telegramBotToken: 'TELEGRAM_BOT_TOKEN',
  telegramChatId: 'TELEGRAM_CHAT_ID',
};

function readStored() {
  try {
    const raw = JSON.parse(fs.readFileSync(readFile(), 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function envOf(field) {
  const name = ENV_MAP[field];
  return (name && process.env[name]) || '';
}

/** 事件开关：文件里显式 false 才关闭，默认 true。 */
function getEvents(stored) {
  const src = stored && stored.events && typeof stored.events === 'object' ? stored.events : {};
  const out = {};
  for (const e of EVENTS) {
    out[e] = src[e] === false ? false : true;
  }
  // 自定义事件：文件里已登记的非内置事件也展示（默认按文件显式值）
  for (const [k, v] of Object.entries(src)) {
    if (k === 'merge') continue;
    if (!(k in out)) out[k] = v !== false;
  }
  return out;
}

/** 某事件是否允许推送。 */
function isEventEnabled(event) {
  if (!event) return true;
  return getEvents(readStored())[event] !== false;
}

/** 追加/删除自定义事件（存为 enabled 布尔）。@returns {boolean} 是否成功变更。 */
function addEvent(event, enabledFlag) {
  if (!event || typeof event !== 'string') return false;
  const id = event.trim().slice(0, 64);
  if (!/^[a-z][a-z0-9_]*$/.test(id)) return false;
  const stored = readStored();
  stored.events = stored.events && typeof stored.events === 'object' ? stored.events : {};
  stored.events[id] = enabledFlag !== false;
  writeJsonAtomic(FILE, stored);
  return true;
}

function removeEvent(event) {
  if (!event) return false;
  const stored = readStored();
  if (stored.events && typeof stored.events === 'object' && event in stored.events) {
    delete stored.events[event];
    writeJsonAtomic(FILE, stored);
    return true;
  }
  return false;
}

/** 合并后的生效配置（用于展示与发送）。 */
function getEffective() {
  const stored = readStored();
  const out = {};
  for (const f of FIELDS) {
    const v = typeof stored[f] === 'string' ? stored[f].trim() : '';
    out[f] = v || envOf(f);
  }
  out.events = getEvents(stored);
  return out;
}

/** 保存传入的字段（全量替换对应键）；返回生效配置。 */
function save(partial) {
  const stored = readStored();
  for (const f of FIELDS) {
    if (typeof partial[f] === 'string') stored[f] = partial[f].trim();
  }
  if (partial.events && typeof partial.events === 'object') {
    stored.events = { ...(stored.events && typeof stored.events === 'object' ? stored.events : {}) };
    for (const e of EVENTS) {
      if (typeof partial.events[e] === 'boolean') stored.events[e] = partial.events[e];
    }
    // 自定义事件同样可保存开关状态
    for (const [k, v] of Object.entries(partial.events)) {
      if (!(k in EVENTS) && k !== 'merge' && typeof v === 'boolean') stored.events[k] = v;
    }
  }
  writeJsonAtomic(FILE, stored);
  return getEffective();
}

module.exports = { FIELDS, EVENTS, getEffective, save, isEventEnabled, addEvent, removeEvent, FILE, readFile };
