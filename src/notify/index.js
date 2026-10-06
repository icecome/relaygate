'use strict';
/**
 * notify/index.js — 轻量事件通知（Webhook / Server酱 / PushPlus / Telegram）。
 *
 * 仅支持个人规模：进程内去重 + fire-and-forget，不引入队列。
 * 事件：checkin_ok / checkin_fail / credits_expiring / balance_low / refresh_fail / pool_empty
 * （account_disabled / scheduler_error 仍可发，未列入默认开关表时视为开启）
 */
const config = require('../config');
const settings = require('./settings');

/** key -> lastSentMs */
const recent = new Map();
/** 合并窗口：同一 key 在窗口内多次触发时，把详情串追加到「合并详情」键。 */
const merged = new Map();

/** 当前已启用的渠道名列表（总开关关闭时返回空）。 */
function activeChannels() {
  const s = settings.getEffective();
  if (s.enabled === false) return [];
  const list = [];
  if (s.webhookUrl) list.push('webhook');
  if (s.serverChanSendKey) list.push('serverchan');
  if (s.pushPlusToken) list.push('pushplus');
  if (s.telegramBotToken && s.telegramChatId) list.push('telegram');
  return list;
}

/** 已配置渠道（忽略总开关），供面板展示「配了但被关掉」。 */
function configuredChannels() {
  const s = settings.getEffective();
  const list = [];
  if (s.webhookUrl) list.push('webhook');
  if (s.serverChanSendKey) list.push('serverchan');
  if (s.pushPlusToken) list.push('pushplus');
  if (s.telegramBotToken && s.telegramChatId) list.push('telegram');
  return list;
}

function enabled() {
  return activeChannels().length > 0;
}

/**
 * 通知事件合并（防重复轰炸）：
 * - 同 key（event:accountId）在 dedupe 窗口内重复触发 → 跳过正文发送，仅累计计数；
 * - 合并窗口（notifyMergeMs，默认 10 分钟）结束时把「N 条同类事件」合并成一条补发。
 * 实现：shouldSend 返回 false 时记录进合并桶；定时器到点后把桶内事件合并补发。
 */
function mergeWindowMs() {
  const n = Number(config.notifyMergeMs);
  return Number.isFinite(n) && n >= 0 ? n : 10 * 60 * 1000;
}

function shouldSend(key) {
  const now = Date.now();
  const last = recent.get(key) || 0;
  if (now - last < config.notifyDedupeMs) {
    // 落入去重窗口：计入合并桶（仅计数，不发送）
    const bucket = merged.get(key) || { count: 0, firstAt: last || now, event: null };
    bucket.count += 1;
    if (!bucket.event) {
      const idx = key.indexOf(':');
      bucket.event = idx > 0 ? key.slice(0, idx) : key;
    }
    merged.set(key, bucket);
    scheduleMergeFlush();
    return false;
  }
  recent.set(key, now);
  // 简单清理
  if (recent.size > 200) {
    for (const [k, v] of recent) {
      if (now - v > config.notifyDedupeMs) recent.delete(k);
    }
  }
  return true;
}

let mergeTimer = null;
function scheduleMergeFlush() {
  if (mergeTimer || merged.size === 0) return;
  mergeTimer = setTimeout(() => {
    mergeTimer = null;
    flushMerged();
  }, mergeWindowMs());
  mergeTimer.unref?.();
}

