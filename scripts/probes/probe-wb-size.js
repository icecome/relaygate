'use strict';
/**
 * ⚠️ 会打真实上游并**消耗真实账号积分**（每次 max_tokens=1，费用极小但非零）。
 * 仅在需要取证时手动运行，不要放进定时任务或 CI。
 *
 * scripts/probes/probe-wb-size.js —— 11128 的「体量 × 头集」二维探测。
 *
 * 现象回顾：2026-10-21 09:59–10:00 的 12 次 11128 全部是
 *   virtualModel=vm/long-context、toolsIn=42、耗时 380–500ms（上游前置闸门，未进推理）。
 * 第一轮已证明：小请求无论新旧头集都过。于是怀疑闸门按「体量」或「头集 × 体量」触发。
 *
 * 本脚本固定 42 工具，扫输入体量 1k → 400k 字符，分别用
 *   legacy（当前线上 authHeaders）
 *   modern（桌面客户端 app.asar 还原出的头集）
 * 各打一次，观察 11128 是否只在某一档出现。
 *
 * 用法：node scripts/probes/probe-wb-size.js [legacy|modern]
 */
const crypto = require('crypto');
const store = require('../../src/credentials/store');

const HOST = 'https://copilot.tencent.com';
const PATH = '/v2/chat/completions';
const APP_VERSION = '5.8.3';
const CLI_VERSION = '2.63.2';
const randHex = (n) => crypto.randomBytes(n / 2).toString('hex');
const uuid = () => crypto.randomUUID();

const TOOL_NAMES = Array.from({ length: 42 }, (_, i) => 'Tool' + i);
const TOOLS = TOOL_NAMES.map((n) => ({
  type: 'function',
  function: { name: n, description: n, parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } },
}));

function legacyHeaders(info) {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + info.token,
    'User-Agent': 'CLI/' + CLI_VERSION + ' CodeBuddy/' + CLI_VERSION,
    'X-Requested-With': 'XMLHttpRequest',
    'X-User-Id': info.uid,
    'X-Enterprise-Id': '',
    'X-Domain': 'copilot.tencent.com',
    'X-Product': 'SaaS',
    'X-Client-Platform': 'web',
    Origin: 'https://www.codebuddy.cn',
    Referer: 'https://www.codebuddy.cn/',
  };
}

function modernHeaders(info) {
  const t = randHex(32); const s = randHex(16); const p = randHex(16);
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + info.token,
    'User-Agent': `WorkBuddy/${APP_VERSION} WorkBuddy/${APP_VERSION} CLI/${CLI_VERSION}`,
    'x-requested-with': 'XMLHttpRequest',
    'X-User-Id': info.uid,
    'X-Domain': 'copilot.tencent.com',
    'X-Product': 'SaaS',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': APP_VERSION,
    'X-Private-Data': 'true',
    'x-codebuddy-request': '1',
    'X-Conversation-ID': uuid(),
    'X-Conversation-Request-ID': uuid(),
    'X-Conversation-Message-ID': uuid(),
    'X-Request-ID': uuid(),
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    traceparent: `00-${t}-${s}-01`,
    b3: `${t}-${s}-1-${p}`,
    'X-B3-TraceId': t,
    'X-B3-SpanId': s,
    'X-B3-ParentSpanId': p,
    'X-B3-Sampled': '1',
    'X-Trace-ID': t,
  };
}

const SIZES = [1000, 20000, 60000, 100000, 150000, 300000, 400000];

async function probe(headers, info, model, size) {
  const body = JSON.stringify({
    model,
    stream: true,
    max_tokens: 1,
    tools: TOOLS,
    tool_choice: 'auto',
    messages: [
      { role: 'system', content: 'y'.repeat(size) },
      { role: 'user', content: 'ping' },
    ],
  });
  const t0 = Date.now();
  try {
    const r = await fetch(HOST + PATH, { method: 'POST', headers: headers(info), body });
    const text = await r.text().catch(() => '');
    let code = null; let msg = '';
    try { const j = JSON.parse(text); code = j.code ?? null; msg = j.msg || ''; } catch { /* SSE */ }
    return { ok: r.status === 200, status: r.status, code, msg: String(msg).slice(0, 80), ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, code: null, msg: e.message, ms: Date.now() - t0 };
  }
}

(async () => {
  const mode = process.argv[2] || 'both';
  const acct = store.list().find((a) => a.enabled && a.edition === 'workbuddy');
  const full = store.get(acct.id);
  const info = { token: full.token, uid: full.userId };
  const model = process.env.WB_MODEL || 'deepseek-v4.1-flash';
  console.log(`账号 ${acct.label} model=${model} 42 工具\n`);
  const sets = mode === 'legacy' ? [['legacy', legacyHeaders]] : mode === 'modern' ? [['modern', modernHeaders]] : [['legacy', legacyHeaders], ['modern', modernHeaders]];
  for (const [name, fn] of sets) {
    for (const size of SIZES) {
      const r = await probe(fn, info, model, size);
      console.log(name.padEnd(7), String(size).padStart(7) + '字符', r.ok ? 'OK  ' : 'FAIL',
        'http=' + String(r.status).padEnd(3), 'code=' + String(r.code).padEnd(6), String(r.ms + 'ms').padEnd(8), r.ok ? '' : '| ' + r.msg);
      await new Promise((x) => setTimeout(x, 800));
    }
  }
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
