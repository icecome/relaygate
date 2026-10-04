'use strict';
/**
 * workbuddy/auth.js — WorkBuddy（腾讯 CodeBuddy 系）认证与账号接入。
 *
 * 凭据来源（对标 trae 的 storage.json 抓取）：
 *   桌面客户端登录态为明文 JSON：
 *   %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
 *   结构：{ account:{uid,nickname,phoneNumber,...}, auth:{accessToken, refreshToken,
 *          expiresIn(60d), refreshExpiresIn(90d), expiresAt(ms), domain} }
 *
 * 上游（规格对齐 TraeWorkAssistant workbuddy-product-design.md）：
 *   - chat:        POST {chatHost}/v2/chat/completions（OpenAI 兼容 SSE）
 *   - 刷新:        POST https://www.codebuddy.cn/v2/plugin/auth/token/refresh（X-Refresh-Token 头，空体 {}）
 *   - 余额/验证:   POST {billingBase}/billing/meter/get-user-resource-summary
 *   统一认证头：Authorization Bearer + UA "CLI/2.63.2 CodeBuddy/2.63.2" + X-Requested-With +
 *   X-User-Id + X-Enterprise-Id + X-Domain + X-Product: SaaS + X-Client-Platform: web
 *   红线：chat 请求绝不携带 X-Refresh-Token。
 *
 * SSRF 防御：所有上游 URL 由「区域枚举（cn|global）→ 常量映射」生成，
 * 用户输入最多选择区域，永不直接参与 URL 拼接。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const variant = require('../platform/variant');

const WB_HOSTS = variant.variantOf(variant.WORKBUDDY).hosts;
const WB_IDENTITY = variant.variantOf(variant.WORKBUDDY).identity;
const WB_ERR = variant.variantOf(variant.WORKBUDDY).errors;

const DEFAULT_AUTH_DIR = path.join(process.env.LOCALAPPDATA || '', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
const AUTH_FILE_NAME = 'workbuddy-desktop.info';
const UA = process.env.WB_UA || WB_IDENTITY.userAgent;
const REFRESH_URL = WB_HOSTS.tokenRefresh;

// 常量映射表（全部字面量；region 仅允许 'cn' | 'global'）
const CHAT_HOSTS = WB_HOSTS.chat;
const BILLING_BASES = WB_HOSTS.billing;
const DOMAINS = WB_HOSTS.domain;

/** 由 domain/host 字符串推导区域枚举（无法识别时归为 cn）。
 *  region 判定与规范化统一取自 platform/variant（平台差异单一事实源），
 *  本地不再各写一份，避免与 Trae 侧的判定口径分叉。 */
const regionOf = variant.regionOf;
const validRegion = variant.validRegion;

/** 定位桌面端 auth 文件：优先主文件，否则取最新的轮转备份。 */
function locateAuthFile() {
  const main = path.join(DEFAULT_AUTH_DIR, AUTH_FILE_NAME);
  if (fs.existsSync(main)) return main;
  if (!fs.existsSync(DEFAULT_AUTH_DIR)) return null;
  const candidates = fs.readdirSync(DEFAULT_AUTH_DIR)
    .filter((f) => f.startsWith('workbuddy-desktop.') && f.endsWith('.info'))
    .map((f) => {
      const full = path.join(DEFAULT_AUTH_DIR, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return candidates.length ? candidates[0].full : null;
}

/** 读取并归一化 auth 文件（region 为枚举）。
 *  新版桌面客户端将 accessToken/refreshToken 存为 {$wbEncrypted:1, envelope} 加密对象，
 *  本项目无法解密——这类字段归一化为 null，避免垃圾值流进请求头或账号库。 */
function plainToken(v) {
  return (typeof v === 'string' && v && !v.startsWith('[object')) ? v : null;
}

function readAuthFile(filePath) {
  const file = filePath || locateAuthFile();
  if (!file || !fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const acc = raw.account || {};
  const auth = raw.auth || {};
  const accessToken = plainToken(auth.accessToken);
  const refreshToken = plainToken(auth.refreshToken);
  if (!accessToken && !refreshToken) return null;
  return {
    file,
    uid: acc.uid || null,
    nickname: plainToken(acc.nickname) || null,
    phoneNumber: acc.phoneNumber || null,
    uin: acc.uin || null,
    accessToken,
    refreshToken,
    expiresAtMs: auth.expiresAt || (auth.expiresIn ? Date.now() + auth.expiresIn * 1000 : null),
    refreshExpiresAtMs: auth.refreshExpiresIn ? Date.now() + auth.refreshExpiresIn * 1000 : null,
    region: regionOf(auth.domain),
  };
}

/** chat 上游 base（存入账号 host 字段）。 */
function chatHost(region) {
  return variant.hostFor(CHAT_HOSTS, validRegion(region));
}

/** 计费/验证 base。 */
function billingBase(region) {
  return variant.hostFor(BILLING_BASES, validRegion(region));
}

/** 统一认证头。extra 用于追加（如 X-Refresh-Token）。 */
function authHeaders(info, extra) {
  const r = validRegion(info.region);
  const domain = variant.hostFor(DOMAINS, r);
  const base = variant.hostFor(BILLING_BASES, r);
  return Object.assign({
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + String(info.accessToken || '').slice(0, 4096),
    'User-Agent': UA,
    'X-Requested-With': 'XMLHttpRequest',
    'X-User-Id': String(info.uid || '').slice(0, 64),
    'X-Enterprise-Id': '',
    'X-Domain': domain,
    'X-Product': 'SaaS',
    'X-Client-Platform': 'web',
    'Origin': base,
    'Referer': base + '/',
  }, extra || {});
}

/** 底层请求（仅 https），返回 {status, json, text}。 */
function request(url, options) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, Object.assign({ method: 'POST' }, options), (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch (e) { /* 非 JSON 保留原文 */ }
        resolve({ status: res.statusCode, json, text: d.slice(0, 500) });
      });
    });
    req.on('error', reject);
    if (options && options.body) req.write(options.body);
    req.end();
  });
}

