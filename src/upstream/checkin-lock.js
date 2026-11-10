'use strict';
/**
 * upstream/checkin-lock.js — 签到轮的进程级互斥。
 *
 * 为什么需要（实测 2026-11-03）：08:45 自动轮与 08:58 手动轮同时在跑同一批账号。
 * 自动轮按 checkinSpreadMinutes=30 分散在 08:45–09:15，期间用户点「全部签到」
 * 会立刻起第二轮（手动轮 spreadMinutes=0），于是两批各领一半：
 *   08:58:22 task=checkin sub=trae trig=manual        claimed=3 already=5
 *   09:14:01 task=checkin sub=trae trig=checkin-chain claimed=5 already=3
 * 积分没有损失（上游同 x-device-id 当日仅可 claim 一次，重复返回 9095 归 already），
 * 但通知与面板把「今日已全部签完」报成「签到 3 · 已签 5」，看起来像 5 个号失败。
 *
 * 与 upstream/balance.js 的 withBatchLock 同一思路、同一实现风格：
 *   - 锁在**轮**这一层（覆盖整条签到链），不在单平台 runner 里。
 *     若按平台分别加锁，手动轮会绕过正在跑的 Trae 锁去起 WB，而自动轮随后
 *     也起 WB —— 冲突只是从 Trae 挪到 WB。
 *   - 同步置位 + finally 释放：node:sqlite 与本项目任务体之间没有「持锁期间
 *     被别的同步代码改写标志」的窗口。
 *   - 被跳过方返回 { skipped:true }，调用方必须如实告知用户「另一轮正在跑」，
 *     不能静默返回空结果（那是假成功）。
 *
 * 单账号签到（POST /:id/checkin）**不参与**本锁：用户点名要签某个号时，
 * 排队或拒绝都不如让他立刻拿到该号的结果；上游设备维度限次已保证不重复入账。
 */

let roundRunning = false;

/** 当前是否有签到轮在执行（供面板与 /health 读取）。 */
function isRoundRunning() {
  return roundRunning;
}

/**
 * 以互斥方式执行一轮签到。
 * @param {() => Promise<object>} fn 实际签到逻辑
 * @param {{label?:string}} [opts] label 仅用于日志
 * @returns {Promise<object>} fn 的结果；被跳过时返回 { skipped:true, running:true, label }
 */
async function withCheckinRound(fn, opts = {}) {
  if (roundRunning) {
    const label = opts.label || 'checkin';
    console.log(`[checkin-lock] ${label} skipped: 另一轮签到正在进行`);
    return { skipped: true, running: true, label };
  }
  roundRunning = true;
  try {
    return await fn();
  } finally {
    roundRunning = false;
  }
}

module.exports = { withCheckinRound, isRoundRunning };
