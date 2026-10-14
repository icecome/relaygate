'use strict';
/**
 * models/official-daily.js — 官方账单的「按日」聚合。
 *
 * 用途：traffic.jsonl 的 token 字段在 2026-10-10 前被误脱敏成 "***"（且 10-04/10-05
 * 无数值行），网关侧计量在那段日期是空的。官方账单缓存（Trae 会话账单 + WorkBuddy
 * 逐请求账单）覆盖同样的日期且是上游权威口径，按日聚合后正好补上这个洞。
 *
 * 两个数据源已在各自模块缓存到文件（trae-usage-cache 与 official-usage-cache），
 * 这里只读文件聚合，不请求上游。
 */
const fs = require('fs');
const path = require('path');
const { stateDir, legacyStateDir } = require('../lib/paths');
const { round2 } = require('../lib/round');

function cacheDirOf(name) {
  const fresh = path.join(stateDir(), name);
  if (fs.existsSync(fresh)) return fresh;
  const legacy = path.join(legacyStateDir(), name);
  return fs.existsSync(legacy) ? legacy : fresh;
}

const traeDir = () => cacheDirOf('trae-usage-cache');
const wbDir = () => cacheDirOf('official-usage-cache');

function readRowsMatching(dir, suffix) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(suffix)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      for (const r of raw.rows || []) out.push(r);
    } catch { /* 单文件损坏跳过 */ }
  }
  return out;
}

/**
 * 聚合最近 N 天的官方账单积分（按日）。
 * @param {number} days
 * @returns {{byDay: {date:string, traeCredit:number, traeTokens:number, traeSessions:number, wbCredit:number, wbRequests:number, totalCredit:number, covered:boolean}[], traeCreditTotal:number, wbCreditTotal:number}}
 *   covered=true 表示该日两路账单缓存都存在（不代表有消耗，只代表「查过且入账」）；
 *   Trae 账单按会话入账有 1~2 天滞后，最近一两天 traeCredit=0 多半是未入账，不是没消耗。
 */
function dailyCredits(days) {
  const byDay = new Map();
  const dayKey = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  for (let i = 0; i < days; i++) {
    byDay.set(dayKey(i), {
      date: dayKey(i),
      traeCredit: 0, traeTokens: 0, traeSessions: 0,
      wbCredit: 0, wbRequests: 0,
      totalCredit: 0,
      covered: false,
    });
  }
  const daySet = new Set(byDay.keys());

  // Trae 会话账单：缓存文件名 <accountId>-<date>.json
  const tdir = traeDir();
  const traeDays = new Set();
  if (fs.existsSync(tdir)) {
    for (const f of fs.readdirSync(tdir)) {
      const m = f.match(/-(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m || !daySet.has(m[1])) continue;
      traeDays.add(m[1]);
      const bucket = byDay.get(m[1]);
      try {
        for (const r of JSON.parse(fs.readFileSync(path.join(tdir, f), 'utf-8')).rows || []) {
          bucket.traeCredit += Number(r.credits) || 0;
          bucket.traeTokens += (Number(r.inputTokens) || 0) + (Number(r.outputTokens) || 0);
          bucket.traeSessions++;
        }
      } catch { /* 单文件损坏跳过 */ }
    }
  }

  // WorkBuddy 逐请求账单：同命名规则
  const wdir = wbDir();
  const wbDays = new Set();
  if (fs.existsSync(wdir)) {
    for (const f of fs.readdirSync(wdir)) {
      const m = f.match(/-(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m || !daySet.has(m[1])) continue;
      wbDays.add(m[1]);
      const bucket = byDay.get(m[1]);
      try {
        for (const r of JSON.parse(fs.readFileSync(path.join(wdir, f), 'utf-8')).rows || []) {
          bucket.wbCredit += Number(r.credit) || 0;
          bucket.wbRequests++;
        }
      } catch { /* 单文件损坏跳过 */ }
    }
  }

  let traeCreditTotal = 0;
  let wbCreditTotal = 0;
  const out = [...byDay.values()].sort((a, b) => b.date.localeCompare(a.date));
  for (const d of out) {
    d.traeCredit = round2(d.traeCredit);
    d.wbCredit = round2(d.wbCredit);
    d.totalCredit = round2(d.traeCredit + d.wbCredit);
    d.traeTokens = Math.round(d.traeTokens);
    traeCreditTotal += d.traeCredit;
    wbCreditTotal += d.wbCredit;
    // covered：该日已有账单缓存文件（读取成功）。不代表当日一定有消耗——
    // Trae 按会话入账有 1~2 天滞后，最近一两日 traeCredit=0 多半是「尚未入账」，
    // 调用方须结合该事实解读，不可读作「当天没花积分」。
    d.covered = traeDays.has(d.date) || wbDays.has(d.date);
  }
  return {
    byDay: out,
    traeCreditTotal: round2(traeCreditTotal),
    wbCreditTotal: round2(wbCreditTotal),
  };
}

module.exports = { dailyCredits };