/**
 * 验证账号有效性并返回余额摘要（登录验证 + 余额一体）。
 * 端点：POST {billingBase}/billing/meter/get-user-resource-summary。
 */
async function verify(info) {
  const url = billingBase(validRegion(info.region)) + '/billing/meter/get-user-resource-summary';
  const r = await request(url, {
    headers: authHeaders(info, { 'X-Client-Platform': 'web' }),
    body: JSON.stringify({}),
  });
  if (r.status === 401 || r.status === 403) {
    return { valid: false, reason: 'token 无效或已过期（HTTP ' + r.status + '）' };
  }
  if (r.status !== 200 || !r.json) {
    return { valid: false, reason: '上游异常 HTTP ' + r.status + ' ' + (r.text || '').slice(0, 120) };
  }
  // 宽容解析：余额 = 各资源包剩余求和
  // 兼容形态：data.Packages[]（实测主形态，CycleRemainCapacity/CycleTotalCapacity）
  //           data.Accounts[].resources[].remaining（TWA 文档形态）
  const data = (r.json.data || r.json.Data || r.json) || {};
  const packagesRaw = data.Packages || data.packages || [];
  const accountsRaw = data.Accounts || (data.data && data.data.Accounts) || (data.Response && data.Response.Data && data.Response.Data.Accounts) || [];
  let remaining = 0;
  const resources = [];
  const num = (v) => { const n = v != null ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };
  for (const p of Array.isArray(packagesRaw) ? packagesRaw : []) {
    const rem = num(p.CycleRemainCapacity) != null ? num(p.CycleRemainCapacity) : num(p.remaining);
    const total = num(p.CycleTotalCapacity) != null ? num(p.CycleTotalCapacity) : num(p.CycleCapacitySizePrecise);
    if (rem != null) { remaining += rem; resources.push({ code: p.PackageCode || '', remaining: rem, total: total || null, unit: p.CapacityUnit || 'credits' }); }
  }
  for (const a of Array.isArray(accountsRaw) ? accountsRaw : []) {
    for (const p of Array.isArray(a.resources || a.Resources) ? (a.resources || a.Resources) : []) {
      const rem = num(p.remaining) != null ? num(p.remaining) : num(p.Remaining);
      if (rem != null) { remaining += rem; resources.push({ name: p.name || p.Name || '', remaining: rem }); }
    }
  }
  return { valid: true, balance: Math.round(remaining * 100) / 100, resources, region: validRegion(info.region), raw: r.json };
}

/**
 * 刷新 token：POST /v2/plugin/auth/token/refresh（X-Refresh-Token 头，空体 {}）。
 * 返回 {accessToken, refreshToken, expiresAt(ISO)}。
 */
