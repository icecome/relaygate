'use strict';
/**
 * ⚠️ 会打真实上游并**消耗真实账号积分**（每次 max_tokens=1，费用极小但非零）。
 * 仅在需要取证时手动运行，不要放进定时任务或 CI。
 *
 * scripts/probes/probe-wb-origin.js —— 前端门（front door）维度：11128 是否与「接入哪个域名」有关。
 *
 * 依据：桌面客户端 5.8.3 的 product.json `productFeaturesConfig.NetworkFailover`
 * 把核心 API 的信任来源定义为三个 origin，且有明确的主/备之分：
 *   PRIMARY   https://www.workbuddy.cn
 *   ALTERNATE https://copilot.tencent.com
 *   BACKUP    https://wb.tencentbuddy.com
 * 本仓库一直只用 ALTERNATE（copilot.tencent.com）作 chat host。
 * 若上游的「渠道校验」按 front door 判定，改走 PRIMARY 即应恢复。
 *
 * 用法：node scripts/probes/probe-wb-origin.js
 */
const crypto = require('crypto');
const store = require('../../src/credentials/store');

const ORIGINS = [
  ['primary', 'https://www.workbuddy.cn'],
  ['alternate', 'https://copilot.tencent.com'],
  ['backup', 'https://wb.tencentbuddy.com'],
];
const PATH = '/v2/chat/completions';
const APP = '5.8.3';
const CLI = '2.161.0';
const randHex = (n) => crypto.randomBytes(n / 2).toString('hex');
const uuid = () => crypto.randomUUID();

const TOOLS = Array.from({ length: 42 }, (_, i) => ({
  type: 'function',
  function: { name: 'Tool' + i, description: 'T' + i, parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } },
}));

function modern(info, domain) {
  const t = randHex(32); const s = randHex(16); const p = randHex(16);
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + info.token,
    'User-Agent': `WorkBuddy/${APP} WorkBuddy/${APP} CLI/${CLI}`,
    'x-requested-with': 'XMLHttpRequest',
    'X-User-Id': info.uid,
    'X-Domain': domain,
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

function legacy(info, domain) {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + info.token,
    'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
    'X-Requested-With': 'XMLHttpRequest',
    'X-User-Id': info.uid,
    'X-Enterprise-Id': '',
    'X-Domain': domain,
    'X-Product': 'SaaS',
    'X-Client-Platform': 'web',
    Origin: 'https://www.codebuddy.cn',
    Referer: 'https://www.codebuddy.cn/',
  };
}

async function probe(base, headers, model, label) {
  const body = JSON.stringify({
    model, stream: true, max_tokens: 1,
    tools: TOOLS, tool_choice: 'auto',
    messages: [{ role: 'user', content: 'ping' }],
  });
  const t0 = Date.now();
  try {
    const r = await fetch(base + PATH, { method: 'POST', headers, body });
    const text = await r.text().catch(() => '');
    let code = null; let msg = '';
    try { const j = JSON.parse(text); code = j.code ?? null; msg = j.msg || ''; } catch { /* SSE */ }
    console.log(label.padEnd(26), r.status === 200 ? 'OK  ' : 'FAIL',
      'http=' + String(r.status).padEnd(3), 'code=' + String(code).padEnd(6),
      String(Date.now() - t0 + 'ms').padEnd(8), r.status === 200 ? '' : '| ' + String(msg).slice(0, 60));
    return r.status === 200;
  } catch (e) {
    console.log(label.padEnd(26), 'ERR ', e.message.slice(0, 70));
    return false;
  }
}

(async () => {
  const acct = store.list().find((a) => a.enabled && a.edition === 'workbuddy');
  const full = store.get(acct.id);
  const info = { token: full.token, uid: full.userId };
  const model = process.env.WB_MODEL || 'deepseek-v4.1-flash';
  console.log(`账号 ${acct.label} model=${model}\n`);
  for (const [name, base] of ORIGINS) {
    const domain = new URL(base).host;
    await probe(base, modern(info, domain), model, name + '/modern');
    await new Promise((r) => setTimeout(r, 600));
    await probe(base, legacy(info, domain), model, name + '/legacy');
    await new Promise((r) => setTimeout(r, 600));
  }
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
