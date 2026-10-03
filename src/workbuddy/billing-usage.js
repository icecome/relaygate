'use strict';
/**
 * workbuddy/billing-usage.js — 官方账单接口客户端（精确积分来源）。
 *
 * 背景：网关侧只能拿到余额快照，积分消耗靠相邻快照差分推算（下界、非精确）。
 * WorkBuddy 官方提供逐请求账单接口 get-user-request-usage，其 credit 字段是精确消耗值。
 * 本模块按单日分块拉取、按 requestId 去重、结果落本地缓存，作为「客户端消耗」之外的
 * 另一独立对照口径。
 *
 * 关键约束（均经实测确认，非文档声明）：
 *  - 认证头 X-Enterprise-Id 传空字符串即可（实测 HTTP 200 / code 0）。
 *  - 日期跨度：startTime~endTime 超过 32 天会静默返回空（HTTP 200 + code 0 + total 0），
 *    因此必须用「单日滑窗」逐日扫描，绝不可用宽区间。
 *  - total 字段不可信：随区间与 pageSize 变化，不能作为翻页终止条件。
 *  - requestTime 为北京时间（CST），按时间倒序返回。
 *  - 返回体含 input 字段（完整请求正文），绝不落盘。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const auth = require('../auth');
const wbAuth = require('../workbuddy/auth');
const { writeJsonAtomic } = require('../lib/atomic-write');
const { stateDir, legacyStateDir } = require('../lib/paths');

const BASE_PATH = '/billing/meter/get-user-request-usage';
const PAGE_SIZE = 3000;
const SCAN_DAYS = 30;
const CACHE_VERSION = 1;
const ROUND2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);

// 读优先新位置，旧位置兜底；写入固定新目录（缓存可重建，不做逐文件迁移）
function cacheDir() {
  const fresh = path.join(stateDir(), 'official-usage-cache');
  if (fs.existsSync(fresh)) return fresh;
  const legacy = path.join(legacyStateDir(), 'official-usage-cache');
  return fs.existsSync(legacy) ? legacy : fresh;
}

function writeCacheDir() {
  return path.join(stateDir(), 'official-usage-cache');
}

async function postUsage(acct, info, startTime, endTime) {
  const base = wbAuth.billingBase(wbAuth.regionOf(info.host || acct.host));
  const headers = wbAuth.authHeaders(info, { Origin: base, Referer: base + '/' });
  const url = base + BASE_PATH;
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify({ startTime, endTime, pageNum: 1, pageSize: PAGE_SIZE }));
    req.end();
  });
}

/** 归一化账单行：只保留 credit/model/requestId/requestTime，并按 requestId 去重。 */
function normalizeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const x of Array.isArray(rows) ? rows : []) {
    if (!x || typeof x !== 'object') continue;
    const rid = x.requestId || `${x.requestTime}-${x.model}`;
    if (seen.has(rid)) continue;
    seen.add(rid);
    out.push({
      requestId: rid,
      model: x.model || 'unknown',
      credit: ROUND2(Number(x.credit) || 0),
      requestTime: x.requestTime || null,
    });
  }
  return out;
}

/** 最近 N 天的本地日期键（新→旧）。 */
function recentDayKeys(days, now = new Date()) {
  const keys = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return keys;
}

/** 单日扫描：返回该日去重后的账单行（只保留 credit/model/requestId/requestTime）。 */
async function scanDay(acct, info, dayKey) {
  const start = `${dayKey} 00:00:00`;
  const end = `${dayKey} 23:59:59`;
  const r = await postUsage(acct, info, start, end);
  if (r.status !== 200 || !r.json || r.json.code !== 0) {
    return { ok: false, reason: `HTTP ${r.status} code=${r.json && r.json.code} ${r.json && r.json.msg || ''}`.trim(), rows: [] };
  }
  const rows = (r.json.data && r.json.data.data) || [];
  return { ok: true, rows: normalizeRows(rows) };
}

function readCache(acctId, dayKey) {
  try {
    const f = path.join(cacheDir(), `${acctId}-${dayKey}.json`);
    if (!fs.existsSync(f)) return null;
    const raw = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if (!raw || raw.version !== CACHE_VERSION) return null;
    return raw.rows;
  } catch {
    return null;
  }
}

