'use strict';
/**
 * ⚠️ 会打真实上游并**消耗真实账号积分**（每次 max_tokens=1，费用极小但非零）。
 * 仅在需要取证时手动运行，不要放进定时任务或 CI。
 *
 * scripts/probes/probe-wb-accounts.js —— 用「网关真实代码路径」逐账号打一次 chat，
 * 定位 11128 是账号级/令牌级，还是全局策略。
 *
 * 与 probe-wb-channel.js 的区别：这里不自己拼头，直接调 src/workbuddy/chat.js，
 * 保证请求与线上转发完全同形（含 Origin/Referer/X-Client-Platform/42 工具）。
 *
 * 用法：node scripts/probes/probe-wb-accounts.js [模型]
 */
const store = require('../../src/credentials/store');
const wbChat = require('../../src/workbuddy/chat');

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
      description: 'Tool ' + n,
      parameters: { type: 'object', properties: { arg: { type: 'string' } }, required: ['arg'] },
    },
  }));
}

async function one(acct, model, withTools) {
  const full = store.get(acct.id);
  const acctObj = { token: full.token, userId: full.userId, host: full.host, region: 'cn' };
  const body = {
    model,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
    ...(withTools ? { tools: tools(), tool_choice: 'auto' } : {}),
  };
  const t0 = Date.now();
  try {
    const r = await wbChat.chatStream(acctObj, body);
    let code = null; let msg = '';
    if (r.status !== 200) {
      try { const j = JSON.parse(r.text || ''); code = j.code ?? null; msg = j.msg || ''; } catch { msg = String(r.text || '').slice(0, 80); }
    } else if (r.body) {
      // 读掉流，避免悬挂连接
      const rd = r.body.getReader();
      try { for (;;) { const { done } = await rd.read(); if (done) break; } } catch { /* ignore */ }
    }
    return { ok: r.status === 200, status: r.status, code, msg: String(msg).slice(0, 90), ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, code: null, msg: e.message, ms: Date.now() - t0 };
  }
}

(async () => {
  const model = process.argv[2] || process.env.WB_MODEL || 'deepseek-v4.1-flash';
  const accts = store.list().filter((a) => a.edition === 'workbuddy' && a.enabled);
  console.log(`model=${model} 账号数=${accts.length}\n`);
  console.log('账号'.padEnd(26), 'label'.padEnd(13), '无工具'.padEnd(22), '42 工具');
  for (const a of accts) {
    const r1 = await one(a, model, false);
    await new Promise((r) => setTimeout(r, 700));
    const r2 = await one(a, model, true);
    await new Promise((r) => setTimeout(r, 700));
    const fmt = (r) => (r.ok ? `OK ${r.ms}ms` : `FAIL ${r.status}/${r.code} ${r.msg}`).slice(0, 21).padEnd(22);
    console.log(a.id.padEnd(26), String(a.label || '').padEnd(13), fmt(r1), r2.ok ? `OK ${r2.ms}ms` : `FAIL ${r2.status}/${r2.code} ${r2.msg}`);
  }
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
