'use strict';
/**
 * ⚠️ 会打真实上游并**消耗真实账号积分**（每次 max_tokens=1，费用极小但非零）。
 * 仅在需要取证时手动运行，不要放进定时任务或 CI。
 *
 * scripts/probes/probe-wb-burst.js —— 11128 是否为「突发风控」的验证。
 *
 * 12 次 11128 全部落在 84 秒窗口内、每次上游只花 380–500ms（前置闸门，未进推理），
 * 且 displayMsg 是「请求被拦截，请重新发送」。这更像风控/频控而不是头集校验。
 * 本脚本用并发突发（默认 20 路，带 42 工具）验证：若 11128 复现，即为频控触发。
 *
 * 用法：node scripts/probes/probe-wb-burst.js [并发数] [每轮请求数]
 */
const crypto = require('crypto');
const store = require('../../src/credentials/store');

const HOST = 'https://copilot.tencent.com';
const PATH = '/v2/chat/completions';
const APP = '5.8.3';
const CLI = '2.63.2';
const randHex = (n) => crypto.randomBytes(n / 2).toString('hex');
const uuid = () => crypto.randomUUID();

const TOOLS = Array.from({ length: 42 }, (_, i) => ({
  type: 'function',
  function: { name: 'Tool' + i, description: 'T' + i, parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } },
}));

function headers(info) {
  const t = randHex(32); const s = randHex(16); const p = randHex(16);
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + info.token,
    'User-Agent': `WorkBuddy/${APP} WorkBuddy/${APP} CLI/${CLI}`,
    'x-requested-with': 'XMLHttpRequest',
    'X-User-Id': info.uid,
    'X-Domain': 'copilot.tencent.com',
    'X-Product': 'SaaS',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': APP,
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

async function one(info, model, i) {
  const body = JSON.stringify({
    model,
    stream: true,
    max_tokens: 1,
    tools: TOOLS,
    tool_choice: 'auto',
    messages: [{ role: 'user', content: 'burst ' + i }],
  });
  const t0 = Date.now();
  try {
    const r = await fetch(HOST + PATH, { method: 'POST', headers: headers(info), body });
    const text = await r.text().catch(() => '');
    let code = null; let msg = '';
    try { const j = JSON.parse(text); code = j.code ?? null; msg = j.msg || ''; } catch { /* SSE */ }
    return { i, status: r.status, code, msg: String(msg).slice(0, 60), ms: Date.now() - t0 };
  } catch (e) {
    return { i, status: 0, code: null, msg: e.message, ms: Date.now() - t0 };
  }
}

(async () => {
  const conc = Number(process.argv[2] || 20);
  const rounds = Number(process.argv[3] || 2);
  const acct = store.list().find((a) => a.enabled && a.edition === 'workbuddy');
  const full = store.get(acct.id);
  const info = { token: full.token, uid: full.userId };
  const model = process.env.WB_MODEL || 'deepseek-v4.1-flash';
  console.log(`账号 ${acct.label} model=${model} 并发=${conc} 轮=${rounds}\n`);
  const all = [];
  for (let r = 0; r < rounds; r++) {
    const batch = await Promise.all(Array.from({ length: conc }, (_, i) => one(info, model, r * 100 + i)));
    all.push(...batch);
    const byStatus = batch.reduce((m, x) => { const k = x.status + '/' + x.code; m[k] = (m[k] || 0) + 1; return m; }, {});
    console.log(`round ${r}: ${JSON.stringify(byStatus)}`);
  }
  const codes = {};
  for (const x of all) { const k = String(x.code); codes[k] = (codes[k] || 0) + 1; }
  console.log('\n业务码分布:', JSON.stringify(codes));
  const bad = all.filter((x) => x.code === 11128);
  console.log('11128 命中:', bad.length);
  if (bad.length) console.log('样本:', JSON.stringify(bad.slice(0, 3)));
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
