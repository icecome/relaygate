'use strict';
/**
 * ⚠️ 会打真实上游并**消耗真实账号积分**（每次 max_tokens=1，费用极小但非零）。
 * 仅在需要取证时手动运行，不要放进定时任务或 CI。
 *
 * scripts/probes/probe-wb-matrix.js —— 模型 × 头集 矩阵：定位 11128 是否只落在特定模型/头集。
 *
 * 失败现场的候选全部是 WorkBuddy 侧模型（step-5-preview / glm-5.3-flash /
 * minimax-m3.1-flash / space-bunny / deepseek-v4.1-flash / mimo-v2.6-pro）。
 * 本脚本对这 6 个模型各打 2 种头集 × 2 次，输出业务码矩阵。
 *
 * 用法：node scripts/probes/probe-wb-matrix.js
 */
const crypto = require('crypto');
const store = require('../../src/credentials/store');

const HOST = 'https://copilot.tencent.com';
const PATH = '/v2/chat/completions';
const APP = '5.8.3';
const CLI = '2.63.2';
const randHex = (n) => crypto.randomBytes(n / 2).toString('hex');
const uuid = () => crypto.randomUUID();

const MODELS = ['step-5-preview', 'glm-5.3-flash', 'minimax-m3.1-flash', 'space-bunny', 'deepseek-v4.1-flash', 'mimo-v2.6-pro'];

const TOOLS = Array.from({ length: 42 }, (_, i) => ({
  type: 'function',
  function: { name: 'Tool' + i, description: 'T' + i, parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } },
}));

function legacy(info) {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + info.token,
    'User-Agent': 'CLI/' + CLI + ' CodeBuddy/' + CLI,
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

function modern(info) {
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

async function one(h, info, model) {
  const body = JSON.stringify({
    model,
    stream: true,
    max_tokens: 1,
    tools: TOOLS,
    tool_choice: 'auto',
    messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'ping' }],
  });
  const t0 = Date.now();
  try {
    const r = await fetch(HOST + PATH, { method: 'POST', headers: h(info), body });
    const text = await r.text().catch(() => '');
    let code = null;
    try { const j = JSON.parse(text); code = j.code ?? null; } catch { /* SSE */ }
    return { ok: r.status === 200, status: r.status, code, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, code: e.message.slice(0, 20), ms: Date.now() - t0 };
  }
}

(async () => {
  const acct = store.list().find((a) => a.enabled && a.edition === 'workbuddy');
  const full = store.get(acct.id);
  const info = { token: full.token, uid: full.userId };
  console.log(`账号 ${acct.label}\n`);
  console.log('model'.padEnd(20), 'legacy#1'.padEnd(16), 'legacy#2'.padEnd(16), 'modern#1'.padEnd(16), 'modern#2');
  const bad = [];
  for (const m of MODELS) {
    const cells = [];
    for (const h of [legacy, legacy, modern, modern]) {
      const r = await one(h, info, m);
      cells.push((r.ok ? 'OK' : 'FAIL/' + r.code) + ' ' + r.ms + 'ms');
      if (!r.ok) bad.push(`${m}/${r.code}`);
      await new Promise((x) => setTimeout(x, 600));
    }
    console.log(m.padEnd(20), cells.map((c) => c.padEnd(16)).join(''));
  }
  console.log('\n失败：' + (bad.length ? bad.join(', ') : '（无）'));
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
