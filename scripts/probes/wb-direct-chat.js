'use strict';
/**
 * scripts/probes/wb-direct-chat.js — 绕过网关进程，直接用**当前工作区的** chat 客户端
 * 打真实 WorkBuddy 上游，验证新头集（5.9.3 形状）能否放行。
 *
 * 为什么不走 /v1/chat/completions：运行中的网关服务是旧代码（模块在启动时加载），
 * 走它验证不到本轮改动。本脚本在进程内直接 require src/workbuddy/*，头就是改完的头。
 *
 * ⚠️ 会消耗真实积分（max_tokens 很小，但非零）。
 * 用法：node scripts/probes/wb-direct-chat.js [模型] [工具数]
 */
const store = require('../../src/credentials/store');
const wbAuth = require('../../src/workbuddy/auth');
const wbChat = require('../../src/workbuddy/chat');
const dispatch = require('../../src/model-router/dispatch');

const MODEL = process.argv[2] || 'glm-5.3';
const NTOOLS = Number(process.argv[3] || 45);

function tools(n) {
  return Array.from({ length: n }, (_, i) => ({
    type: 'function',
    function: { name: 'Tool' + i, description: 'Tool ' + i, parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } },
  }));
}

(async () => {
  const acct = store.list().find((a) => a.enabled && a.edition === 'workbuddy');
  if (!acct) throw new Error('账号库里没有启用的 WorkBuddy 账号');
  const full = store.get(acct.id);
  const resolved = {
    token: full.token,
    userId: full.userId,
    host: full.host || wbAuth.chatHost(full.region || 'cn'),
    region: wbAuth.regionOf(full.host),
  };
  const convOpts = dispatch.wbConversationOpts({ stickyKey: 'probe-direct-' + Date.now() });

  const body = {
    model: MODEL,
    stream: false,
    max_tokens: 16,
    tools: tools(NTOOLS),
    tool_choice: 'auto',
    messages: [
      { role: 'system', content: 'You are a coding assistant. Use tools when useful.' },
      { role: 'user', content: 'say ok' },
    ],
  };
  const t0 = Date.now();
  const r = await wbChat.chatStream(resolved, body, convOpts);
  console.log(`acct=${acct.id} model=${MODEL} tools=${NTOOLS} conv=${convOpts.conversationId} acp=${convOpts.acpConnectionId}`);
  console.log(`http ${r.status} in ${Date.now() - t0}ms`);
  if (r.status !== 200) {
    console.log(String(r.text || '').slice(0, 600));
    process.exit(1);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let first = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    first += dec.decode(value, { stream: true });
    if (first.length > 800) break;
  }
  console.log(first.slice(0, 700));
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
