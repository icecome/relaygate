'use strict';
// 只读探测：用本机 Raccoon 客户端自己的 token 复放它的运营面请求，
// 逐条验证静态分析得到的接口与鉴权口径。默认不做任何写操作（POST 领取需 --grant）。
// node scripts/probe-raccoon-api.js [--grant] [--raw]
const fs = require('fs');
const path = require('path');

const BASE = 'https://xiaohuanxiong.com';
const AUTH_DIR = 'C:\\Users\\bing\\.box-agent\\config';
const args = process.argv.slice(2);
const doGrant = args.includes('--grant');

function readAuth() {
  const p = path.join(AUTH_DIR, 'auth.json');
  if (!fs.existsSync(p)) throw new Error(`no auth.json at ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function jwtExp(t) {
  try {
    const p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(p.padEnd(Math.ceil(p.length / 4) * 4, '='), 'base64').toString('utf8'));
  } catch { return null; }
}

const auth = readAuth();
const token = auth.access_token;
const claims = jwtExp(token);
const now = Math.floor(Date.now() / 1000);
console.log('== token ==');
console.log(`  sub=${claims?.sub} iss=${claims?.iss}`);
console.log(`  nbf=${claims?.nbf} exp=${claims?.exp}  valid=${claims && now > claims.nbf && now < claims.exp}`);
console.log(`  ttl_hours=${claims ? ((claims.exp - now) / 3600).toFixed(1) : 'n/a'}`);
console.log(`  lifetime_hours=${claims ? ((claims.exp - claims.nbf) / 3600).toFixed(1) : 'n/a'}`);
console.log('');

// 客户端 createHeaders() 的实际形态（从 asar 里 20616 模块还原）
function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Org-Code': '',
    'X-Raccoon-Language': 'zh',
    'X-Client-Platform': 'desktop-windows',
    'X-Client-Version': 'v1.0.38',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Raccoon/1.0.38',
    ...extra,
  };
}

async function call(label, method, url, { body, headers: h } = {}) {
  const t0 = Date.now();
  let res, text, status;
  try {
    res = await fetch(url, { method, headers: headers(h), body: body ? JSON.stringify(body) : undefined });
    status = res.status;
    text = await res.text();
  } catch (e) {
    console.log(`[${label}] ${method} ${url}\n  ERROR ${e.message} (${Date.now() - t0}ms)\n`);
    return null;
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  const shown = json ? JSON.stringify(json, null, 0) : text;
  console.log(`[${label}] ${method} ${url} -> ${status} (${Date.now() - t0}ms)`);
  console.log('  ' + (shown.length > 2000 ? shown.slice(0, 2000) + ' …[TRUNC]' : shown));
  console.log('');
  return json ?? { _status: status, _raw: text };
}

(async () => {
  const results = {};

  results.balance = await call('points.balance', 'GET', `${BASE}/api/web/points/v1/balance`);
  results.bills_all = await call('points.bills?type=all', 'GET', `${BASE}/api/web/points/v1/bills?paging.limit=50&type=all`);
  results.userinfo = await call('auth.user_info', 'GET', `${BASE}/api/web/auth/v1/user_info`);
  results.catalog = await call('llm.model_catalog', 'GET', `${BASE}/api/web/llm/v2/model_catalog`);

  // 静态分析里发现的「活动/在线运营」面 —— 参考项目完全没有这一段
  results.activities = await call('online_activities', 'GET', `${BASE}/online_activities`);
  results.qualification = await call('activity.qualification', 'GET', `${BASE}/online_activities/qualification`);

  // 每日发放：账单里 daily_grant 是否有独立端点？枚举候选路径（GET，无副作用）
  const candidates = [
    '/api/web/points/v1/daily',
    '/api/web/points/v1/daily/claim',
    '/api/web/points/v1/claim',
    '/api/web/points/v1/receive',
    '/api/web/points/v1/tasks',
    '/api/web/points/v1/task/list',
    '/api/web/points/v1/sign_in',
    '/api/web/points/v1/signin',
    '/api/web/points/v1/check_in',
    '/api/web/points/v1/checkin',
    '/api/web/points/v1/daily_points',
    '/api/web/points/v1/records',
    '/api/web/points/v1/transactions',
    '/api/web/points/v1/entitlement',
    '/api/web/desktop/v1/points/grant',
    '/api/web/desktop/v1/daily/points/grant',
    '/api/web/desktop/v1/checkin',
    '/api/web/desktop/v1/sign_in',
  ];
  console.log('== 签到端点候选探测（GET，无副作用）==');
  for (const c of candidates) {
    const r = await call('GET ' + c, 'GET', `${BASE}${c}`, { body: undefined });
    const code = r?.code ?? r?.data?.code;
    // 404 vs 401 vs 业务码 的区分本身就说明端点是否存在
    console.log(`     status=${r?._status ?? r?.status ?? code} msg=${(r?._raw || r?.message || r?.msg || '').toString().slice(0, 80)}`);
  }

  if (doGrant) {
    results.grant = await call('desktop.login.points.grant', 'POST',
      `${BASE}/api/web/desktop/v1/login/points/grant`, { headers: { 'X-Client-Platform': 'desktop-windows', 'X-Client-Version': 'v1.0.38' } });
  } else {
    console.log('== 跳过 POST login/points/grant（加 --grant 才执行，它会真实领取奖励）==\n');
  }

  fs.writeFileSync(path.join(__dirname, '..', '..', 'logs', 'raccoon-api-probe.json'),
    JSON.stringify({ at: new Date().toISOString(), token: { sub: claims?.sub, exp: claims?.exp, nbf: claims?.nbf }, results }, null, 2));
  console.log('saved -> logs/raccoon-api-probe.json');
})();
