'use strict';
/**
 * ⚠️ 会打真实上游并**消耗真实账号积分**（每次 max_tokens=1，费用极小但非零）。
 * 仅在需要取证时手动运行，不要放进定时任务或 CI。
 *
 * scripts/probes/probe-wb-body.js —— 11128 的「请求体维度」探测。
 *
 * 第一轮（probe-wb-channel.js）已证明：仅换/不换头，最小请求体都能过。
 * 于是 11128 的判定必然落在请求体或请求形状上。本脚本对同一账号固定用
 * 「新头集」，只改请求体形状，逐项二分：
 *   s1  最小体（基线）
 *   s2  带 42 个工具（复刻网关实际请求的 toolsIn=42）
 *   s3  带 42 个工具 + tool_choice
 *   s4  带 42 个工具 + stream_options
 *   s5  超长 system（>100k 字符，触发 long-context 档）
 *   s6  带 reasoning_effort
 *   s7  带 parallel_tool_calls
 *   s8  带 response_format
 *
 * 用法：node scripts/probes/probe-wb-body.js [s1 s2 ...]
 */
const store = require('../../src/credentials/store');

const HOST = 'https://copilot.tencent.com';
const PATH = '/v2/chat/completions';
const APP_VERSION = process.env.WB_APP_VERSION || '5.8.3';
const CLI_VERSION = process.env.WB_CLI_VERSION || '2.63.2';

const crypto = require('crypto');
const randHex = (n) => crypto.randomBytes(n / 2).toString('hex');
const uuid = () => crypto.randomUUID();

function headers(info) {
  const trace = randHex(32); const span = randHex(16); const parent = randHex(16);
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + info.token,
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
    traceparent: '00-' + trace + '-' + span + '-01',
    b3: trace + '-' + span + '-1-' + parent,
    'X-B3-TraceId': trace,
    'X-B3-SpanId': span,
    'X-B3-ParentSpanId': parent,
    'X-B3-Sampled': '1',
    'X-Trace-ID': trace,
  };
}

/** 复刻网关实际携带的 42 个工具（名称/结构取 OpenAI function 形态）。 */
const TOOL_NAMES = [
  'Read', 'Write', 'Edit', 'Bash', 'PowerShell', 'Glob', 'Grep', 'LS',
  'TodoWrite', 'Task', 'WebFetch', 'WebSearch', 'NotebookEdit', 'NotebookRead',
  'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion', 'BashOutput', 'KillShell',
  'SlashCommand', 'Skill', 'Agent', 'TaskOutput', 'TaskStop', 'ToolSearch',
  'DeferExecuteTool', 'REPL', 'Monitor', 'Workflow', 'StructuredOutput',
  'ReportFindings', 'PushNotification', 'SendMessage', 'TeamCreate', 'TeamDelete',
  'CronCreate', 'CronDelete', 'CronList', 'LibraryUpload', 'Artifact', 'ImageGen',
  'SendUserMessage',
];
function tools() {
  return TOOL_NAMES.map((n) => ({
    type: 'function',
    function: {
      name: n,
      description: 'Tool ' + n + ' description',
      parameters: { type: 'object', properties: { arg: { type: 'string', description: 'arg' } }, required: ['arg'] },
    },
  }));
}

const SHAPES = {
  s1: { label: '最小体', build: () => ({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }) },
  s2: { label: '42 工具', build: () => ({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, tools: tools() }) },
  s3: { label: '42 工具 + tool_choice=auto', build: () => ({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, tools: tools(), tool_choice: 'auto' }) },
  s4: { label: '42 工具 + stream_options', build: () => ({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, tools: tools(), stream_options: { include_usage: true } }) },
  s5: { label: '超长 system(120k 字符)', build: () => ({ messages: [{ role: 'system', content: 'x'.repeat(120000) }, { role: 'user', content: 'ping' }], max_tokens: 1 }) },
  s6: { label: 'reasoning_effort=high', build: () => ({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, reasoning_effort: 'high' }) },
  s7: { label: 'parallel_tool_calls', build: () => ({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, parallel_tool_calls: true }) },
  s8: { label: 'response_format=json_object', build: () => ({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, response_format: { type: 'json_object' } }) },
  s9: { label: 'system+user 常规对话', build: () => ({ messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'ping' }], max_tokens: 1 }) },
};

async function probe(name, info, model) {
  const shape = SHAPES[name];
  const body = JSON.stringify(Object.assign({ model, stream: true }, shape.build()));
  const t0 = Date.now();
  let out;
  try {
    const resp = await fetch(HOST + PATH, { method: 'POST', headers: headers(info), body });
    const text = await resp.text().catch(() => '');
    let code = null; let msg = '';
    try { const j = JSON.parse(text); code = j.code ?? null; msg = j.msg || j.message || ''; } catch { /* SSE */ }
    out = { status: resp.status, code, msg: String(msg).slice(0, 100), ms: Date.now() - t0, ok: resp.status === 200 };
  } catch (e) {
    out = { status: 0, code: null, msg: e.message, ms: Date.now() - t0, ok: false };
  }
  console.log(String(name).padEnd(3), out.ok ? 'OK  ' : 'FAIL', 'http=' + String(out.status).padEnd(3),
    'code=' + String(out.code).padEnd(6), String(out.ms + 'ms').padEnd(7), shape.label,
    out.ok ? '' : '| ' + out.msg);
  return out;
}

(async () => {
  const acct = store.list().find((a) => a.enabled && a.edition === 'workbuddy');
  const full = store.get(acct.id);
  const info = { token: full.token, uid: full.userId };
  const model = process.env.WB_MODEL || 'deepseek-v4.1-flash';
  console.log(`账号 ${acct.label}  model=${model}\n`);
  const wanted = process.argv.slice(2).filter((x) => SHAPES[x]);
  const names = wanted.length ? wanted : Object.keys(SHAPES);
  const res = {};
  for (const n of names) {
    res[n] = await probe(n, info, model);
    await new Promise((r) => setTimeout(r, 900));
  }
  console.log('\n通过：' + (names.filter((n) => res[n].ok).join(',') || '（无）'));
  console.log('被拒：' + (names.filter((n) => !res[n].ok).join(',') || '（无）'));
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