/** 合并桶到点：把 count>1 的事件补发一条汇总。 */
async function flushMerged() {
  if (merged.size === 0) return;
  const items = Array.from(merged.entries());
  merged.clear();
  for (const [key, bucket] of items) {
    if (!bucket.event || bucket.count < 2) continue;
    // 渠道内并发送一条「合并摘要」
    const channels = activeChannels();
    if (!channels.length) continue;
    const s = settings.getEffective();
    const text = `[relay-gate] 合并提醒：${bucket.event} 在 ${Math.round(mergeWindowMs() / 60000)} 分钟内触发 ${bucket.count} 次（同类事件已去重，仅汇总一次）`;
    const results = [];
    const run = async (channel, fn) => {
      try { await fn(); results.push({ channel, ok: true }); }
      catch (e) { results.push({ channel, ok: false, message: e.message }); }
    };
    const jobs = [];
    if (channels.includes('webhook')) jobs.push(run('webhook', () => sendCustomWebhook(s, '合并提醒', text, bucket.event, { mergedCount: bucket.count })));
    if (channels.includes('serverchan')) jobs.push(run('serverchan', () => sendServerChan(s.serverChanSendKey, '合并提醒', text)));
    if (channels.includes('pushplus')) jobs.push(run('pushplus', () => sendPushPlus(s.pushPlusToken, '合并提醒', text)));
    if (channels.includes('telegram')) jobs.push(run('telegram', () => postJson(
      `https://api.telegram.org/bot${s.telegramBotToken}/sendMessage`,
      { chat_id: s.telegramChatId, text, disable_web_page_preview: true },
    )));
    await Promise.all(jobs);
  }
}

async function postJson(url, body, headers) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  return resp.ok;
}

/** 解析 webhookHeaders JSON 字符串，失败返回空对象。 */
function parseWebhookHeaders(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

/** 发送自定义 Webhook：支持自定义 Method、Header、标题/内容字段名。 */
async function sendCustomWebhook(s, title, text, event, payload) {
  const url = s.webhookUrl;
  const method = (s.webhookMethod || 'POST').toUpperCase();
  const headers = Object.assign({ 'Content-Type': 'application/json' }, parseWebhookHeaders(s.webhookHeaders));
  const titleKey = (s.webhookTitleKey || '').trim();
  const contentKey = (s.webhookContentKey || '').trim();

  let body;
  if (titleKey && contentKey) {
    body = { [titleKey]: title, [contentKey]: text };
  } else if (titleKey) {
    body = { [titleKey]: title };
  } else {
    body = { event, ts: new Date().toISOString(), text, payload };
  }

  const resp = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return true;
}

/** Server酱 Turbo：POST 表单到 sctapi.ftqq.com/{key}.send。 */
async function sendServerChan(sendKey, title, text) {
  const url = `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`;
  const body = new URLSearchParams({ title, desp: text }).toString();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const j = await resp.json().catch(() => null);
  if (!j || j.code !== 0) throw new Error(j && j.message ? j.message : 'response invalid');
  return true;
}

/** PushPlus：POST JSON 到 www.pushplus.plus/send。 */
async function sendPushPlus(token, title, text) {
  const resp = await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, title, content: text, template: 'txt' }),
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const j = await resp.json().catch(() => null);
  if (!j || j.code !== 200) throw new Error(j && j.msg ? j.msg : 'response invalid');
  return true;
}

/**
 * 事件 → 人话标题模板（数字前置，一眼看懂价值）。
 */
const EVENT_TITLES = {
  checkin_ok: '签到完成',
  checkin_fail: '签到部分失败',
  credits_expiring: '积分临期提醒',
  balance_low: '余额过低提醒',
  refresh_fail: 'Token 刷新失败',
  pool_empty: '账号池无可用账号',
  growth_claimed: 'WorkBuddy 成长奖励到账',
  growth_departed: 'WorkBuddy 派猫出发',
  backup_done: '系统备份完成',
  backup_failed: '系统备份失败',
};

function humanTitle(event, payload = {}, fallback) {
  const base = EVENT_TITLES[event] || fallback || event;
  // 积分临期：把 d3/d7 数字直接带进标题
  if (event === 'credits_expiring' && (payload.expiring3d != null || payload.expiring7d != null)) {
    const parts = [];
    if (payload.expiring3d) parts.push(`3天内 ${payload.expiring3d}`);
    if (payload.expiring7d) parts.push(`7天内 ${payload.expiring7d}`);
    if (parts.length) return `${base}：${parts.join(' · ')}`;
  }
  // 余额过低：阈值 + 账号数
  if (event === 'balance_low' && payload.accounts && payload.accounts.length) {
    return `${base}：${payload.accounts.length} 个账号低于 ${payload.threshold ?? ''}`;
  }
  // 签到：成功/失败数
  if (event === 'checkin_ok' && payload.ok != null) return `${base}：${payload.ok} 个账号`;
  if (event === 'checkin_fail' && (payload.ok != null || payload.failed != null)) {
    const ok = payload.ok != null ? `成功 ${payload.ok}` : '';
    const failed = payload.failed != null ? `失败 ${payload.failed}` : '';
    return `${base}：${[ok, failed].filter(Boolean).join(' · ')}`;
  }
  return base;
}

