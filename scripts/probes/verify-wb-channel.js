'use strict';
/**
 * scripts/probes/verify-wb-channel.js —— 渠道身份升级的回归验证。
 *
 * 断言四件事（都不打网络，纯本地）：
 *   1. chat 面头集 = 桌面端身份：UA 以 WorkBuddy/ 开头、带 X-IDE- 三件套、X-Private-Data、
 *      x-codebuddy-request、会话头、追踪头；
 *   2. chat 面**不带**插件身份：没有 X-Client-Platform、没有 Origin/Referer 指向
 *      codebuddy.cn（这正是 11128 之前的形状）；
 *   3. billing/checkin 面仍是 web 身份（authHeaders 未被改动）；
 *   4. 11128 被分类为 'channel'，且该分类不冷却账号、不在同平台内重试。
 *
 * 用法：node scripts/probes/verify-wb-channel.js
 */
const assert = require('assert');
const wbAuth = require('../../src/workbuddy/auth');
const { classifyError, isRetryable, isChannelBlockedError, CODE_CHANNEL_BLOCKED } = require('../../src/upstream/errors');

let pass = 0;
function ok(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; } catch (e) { console.log('  FAIL ' + name + ' :: ' + e.message); process.exitCode = 1; }
}

console.log('[1] chat 面头集（桌面端身份）');
const chat = wbAuth.chatHeaders({ accessToken: 'tok', uid: 'u1', region: 'cn' });
ok('UA 以 WorkBuddy/ 开头', () => assert.ok(/^WorkBuddy\//.test(chat['User-Agent']), chat['User-Agent']));
ok('UA 同时带 CLI/ 段', () => assert.ok(/CLI\/\d/.test(chat['User-Agent']), chat['User-Agent']));
ok('X-IDE-Type = WorkBuddy', () => assert.strictEqual(chat['X-IDE-Type'], 'WorkBuddy'));
ok('X-IDE-Name = WorkBuddy', () => assert.strictEqual(chat['X-IDE-Name'], 'WorkBuddy'));
ok('X-IDE-Version 为桌面版本', () => assert.ok(/^\d+\.\d+\.\d+$/.test(chat['X-IDE-Version']), chat['X-IDE-Version']));
ok('X-Private-Data 存在', () => assert.ok(chat['X-Private-Data'] != null));
ok('x-codebuddy-request = 1', () => assert.strictEqual(chat['x-codebuddy-request'], '1'));
ok('带 X-Conversation-ID', () => assert.ok(chat['X-Conversation-ID']));
ok('带 X-Request-ID', () => assert.ok(chat['X-Request-ID']));
ok('带 X-Agent-Intent', () => assert.ok(chat['X-Agent-Intent']));
ok('带 traceparent', () => assert.ok(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(chat.traceparent), chat.traceparent));
ok('带 B3 多段', () => assert.ok(chat['X-B3-TraceId'] && chat['X-B3-SpanId']));
ok('Authorization 为 Bearer', () => assert.strictEqual(chat.Authorization, 'Bearer tok'));

console.log('[2] chat 面不带插件/网页身份');
ok('无 X-Client-Platform', () => assert.strictEqual(chat['X-Client-Platform'], undefined));
ok('无 Origin', () => assert.strictEqual(chat.Origin, undefined));
ok('无 Referer', () => assert.strictEqual(chat.Referer, undefined));
ok('无 X-Enterprise-Id 空值', () => assert.strictEqual(chat['X-Enterprise-Id'], undefined));
ok('绝无 X-Refresh-Token', () => assert.strictEqual(chat['X-Refresh-Token'], undefined));

console.log('[3] 会话键可复用');
const a = wbAuth.chatHeaders({ accessToken: 't', uid: 'u', region: 'cn' }, { conversationId: 'conv-1', requestId: 'req-1' });
ok('传入的 conversationId 被采用', () => assert.strictEqual(a['X-Conversation-ID'], 'conv-1'));
ok('传入的 requestId 被采用', () => assert.strictEqual(a['X-Request-ID'], 'req-1'));
ok('两次调用默认值不同', () => {
  const x = wbAuth.chatHeaders({ accessToken: 't', uid: 'u', region: 'cn' });
  const y = wbAuth.chatHeaders({ accessToken: 't', uid: 'u', region: 'cn' });
  assert.notStrictEqual(x['X-Conversation-ID'], y['X-Conversation-ID']);
});

console.log('[4] billing 面仍是 web 身份');
const web = wbAuth.authHeaders({ accessToken: 'tok', uid: 'u1', region: 'cn' });
ok('authHeaders 仍带 X-Client-Platform: web', () => assert.strictEqual(web['X-Client-Platform'], 'web'));
ok('authHeaders 仍带 Origin', () => assert.ok(web.Origin));
ok('authHeaders 不带 X-IDE-Type', () => assert.strictEqual(web['X-IDE-Type'], undefined));

console.log('[5] 11128 的分类与降级语义');
const e = new Error('WorkBuddy upstream HTTP 400 {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}');
e.status = 400;
ok('classified as channel', () => assert.strictEqual(classifyError(e), 'channel'));
ok('upstreamCode 回填为 11128', () => assert.strictEqual(e.upstreamCode, CODE_CHANNEL_BLOCKED));
ok('不重试', () => assert.strictEqual(isRetryable('channel'), false));
ok('isChannelBlockedError 为真', () => assert.strictEqual(isChannelBlockedError(e), true));
ok('文案兜底也能识别', () => {
  const t = new Error('upstream said: Illegal API invocation from an unapproved channel');
  assert.strictEqual(isChannelBlockedError(t), true);
});
ok('11128 不会被误判为 auth', () => assert.notStrictEqual(classifyError(e), 'auth'));

console.log(`\n通过 ${pass} 项`);
