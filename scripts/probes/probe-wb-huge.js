'use strict';
/**
 * ⚠️ 会打真实上游并**消耗真实账号积分**（每次 max_tokens=1，费用极小但非零）。
 * 仅在需要取证时手动运行，不要放进定时任务或 CI。
 *
 * scripts/probes/probe-wb-huge.js —— 超大请求体（>1MB）下 11128 的复现尝试。
 *
 * 失败现场（2026-10-21 09:59–10:00）：vm/long-context（声明窗口 1M），
 * 上游 380–500ms 即回 400/11128——这个耗时只够前置闸门读 body 头，不够进推理。
 * 上一轮 400k 字符（≈100k token）仍 200，故继续上探到 1M–4M 字符。
 *
 * 用法：node scripts/probes/probe-wb-huge.js [legacy|modern]
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
  return Object.assign(legacy(info), {
    Accept: 'application/json',
    'User-Agent': `WorkBuddy/${APP} WorkBuddy/${APP} CLI/${CLI}`,
    'x-requested-with': 'XMLHttpRequest',
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
  });
}

const SIZES = [600000, 1200000, 2400000, 4000000];

async function probe(fn, info, model, size) {
  const body = JSON.stringify({
    model,
    stream: true,
    max_tokens: 1,
    tools: TOOLS,
    tool_choice: 'auto',
    messages: [
      { role: 'system', content: 'q'.repeat(size) },
      { role: 'user', content: 'ping' },
    ],
  });
  const t0 = Date.now();
  try {
    const r = await fetch(HOST + PATH, { method: 'POST', headers: fn(info), body });
    const text = await r.text().catch(() => '');
    let code = null; let msg = '';
    try { const j = JSON.parse(text); code = j.code ?? null; msg = j.msg || ''; } catch { /* SSE */ }
    return { ok: r.status === 200, status: r.status, code, msg: String(msg).slice(0, 70), ms: Date.now() - t0, bytes: body.length };
  } catch (e) {
    return { ok: false, status: 0, code: null, msg: e.message, ms: Date.now() - t0, bytes: body.length };
  }
}

(async () => {
  const which = process.argv[2] || 'both';
  const acct = store.list().find((a) => a.enabled && a.edition === 'workbuddy');
  const full = store.get(acct.id);
  const info = { token: full.token, uid: full.userId };
  const model = process.env.WB_MODEL || 'deepseek-v4.1-flash';
  console.log(`账号 ${acct.label} model=${model}\n`);
  const sets = which === 'legacy' ? [['legacy', legacy]] : which === 'modern' ? [['modern', modern]] : [['legacy', legacy], ['modern', modern]];
  for (const [name, fn] of sets) {
    for (const size of SIZES) {
      const r = await probe(fn, info, model, size);
      console.log(name.padEnd(7), String(size).padStart(8) + '字符', (r.bytes / 1048576).toFixed(2) + 'MB',
        r.ok ? 'OK  ' : 'FAIL', 'http=' + String(r.status).padEnd(3), 'code=' + String(r.code).padEnd(6),
        String(r.ms + 'ms').padEnd(8), r.ok ? '' : '| ' + r.msg);
      await new Promise((x) => setTimeout(x, 700));
    }
  }
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
