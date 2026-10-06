'use strict';
/**
 * upstream/trae-usage.js — Trae 会话级用量明细（精确积分来源，Trae 侧）。
 *
 * 端点：POST {ug}/trae/api/v1/pay/query_user_usage_group_by_session
 * （v1，非 v2 —— v2 实测 404；与 WorkBuddy 的逐请求账单对位，
 *  但 Trae 粒度是「逐会话聚合」：一行 = 一次完整会话的积分与 token 汇总。）
 *
 * 请求契约（2026-10 池内 8 个账号实测，与多个开源实现交叉印证）：
 *   body: { start_time, end_time, page_size, page_num, usage_type: [7] }
 *   - usage_type [7] = Cloud-IDE 会话积分口径（对齐官网控制台）
 *   - page_size 上限 50（实测 50 返 200；100/200/500 均 400 code=9004）
 *   - 时间区间可超过 30 天（60 天实测 200），故按日分块仅为归集与缓存，
 *     不受上游区间上限约束
 *   - 响应根直接是 { total, user_usage_group_by_sessions: [...] }（无 data 包裹）
 *
 * 数据滞后（实测）：部分账号的最新记录停在 10-04，另一些到 10-06。
 * 上游按会话聚合落库，非实时；单日返回 0 可能是「当天确实无会话」，
 * 也可能是「尚未入账」，本模块不做补期推断，只如实呈现。
 *
 * 行字段：session_id / usage_time(unix秒,北京时间语义) / model_name(展示名) /
 *   credits_float(积分) / amount_float(同 credits) / cost_money_float(金额) /
 *   extra_info{input_token,output_token,cache_read_token,cache_write_token} /
 *   usage_group_details[](按模型拆分)
 *
 * 鉴权头要求（关键坑）：Web 控制台形态 —— 浏览器 UA + Origin/Referer: www.trae.cn，
 * 不带 IDE 客户端指纹头（x-device-id 等）。与 lib/headers.js 的 buildCommonHeaders
 * 不同，这里单独组装。
 */
const fs = require('fs');
const path = require('path');
const auth = require('../auth');
const credStore = require('../credentials/store');
const variant = require('../platform/variant');
const { writeJsonAtomic } = require('../lib/atomic-write');
const { stateDir, legacyStateDir } = require('../lib/paths');
const { round4 } = require('../lib/round');

const API_PATH = variant.variantOf(variant.TRAE).paths.sessionUsage;
/** 实测上限 50：50 返 200，100 及以上 400 code=9004。 */
const PAGE_SIZE = 50;
const CACHE_VERSION = 1;
/** usage_type=7：Cloud-IDE 会话积分口径。 */
const USAGE_TYPE_CHAT = [7];
const TIMEOUT_MS = 20000;

function ugHost() {
  if (process.env.TRAE_UG_HOST) return process.env.TRAE_UG_HOST.replace(/\/$/, '');
  return variant.variantOf(variant.TRAE).hosts.ug;
}

/** Web 控制台形态头。缺一可能被拒（社区实测 400/9004），勿改为 IDE 指纹头。 */
function webHeaders(token, userId) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    Authorization: `Cloud-IDE-JWT ${token}`,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    origin: 'https://www.trae.cn',
    referer: 'https://www.trae.cn/',
    'x-uid': userId || '',
  };
}

