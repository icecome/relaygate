'use strict';
/**
 * ⚠️ 会打真实上游并**消耗真实账号积分**（每次 max_tokens=1，费用极小但非零）。
 * 仅在需要取证时手动运行，不要放进定时任务或 CI。
 *
 * scripts/probes/probe-wb-channel.js —— WorkBuddy「渠道校验」(code=11128) 探测探针。
 *
 * 背景：2026-10-21 起，网关用旧头集请求 POST {chatHost}/v2/chat/completions
 * 一律被上游判为 HTTP 400 / code=11128
 * （Illegal API invocation from an unapproved channel）。
 *
 * 本脚本把「旧头集」与从桌面客户端 app.asar 里还原出的「新头集」并排打一次，
 * 用同一账号、同一 model、最小 max_tokens，逐个变体定位真正被校验的那几个头。
 *
 * 用法：
 *   node scripts/probes/probe-wb-channel.js            # 跑全部变体
 *   node scripts/probes/probe-wb-channel.js A C        # 只跑指定变体
 *
 * 约定：每个变体只发 1 次、max_tokens=1，被拒（400）不产生积分消耗。
 */
const store = require('../../src/credentials/store');
const wbAuth = require('../../src/workbuddy/auth');

const HOST = 'https://copilot.tencent.com';
const PATH = '/v2/chat/completions';

/** 桌面客户端版本：取自 C:\opt\software\Tencent\WorkBuddy\resources\install-manifest.json */
const APP_VERSION = process.env.WB_APP_VERSION || '5.8.3';
const CLI_VERSION = process.env.WB_CLI_VERSION || '2.63.2';

function randHex(n) {
  return require('crypto').randomBytes(n / 2).toString('hex');
}
function uuid() {
  return require('crypto').randomUUID();
}

/** 旧头集：当前 src/workbuddy/auth.js#authHeaders 产出的样子。 */
function legacyHeaders(info) {
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + info.token,
    'User-Agent': 'CLI/' + CLI_VERSION + ' CodeBuddy/' + CLI_VERSION,
    'X-Requested-With': 'XMLHttpRequest',
    'X-User-Id': info.uid,
    'X-Enterprise-Id': '',
    'X-Domain': 'copilot.tencent.com',
    'X-Product': 'SaaS',
    'X-Client-Platform': 'web',
    'Origin': 'https://www.codebuddy.cn',
    'Referer': 'https://www.codebuddy.cn/',
  };
}

/** 新头集：桌面客户端 VLM 代理 / ModelProvider 的并集（见 app.asar main/server.js）。 */
function modernHeaders(info) {
  const trace = randHex(32);
  const span = randHex(16);
  const parent = randHex(16);
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + info.token,
    'User-Agent': 'WorkBuddy/' + APP_VERSION + ' WorkBuddy/' + APP_VERSION + ' CLI/' + CLI_VERSION,
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
    'traceparent': '00-' + trace + '-' + span + '-01',
    'b3': trace + '-' + span + '-1-' + parent,
    'X-B3-TraceId': trace,
    'X-B3-SpanId': span,
    'X-B3-ParentSpanId': parent,
    'X-B3-Sampled': '1',
    'X-Trace-ID': trace,
  };
}

/** 变体表：从旧头集出发，逐项替换，用来二分出被校验的字段。 */
const VARIANTS = {
  A: { label: '旧头集（复现 11128）', build: legacyHeaders },
  B: { label: '新头集（全量）', build: modernHeaders },
  C: { label: '旧头集 + 只换 User-Agent', build: (i) => Object.assign(legacyHeaders(i), { 'User-Agent': 'WorkBuddy/' + APP_VERSION + ' WorkBuddy/' + APP_VERSION + ' CLI/' + CLI_VERSION }) },
  D: { label: '旧头集 + 只加 x-codebuddy-request', build: (i) => Object.assign(legacyHeaders(i), { 'x-codebuddy-request': '1' }) },
  E: { label: '旧头集 + 只加 X-IDE-*', build: (i) => Object.assign(legacyHeaders(i), { 'X-IDE-Type': 'WorkBuddy', 'X-IDE-Name': 'WorkBuddy', 'X-IDE-Version': APP_VERSION }) },
  F: { label: '旧头集 + 只加 X-Private-Data', build: (i) => Object.assign(legacyHeaders(i), { 'X-Private-Data': 'true' }) },
  G: { label: '旧头集 + UA/x-codebuddy/IDE 三件套', build: (i) => Object.assign(legacyHeaders(i), { 'User-Agent': 'WorkBuddy/' + APP_VERSION + ' WorkBuddy/' + APP_VERSION + ' CLI/' + CLI_VERSION, 'x-codebuddy-request': '1', 'X-IDE-Type': 'WorkBuddy', 'X-IDE-Name': 'WorkBuddy', 'X-IDE-Version': APP_VERSION }) },
  H: { label: '旧头集 + 去掉 X-Client-Platform', build: (i) => { const h = legacyHeaders(i); delete h['X-Client-Platform']; return h; } },
};

async function probe(name, build, info, model) {
  const v = VARIANTS[name];
  const headers = build(info);
  const body = JSON.stringify({
    model,
    stream: true,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  });
  const t0 = Date.now();
  let out;
  try {
    const resp = await fetch(HOST + PATH, { method: 'POST', headers, body });
    const text = await resp.text().catch(() => '');
    let code = null; let msg = '';
    try { const j = JSON.parse(text); code = j.code ?? null; msg = j.msg || j.message || ''; } catch { /* SSE 成功体 */ }
    out = { status: resp.status, code, msg: String(msg).slice(0, 90), ms: Date.now() - t0, ok: resp.status === 200 };
  } catch (e) {
    out = { status: 0, code: null, msg: e.message, ms: Date.now() - t0, ok: false };
  }
  console.log(
    String(name).padEnd(2),
    (out.ok ? 'OK  ' : 'FAIL'),
    'http=' + String(out.status).padEnd(3),
    'code=' + String(out.code).padEnd(6),
    String(out.ms + 'ms').padEnd(7),
    v.label,
    out.ok ? '' : '| ' + out.msg,
  );
  return out;
}

(async () => {
  const acct = store.list().find((a) => a.enabled && a.edition === 'workbuddy');
  if (!acct) throw new Error('没有启用的 workbuddy 账号');
  const full = store.get(acct.id);
  const info = { token: full.token, uid: full.userId };
  const model = process.env.WB_MODEL || 'deepseek-v4.1-flash';
  console.log(`账号 ${acct.id}（${acct.label}）  model=${model}  appVersion=${APP_VERSION} cliVersion=${CLI_VERSION}\n`);

  const wanted = process.argv.slice(2).filter((x) => VARIANTS[x]);
  const names = wanted.length ? wanted : Object.keys(VARIANTS);
  const results = {};
  for (const n of names) {
    results[n] = await probe(n, VARIANTS[n].build, info, model);
    await new Promise((r) => setTimeout(r, 800)); // 避免同账号连打触发频控
  }

  const ok = names.filter((n) => results[n].ok);
  console.log('\n通过：' + (ok.length ? ok.join(',') : '（无）'));
  console.log('被拒：' + (names.filter((n) => !results[n].ok).join(',') || '（无）'));
})().catch((e) => {
  console.error('probe failed:', e.message);
  process.exit(1);
});