async function refresh(refreshToken) {
  const headers = authHeaders({ region: 'cn' }, { 'X-Refresh-Token': String(refreshToken || '').slice(0, 4096) });
  delete headers.Authorization; // 刷新端点用 X-Refresh-Token，不带旧 Bearer
  const r = await request(REFRESH_URL, { headers, body: JSON.stringify({}) });
  const data = (r.json && r.json.data) || null;
  if (r.status !== 200 || !data || !(data.accessToken || data.access_token)) {
    const meta = (r.json && r.json.ResponseMetadata) || {};
    const msg = (r.json && r.json.message) || meta.Message || '';
    throw new Error(`刷新失败 HTTP ${r.status} ${msg}`.trim());
  }
  const accessToken = data.accessToken || data.access_token;
  const expiresIn = Number(data.expiresIn) || 5184000;
  return {
    accessToken,
    refreshToken: data.refreshToken || data.refresh_token || refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

/** 上游业务码：今日已签到（实测 HTTP 200 / code=10001）。 */
const CHECKIN_CODE_ALREADY = WB_ERR.alreadyCheckedIn[0];

/**
 * 每日签到状态（只读，不消耗签到次数）。
 * 端点：POST {billingBase}/v2/billing/meter/checkin-activity-status（体 {}）。
 * 客户端 buildHeaders 只需 accessToken/uid/domain；Turing 设备 token（X-Device-Token）
 * 为可选增强，缺失时后端按默认走（实测无该头同样 200）。
 * 返回 {checkedIn, streakDays, dailyCredit, todayCredit, totalCredits, dates, raw}。
 */
async function checkinStatus(info) {
  const url = billingBase(validRegion(info.region)) + '/v2/billing/meter/checkin-activity-status';
  const r = await request(url, { headers: authHeaders(info), body: '{}' });
  if (r.status === 401 || r.status === 403) {
    return { ok: false, reason: 'token 无效或已过期（HTTP ' + r.status + '）' };
  }
  if (r.status !== 200 || !r.json) {
    return { ok: false, reason: '上游异常 HTTP ' + r.status + ' ' + (r.text || '').slice(0, 120) };
  }
  if (r.json.code !== 0) {
    return { ok: false, reason: r.json.msg || ('上游返回 code ' + r.json.code), code: Number(r.json.code) || 0, raw: r.json };
  }
  const d = r.json.data || {};
  return {
    ok: true,
    active: !!d.active,
    checkedIn: !!d.today_checked_in,
    streakDays: d.streak_days ?? null,
    dailyCredit: d.daily_credit ?? null,
    todayCredit: d.today_credit ?? null,
    totalCredits: d.total_credits ?? null,
    dates: Array.isArray(d.checkin_dates) ? d.checkin_dates : [],
    themeName: d.theme_name || null,
    activityName: d.activity_name || null,
    season: d.season ?? null,
    endTime: d.end_time || null,
    raw: r.json,
  };
}

/**
 * 每日签到（真实领取）。端点：POST {billingBase}/v2/billing/meter/daily-checkin（体 {}）。
 * 成功判定：HTTP 200 且 code===0。code=10001 视为已签到（alreadyCheckedIn）。
 * 返回 {ok, credited, alreadyCheckedIn, code, reason, ...}。
 */
async function checkin(info) {
  const url = billingBase(validRegion(info.region)) + '/v2/billing/meter/daily-checkin';
  const r = await request(url, { headers: authHeaders(info), body: '{}' });
  if (r.status === 401 || r.status === 403) {
    return { ok: false, reason: 'token 无效或已过期（HTTP ' + r.status + '）', code: 0 };
  }
  if (r.status !== 200 && r.status !== 400 && !r.json) {
    return { ok: false, reason: '上游异常 HTTP ' + r.status + ' ' + (r.text || '').slice(0, 120), code: 0 };
  }
  const code = r.json && r.json.code != null ? Number(r.json.code) : 0;
  const msg = (r.json && (r.json.msg || r.json.message)) || '';
  if (code === CHECKIN_CODE_ALREADY || msg.includes('已签到')) {
    return {
      ok: false,
      alreadyCheckedIn: true,
      code,
      reason: msg || 'already checked in',
      raw: r.json,
    };
  }
  if (r.status !== 200 || !r.json || code !== 0) {
    return {
      ok: false,
      code,
      reason: msg || ('上游返回 code ' + code + ' / HTTP ' + r.status),
      raw: r.json,
    };
  }
  const d = r.json.data || {};
  return {
    ok: true,
    code,
    credited: d.today_credit ?? d.daily_credit ?? d.credit ?? null,
    streakDays: d.streak_days ?? null,
    totalCredits: d.total_credits ?? null,
    alreadyCheckedIn: d.today_checked_in === true,
    raw: r.json,
  };
}

/** 解析资源包到期时间（毫秒时间戳或 "YYYY-MM-DD HH:MM:SS"）。 */
function parseCycleTime(ts) {
  if (ts == null || ts === '') return null;
  const n = Number(ts);
  if (Number.isFinite(n) && n > 1e12) return n; // ms
  if (Number.isFinite(n) && n > 1e9) return n * 1000; // s
  const parsed = Date.parse(String(ts).replace(' ', 'T') + (/[zZ+]|\d{2}:\d{2}$/.test(String(ts)) ? '' : '+08:00'));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 查询资源包明细（含到期时间），供余额/临期展示。
 * 对齐网页端 plans-usage：summary 取 PackageCodes，free/paid 取包容量与 CycleEndTime。
 * 失败不抛错，返回空列表（不影响签到主流程）。
 */
async function fetchResourcePacks(info) {
  const base = billingBase(validRegion(info.region));
  const post = async (path, payload) => {
    const headers = authHeaders(info, {
      'Origin': base,
      'Referer': base + '/profile/plans-usage',
    });
    return request(base + path, { headers, body: JSON.stringify(payload || {}) });
  };

  const out = { packs: [], totalRemaining: 0 };
  try {
    const summary = await post('/billing/meter/get-user-resource-summary', {});
    if (summary.status !== 200 || !summary.json) return out;
    const data = summary.json.data || summary.json.Data || {};
    const codes = (data.Packages || data.packages || [])
      .map((p) => p && (p.PackageCode || p.packageCode))
      .filter(Boolean);
    if (!codes.length) return out;

    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date();
    dayEnd.setHours(23, 59, 59, 999);
    const fmt = (d) => d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0') + ':' +
      String(d.getSeconds()).padStart(2, '0');

    const slices = [
      ['/billing/meter/get-user-resource-free-packages', {
        PageNumber: 1, PageSize: 200, PackageCodes: codes, Status: [0, 3],
        SlicePeriodStartTime: fmt(dayStart), SlicePeriodEndTime: fmt(dayEnd),
      }],
      ['/billing/meter/get-user-resource-paid-packages', {
        PageNumber: 1, PageSize: 200, PackageCodes: codes, Status: [0, 3], NeedRenewInfo: true,
      }],
    ];

    const seen = new Set();
    for (const [path, payload] of slices) {
      try {
        const r = await post(path, payload);
        if (r.status !== 200 || !r.json) continue;
        const accounts = (r.json.data || r.json.Data || {}).Accounts || [];
        for (const a of accounts) {
          const id = a.AccountId || a.accountId;
          if (id != null && seen.has(id)) continue;
          if (id != null) seen.add(id);
          const expireMs = parseCycleTime(a.CycleEndTime || a.cycleEndTime);
          const remaining = a.CycleCapacityRemain != null
            ? Number(a.CycleCapacityRemain)
            : (a.remaining != null ? Number(a.remaining) : null);
          if (!Number.isFinite(remaining) || remaining <= 0) continue;
          const limit = a.CycleCapacitySize != null
            ? Number(a.CycleCapacitySize)
            : (a.CycleCapacitySizePrecise != null ? Number(a.CycleCapacitySizePrecise) : null);
          const pack = {
            name: a.PackageName || a.PackageCode || a.packageName || null,
            packId: id != null ? String(id) : null,
            expireTime: expireMs != null ? Math.floor(expireMs / 1000) : null,
            limit: Number.isFinite(limit) ? limit : null,
            used: Number.isFinite(limit) ? Math.max(limit - remaining, 0) : 0,
            remaining,
            unlimited: false,
          };
          out.packs.push(pack);
          out.totalRemaining += remaining;
        }
      } catch (e) {
        // 单包列表失败不阻断
      }
    }
  } catch (e) {
    // 资源查询失败不影响主流程
  }
  return out;
}

module.exports = {
  locateAuthFile,
  readAuthFile,
  regionOf,
  validRegion,
  authHeaders,
  chatHost,
  billingBase,
  verify,
  refresh,
  checkinStatus,
  checkin,
  fetchResourcePacks,
  parseCycleTime,
  CHECKIN_CODE_ALREADY,
  UA,
};