function writeCache(acctId, dayKey, rows) {
  writeJsonAtomic(path.join(writeCacheDir(), `${acctId}-${dayKey}.json`), { version: CACHE_VERSION, rows }, { newline: false });
}

/**
 * 扫描某账号最近 N 天（默认 30）的官方账单，按日聚合 credit。
 * @returns {{accountId,label,days,available,error,credit:number,requests:number,byDay:Array,byModel:Array,byTier:object}}
 */
async function scanAccount(acctId, days = SCAN_DAYS) {
  const acct = auth.activeAccounts().find((a) => a.id === acctId);
  if (!acct || acct.edition !== 'workbuddy') {
    return { accountId: acctId, label: acct && acct.label || acctId, days, available: false, error: 'not a workbuddy account', credit: 0, requests: 0, byDay: [], byModel: [], byTier: {} };
  }
  let ensured;
  try {
    ensured = await auth.ensureAuth(acctId);
  } catch (e) {
    return { accountId: acctId, label: acct.label, days, available: false, error: e.message, credit: 0, requests: 0, byDay: [], byModel: [], byTier: {} };
  }
  const info = { accessToken: ensured.token, uid: ensured.userId, host: ensured.host, region: wbAuth.regionOf(ensured.host || acct.host) };

  const dayKeys = recentDayKeys(days);

  const byDay = [];
  const byModel = {};
  let totalCredit = 0;
  let totalReq = 0;
  let anyError = null;

  // 单日一次请求，30 天串行约 30 次往返；用有限并发压到数秒，同时避免触发上游限流
  const CONCURRENCY = 5;
  const dayRows = new Map();
  let cursor = 0;
  const worker = async () => {
    while (cursor < dayKeys.length) {
      const dayKey = dayKeys[cursor++];
      const cachedRows = readCache(acctId, dayKey);
      if (cachedRows) { dayRows.set(dayKey, { rows: cachedRows, fromCache: true }); continue; }
      const res = await scanDay(acct, info, dayKey);
      if (!res.ok) {
        anyError = anyError || res.reason;
        dayRows.set(dayKey, { rows: [], fromCache: false, failed: true });
      } else {
        writeCache(acctId, dayKey, res.rows);
        dayRows.set(dayKey, { rows: res.rows, fromCache: false });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dayKeys.length) }, worker));

  for (const dayKey of dayKeys) {
    const entry = dayRows.get(dayKey) || { rows: [], fromCache: false };
    const rows = entry.rows;
    let dayCredit = 0;
    for (const row of rows) {
      dayCredit += row.credit;
      totalCredit += row.credit;
      totalReq++;
      const m = byModel[row.model] || (byModel[row.model] = { model: row.model, requests: 0, credit: 0 });
      m.requests++; m.credit = ROUND2(m.credit + row.credit);
    }
    // 失败的日不写 0，避免把「没取到」呈现成「消耗为 0」
    if (!entry.failed) {
      byDay.push({ date: dayKey, requests: rows.length, credit: ROUND2(dayCredit) });
    }
  }

  return {
    accountId: acctId,
    label: acct.label || acctId,
    days,
    available: !anyError || byDay.length > 0,
    error: anyError,
    credit: ROUND2(totalCredit),
    requests: totalReq,
    byDay: byDay.sort((a, b) => b.date.localeCompare(a.date)),
    byModel: Object.values(byModel).sort((a, b) => b.credit - a.credit),
    byTier: { workbuddy: { credit: ROUND2(totalCredit), requests: totalReq } },
    cached: true,
  };
}

/** 扫描全部 workbuddy 账号并汇总。 */
async function scanAll(days = SCAN_DAYS) {
  const accts = auth.activeAccounts().filter((a) => a.edition === 'workbuddy');
  const results = [];
  for (const a of accts) results.push(await scanAccount(a.id, days));
  return { object: 'official_usage', days, accounts: results };
}

function clearCache() {
  try {
    // 两处都清，避免旧目录残留继续被读取
    fs.rmSync(writeCacheDir(), { recursive: true, force: true });
    fs.rmSync(path.join(legacyStateDir(), 'official-usage-cache'), { recursive: true, force: true });
    return true;
  } catch { return false; }
}

module.exports = { scanAccount, scanAll, clearCache, cacheDir, writeCacheDir, normalizeRows, recentDayKeys, SCAN_DAYS, CACHE_VERSION };