async function postUsage(acct, body) {
  const url = ugHost() + API_PATH;
  const resp = await fetch(url, {
    method: 'POST',
    headers: webHeaders(acct.token, acct.userId),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 保留 null */ }
  return { status: resp.status, json, text };
}

/**
 * 归一化一行会话用量。只保留计费相关字段；input_preview 不落盘（隐私）。
 * token 缺失时置 0，不虚报。
 */
function normalizeRow(x) {
  if (!x || typeof x !== 'object') return null;
  const sid = x.session_id || null;
  if (!sid) return null;
  const ex = x.extra_info && typeof x.extra_info === 'object' ? x.extra_info : {};
  const detailRows = Array.isArray(x.usage_group_details) ? x.usage_group_details : [];
  // usage_group_details 按模型拆分（一行会话可能含多模型调用）；无拆分时回退行级
  // credits 精度为 4 位（实测 1.5324）；cost_money 为 5 位（0.03831）。
  // 用 round2 会把单会话金额抹掉近 3 个数量级的尾数，故统一 round4。
  const byModel = detailRows.length
    ? detailRows.map((d) => ({
      model: String((d && (d.model_display_name || d.model_name)) || x.model_name || 'unknown'),
      credits: round4(Number(d && (d.credits_float ?? d.amount_float)) || 0),
    }))
    : [{ model: String(x.model_name || 'unknown'), credits: round4(Number(x.credits_float ?? x.amount_float) || 0) }];
  return {
    sessionId: sid,
    usageTime: Number(x.usage_time) || 0,
    credits: round4(Number(x.credits_float ?? x.amount_float) || 0),
    costMoney: round4(Number(x.cost_money_float) || 0),
    inputTokens: Number(ex.input_token) || 0,
    outputTokens: Number(ex.output_token) || 0,
    cacheReadTokens: Number(ex.cache_read_token) || 0,
    cacheWriteTokens: Number(ex.cache_write_token) || 0,
    modelName: String(x.model_name || 'unknown'),
    byModel,
  };
}

/** 单页拉取（含翻页）。返回去重后的会话行。 */
async function fetchRange(acct, startTime, endTime, { onPage } = {}) {
  const seen = new Set();
  const rows = [];
  let page = 1;
  for (;;) {
    const r = await postUsage(acct, {
      start_time: Math.floor(startTime),
      end_time: Math.floor(endTime),
      page_size: PAGE_SIZE,
      page_num: page,
      usage_type: USAGE_TYPE_CHAT,
    });
    if (r.status !== 200) {
      throw new Error(`session usage failed: HTTP ${r.status} ${String(r.text || '').slice(0, 120)}`);
    }
    const list = (r.json && (r.json.user_usage_group_by_sessions || (r.json.data && r.json.data.user_usage_group_by_sessions))) || [];
    if (!list.length) break;
    for (const raw of list) {
      const row = normalizeRow(raw);
      if (row && !seen.has(row.sessionId + ':' + row.usageTime)) {
        seen.add(row.sessionId + ':' + row.usageTime);
        rows.push(row);
      }
    }
    if (onPage) onPage(page, list.length);
    // 不满页即最后一页（total 字段实测为全量行数但不可靠，用行数判定）
    if (list.length < PAGE_SIZE) break;
    page += 1;
    if (page > 100) break; // 防御：50*100=5000 行封顶，避免异常响应导致死循环
  }
  return rows;
}

// ---- 日缓存（与 WorkBuddy billing-usage 同构；今天不缓存，历史日落盘） ----

function cacheDir() {
  const fresh = path.join(stateDir(), 'trae-usage-cache');
  if (fs.existsSync(fresh)) return fresh;
  const legacy = path.join(legacyStateDir(), 'trae-usage-cache');
  return fs.existsSync(legacy) ? legacy : fresh;
}

function writeCacheDir() {
  return path.join(stateDir(), 'trae-usage-cache');
}

/** 本地日界（北京时间语义按服务器本地时区；usage_time 为 unix 秒）。 */
function dayBounds(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const start = Math.floor(new Date(y, m - 1, d).getTime() / 1000);
  return { start, end: start + 86400 };
}

function recentDayKeys(days, now = new Date()) {
  const keys = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return keys;
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
 * 扫描单账号最近 N 天的会话用量。
 * 历史日命中缓存；今天与缓存缺失的日走上游。
 * @returns {{accountId,label,days,available,error,credit,requests,tokens,byDay,byModel,cached}}
 */
async function scanAccount(acctId, days = 30) {
  const stored = credStore.get(acctId);
  if (!stored) {
    return { accountId: acctId, label: acctId, days, available: false, error: 'account not found', credit: 0, requests: 0, tokens: 0, byDay: [], byModel: [] };
  }
  let ensured;
  try {
    ensured = await auth.ensureAuth(acctId);
  } catch (e) {
    return { accountId: acctId, label: stored.label || acctId, days, available: false, error: e.message, credit: 0, requests: 0, tokens: 0, byDay: [], byModel: [] };
  }
  const acct = { ...stored, ...ensured };
  const dayKeys = recentDayKeys(days);
  const byDay = [];
  const byModel = {};
  let totalCredit = 0;
  let totalReq = 0;
  let totalTokens = 0;
  let anyError = null;

  for (const dayKey of dayKeys) {
    const isToday = dayKey === recentDayKeys(1)[0];
    let rows = null;
    let failed = false;
    if (!isToday) rows = readCache(acctId, dayKey);
    if (!rows) {
      const { start, end } = dayBounds(dayKey);
      try {
        rows = await fetchRange(acct, start, end);
        // 空日不落盘：上游按会话聚合入账存在滞后（实测部分账号最新记录停在
        // 数天前），把「暂时没入账」缓存成 0 会让该日永久失真。
        // 代价是真正无消耗的日会被重复查询（每日一次请求，可接受）。
        if (!isToday && rows.length) writeCache(acctId, dayKey, rows);
      } catch (e) {
        anyError = anyError || e.message;
        failed = true;
      }
    }
    // 失败的日不写 0，避免把「没取到」呈现成「消耗为 0」
    if (failed) continue;
    let dayCredit = 0;
    let dayTokens = 0;
    for (const row of rows) {
      dayCredit += row.credits;
      totalCredit += row.credits;
      totalReq++;
      dayTokens += row.inputTokens + row.outputTokens;
      totalTokens += row.inputTokens + row.outputTokens;
      for (const bm of row.byModel) {
        const m = byModel[bm.model] || (byModel[bm.model] = { model: bm.model, requests: 0, credits: 0 });
        m.requests++;
        m.credits = round4(m.credits + bm.credits);
      }
    }
    byDay.push({ date: dayKey, requests: rows.length, credit: round4(dayCredit), tokens: dayTokens });
  }

  return {
    accountId: acctId,
    label: stored.label || acctId,
    days,
    available: !anyError || byDay.length > 0,
    error: anyError,
    credit: round4(totalCredit),
    requests: totalReq,
    tokens: totalTokens,
    byDay: byDay.sort((a, b) => b.date.localeCompare(a.date)),
    byModel: Object.values(byModel).sort((a, b) => b.credits - a.credits),
    cached: true,
  };
}

/** 扫描全部启用 Trae 账号并汇总。 */
async function scanAll(days = 30) {
  const accounts = credStore.list().filter((a) => a.enabled && a.edition !== 'workbuddy');
  const results = [];
  for (const a of accounts) results.push(await scanAccount(a.id, days));
  return { object: 'trae_session_usage', days, accounts: results };
}

function clearCache() {
  try {
    fs.rmSync(writeCacheDir(), { recursive: true, force: true });
    fs.rmSync(path.join(legacyStateDir(), 'trae-usage-cache'), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  scanAccount,
  scanAll,
  clearCache,
  cacheDir,
  normalizeRow,
  fetchRange,
  recentDayKeys,
  dayBounds,
  API_PATH,
  PAGE_SIZE,
  CACHE_VERSION,
};