function buildText(event, payload = {}, title) {
  return [
    `[relay-gate] ${title || humanTitle(event, payload)}`,
    payload.accountId ? `账号: ${payload.accountId}` : '',
    payload.label ? `标签: ${payload.label}` : '',
    payload.message ? `详情: ${payload.message}` : '',
    payload.ok != null ? `成功: ${payload.ok}` : '',
    payload.failed != null ? `失败: ${payload.failed}` : '',
    // 成长奖励：优先展示奖励数值（旅行/兑换/抽奖）
    payload.rewardCredit != null ? `到账积分: +${payload.rewardCredit}` : '',
    payload.credit != null ? `到账积分: +${payload.credit}` : '',
    payload.prize ? `奖品: ${payload.prize}` : '',
    payload.energy != null ? `能量: ${payload.energy}` : '',
    // 临期明细：各账号单独列出
    payload.accounts && payload.accounts.length
      ? `明细: ${payload.accounts.join('；')}`
      : '',
  ].filter(Boolean).join('\n');
}

/**
 * 发送事件并返回逐渠道明细。
 * @param {string} event
 * @param {object} payload
 * @param {string} [title]
 * @param {object} [opts]
 * @param {boolean} [opts.force] 跳过去重（测试用）
 * @returns {Promise<{delivered:boolean, enabled:boolean, results:Array<{channel:string, ok:boolean, message?:string}>}>}
 */
async function notifyDetail(event, payload = {}, title, opts = {}) {
  const channels = activeChannels();
  if (!channels.length) return { delivered: false, enabled: false, results: [] };
  if (!opts.force && !settings.isEventEnabled(event)) {
    return { delivered: false, enabled: true, results: [], skipped: 'event_disabled' };
  }
  const key = `${event}:${payload.accountId || payload.id || 'global'}`;
  if (!opts.force && !shouldSend(key)) return { delivered: false, enabled: true, results: [] };

  const text = buildText(event, payload, title);
  const s = settings.getEffective();
  const results = [];
  const sendTitle = title || humanTitle(event, payload);

  const run = async (channel, fn) => {
    try {
      await fn();
      results.push({ channel, ok: true });
    } catch (e) {
      console.error(`[notify] ${channel} failed:`, e.message);
      results.push({ channel, ok: false, message: e.message });
    }
  };

  const jobs = [];
  if (channels.includes('webhook')) {
    jobs.push(run('webhook', () => sendCustomWebhook(s, sendTitle, text, event, payload)));
  }
  if (channels.includes('serverchan')) {
    jobs.push(run('serverchan', () => sendServerChan(s.serverChanSendKey, sendTitle, text)));
  }
  if (channels.includes('pushplus')) {
    jobs.push(run('pushplus', () => sendPushPlus(s.pushPlusToken, sendTitle, text)));
  }
  if (channels.includes('telegram')) {
    jobs.push(run('telegram', () => postJson(
      `https://api.telegram.org/bot${s.telegramBotToken}/sendMessage`,
      { chat_id: s.telegramChatId, text, disable_web_page_preview: true }
    )));
  }
  await Promise.all(jobs);
  return { delivered: results.some((r) => r.ok), enabled: true, results };
}

/**
 * 发送事件。返回是否已实际投递。
 * @param {string} event checkin_ok | checkin_fail | credits_expiring | balance_low | refresh_fail | pool_empty | …
 * @param {object} payload
 * @param {string} [title] 人类可读标题
 */
async function notify(event, payload = {}, title) {
  if (!enabled()) return false;
  const r = await notifyDetail(event, payload, title);
  return r.delivered;
}

module.exports = { notify, notifyDetail, enabled, activeChannels, configuredChannels };
