'use strict';
/**
 * ⚠️ 会打真实上游并**消耗真实账号积分**（每次 max_tokens=1，费用极小但非零）。
 * 仅在需要取证时手动运行，不要放进定时任务或 CI。
 *
 * scripts/probes/probe-wb-trigger.js —— 反向定位：哪一处缺失会触发 11128。
 *
 * 正向（A/B 全量头）都过，说明上游的渠道校验是「必要条件集合」而非「充分条件」。
 * 反向逐项**删掉**某个特征，看是否出现 11128——命中即证明该字段是校验项。
 *
 * 用法：node scripts/probes/probe-wb-trigger.js [t1 t2 ...]
 */
const crypto = require('crypto');
const store = require('../../src/credentials/store');

const HOST = 'https://copilot.tencent.com';
const PATH = '/v2/chat/completions';
const APP = '5.8.3';
const CLI = '2.63.2';
const randHex = (n) => crypto.randomBytes(n / 2).toString('hex');
const uuid = () => crypto.randomUUID();

/** 完整官方头集（桌面端 5.8.3 形态）。 */
function base(info) {
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

const drop = (keys) => (info) => { const h = base(info); for (const k of keys) delete h[k]; return h; };
const set = (kv) => (info) => Object.assign(base(info), kv);

const CASES = {
  t0: { label: '完整官方头（对照）', build: base },
  t1: { label: '删 UA', build: drop(['User-Agent']) },
  t2: { label: 'UA 换成 axios', build: set({ 'User-Agent': 'axios/1.18.1' }) },
  t3: { label: '删 x-codebuddy-request', build: drop(['x-codebuddy-request']) },
  t4: { label: '删 X-IDE-*', build: drop(['X-IDE-Type', 'X-IDE-Name', 'X-IDE-Version']) },
  t5: { label: '删 X-Private-Data', build: drop(['X-Private-Data']) },
  t6: { label: '删 traceparent/b3/B3*', build: drop(['traceparent', 'b3', 'X-B3-TraceId', 'X-B3-SpanId', 'X-B3-ParentSpanId', 'X-B3-Sampled', 'X-Trace-ID']) },
  t7: { label: '删 X-Conversation-*', build: drop(['X-Conversation-ID', 'X-Conversation-Request-ID', 'X-Conversation-Message-ID']) },
  t8: { label: '删 X-Agent-Intent/Purpose', build: drop(['X-Agent-Intent', 'X-Agent-Purpose']) },
  t9: { label: '删 X-Product', build: drop(['X-Product']) },
  t10: { label: '删 x-requested-with', build: drop(['x-requested-with']) },
  t11: { label: 'UA 版本降到 5.0.0', build: set({ 'User-Agent': 'WorkBuddy/5.0.0 WorkBuddy/5.0.0 CLI/2.50.0', 'X-IDE-Version': '5.0.0' }) },
  t12: { label: '只留 Authorization（裸请求）', build: (info) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + info.token }) },
  t13: { label: '旧头集 + Origin/Referer=codebuddy.cn', build: (info) => Object.assign(base(info), { Origin: 'https://www.codebuddy.cn', Referer: 'https://www.codebuddy.cn/' }) },
  t14: { label: '旧头集 + X-Client-Platform: web', build: (info) => Object.assign(base(info), { 'X-Client-Platform': 'web' }) },
};

async function probe(name, info, model) {
  const c = CASES[name];
  const body = JSON.stringify({
    model,
    stream: true,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  });
  const t0 = Date.now();
  try {
    const r = await fetch(HOST + PATH, { method: 'POST', headers: c.build(info), body });
    const text = await r.text().catch(() => '');
    let code = null; let msg = '';
    try { const j = JSON.parse(text); code = j.code ?? null; msg = j.msg || ''; } catch { /* SSE */ }
    const ok = r.status === 200;
    console.log(String(name).padEnd(4), ok ? 'OK  ' : 'FAIL', 'http=' + String(r.status).padEnd(3),
      'code=' + String(code).padEnd(6), String(Date.now() - t0 + 'ms').padEnd(8), c.label,
      ok ? '' : '| ' + String(msg).slice(0, 70));
    return ok;
  } catch (e) {
    console.log(String(name).padEnd(4), 'ERR ', e.message, '|', c.label);
    return false;
  }
}

(async () => {
  const acct = store.list().find((a) => a.enabled && a.edition === 'workbuddy');
  const full = store.get(acct.id);
  const info = { token: full.token, uid: full.userId };
  const model = process.env.WB_MODEL || 'deepseek-v4.1-flash';
  const wanted = process.argv.slice(2).filter((x) => CASES[x]);
  const names = wanted.length ? wanted : Object.keys(CASES);
  console.log(`账号 ${acct.label} model=${model}\n`);
  const bad = [];
  for (const n of names) {
    const ok = await probe(n, info, model);
    if (!ok) bad.push(n);
    await new Promise((r) => setTimeout(r, 800));
  }
  console.log('\n触发 11128/失败：' + (bad.length ? bad.join(',') : '（无 —— 上游未按头集校验）'));
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
