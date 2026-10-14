'use strict';
/**
 * upstream/checkin-all.js — 跨平台「全部签到」聚合（m-39）。
 *
 * 此前前端「全部签到」指向 Trae 专用的 POST /v1/credentials/checkin，该端点
 * 内部按 `variant.isTrae(a.edition)` 过滤，WorkBuddy 账号被静默跳过；而
 * WorkBuddy 自己的批量端点 /v1/workbuddy/checkin-all 前端从未调用。按钮名
 * 承诺「全部」，实际只签 Trae，且跳过无任何提示。
 *
 * 本模块是平台无关的聚合层：以 platform/variant 的 capability.checkin 为准
 * 枚举平台，逐平台调用各自实现，返回分平台明细。不放入 upstream/checkin.js
 * ——那是 Trae 签到实现，混入 WorkBuddy 会让它同时依赖两个平台模块。
 */
const store = require('../credentials/store');
const variant = require('../platform/variant');
const { appendCheckinTaskLog } = require('../jobs/checkin-log');

/** 单平台的签到实现（惰性 require：避免本模块与具体平台实现产生顶层依赖）。 */
const PLATFORM_RUNNERS = {
  trae: () => require('./checkin').checkinAllEnabled,
  workbuddy: () => require('./wb-checkin').wbCheckinAllEnabled,
};

/** 把某个平台的批次结果压成统一的明细行。 */
function summarize(platformId, batch, err) {
  if (err) {
    return {
      platform: platformId,
      total: 0,
      claimed: 0,
      already: 0,
      disabled: 0,
      failed: 1,
      error: err.message,
      accounts: [],
    };
  }
  const accounts = [
    ...(batch.claimed || []).map((x) => ({ id: x.accountId || x.id, label: x.label, result: 'claimed', credit: x.checkinCredits ?? null })),
    ...(batch.already || []).map((x) => ({ id: x.accountId || x.id, label: x.label, result: 'already' })),
    ...(batch.disabled || []).map((x) => ({ id: x.accountId || x.id, label: x.label, result: 'disabled' })),
    ...(batch.failed || []).map((x) => ({ id: x.accountId || x.id, label: x.label, result: 'failed', reason: x.reason || null })),
  ];
  return {
    platform: platformId,
    total: batch.total != null ? batch.total : accounts.length,
    claimed: (batch.claimed || []).length,
    already: (batch.already || []).length,
    disabled: (batch.disabled || []).length,
    failed: (batch.failed || []).length,
    error: null,
    accounts,
  };
}

/**
 * 本轮实际参与签到的平台：由启用账号的 edition 推导，而非硬编码平台名单。
 * 新增平台只要在 variant 里声明 capability.checkin 并有对应 runner，就会
 * 自动纳入「全部签到」；没有账号的平台也不会白跑一轮。
 *
 * edition 归一：Trae 侧历史值（cn/sg/us/manual）必须归到 trae，否则 cn 账号
 * 会因查不到 runner 被丢弃（首次实测只跑了 workbuddy，正是漏了这步）。
 */
function checkinPlatforms() {
  const ids = new Set();
  for (const a of store.list()) {
    if (!a.enabled) continue;
    const id = variant.normalizeEdition(a.edition);
    if (!variant.can(id, 'checkin')) continue;
    if (PLATFORM_RUNNERS[id]) ids.add(id);
  }
  // 稳定顺序：trae 在前（历史行为），其余按字典序
  const order = ['trae', 'workbuddy'];
  return [...ids].sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
}

/**
 * 对所有「声明了签到能力」的平台跑一遍批量签到。
 *
 * @param {{spreadMinutes?:number, windowStartMs?:number, trigger?:string, notifyOnDone?:boolean}} [opts]
 *   trigger      'manual'（默认）或 'scheduler'，仅用于任务日志与通知措辞
 *   notifyOnDone 是否推送汇总通知（手动触发时用户明确要求提醒，见 m-39）
 * @returns {Promise<object>} {object, trigger, total, claimed, already, disabled, failed, platforms[], message}
 */
async function checkinAllByPlatform(opts = {}) {
  const spreadMinutes = Number(opts.spreadMinutes) || 0;
  const windowStartMs = opts.windowStartMs || Date.now();
  const trigger = opts.trigger || 'manual';
  const notifyOnDone = opts.notifyOnDone !== false;

  // 统计本轮实际会签到多少账号（含各平台），避免「点了但一个号都没有」的假成功
  const accounts = store.list().filter((a) => a.enabled && variant.can(a.edition, 'checkin'));
  const platforms = checkinPlatforms();

  const results = [];
  for (const platformId of platforms) {
    let batch = null;
    let err = null;
    try {
      const runner = PLATFORM_RUNNERS[platformId]();
      batch = await runner({ spreadMinutes, windowStartMs });
    } catch (e) {
      err = e;
      console.error(`[checkin-all] ${platformId} failed: ${e.message}`);
    }
    const row = summarize(platformId, batch, err);
    results.push(row);
    // 分平台写任务日志，与调度器签到链同口径（面板「任务日志」可见）
    if (batch && (batch.total || batch.claimed?.length || batch.failed?.length)) {
      appendCheckinTaskLog({ edition: platformId, batch, trigger });
    } else if (err) {
      appendCheckinTaskLog({
        edition: platformId,
        batch: { claimed: [], already: [], disabled: [], failed: [{ reason: err.message }] },
        trigger,
      });
    }
  }

  const sum = (k) => results.reduce((s, r) => s + (r[k] || 0), 0);
  const total = sum('total');
  const claimed = sum('claimed');
  const already = sum('already');
  const disabled = sum('disabled');
  const failed = sum('failed');

  // 明细文案：按平台逐条列出，UI 直接展示即可如实反映覆盖面
  const message = results
    .map((r) => {
      const label = variant.variantOf(r.platform).label || r.platform;
      const bits = [];
      if (r.claimed) bits.push(`签到 ${r.claimed}`);
      if (r.already) bits.push(`已签 ${r.already}`);
      if (r.disabled) bits.push(`停用 ${r.disabled}`);
      if (r.failed) bits.push(`失败 ${r.failed}`);
      const tail = bits.length ? bits.join(' · ') : '无账号';
      return `${label} ${tail}${r.error ? `（${r.error}）` : ''}`;
    })
    .join('；');

  const out = {
    object: 'checkin.all',
    trigger,
    total,
    claimed,
    already,
    disabled,
    failed,
    platforms: results,
    message,
  };

  // 手动触发也要提醒（m-39：此前手动签到不推送，用户不知道结果）
  if (notifyOnDone && (total || failed)) {
    const { notify } = require('../notify');
    // 「今日均已签到」时 claimed=0，如实说明而不报「签到完成」
    const title = failed
      ? '签到部分失败'
      : (claimed ? `签到完成：${claimed} 个账号` : '今日均已签到');
    notify(failed ? 'checkin_fail' : 'checkin_ok', {
      ok: claimed + already + disabled,
      failed,
      claimed,
      already,
      message: `${trigger === 'manual' ? '手动' : '自动'}签到：${message}`,
    }, title).catch(() => {});
  }
  return out;
}

module.exports = { checkinAllByPlatform, checkinPlatforms };
