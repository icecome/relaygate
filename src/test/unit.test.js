'use strict';
/**
 * test/unit.test.js — 纯函数层最小单测（node 内置 assert，无需依赖）。
 * 运行：node src/test/unit.test.js
 *
 * 注意：必须在 require 任何模块之前设置 WORKSPACE_DIR / TRAE_API_ENCRYPT_KEY，
 * 否则 config.workspaceDir 会被固化到默认 output/，污染真实账号库。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `trae-test-${Date.now()}`);
process.env.TRAE_API_ENCRYPT_KEY = 'a'.repeat(64);
process.env.API_KEY = 'test-api-key';
process.env.ADMIN_KEY = 'test-admin-key';

const assert = require('assert');
const { normalizeTraeMessages } = require('../transform/request');
const { createStreamHandler } = require('../transform/sse');
const { exportOpenAI, exportAnthropic } = require('../transform/emitters');
const { buildBody } = require('../upstream/client');
const { classifyError } = require('../upstream/errors');
// store/import 在 credentials.pool 段落再 require，避免与 WORKSPACE 初始化顺序冲突

let pass = 0;
const queue = [];
function t(name, fn) {
  queue.push({ name, fn });
}

async function runAll() {
  for (const { name, fn } of queue) {
    try { await fn(); pass++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`FAIL  ${name}: ${e.message}`); process.exitCode = 1; }
  }
}

async function main() {
  await runAll();
  console.log(`\n${pass} passed`);
  if (process.exitCode) process.exit(process.exitCode);
}

console.log('request.normalizeTraeMessages');
t('字符串 content 转数组', () => {
  const r = normalizeTraeMessages([{ role: 'user', content: 'hi' }]);
  assert.deepStrictEqual(r[0].content, [{ type: 'text', text: 'hi' }]);
});
t('保留 assistant tool_calls 结构', () => {
  const r = normalizeTraeMessages([{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function_call: { name: 'read_file', arguments: '{"x":1}' } }] }]);
  assert.strictEqual(r[0].tool_calls[0].function_call.name, 'read_file');
});
t('合并连续 user 消息', () => {
  const r = normalizeTraeMessages([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].content.length, 2);
});

console.log('sse.createStreamHandler');
t('提取裸工具 JSON (ingest)', () => {
  const calls = [];
  const h = createStreamHandler((e) => { if (e.type === 'tool_call') calls.push(e.call); });
  h.feedLine('event:output');
  h.ingest({ content: '{"name":"read_file","arguments":{"path":"a.txt"}}' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, 'read_file');
});
t('跨 chunk 拆分裸工具 JSON (feedLine)', () => {
  const calls = [];
  const h = createStreamHandler((e) => { if (e.type === 'tool_call') calls.push(e.call); });
  const json = '{"name":"run","arguments":{"cmd":"ls"}}';
  // 先把整段作为一次 output 内的 content 经 feedLine 喂入（JSON.parse 一次）
  for (const part of [json.slice(0, 10), json.slice(10, 20), json.slice(20)]) {
    h.feedLine('event:output');
    h.ingest({ content: part });
  }
  assert.strictEqual(calls.length, 1, 'should extract one tool call');
  assert.strictEqual(calls[0].name, 'run');
});

console.log('emitters');
t('OpenAI 文本块', () => {
  const out = exportOpenAI();
  const b = out.text('c1', 'auto', 'hello');
  assert.ok(b[0].includes('chat.completion.chunk'));
  assert.ok(JSON.parse(b[0].slice(6)).choices[0].delta.content === 'hello');
});
t('Anthropic tool_use 块', () => {
  const out = exportAnthropic();
  const b = out.toolCall('m1', 'glm', { id: 'x', name: 'read_file', arguments: '{"p":"a"}' });
  const s = b[0].slice(6);
  assert.ok(JSON.parse(s).content_block.type === 'tool_use');
});

console.log('upstream.buildBody');
t('model=auto 用 inline_chat', () => {
  const b = buildBody([], 'auto', true, {});
  assert.strictEqual(b.function, 'inline_chat');
});
t('非 auto 模型：请求体增强（config_name/model_name/会话字段）', () => {
  const authInfo = { userId: 'u-123', devices: { deviceId: 'dev-1', machineId: 'mach-1' } };
  const b = buildBody([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], 'deepseek-v4-flash-official', true, {}, authInfo);
  assert.strictEqual(b.model, 'DeepSeek-V4-Flash-Official');
  assert.strictEqual(b.config_name, 'DeepSeek-V4-Flash-Official');
  assert.strictEqual(b.model_name, 'DeepSeek-V4-Flash-Official__dev');
  assert.strictEqual(b.user_id, 'u-123');
  assert.strictEqual(b.device_id, 'dev-1');
  assert.strictEqual(b.machine_id, 'mach-1');
  assert.strictEqual(b.prompt_max_tokens, 168000);
  assert.strictEqual(b.mode, 'FunctionCall');
  assert.ok(b.conversation_id && b.session_id && b.project_id, '应生成会话 id');
});
t('TRAE_BODY_ENRICH=off 关闭请求体增强', () => {
  process.env.TRAE_BODY_ENRICH = 'off';
  try {
    const b = buildBody([], 'glm-5.2', true, {});
    assert.strictEqual(b.model, 'glm-5.2');
    assert.strictEqual(b.config_name, undefined);
    assert.strictEqual(b.model_name, undefined);
  } finally {
    delete process.env.TRAE_BODY_ENRICH;
  }
});
t('TRAE_WORK_IDENTITY=on 注入 TraeWork 请求语义', () => {
  process.env.TRAE_WORK_IDENTITY = 'on';
  try {
    const authInfo = { userId: 'u-w', devices: { deviceId: 'd-1', machineId: 'm-1' } };
    const b = buildBody([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], 'deepseek-v4-flash-official', true, {}, authInfo);
    assert.strictEqual(b.function, 'solo_work_lite', 'chat_v3 应切换为 solo_work_lite');
    assert.deepStrictEqual(b.common_params, { product_name: 'lite', chat_mode: 'work' });
    const b2 = buildBody([], 'glm-5.2', true, { function: 'solo_agent_lite' }, authInfo);
    assert.strictEqual(b2.function, 'solo_agent_lite', 'options.function 显式指定时应优先');
  } finally {
    delete process.env.TRAE_WORK_IDENTITY;
  }
});
t('TRAE_WORK_IDENTITY 默认关闭：请求体无 Work 语义', () => {
  const b = buildBody([], 'glm-5.2', true, {});
  assert.strictEqual(b.common_params, undefined);
  assert.strictEqual(b.function, 'chat_v3');
});
t('tools：Anthropic input_schema 映射为 parameters', () => {
  const tools = [{ name: 'read_file', description: '读文件', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
  const b = buildBody([], 'glm-5.2', true, { tools });
  const params = JSON.parse(b.tools[0].function.parameters);
  assert.deepStrictEqual(params.properties.path, { type: 'string' });
  assert.strictEqual(b.tools[0].function.name, 'read_file');
});
t('tools：OpenAI parameters 形态仍正确透出', () => {
  const tools = [{ type: 'function', function: { name: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }];
  const b = buildBody([], 'glm-5.2', true, { tools });
  const params = JSON.parse(b.tools[0].function.parameters);
  assert.deepStrictEqual(params.properties.cmd, { type: 'string' });
});
t('headersFor 在 Work 身份下追加 X-App-Function/X-Ide-Function', () => {
  const authMod = require('../auth');
  process.env.TRAE_WORK_IDENTITY = 'on';
  try {
    const h = authMod.headersFor({ token: 't-1', userId: 'u-1', devices: null }, 'req-1');
    assert.strictEqual(h['X-App-Function'], 'solo_work_lite');
    assert.strictEqual(h['X-Ide-Function'], 'solo_work_lite');
    const hOff = (() => {
      delete process.env.TRAE_WORK_IDENTITY;
      return authMod.headersFor({ token: 't-1', userId: 'u-1', devices: null }, 'req-2');
    })();
    assert.strictEqual(hOff['X-App-Function'], undefined);
  } finally {
    delete process.env.TRAE_WORK_IDENTITY;
  }
});
t('model_name 映射：deepseek-v4-pro 用 snake_case 特例，未知模型回退 __dev', () => {
  const { upstreamModelName } = require('../upstream/client');
  assert.strictEqual(upstreamModelName('DeepSeek-V4-Pro', 'deepseek-v4-pro'), 'deepseek_v4_pro__dev');
  assert.strictEqual(upstreamModelName('Some-Model-X', 'some-model-x'), 'Some-Model-X__dev');
});

console.log('errors');
t('3004 归为 rate_limit', () => {
  const e = new Error('Error 3004: rate limit');
  assert.strictEqual(classifyError(e), 'rate_limit');
});
t('SSE 流内错误经 upstreamCode 归为 rate_limit', () => {
  const e = new Error("We're sorry, your requests have exceeded the rate limit.");
  e.code = 'UPSTREAM_STREAM_ERROR';
  e.upstreamCode = 3004;
  assert.strictEqual(classifyError(e), 'rate_limit');
});
t('isRateLimitCode 识别数字与字符串码', () => {
  const { isRateLimitCode } = require('../upstream/errors');
  assert.strictEqual(isRateLimitCode(3004), true);
  assert.strictEqual(isRateLimitCode('3004'), true);
  assert.strictEqual(isRateLimitCode(4005), false);
  assert.strictEqual(isRateLimitCode(null), false);
});
t('4001 模型配置问题归为 model 类', () => {
  const { isModelConfigError } = require('../upstream/errors');
  const e1 = new Error('model config is empty');
  e1.upstreamCode = 4001;
  assert.strictEqual(classifyError(e1), 'model');
  const e2 = new Error('bad request: {"code":4001,...}');
  e2.status = 400;
  assert.strictEqual(isModelConfigError(e2), false, '仅 HTTP 400 不算模型问题');
  const e3 = new Error('upstream error: model config is empty');
  assert.strictEqual(isModelConfigError(e3), true);
});
t('pool.record model 类不冷却不记错误', () => {
  const a = pStore.add({ label: 'model-err', token: 'm1' }, 'import');
  pool.record(a.id, 'model');
  const g = pStore.get(a.id);
  assert.strictEqual(g.errorCount, 0);
  assert.strictEqual(g.coolUntil, null);
  pStore.remove(a.id);
});
t('rate_limit 同账号只重试1次后抛出（交还账号池轮换）', async () => {
  const { retryWithBackoff } = require('../upstream/errors');
  let calls = 0;
  await assert.rejects(
    retryWithBackoff(async () => {
      calls++;
      const e = new Error('limited');
      e.upstreamCode = 3004;
      throw e;
    }, { maxRetries: 3, baseDelay: 1 }),
    /limited/
  );
  assert.strictEqual(calls, 2); // 首次 + 1 次重试，而非 4 次
});

console.log('sse 空参数补偿');
t('空参数原生 tool_calls 被补偿(file_path)', () => {
  const calls = [];
  const h = require('../transform/sse').createStreamHandler((e) => { if (e.type === 'tool_call') calls.push(e.call); }, { userText: 'read c:/tmp/a.txt' });
  h.ingest({ tool_calls: [{ id: 't1', function_call: { name: 'read_file', arguments: '' } }] });
  h.flushToolAccum();
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(JSON.parse(calls[0].arguments), { file_path: 'c:/tmp/a.txt', path: 'c:/tmp/a.txt' });
});
t('无补偿时仍发出工具调用(空参)', () => {
  const calls = [];
  const h = require('../transform/sse').createStreamHandler((e) => { if (e.type === 'tool_call') calls.push(e.call); }, { userText: '' });
  h.ingest({ tool_calls: [{ id: 't1', function_call: { name: 'list_branches', arguments: null } }] });
  h.flushToolAccum();
  assert.strictEqual(calls.length, 1, '不应丢弃无参工具');
  assert.deepStrictEqual(JSON.parse(calls[0].arguments), {});
});
t('空对象参数视为合法', () => {
  const calls = [];
  const h = require('../transform/sse').createStreamHandler((e) => { if (e.type === 'tool_call') calls.push(e.call); });
  h.ingest({ tool_calls: [{ id: 't2', function_call: { name: 'noop', arguments: '{}' } }] });
  h.flushToolAccum();
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(JSON.parse(calls[0].arguments), {});
});
t('partial_arguments 可回退并补偿 glob', () => {
  const calls = [];
  const h = require('../transform/sse').createStreamHandler((e) => { if (e.type === 'tool_call') calls.push(e.call); }, { userText: 'search **/*.js' });
  h.ingest({ tool_calls: [{ id: 't3', function_call: { name: 'glob', arguments: '', partial_arguments: null } }] });
  h.flushToolAccum();
  assert.strictEqual(calls.length, 1);
  const args = JSON.parse(calls[0].arguments);
  assert.ok(args.pattern, '应有 pattern');
});

console.log('traffic 日志');
t('sanitize 脱敏 authorization', () => {
  const { sanitize } = require('../log/traffic');
  const s = sanitize({ authorization: 'Bearer secret-token-123456', model: 'glm' });
  assert.ok(!s.authorization.includes('secret-token'));
  assert.strictEqual(s.model, 'glm');
});
t('logRequest 落盘', () => {
  const { logRequest } = require('../log/traffic');
  const seq = logRequest({ endpoint: '/v1/chat/completions', method: 'POST', model: 'test', status: 200, toolCalls: 2, durationMs: 10 });
  assert.ok(seq > 0);
});

console.log('credentials.pool');

const pStore = require('../credentials/store');
const pool = require('../credentials/pool');
const { importAccount } = require('../credentials/import');

t('import storageJsonText 解密并新增账号（不覆盖）', () => {
  const auth = {
    token: 'tok-plain',
    refreshToken: 'rt-plain',
    userId: 'u-import-1',
    expiredAt: '2030-01-01T00:00:00.000Z',
    account: 'import-user',
  };
  const text = JSON.stringify({ 'iCubeAuthInfo://icube.cloudide': JSON.stringify(auth) });
  const a1 = importAccount({ storageJsonText: text, label: 'imp-1' });
  const auth2 = { ...auth, userId: 'u-import-2' };
  const text2 = JSON.stringify({ 'iCubeAuthInfo://icube.cloudide': JSON.stringify(auth2) });
  const a2 = importAccount({ storageJsonText: text2, label: 'imp-2' });
  assert.ok(a1.id !== a2.id, '不同 userId 两次导入应有不同 id');
  assert.strictEqual(a1.label, 'imp-1');
  assert.strictEqual(a2.label, 'imp-2');
  assert.ok(!a1.token, '响应应脱敏无 token');
});

t('导入后 lastCheckin 字段可读', () => {
  const a = pStore.add({ label: 'ci', token: 't' }, 'import');
  const g = pStore.get(a.id);
  assert.strictEqual(g.lastCheckinAt || null, null);
  pStore.update(a.id, { lastCheckinAt: '2026-09-10T12:00:00.000Z', lastCheckinResult: 'claimed' });
  const g2 = pStore.get(a.id);
  assert.strictEqual(g2.lastCheckinResult, 'claimed');
});

t('auth 对象字段（userRegion/host 对象）可入库', () => {
  const r = importAccount({
    authObject: {
      token: 'tok-obj',
      refreshToken: 'rt-obj',
      userRegion: { region: 'CN' },
      host: { name: 'example' },
      userId: 12345,
    },
    label: 'obj-region',
  });
  assert.ok(r.id);
  const g = pStore.get(r.id);
  assert.ok(typeof g.userRegion === 'string');
  assert.ok(String(g.userRegion).indexOf('CN') >= 0);
});

t('同 userId 再次导入不新增行（更新）', () => {
  const a1 = importAccount({
    authObject: { token: 't1', refreshToken: 'r1', userId: 'dup-uid-1' },
    label: 'dup-a',
  });
  const a2 = importAccount({
    authObject: { token: 't2', refreshToken: 'r2', userId: 'dup-uid-1' },
    label: 'dup-b',
  });
  assert.strictEqual(a1.action, 'created');
  assert.strictEqual(a2.action, 'updated');
  assert.strictEqual(a2.id, a1.id);
  const n = pStore.list().filter((a) => String(a.userId) === 'dup-uid-1').length;
  assert.strictEqual(n, 1, '同 userId 应仅一行');
});

t('forceNew 可强制插入同 userId', () => {
  const a1 = importAccount({
    authObject: { token: 't1', refreshToken: 'r1', userId: 'force-uid-1' },
    label: 'force-1',
  });
  const a2 = importAccount({
    authObject: { token: 't2', refreshToken: 'r2', userId: 'force-uid-1' },
    label: 'force-2',
    forceNew: true,
  });
  assert.strictEqual(a1.action, 'created');
  assert.strictEqual(a2.action, 'created');
  assert.notStrictEqual(a1.id, a2.id);
});

t('删除账号', () => {
  const a = pStore.add({ label: 'del-me', token: 'x' }, 'import');
  assert.strictEqual(pStore.remove(a.id), true);
  assert.strictEqual(pStore.get(a.id), null);
});

t('parseEntitlementUsage 汇总 remaining', () => {
  const { parseEntitlementUsage } = require('../upstream/balance');
  const parsed = parseEntitlementUsage({
    is_credits_billing: true,
    usage_summary: { total_amount: 3774.87, consumed_amount: 0 },
    user_entitlement_pack_list: [
      { entitlement_base_info: { quota: { credits_limit: 1000 } }, usage: { credits_amount: 250 } },
    ],
  });
  assert.ok(parsed);
  assert.strictEqual(parsed.source, 'usage_summary');
  assert.strictEqual(parsed.remaining, 3774.87);
  assert.strictEqual(parsed.limit, 3774.87);
  assert.strictEqual(parsed.packs.length, 1);
  assert.strictEqual(parsed.packs[0].remaining, 750);
});

t('parseEntitlementUsage 回退 pack 汇总并忽略过期包', () => {
  const { parseEntitlementUsage } = require('../upstream/balance');
  const nowSec = Math.floor(Date.now() / 1000);
  const parsed = parseEntitlementUsage({
    is_credits_billing: true,
    user_entitlement_pack_list: [
      { status: 1, expire_time: nowSec + 3600, entitlement_base_info: { quota: { credits_limit: 100 } }, usage: { credits_amount: 40 } },
      { status: 1, expire_time: nowSec - 10, entitlement_base_info: { quota: { credits_limit: 999 } }, usage: { credits_amount: 0 } },
      { status: 0, expire_time: nowSec + 3600, entitlement_base_info: { quota: { credits_limit: 888 } }, usage: { credits_amount: 0 } },
    ],
  });
  assert.ok(parsed);
  assert.strictEqual(parsed.source, 'pack_list');
  assert.strictEqual(parsed.remaining, 60);
  assert.strictEqual(parsed.used, 40);
  assert.strictEqual(parsed.packs.length, 1);
});

t('summarizeExpiry 按自然日窗口汇总 3/7 天', () => {
  const { summarizeExpiry } = require('../credentials/credits');
  const now = new Date('2026-05-10T12:00:00');
  const nowMs = now.getTime();
  const dayStart = (offset) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    return Math.floor(d.getTime() / 1000) + 3600 * 10; // 当天 10:00
  };
  const packs = [
    { remaining: 10, expireTime: dayStart(1) },  // 明天 → 3天内
    { remaining: 20, expireTime: dayStart(3) },  // 第3天 → 3天内
    { remaining: 30, expireTime: dayStart(5) },  // 第5天 → 仅7天内
    { remaining: 40, expireTime: dayStart(10) }, // 更远 → 不计入
    { remaining: 5, expireTime: dayStart(0) },   // 今天 → 3天内
  ];
  const r = summarizeExpiry(packs, nowMs);
  assert.strictEqual(r.d3, 35);
  assert.strictEqual(r.d7, 65);
});

t('summarizeExpiry 空列表返回 0', () => {
  const { summarizeExpiry } = require('../credentials/credits');
  assert.deepStrictEqual(summarizeExpiry([]), { d3: 0, d7: 0 });
  assert.deepStrictEqual(summarizeExpiry(null), { d3: 0, d7: 0 });
});

t('roundCredits 消除浮点噪声', () => {
  const { roundCredits } = require('../credentials/credits');
  assert.strictEqual(roundCredits(13215.630000000001), 13215.63);
  assert.strictEqual(roundCredits(4309), 4309);
  assert.strictEqual(roundCredits(null), null);
});

t('选号落在 enabled 账号', () => {
  pStore.add({ label: 'a1', token: 'x', refreshToken: 'r' }, 'import');
  pStore.add({ label: 'a2', token: 'y', enabled: false }, 'import');
  const chosen = pool.pick();
  assert.ok(chosen, '应有可选账号');
  assert.strictEqual(chosen.enabled, true, '应选中 enabled 账号');
});

t('record auth 错误设置冷却', () => {
  const a1 = pStore.list().find((a) => a.label === 'a1');
  pool.record(a1.id, 'auth');
  const a = pStore.get(a1.id);
  assert.ok(a.coolUntil, 'auth 错误后应设置 coolUntil');
  assert.ok(a.errorCount >= 1);
});

t('非 auth 错误直接抛出(不换号)', async () => {
  pStore.add({ label: 'a4', token: 'w', refreshToken: 'rw' }, 'import');
  const n5 = new Error('server boom');
  n5.status = 500;
  let calls = 0;
  await assert.rejects(
    pool.run(async () => { calls += 1; throw n5; }, { maxSwitches: 3 })
  );
  assert.strictEqual(calls, 1, '5xx 非可换号错误应直接抛出，只调用一次');
});

t('rate_limit 触发账号池轮换并对账号冷却', async () => {
  const a = pStore.add({ label: 'rl-a', token: 'r1' }, 'import');
  const b = pStore.add({ label: 'rl-b', token: 'r2' }, 'import');
  const tried = [];
  await assert.rejects(
    pool.run(async (id) => { tried.push(id); const e = new Error('limited'); e.upstreamCode = 3004; throw e; }, { maxSwitches: 3 })
  );
  assert.ok(tried.length >= 2, `应轮换尝试多个账号，实际尝试: ${tried.join(',')}`);
  for (const id of tried) {
    const g = pStore.get(id);
    assert.ok(g.coolUntil && pool.inCooldown(g), `${id} 应进入冷却`);
  }
  for (const id of [a.id, b.id]) pStore.remove(id);
});

t('record ok 清零 errorCount', () => {
  pStore.add({ label: 'a3', token: 'z', refreshToken: 'rr' }, 'import');
  const a3 = pStore.list().find((a) => a.label === 'a3');
  pStore.update(a3.id, { errorCount: 5, coolUntil: new Date(Date.now() + 60000).toISOString() });
  pool.record(a3.id, 'ok');
  const after = pStore.get(a3.id);
  assert.strictEqual(after.errorCount, 0);
  assert.strictEqual(after.coolUntil, null);
});

t('设备重置：gen 自增且指纹更换', () => {
  const { resetAccountDevices } = require('../credentials/import');
  const a = pStore.add({ label: 'dev-reset', token: 'dr' }, 'import');
  const before = pStore.get(a.id);
  const r = resetAccountDevices(a.id);
  const after = pStore.get(a.id);
  assert.strictEqual(r.deviceGen, 1);
  assert.strictEqual(after.deviceGen, 1);
  assert.notStrictEqual(after.devices.machineId, (before.devices && before.devices.machineId) || '', 'machineId 应更换');
  assert.ok(after.devices.machineId, '新指纹非空');
  pStore.remove(a.id);
});

t('分组：PATCH 白名单 + 分组过滤', () => {
  const a = pStore.add({ label: 'grp-a', token: 'g1', group: 'work' }, 'import');
  const b = pStore.add({ label: 'grp-b', token: 'g2', group: 'home' }, 'import');
  pStore.update(b.id, { group: null });
  assert.strictEqual(pStore.get(a.id).group, 'work');
  assert.strictEqual(pStore.get(b.id).group, null);
  process.env.POOL_GROUPS = 'work';
  try {
    const picked = pool.pick(null, { exclude: [] });
    // 只允许 work 组：若选到账号必属 work 组（可能为 null——池内其它测试账号无分组且会被排除）
    if (picked) assert.strictEqual(picked.group, 'work');
  } finally {
    delete process.env.POOL_GROUPS;
    pStore.remove(a.id);
    pStore.remove(b.id);
  }
});

t('积分快照：差分统计消耗', () => {
  const ch = require('../credentials/credit-history');
  const a = pStore.add({ label: 'ch-a', token: 'c1' }, 'import');
  ch.add(a.id, { remaining: 1000, used: 0, source: 'test' });
  ch.add(a.id, { remaining: 940, used: 60, source: 'test' });
  ch.add(a.id, { remaining: 960, used: 60, source: 'test' }); // 余额上涨不计消耗
  ch.add(a.id, { remaining: 900, used: 120, source: 'test' });
  const row = ch.summary(1).find((d) => d.accountId === a.id);
  assert.strictEqual(row.todayUsed, 120); // (1000-940) + (960-900)，上涨不计
  assert.strictEqual(row.snapshots, 4);
  assert.strictEqual(row.latestRemaining, 900);
  pStore.remove(a.id);
});

t('least_balance 优先选余额更高账号', () => {
  const low = pStore.add({ label: 'bal-low', token: 'l', balance: 10 }, 'import');
  const high = pStore.add({ label: 'bal-high', token: 'h', balance: 9999 }, 'import');
  // 禁用其它 enabled 以免干扰
  for (const a of pStore.list()) {
    if (a.id !== low.id && a.id !== high.id) pStore.update(a.id, { enabled: false });
  }
  pStore.update(low.id, { lastPickedAt: 0, coolUntil: null, enabled: true });
  pStore.update(high.id, { lastPickedAt: 0, coolUntil: null, enabled: true });
  const chosen = pool.pick(null, { exclude: [] });
  assert.ok(chosen);
  assert.strictEqual(chosen.id, high.id, '应选中余额更高的账号');
  // 恢复
  pStore.update(high.id, { enabled: false });
  pStore.update(low.id, { enabled: false });
});

// packSec：指定第 offset 天 10:00 到期的秒级时间戳
const packSec = (offset) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return Math.floor(d.getTime() / 1000) + 3600 * 10;
};

t('least_balance 临期账号优先于余额更高账号（FEFO）', () => {
  const far = pStore.add({ label: 'bal-far', token: 'f', balance: 9999, entitlementSnapshot: { packs: [{ name: 'far', expireTime: packSec(30), remaining: 9999 }] } }, 'import');
  const near = pStore.add({ label: 'bal-near', token: 'n', balance: 50, entitlementSnapshot: { packs: [{ name: 'near', expireTime: packSec(1), remaining: 50 }] } }, 'import');
  for (const a of pStore.list()) {
    if (a.id !== far.id && a.id !== near.id) pStore.update(a.id, { enabled: false });
  }
  pStore.update(far.id, { lastPickedAt: 0, coolUntil: null, enabled: true });
  pStore.update(near.id, { lastPickedAt: 0, coolUntil: null, enabled: true });
  const chosen = pool.pick(null, { exclude: [] });
  assert.ok(chosen);
  assert.strictEqual(chosen.id, near.id, '临期积分账号应优先于余额更高的账号');
  pStore.update(far.id, { enabled: false });
  pStore.update(near.id, { enabled: false });
  pStore.remove(far.id);
  pStore.remove(near.id);
});

t('least_balance d3 临期优先级高于 d7（更近作废窗口先消耗）', () => {
  const d7only = pStore.add({ label: 'd7', token: 'd7', balance: 400, entitlementSnapshot: { packs: [{ name: 'p7', expireTime: packSec(6), remaining: 400 }] } }, 'import');
  const d3only = pStore.add({ label: 'd3', token: 'd3', balance: 50, entitlementSnapshot: { packs: [{ name: 'p3', expireTime: packSec(1), remaining: 50 }] } }, 'import');
  for (const a of pStore.list()) {
    if (a.id !== d7only.id && a.id !== d3only.id) pStore.update(a.id, { enabled: false });
  }
  pStore.update(d7only.id, { lastPickedAt: 0, coolUntil: null, enabled: true });
  pStore.update(d3only.id, { lastPickedAt: 0, coolUntil: null, enabled: true });
  const chosen = pool.pick(null, { exclude: [] });
  assert.ok(chosen);
  assert.strictEqual(chosen.id, d3only.id, '3 天内到期应先于仅 7 天内到期消耗');
  pStore.update(d7only.id, { enabled: false });
  pStore.update(d3only.id, { enabled: false });
  pStore.remove(d7only.id);
  pStore.remove(d3only.id);
});

t('quota 错误硬冷却到次日', () => {
  const a = pStore.add({ label: 'quota-a', token: 'q' }, 'import');
  pool.record(a.id, 'quota');
  const after = pStore.get(a.id);
  assert.ok(after.coolUntil, '应有 coolUntil');
  assert.ok(pool.inCooldown(after));
});

// ===== 模型级冷却 + 429 退避（P0-1/P0-2）=====
t('parseRateLimitReset 解析中文 UTC+8 恢复时刻', () => {
  const { parseRateLimitReset } = require('../upstream/errors');
  const iso = parseRateLimitReset('您的使用量已超出频率限制，将在 2026-09-29 20:48:47 UTC+8 重置，您也可以切换其他模型继续使用。');
  assert.ok(iso, '应解析出时刻');
  // 2026-09-29 20:48:47 UTC+8 == 12:48:47Z
  assert.strictEqual(iso, '2026-09-29T12:48:47.000Z');
});

t('parseRateLimitReset 解析英文 reset at（按 UTC）', () => {
  const { parseRateLimitReset } = require('../upstream/errors');
  const iso = parseRateLimitReset('usage will reset at 2026-10-04 23:00:00');
  assert.strictEqual(iso, '2026-10-04T23:00:00.000Z');
  assert.strictEqual(parseRateLimitReset('no timestamp here'), null);
  assert.strictEqual(parseRateLimitReset(''), null);
});

t('model 级限流只冷 (账号,模型)，其他模型仍可被 pick', () => {
  const a = pStore.add({ label: 'mc-a', token: 't' }, 'import');
  pool.record(a.id, 'model', { model: 'kimi-k3' });
  const after = pStore.get(a.id);
  assert.ok(!after.coolUntil, '不应整号冷却');
  assert.ok(pool.modelCooling(after, 'kimi-k3'), '该模型应在冷却');
  assert.strictEqual(pool.modelCooling(after, 'glm-5.3'), false, '其他模型不受影响');
  // pick 该模型时应跳过此账号
  const got = pool.pick(null, { model: 'kimi-k3' });
  if (got) assert.notStrictEqual(got.id, a.id, '冷却中的模型不应被选中');
  pStore.remove(a.id);
});

t('model 级限流解析到精确恢复时刻则用精确值', () => {
  const a = pStore.add({ label: 'mc-b', token: 't' }, 'import');
  pool.record(a.id, 'model', { model: 'm1', message: '将在 2030-01-01 00:00:00 UTC+8 重置' });
  const after = pStore.get(a.id);
  assert.strictEqual(after.modelCooldowns.m1, '2029-12-31T16:00:00.000Z');
  pStore.remove(a.id);
});

t('rate_limit 无精确时刻时指数退避（连续翻倍，封顶 RATE_COOLDOWN_MAX_MS）', () => {
  const a = pStore.add({ label: 'bl-a', token: 't' }, 'import');
  const base = 20000;
  pool.record(a.id, 'rate_limit', { model: 'm-x' });
  let cur = pStore.get(a.id);
  const wait1 = new Date(cur.coolUntil).getTime() - Date.now();
  assert.ok(wait1 > base * 0.8 && wait1 <= base + 1000, `第一次应约等于基数，实际 ${wait1}ms`);
  // 连续第二次：带 model 时模型冷却翻倍（账号级不动，因模型维度已有精确路径外退避）
  pool.record(a.id, 'rate_limit', { model: 'm-x' });
  pool.record(a.id, 'rate_limit', { model: 'm-x' });
  cur = pStore.get(a.id);
  assert.ok(cur.modelCooldowns && cur.modelCooldowns['m-x'], '模型冷却应存在');
  pStore.remove(a.id);
});

t('rate_limit 带精确恢复时刻且无 model：整号冷到精确时刻', () => {
  const a = pStore.add({ label: 'bl-b', token: 't' }, 'import');
  pool.record(a.id, 'rate_limit', { message: 'usage will reset at 2030-01-01 00:00:00' });
  const after = pStore.get(a.id);
  assert.strictEqual(after.coolUntil, '2030-01-01T00:00:00.000Z');
  pStore.remove(a.id);
});

t('record ok 清除限流计数与过期模型冷却', () => {
  const a = pStore.add({ label: 'bl-c', token: 't' }, 'import');
  pool.record(a.id, 'rate_limit', { model: 'm1' });
  pool.record(a.id, 'ok');
  const after = pStore.get(a.id);
  assert.strictEqual(after.rateStreak || 0, 0, 'ok 应清零 rateStreak');
  assert.strictEqual(after.coolUntil, null);
  pStore.remove(a.id);
});
// ===== 模型级冷却 + 429 退避 结束 =====

t('sticky 映射绑定与查询', () => {
  const sticky = require('../session/sticky');
  sticky.bind('sess-1', 'acct_test');
  assert.strictEqual(sticky.lookup('sess-1'), 'acct_test');
  sticky.unbind('sess-1');
  assert.strictEqual(sticky.lookup('sess-1'), null);
});

t('classifyError 识别 quota', () => {
  const e = new Error('quota exhausted');
  e.status = 402;
  assert.strictEqual(classifyError(e), 'quota');
});

// checkin 批次拆分依赖 store；真实网络不在单测内。
t('checkin 模块导出', () => {
  const c = require('../upstream/checkin');
  assert.strictEqual(typeof c.checkinAccount, 'function');
  assert.strictEqual(typeof c.checkinAllEnabled, 'function');
});

t('wb-checkin 模块导出与 already 判定', () => {
  const w = require('../upstream/wb-checkin');
  assert.strictEqual(typeof w.wbCheckinAccount, 'function');
  assert.strictEqual(typeof w.wbCheckinAllEnabled, 'function');
  assert.strictEqual(w.isAlreadyResult({ code: 10001 }), true);
  assert.strictEqual(w.isAlreadyResult({ reason: '今天已签到' }), true);
  assert.strictEqual(w.isAlreadyResult({ alreadyCheckedIn: true }), true);
  assert.strictEqual(w.isAlreadyResult({ reason: 'network error' }), false);
  assert.strictEqual(w.isWorkbuddy({ edition: 'workbuddy' }), true);
  assert.strictEqual(w.isWorkbuddy({ edition: 'cn' }), false);
});

t('workbuddy parseCycleTime 解析毫秒与字符串', () => {
  const { parseCycleTime } = require('../workbuddy/auth');
  assert.strictEqual(parseCycleTime(1760000000000), 1760000000000);
  const s = parseCycleTime('2026-09-17 10:06:25');
  assert.ok(typeof s === 'number' && s > 0);
});

t('routes/workbuddy 跨机导入拒绝 $wbEncrypted 加密 token（不得入库 [object Object]）', () => {
  // 静态校验防护判定式存在（引入 index 会启动服务，不适合单测）
  const { readFileSync } = require('fs');
  const src = readFileSync(require.resolve('../routes/workbuddy'), 'utf8');
  assert.ok(src.includes('$wbEncrypted'), '导入端点必须检测 $wbEncrypted 对象');
  assert.ok(src.includes('WB_TOKEN_ENCRYPTED'), '拒绝响应必须携带 WB_TOKEN_ENCRYPTED 错误码');
  // plainToken（本机抓取路径的既有防护）依旧把加密对象归一为 null
  const { readAuthFile } = require('../workbuddy/auth');
  assert.strictEqual(typeof readAuthFile, 'function');
});

t('pickCheckinFields 以 checked_in 为准并识别业务码', () => {
  const { pickCheckinFields, CODE_ALREADY } = require('../upstream/checkin');
  const s = pickCheckinFields({
    checked_in: false,
    did_checked_in: true,
    enable: true,
    credits: 150,
    code: 0,
    message: 'success',
  });
  assert.strictEqual(s.checkedIn, false);
  assert.strictEqual(s.code, 0);
  assert.strictEqual(s.credits, 150);

  const done = pickCheckinFields({ checked_in: true, code: 0, message: 'success' });
  assert.strictEqual(done.checkedIn, true);

  const claim = pickCheckinFields({
    code: CODE_ALREADY,
    message: '当前设备今日已经签到，请明日再来哦～',
  });
  assert.strictEqual(claim.code, CODE_ALREADY);
  assert.notStrictEqual(claim.code, 0);
});

t('import genDevices 生成独立指纹', () => {
  const { genDevices } = require('../credentials/import');
  const a = genDevices('acct-a');
  const b = genDevices('acct-b');
  assert.ok(a.machineId && a.devDeviceId && a.deviceId);
  assert.notStrictEqual(a.machineId, b.machineId);
  assert.notStrictEqual(a.deviceId, b.deviceId);
  assert.notStrictEqual(a.machineId, b.machineId);
});

t('import devicesFromStorage 抽取 telemetry', () => {
  const { devicesFromStorage } = require('../credentials/import');
  const d = devicesFromStorage({
    'telemetry.machineId': 'm-1',
    'telemetry.sqmId': 's-1',
    'telemetry.devDeviceId': 'd-1',
  }, 'u1');
  assert.strictEqual(d.machineId, 'm-1');
  assert.strictEqual(d.devDeviceId, 'd-1');
  assert.strictEqual(d.sqmId, 's-1');
  assert.ok(d.deviceId);
});

t('model availability 默认 unknown', () => {
  const av = require('../models/availability');
  assert.strictEqual(av.statusOf('no-such-model-xyz'), 'unknown');
  av.markUnavailable('no-such-model-xyz', 'test 4001');
  assert.strictEqual(av.statusOf('no-such-model-xyz'), 'unavailable');
  assert.ok(av.isHidden('no-such-model-xyz'));
  av.reset('no-such-model-xyz');
  assert.strictEqual(av.statusOf('no-such-model-xyz'), 'unknown');
});

t('buildBody 尊重 upstreamFunction 覆盖', () => {
  process.env.TRAE_UPSTREAM_FUNCTION = 'solo_work_lite';
  // config 已加载时不会热更；直接测 options.function 优先级
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../upstream/client')];
  const cfg = require('../config');
  assert.strictEqual(cfg.upstreamFunction, 'solo_work_lite');
  const { buildBody } = require('../upstream/client');
  const body = buildBody([{ role: 'user', content: 'hi' }], 'auto', true, {});
  assert.strictEqual(body.function, 'solo_work_lite');
  delete process.env.TRAE_UPSTREAM_FUNCTION;
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../upstream/client')];
});

t('priority 置顶优先于余额', () => {
  const pStore = require('../credentials/store');
  const pool = require('../credentials/pool');
  const low = pStore.add({ label: 'pri-low', token: 't', balance: 100 }, 'import');
  const high = pStore.add({ label: 'pri-high', token: 't', balance: 10, priority: 5 }, 'import');
  const picked = pool.pick();
  assert.ok(picked, 'should pick an account');
  assert.strictEqual(picked.id, high.id, 'priority should win over balance');
  pStore.remove(low.id);
  pStore.remove(high.id);
});

t('explainCandidates 标记冷却与禁用', () => {
  const pStore = require('../credentials/store');
  const { explainCandidates } = require('../credentials/pool');
  const off = pStore.add({ label: 'rc-off', token: 't', enabled: false }, 'import');
  const cool = pStore.add({
    label: 'rc-cool',
    token: 't',
    coolUntil: new Date(Date.now() + 3600000).toISOString(),
  }, 'import');
  const rows = explainCandidates();
  const offRow = rows.find((r) => r.id === off.id);
  const coolRow = rows.find((r) => r.id === cool.id);
  assert.ok(offRow.reasons.includes('disabled'));
  assert.ok(coolRow.reasons.includes('cooling'));
  assert.strictEqual(offRow.usable, false);
  pStore.remove(off.id);
  pStore.remove(cool.id);
});

t('notify 未配置时直接关闭', () => {
  const fs = require('fs');
  const n = require('../notify');
  const settings = require('../notify/settings');
  // 路径取自模块导出：状态文件已随 WORKSPACE_DIR 走，测试不再触碰仓库内文件
  const file = settings.FILE;
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
  // 清空渠道字段，隔离本机真实配置
  settings.save({
    webhookUrl: '',
    serverChanSendKey: '',
    pushPlusToken: '',
    telegramBotToken: '',
    telegramChatId: '',
  });
  try {
    assert.strictEqual(n.enabled(), false);
  } finally {
    if (backup != null) fs.writeFileSync(file, backup, 'utf-8');
    else if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

t('sticky listSafe 不暴露完整 key', () => {
  const sticky = require('../session/sticky');
  sticky.bind('secret-sticky-key-abcdef', 'acct_x');
  const list = sticky.listSafe();
  const row = list.find((r) => r.accountId === 'acct_x');
  assert.ok(row);
  assert.ok(!('key' in row));
  assert.strictEqual(row.keyTail.length, 6);
  sticky.unbind('secret-sticky-key-abcdef');
});

t('api-keys 创建/校验/禁用/删除（按平台绑定）', () => {
  const keys = require('../credentials/api-keys');
  const created = keys.createKey({ label: 'unit-wb', platform: 'workbuddy' });
  assert.ok(created.key && created.key.startsWith('sk-'));
  assert.strictEqual(created.platform, 'workbuddy');

  const rec = keys.verifyKey(created.key);
  assert.ok(rec);
  assert.strictEqual(rec.platform, 'workbuddy');

  keys.updateKey(created.id, { enabled: false });
  assert.strictEqual(keys.verifyKey(created.key), null);

  keys.updateKey(created.id, { enabled: true });
  assert.ok(keys.verifyKey(created.key));

  assert.strictEqual(keys.deleteKey(created.id), true);
  assert.strictEqual(keys.verifyKey(created.key), null);
});

t('api-keys 拒绝非法 platform', () => {
  const keys = require('../credentials/api-keys');
  assert.throws(() => keys.createKey({ platform: 'openai' }), /invalid platform/);
});

t('api-keys 支持通用密钥 platform=all，且 scope=universal', () => {
  const keys = require('../credentials/api-keys');
  const created = keys.createKey({ label: 'unit-all', platform: 'all' });
  assert.strictEqual(created.platform, 'all');
  const rec = keys.verifyKey(created.key);
  assert.strictEqual(rec.scope, 'universal');
  keys.deleteKey(created.id);
});

t('model-access：虚拟模型放行进路由层；物理模型仍按平台限制', () => {
  const { canUseModel, providerAllowedForKey } = require('../middleware/model-access');
  const store = require('../model-router/store');
  const mr = require('../model-router');
  store.upsertVirtual('vm/perm-test', {
    strategy: 'priority',
    candidates: [
      { id: 't', provider: 'trae', model: 'glm-5.3', priority: 1 },
      { id: 'w', provider: 'workbuddy', model: 'glm-5.3', priority: 2 },
    ],
  });
  assert.strictEqual(canUseModel('trae', 'vm/perm-test').ok, true);
  assert.strictEqual(canUseModel('workbuddy', 'vm/perm-test').ok, true);
  assert.strictEqual(canUseModel('all', 'vm/perm-test').ok, true);
  assert.strictEqual(canUseModel('trae', 'wb/glm-5.3').ok, false);
  assert.strictEqual(canUseModel('workbuddy', 'wb/glm-5.3').ok, true);

  const vm = store.getVirtual('vm/perm-test');
  const traeOnly = mr.orderCandidates('vm/perm-test', vm, 'trae');
  assert.strictEqual(traeOnly.length, 1);
  assert.strictEqual(traeOnly[0].id, 't');
  const wbOnly = mr.orderCandidates('vm/perm-test', vm, 'workbuddy');
  assert.strictEqual(wbOnly.length, 1);
  assert.strictEqual(wbOnly[0].id, 'w');
  assert.strictEqual(mr.orderCandidates('vm/perm-test', vm, 'all').length, 2);

  assert.strictEqual(providerAllowedForKey({ type: 'openai', builtin: null }, 'trae'), false);
  assert.strictEqual(providerAllowedForKey({ type: 'builtin', builtin: 'trae' }, 'trae'), true);
  store.removeVirtual('vm/perm-test');
});

t('scope ACL：资源通配与拒绝', () => {
  const { authorize, modelResourcePath, canInvokeModel } = require('../auth/scope');
  assert.strictEqual(modelResourcePath('glm-5.3', { platform: 'trae' }), 'model:trae/glm-5.3');
  assert.strictEqual(modelResourcePath('vm/x', { virtual: true }), 'model:virtual/vm/x');
  assert.strictEqual(modelResourcePath('wb/glm-5.3', {}), 'model:workbuddy/glm-5.3');
  const key = { scopes: ['models:invoke'], resources: ['model:workbuddy/*'] };
  assert.strictEqual(canInvokeModel(key, 'wb/glm-5.3').ok, true);
  assert.strictEqual(canInvokeModel(key, 'glm-5.3').ok, false);
  assert.strictEqual(authorize(key, { scope: 'models:read', resource: 'x' }).ok, false);
});

t('密钥生命周期：默认 scope/过期、撤销、轮换宽限', () => {
  const keys = require('../credentials/api-keys');
  const created = keys.createKey({
    label: 'life',
    platform: 'workbuddy',
    resources: ['model:workbuddy/*', 'model:virtual:vm/wb-chat'],
    rpmLimit: 30,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  assert.deepStrictEqual(created.scopes, ['models:invoke']);
  assert.ok(created.resources.includes('model:virtual:vm/wb-chat'));
  assert.strictEqual(created.rpmLimit, 30);
  assert.strictEqual(created.status, 'active');
  assert.strictEqual(created.keyType, 'dedicated');

  const rotated = keys.rotateKey(created.id, { graceMs: 60_000 });
  assert.ok(rotated && rotated.newKey.key);
  assert.strictEqual(rotated.newKey.rotatedFrom, created.id);
  // 旧密钥宽限期内仍可用
  assert.ok(keys.verifyKey(created.key));
  // 新密钥继承资源
  assert.ok(rotated.newKey.resources.includes('model:virtual:vm/wb-chat'));

  assert.strictEqual(keys.revokeKey(rotated.newKey.id), true);
  assert.strictEqual(keys.verifyKey(rotated.newKey.key), null);
  assert.strictEqual(keys.getKey(rotated.newKey.id).status, 'revoked');

  keys.deleteKey(created.id);
  keys.deleteKey(rotated.newKey.id);
});

t('密钥过期后不可鉴权', () => {
  const keys = require('../credentials/api-keys');
  const created = keys.createKey({
    label: 'exp',
    platform: 'trae',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.strictEqual(keys.verifyKey(created.key), null);
  keys.deleteKey(created.id);
});

t('catalog-meta 指纹与增量 diff', () => {
  const meta = require('../models/catalog-meta');
  const a = meta.normalizeMeta('p1', { id: 'm1', display_name: 'M1', rate: 2 });
  const b = meta.normalizeMeta('p1', { id: 'm1', display_name: 'M1', rate: 3 });
  assert.notStrictEqual(a.fingerprint, b.fingerprint);
  meta.upsertMeta(a);
  const diff = meta.diffAgainst('p1', [b, meta.normalizeMeta('p1', { id: 'm2' })]);
  assert.strictEqual(diff.changed.length, 1);
  assert.strictEqual(diff.added.length, 1);
  const applied = meta.applyDiff('p1', diff);
  assert.strictEqual(applied.added, 1);
  assert.strictEqual(applied.changed, 1);
  const diff2 = meta.diffAgainst('p1', []);
  assert.strictEqual(diff2.removed.length, 2);
  meta.applyDiff('p1', diff2);
  const rows = meta.listMeta('p1');
  assert.ok(rows.every((r) => r.lifecycle === 'deprecated'));
});

t('audit 写入可查询', () => {
  const audit = require('../log/audit');
  audit.audit({ action: 'test.action', result: 'ok', resource: 'model:x', actorKeyId: 'k1' });
  const rows = audit.query({ action: 'test.action', limit: 5 });
  assert.ok(rows.length >= 1);
  assert.strictEqual(rows[0].action, 'test.action');
});

t('登录密钥不能当转发 access key', () => {
  const keys = require('../credentials/api-keys');
  const login = keys.createKey({ label: 'login-only', kind: 'login' });
  assert.strictEqual(keys.verifyAccessKey(login.key), null);
  assert.ok(keys.verifyLoginKey(login.key));
  keys.deleteKey(login.id);
});

t('sanitizeUsage 只保留官方三字段', () => {
  const { sanitizeUsage } = require('../model-router/dispatch');
  const u = sanitizeUsage({
    prompt_tokens: 5,
    completion_tokens: 10,
    total_tokens: 15,
    credit: 0,
    prompt_cache_hit_tokens: 1,
    completion_tokens_details: { reasoning_tokens: 2 },
  });
  assert.deepStrictEqual(u, { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 });
});

t('writeCompletionChunks 输出合法 SSE（含 choices，usage 仅在末帧）', () => {
  const { writeCompletionChunks } = require('../model-router/dispatch');
  const chunks = [];
  const res = {
    writableEnded: false,
    headersSent: true,
    write(s) { chunks.push(s); return true; },
    end() { this.writableEnded = true; },
  };
  writeCompletionChunks(res, {
    id: 'chatcmpl-x',
    object: 'chat.completion',
    created: 1,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: '测试完成' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, credit: 9 },
  }, 'vm/unified-chat');
  const datas = chunks.filter((c) => c.startsWith('data: ')).map((c) => c.slice(6).trim());
  assert.strictEqual(datas[datas.length - 1], '[DONE]');
  for (const d of datas.slice(0, -1)) {
    const o = JSON.parse(d);
    assert.strictEqual(o.object, 'chat.completion.chunk');
    assert.ok(Array.isArray(o.choices) && o.choices.length === 1, '每个 chunk 必须有 choices');
    assert.strictEqual(o.model, 'vm/unified-chat');
    if (o.usage) {
      assert.deepStrictEqual(o.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    }
  }
  // role → content → finish(+usage)
  assert.deepStrictEqual(JSON.parse(datas[0]).choices[0].delta, { role: 'assistant' });
  assert.strictEqual(JSON.parse(datas[1]).choices[0].delta.content, '测试完成');
  assert.strictEqual(JSON.parse(datas[2]).choices[0].finish_reason, 'stop');
  assert.ok(JSON.parse(datas[2]).usage);
});

t('writeCompletionChunks：有 tool_calls 时 finish_reason 必须是 tool_calls（即使上游写 stop）', () => {
  const { writeCompletionChunks } = require('../model-router/dispatch');
  const chunks = [];
  const res = {
    writableEnded: false,
    headersSent: true,
    write(s) { chunks.push(s); return true; },
    end() { this.writableEnded = true; },
  };
  writeCompletionChunks(res, {
    id: 'chatcmpl-t',
    object: 'chat.completion',
    created: 1,
    model: 'm',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: '我先看下文件',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }],
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  }, 'vm/unified-chat');
  const datas = chunks.filter((c) => c.startsWith('data: ')).map((c) => c.slice(6).trim());
  const parsed = datas.filter((d) => d !== '[DONE]').map((d) => JSON.parse(d));
  const finishChunk = parsed.find((o) => o.choices[0].finish_reason);
  assert.strictEqual(finishChunk.choices[0].finish_reason, 'tool_calls');
  assert.strictEqual(parsed.filter((o) => o.choices[0].finish_reason).length, 1, '只应有一个 finish 帧');
});

t('resolveStreamFinish：有 tool_calls 时不得回落 stop', () => {
  const { resolveStreamFinish } = require('../model-router/dispatch');
  assert.strictEqual(resolveStreamFinish({ sawToolCalls: true, lastFinish: 'stop' }), 'tool_calls');
  assert.strictEqual(resolveStreamFinish({ sawToolCalls: true, lastFinish: null }), 'tool_calls');
  assert.strictEqual(resolveStreamFinish({ sawToolCalls: true, lastFinish: 'tool_calls' }), 'tool_calls');
  assert.strictEqual(resolveStreamFinish({ sawToolCalls: false, lastFinish: 'stop' }), 'stop');
  assert.strictEqual(resolveStreamFinish({ sawToolCalls: false, lastFinish: null }), 'stop');
  assert.strictEqual(resolveStreamFinish({ sawToolCalls: false, lastFinish: 'length' }), 'length');
});

t('isTruncatedFinish：识别截断类结束原因（截断优先于 tool_calls）', () => {
  const { isTruncatedFinish, resolveStreamFinish } = require('../model-router/dispatch');
  assert.strictEqual(isTruncatedFinish('length'), true);
  assert.strictEqual(isTruncatedFinish('max_tokens'), true);
  assert.strictEqual(isTruncatedFinish('content_filter'), true);
  assert.strictEqual(isTruncatedFinish('stop'), false);
  assert.strictEqual(isTruncatedFinish('tool_calls'), false);
  assert.strictEqual(isTruncatedFinish(null), false);
  // 核心回归：tool_calls 存在时截断信号仍须胜出，否则客户端会执行残缺工具调用
  assert.strictEqual(resolveStreamFinish({ sawToolCalls: true, lastFinish: 'length' }), 'length');
  assert.strictEqual(resolveStreamFinish({ sawToolCalls: true, lastFinish: 'max_tokens' }), 'max_tokens');
  assert.strictEqual(resolveStreamFinish({ sawToolCalls: true, lastFinish: 'content_filter' }), 'content_filter');
});

t('writeCompletionChunks：工具被截断时不得报 tool_calls', () => {
  const { writeCompletionChunks } = require('../model-router/dispatch');
  const chunks = [];
  const res = {
    writableEnded: false,
    headersSent: true,
    write(s) { chunks.push(s); return true; },
    end() { this.writableEnded = true; },
  };
  writeCompletionChunks(res, {
    id: 'chatcmpl-trunc',
    object: 'chat.completion',
    created: 1,
    model: 'm',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a"' } }],
      },
      finish_reason: 'length',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }, 'vm/unified-chat');
  const parsed = chunks.filter((c) => c.startsWith('data: ')).map((c) => c.slice(6).trim())
    .filter((d) => d !== '[DONE]').map((d) => JSON.parse(d));
  const fin = parsed.find((o) => o.choices[0].finish_reason);
  assert.strictEqual(fin.choices[0].finish_reason, 'length', '截断必须透传，不得被 tool_calls 覆盖');
});

t('createStreamHandler：参数残缺的工具调用置 sawIncompleteToolArgs（B2 依据）', () => {
  const { createStreamHandler } = require('../transform/sse');
  const events = [];
  const handler = createStreamHandler((e) => events.push(e), { userText: '' });
  // 半截 JSON：有键值骨架但解析不出对象
  handler.feedLine('event: output');
  handler.feedLine('data: ' + JSON.stringify({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: '{"path":"out.txt","cont' } }] }));
  handler.flushToolAccum();
  assert.strictEqual(handler.sawIncompleteToolArgs(), true, '半截参数应置位');
  const call = events.find((e) => e.type === 'tool_call');
  assert.ok(call, '工具调用仍应发出（不丢弃）');
  // 默认不注入标记（避免严格 schema 客户端不认额外键），但行为判定仍生效
  assert.strictEqual(call.call.arguments, '{}', '默认应给合法空对象，不注入 __incomplete');

  // 完整参数不应置位
  const h2 = createStreamHandler(() => {}, { userText: '' });
  h2.feedLine('event: output');
  h2.feedLine('data: ' + JSON.stringify({ tool_calls: [{ index: 0, id: 'c2', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] }));
  h2.flushToolAccum();
  assert.strictEqual(h2.sawIncompleteToolArgs(), false, '完整参数不应置位');

  // 显式空对象不算残缺
  const h3 = createStreamHandler(() => {}, { userText: '' });
  h3.feedLine('event: output');
  h3.feedLine('data: ' + JSON.stringify({ tool_calls: [{ index: 0, id: 'c3', function: { name: 'list_dir', arguments: '{}' } }] }));
  h3.flushToolAccum();
  assert.strictEqual(h3.sawIncompleteToolArgs(), false, '空对象不算残缺');

  // markIncomplete=true 时才注入诊断标记
  const h4 = createStreamHandler(() => {}, { userText: '', markIncomplete: true });
  h4.feedLine('event: output');
  h4.feedLine('data: ' + JSON.stringify({ tool_calls: [{ index: 0, id: 'c4', function: { name: 'write_file', arguments: '{"path":"o.tx' } }] }));
  h4.flushToolAccum();
  assert.strictEqual(h4.sawIncompleteToolArgs(), true, '开启开关时仍应置位');
});

t('continue：shouldContinue 仅对输出上限类结束原因触发', () => {
  const { shouldContinue } = require('../transform/continue');
  assert.strictEqual(shouldContinue('length'), true);
  assert.strictEqual(shouldContinue('max_tokens'), true);
  assert.strictEqual(shouldContinue('stop'), false);
  assert.strictEqual(shouldContinue('tool_calls'), false);
  // content_filter 是内容策略拦截，重试不会改变结果
  assert.strictEqual(shouldContinue('content_filter'), false);
  assert.strictEqual(shouldContinue(null), false);
});

t('continue：buildContinueMessages 追加 assistant 产出与续写指令', () => {
  const { buildContinueMessages, CONTINUE_PROMPT } = require('../transform/continue');
  const msgs = [{ role: 'user', content: 'q' }];
  const out = buildContinueMessages(msgs, '已输出内容');
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[1].role, 'assistant');
  assert.strictEqual(out[1].content, '已输出内容');
  assert.strictEqual(out[2].role, 'user');
  assert.strictEqual(out[2].content, CONTINUE_PROMPT);
  assert.strictEqual(msgs.length, 1, '不得修改原数组');
  assert.strictEqual(buildContinueMessages(msgs, '').length, 1, '无产出时不追加');
});

t('continue：截断时续写直到正常结束，并累计内容', async () => {
  const { runWithContinuation } = require('../transform/continue');
  let round = 0;
  const r = await runWithContinuation({
    messages: [{ role: 'user', content: 'q' }],
    maxContinues: 5,
    callOnce: async () => {
      round++;
      if (round === 1) return { content: 'A', finishReason: 'length', toolCalls: [], usage: { total_tokens: 1 } };
      if (round === 2) return { content: 'B', finishReason: 'length', toolCalls: [], usage: { total_tokens: 2 } };
      return { content: 'C', finishReason: 'stop', toolCalls: [], usage: { total_tokens: 3 } };
    },
  });
  assert.strictEqual(r.content, 'ABC');
  assert.strictEqual(r.continues, 2);
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.usage.total_tokens, 3, 'usage 取最后一轮');
});

t('continue：达到上限仍截断则如实标记 truncated', async () => {
  const { runWithContinuation } = require('../transform/continue');
  let calls = 0;
  const r = await runWithContinuation({
    messages: [],
    maxContinues: 2,
    callOnce: async () => { calls++; return { content: 'X', finishReason: 'length', toolCalls: [], usage: null }; },
  });
  assert.strictEqual(calls, 3, '首次 + 2 次续写');
  assert.strictEqual(r.content, 'XXX');
  assert.strictEqual(r.continues, 2);
  assert.strictEqual(r.truncated, true, '未收敛时必须如实标记，不得假装完整');
});

t('continue：maxContinues=0 不续写，且工具轮不续写', async () => {
  const { runWithContinuation } = require('../transform/continue');
  let calls = 0;
  const r0 = await runWithContinuation({
    messages: [], maxContinues: 0,
    callOnce: async () => { calls++; return { content: 'Y', finishReason: 'length', toolCalls: [], usage: null }; },
  });
  assert.strictEqual(calls, 1);
  assert.strictEqual(r0.truncated, true);

  let toolCalls = 0;
  await runWithContinuation({
    messages: [], maxContinues: 5,
    callOnce: async () => {
      toolCalls++;
      return { content: 'T', finishReason: 'length', toolCalls: [{ id: 'c1', name: 'f', arguments: '{}' }], usage: null };
    },
  });
  assert.strictEqual(toolCalls, 1, '工具调用轮不得续写（避免残缺参数二次拼接）');
});

t('continue：续写请求带上已产出内容（user,assistant,user）', async () => {
  const { runWithContinuation } = require('../transform/continue');
  const seen = [];
  await runWithContinuation({
    messages: [{ role: 'user', content: 'q' }],
    maxContinues: 1,
    callOnce: async (msgs) => {
      seen.push(msgs.map((m) => m.role).join(','));
      return seen.length === 1
        ? { content: 'P1', finishReason: 'length', toolCalls: [], usage: null }
        : { content: 'P2', finishReason: 'stop', toolCalls: [], usage: null };
    },
  });
  assert.strictEqual(seen[0], 'user');
  assert.strictEqual(seen[1], 'user,assistant,user');
});

t('api-keys 不落库明文（仅哈希）', () => {
  const keys = require('../credentials/api-keys');
  const { db } = require('../credentials/db');
  const created = keys.createKey({ label: 'unit-hash', platform: 'trae' });
  const row = db().prepare('SELECT key_hash FROM api_keys WHERE id = ?').get(created.id);
  assert.ok(row.key_hash);
  assert.notStrictEqual(row.key_hash, created.key);
  assert.strictEqual(row.key_hash, keys.hashKey(created.key));
  keys.deleteKey(created.id);
});

t('login key 创建/校验/重置唯一', () => {
  const keys = require('../credentials/api-keys');
  // 清理可能残留
  for (const k of keys.listKeys({ kind: 'login' })) keys.deleteKey(k.id);
  assert.strictEqual(keys.hasLoginKey(), false);

  const a = keys.createKey({ label: 'L1', kind: 'login' });
  assert.ok(a.key.startsWith('sk-admin-'));
  assert.ok(keys.hasLoginKey());
  assert.ok(keys.verifyLoginKey(a.key));
  assert.strictEqual(keys.verifyAccessKey(a.key), null, 'login key 不能当 access key');

  const b = keys.resetLoginKey({ label: 'L2' });
  assert.strictEqual(keys.verifyLoginKey(a.key), null, '旧 login 应失效');
  assert.ok(keys.verifyLoginKey(b.key));

  for (const k of keys.listKeys({ kind: 'login' })) keys.deleteKey(k.id);
});

t('notify 事件开关默认全开，可单独关闭', () => {
  const fs = require('fs');
  const settings = require('../notify/settings');
  const file = settings.FILE;
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
  try {
    const before = settings.getEffective();
    assert.strictEqual(before.events.checkin_ok, true);
    assert.strictEqual(before.events.credits_expiring, true);

    const saved = settings.save({ events: { credits_expiring: false, balance_low: false } });
    assert.strictEqual(saved.events.credits_expiring, false);
    assert.strictEqual(saved.events.balance_low, false);
    assert.strictEqual(saved.events.checkin_ok, true);
    assert.strictEqual(settings.isEventEnabled('credits_expiring'), false);
    assert.strictEqual(settings.isEventEnabled('checkin_ok'), true);
  } finally {
    if (backup != null) fs.writeFileSync(file, backup, 'utf-8');
    else if (fs.existsSync(file)) {
      // 仅测试写入且原先无文件时，删掉事件字段污染；保留渠道则回写空 events
      const cur = JSON.parse(fs.readFileSync(file, 'utf-8'));
      delete cur.events;
      fs.writeFileSync(file, JSON.stringify(cur, null, 2) + '\n', 'utf-8');
    }
  }
});

t('scheduler-settings 文件优先于 env，越界值被夹紧', () => {
  const fs = require('fs');
  const ss = require('../jobs/scheduler-settings');
  const file = ss.FILE;
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
  try {
    const eff0 = ss.getEffective();
    assert.strictEqual(typeof eff0.checkinHour, 'number');
    assert.strictEqual(typeof eff0.checkinMinute, 'number');

    const saved = ss.save({ checkinHour: 8, checkinMinute: 30, tokenSweepMinutes: 10 });
    assert.strictEqual(saved.checkinHour, 8);
    assert.strictEqual(saved.checkinMinute, 30);
    assert.strictEqual(saved.tokenSweepMinutes, 10);

    const clamped = ss.save({ checkinHour: 99, checkinMinute: -1, tokenSweepMinutes: 0 });
    assert.strictEqual(clamped.checkinHour, 23);
    assert.strictEqual(clamped.checkinMinute, 0);
    assert.strictEqual(clamped.tokenSweepMinutes, 1);
  } finally {
    if (backup != null) fs.writeFileSync(file, backup, 'utf-8');
    else if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

t('credit-alerts 汇总临期与低余额账号', async () => {
  const fs = require('fs');
  const store = require('../credentials/store');
  const settings = require('../notify/settings');
  const { checkCreditAlerts } = require('../jobs/credit-alerts');
  // 测试期间清空通知渠道：force:true 会跳过通知去重并真实投递，
  // 若沿用本机 notify-settings.json（webhook 已配置）会把测试假数据推给真实渠道
  const nf = settings.FILE;
  const backup = fs.existsSync(nf) ? fs.readFileSync(nf, 'utf-8') : null;
  settings.save({
    webhookUrl: '',
    serverChanSendKey: '',
    pushPlusToken: '',
    telegramBotToken: '',
    telegramChatId: '',
  });
  try {
    const soon = Math.floor(Date.now() / 1000) + 2 * 86400;
    const id = store.add({
      label: 'credit-alert',
      token: 't',
      balance: 5,
      enabled: true,
      entitlementSnapshot: {
        updatedAt: new Date().toISOString(),
        packs: [{ name: 'pack', expireTime: soon, remaining: 12, used: 0, limit: 20, unlimited: false }],
      },
    }, 'import').id;
    const r = await checkCreditAlerts({ lowThreshold: 10, force: true });
    assert.ok(r.expiring3d >= 12);
    assert.strictEqual(r.lowBalance.length >= 1, true);
    assert.ok(r.lowBalance.some((x) => x.accountId === id));
    store.remove(id);
  } finally {
    if (backup != null) fs.writeFileSync(nf, backup, 'utf-8');
    else if (fs.existsSync(nf)) fs.unlinkSync(nf);
  }
});

console.log('lib.auth.normalizeExchangeResult');
t('归一化 Result 信封（api.trae.cn）', () => {
  const { normalizeExchangeResult } = require('../lib/auth');
  const r = normalizeExchangeResult({
    ResponseMetadata: {},
    Result: { Token: 'Cloud-IDE-JWT a.b.c', RefreshToken: 'rt-1', TokenExpireAt: '2026-10-01T00:00:00.000Z' },
  });
  assert.strictEqual(r.token, 'Cloud-IDE-JWT a.b.c');
  assert.strictEqual(r.refreshToken, 'rt-1');
  assert.strictEqual(r.expiredAt, '2026-10-01T00:00:00.000Z');
});
t('归一化 data 信封 access_token', () => {
  const { normalizeExchangeResult } = require('../lib/auth');
  const r = normalizeExchangeResult({ code: 0, data: { access_token: 'tok-1', refresh_token: 'rt-2', expiredAt: 1790000000 } });
  assert.strictEqual(r.token, 'tok-1');
  assert.strictEqual(r.refreshToken, 'rt-2');
  assert.ok(r.expiredAt && r.expiredAt.includes('T'));
});
t('归一化平铺 token 形态', () => {
  const { normalizeExchangeResult } = require('../lib/auth');
  const r = normalizeExchangeResult({ token: 'tok-3', refreshToken: 'rt-3', expiredAt: '2026-11-01T00:00:00.000Z' });
  assert.strictEqual(r.token, 'tok-3');
  assert.strictEqual(r.refreshToken, 'rt-3');
  assert.strictEqual(r.expiredAt, '2026-11-01T00:00:00.000Z');
});
t('Result 信封业务错误应抛出', () => {
  const { normalizeExchangeResult } = require('../lib/auth');
  assert.throws(
    () => normalizeExchangeResult({ ResponseMetadata: { Error: { Code: '10101', Message: 'bad' } } }),
    /ExchangeToken failed: code=10101/
  );
});
t('无 token 时抛出', () => {
  const { normalizeExchangeResult } = require('../lib/auth');
  assert.throws(() => normalizeExchangeResult({}), /no access token/);
});

console.log('jobs.balance-refresh');
t('余额刷新配置：默认关闭，间隔夹紧到 5-1440', () => {
  const fs = require('fs');
  const br = require('../jobs/balance-refresh');
  const file = br.FILE();
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
  br.start = () => {}; // 屏蔽定时器副作用
  br.stop = () => {};
  try {
    // 隔离真实配置：先清空，验证默认值，避免受本机 settings 干扰
    fs.mkdirSync(require('path').dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}', 'utf-8');
    const d0 = br.getEffective();
    assert.strictEqual(d0.enabled, false);
    const saved = br.save({ enabled: true, intervalMinutes: 3 });
    assert.strictEqual(saved.enabled, true);
    assert.strictEqual(saved.intervalMinutes, 5, '间隔下限夹到 5 分钟');
    const saved2 = br.save({ enabled: false, intervalMinutes: 9999 });
    assert.strictEqual(saved2.intervalMinutes, 1440, '间隔上限夹到 1440');
  } finally {
    if (backup != null) fs.writeFileSync(file, backup, 'utf-8');
    else if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

console.log('jobs.task-log');
t('任务日志写入/读取/过滤/清空', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  process.env.TASK_LOG_FILE = path.join(os.tmpdir(), `task-log-test-${Date.now()}.jsonl`);
  const tl = require('../jobs/task-log');
  const file = tl.FILE();
  try {
    tl.appendTaskLog({ task: 'balance-refresh', trigger: 'timer', ok: 2, failed: 0, total: 2 });
    tl.appendTaskLog({ task: 'backup', trigger: 'manual', ok: 1, failed: 0, file: 'x.json' });
    const all = tl.readTaskLog(100);
    assert.strictEqual(all.length, 2);
    const bal = tl.readTaskLog(100, 'balance-refresh');
    assert.strictEqual(bal.length, 1);
    assert.strictEqual(bal[0].task, 'balance-refresh');
    assert.ok(tl.clearTaskLog());
    assert.strictEqual(tl.readTaskLog(100).length, 0);
  } finally {
    delete process.env.TASK_LOG_FILE;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

console.log('notify.merge');
t('通知未配置渠道时关闭', () => {
  const n = require('../notify');
  const settings = require('../notify/settings');
  const fs = require('fs');
  // 用模块导出的写入路径，避免测试与实现的位置规则各写一份而失配
  const file = settings.FILE;
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
  settings.save({ webhookUrl: '', serverChanSendKey: '', pushPlusToken: '', telegramBotToken: '', telegramChatId: '' });
  try {
    assert.strictEqual(n.enabled(), false);
    assert.ok(file.startsWith(process.env.WORKSPACE_DIR), '状态文件应落在工作区内，不污染仓库');
  } finally {
    if (backup != null) fs.writeFileSync(file, backup, 'utf-8');
    else if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

console.log('jobs.backup');
t('备份：配置夹紧 + backupKey 可用（临时状态文件隔离）', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  process.env.BACKUP_STATE_FILE = path.join(os.tmpdir(), `bk-state-${Date.now()}.json`);
  process.env.BACKUP_DIR = path.join(os.tmpdir(), `bk-dir-${Date.now()}`);
  process.env.TRAE_BACKUP_PASSPHRASE = 'test-passphrase-0123456789';
  const bk = require('../jobs/backup');
  const stateFile = bk.STATE_FILE();
  try {
    const eff = bk.getEffective();
    assert.ok(eff.dir, '应有备份目录');
    assert.strictEqual(eff.keep, 5, '默认保留 5 份');
    const saved = bk.save({ enabled: true, keep: 99, intervalHours: 6 });
    assert.strictEqual(saved.enabled, true);
    assert.strictEqual(saved.keep, 50, '保留份数上限夹到 50');
    assert.strictEqual(saved.intervalHours, 6);
    const key = bk.backupKey();
    assert.strictEqual(key, process.env.TRAE_BACKUP_PASSPHRASE, '优先用环境变量密钥');
  } finally {
    delete process.env.BACKUP_STATE_FILE;
    delete process.env.BACKUP_DIR;
    delete process.env.TRAE_BACKUP_PASSPHRASE;
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    // backupKey 若生成了持久化 key 文件则一并清理（路径取自实现，避免位置规则各写一份）
    const keyFile = require('../lib/paths').stateFile('backup.key');
    if (fs.existsSync(keyFile)) fs.unlinkSync(keyFile);
  }
});

console.log('model-router');
t('6004 中文频控归为 model（不整号冷却）', () => {
  const e = new Error('WorkBuddy upstream HTTP 429 {"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-09-29 20:48:47 UTC+8 重置，您也可以切换其他模型继续使用。"}');
  e.status = 429;
  assert.strictEqual(classifyError(e), 'model');
  assert.strictEqual(e.upstreamCode, 6004, '应从消息体回填 upstreamCode');
});
t('429 无业务码仍归为 rate_limit', () => {
  const e = new Error('Too Many Requests');
  e.status = 429;
  assert.strictEqual(classifyError(e), 'rate_limit');
});
t('model-router 配置读写与候选排序', () => {
  const store = require('../model-router/store');
  const r = store.upsertVirtual('vm/test-a', {
    description: 't',
    strategy: 'priority',
    candidates: [
      { id: 'b', provider: 'trae', model: 'm2', priority: 2, weight: 1 },
      { id: 'a', provider: 'trae', model: 'm1', priority: 1, weight: 5 },
    ],
    failover: { maxAttempts: 2, cooldownMs: 1000 },
  });
  assert.strictEqual(r.ok, true);
  const mr = require('../model-router');
  const ordered = mr.orderCandidates('vm/test-a', store.getVirtual('vm/test-a'));
  assert.strictEqual(ordered[0].id, 'a', 'priority 小者优先');
  assert.strictEqual(ordered.length, 2);
  store.removeVirtual('vm/test-a');
});
t('model-router 限流冷却后跳过候选并可解冻', () => {
  const store = require('../model-router/store');
  const health = require('../model-router/health');
  const mr = require('../model-router');
  store.upsertVirtual('vm/test-b', {
    strategy: 'priority',
    candidates: [
      { id: 'c1', provider: 'trae', model: 'm1', priority: 1 },
      { id: 'c2', provider: 'trae', model: 'm2', priority: 2 },
    ],
    failover: { cooldownMs: 60000 },
  });
  const err = new Error('{"code":6004,"msg":"您的使用量已超出频率限制，将在 2099-01-01 00:00:00 UTC+8 重置，您也可以切换其他模型继续使用。"}');
  err.status = 429;
  const cooled = health.markFail('vm/test-b', 'c1', 'model', err, 20000);
  assert.ok(cooled.cooledForMs > 0, '模型级限流应冷却候选');
  const ordered = mr.orderCandidates('vm/test-b', store.getVirtual('vm/test-b'));
  assert.strictEqual(ordered.length, 1);
  assert.strictEqual(ordered[0].id, 'c2');
  health.clearCooldown('vm/test-b', 'c1');
  assert.strictEqual(mr.orderCandidates('vm/test-b', store.getVirtual('vm/test-b')).length, 2);
  store.removeVirtual('vm/test-b');
});
t('model-router maxRpm 滑窗限频', () => {
  const health = require('../model-router/health');
  assert.strictEqual(health.allowRpm('vm/r', 'c', 2), true);
  assert.strictEqual(health.allowRpm('vm/r', 'c', 2), true);
  assert.strictEqual(health.allowRpm('vm/r', 'c', 2), false);
  assert.strictEqual(health.allowRpm('vm/r', 'c', 0), true, '未配置频率则不限');
});

console.log('context window guard');
t('token 粗估：中文/英文/混合/空值', () => {
  const { estimatePromptTokens, textTokens } = require('../lib/token-estimate');
  assert.strictEqual(textTokens(''), 0);
  assert.strictEqual(textTokens(null), 0);
  // 9 个汉字 * 0.7 = 6.3 → ceil 7
  assert.strictEqual(textTokens('上下文记忆管理测试'), 7);
  // 8 个 ASCII 字符 / 4 = 2
  assert.strictEqual(textTokens('abcdwxyz'), 2);
  // 混合：2 汉字 * 0.7 + 5 ASCII / 4 = 1.4 + 1.25 → ceil 3
  assert.strictEqual(textTokens('你好world'), 3);
});
t('token 粗估：多部分 content、图片、tool_calls', () => {
  const { estimatePromptTokens, IMAGE_TOKENS, PER_MESSAGE_OVERHEAD } = require('../lib/token-estimate');
  const msgs = [
    { role: 'system', content: 'abcdwxyz' }, // 2 + 8
    { role: 'user', content: [{ type: 'text', text: 'abcdwxyz' }, { type: 'image_url', image_url: { url: 'x' } }] }, // 2 + 1000 + 8
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'abcdwxyz', arguments: '{"abcdwxyz":1}' } }],
    }, // name 2 + arguments 4 = 6 → ceil 6，+ 8
  ];
  const expected = (2 + PER_MESSAGE_OVERHEAD) + (2 + IMAGE_TOKENS + PER_MESSAGE_OVERHEAD) + (6 + PER_MESSAGE_OVERHEAD);
  assert.strictEqual(estimatePromptTokens(msgs), expected);
  assert.strictEqual(estimatePromptTokens([]), 0);
  assert.strictEqual(estimatePromptTokens(null), 0);
});
t('store：contextWindow 声明持久化与归一化', () => {
  const store = require('../model-router/store');
  store.upsertVirtual('vm/win-test', {
    strategy: 'priority',
    contextWindow: 168000,
    candidates: [{ id: 't', provider: 'trae', model: 'glm-5.3', priority: 1 }],
  });
  assert.strictEqual(store.getVirtual('vm/win-test').contextWindow, 168000);
  // 非法值归一为 null（不守门）
  store.upsertVirtual('vm/win-test', {
    strategy: 'priority',
    contextWindow: 'abc',
    candidates: [{ id: 't', provider: 'trae', model: 'glm-5.3', priority: 1 }],
  });
  assert.strictEqual(store.getVirtual('vm/win-test').contextWindow, null);
  // 仅接受 number 类型：true→1、数组等意外形态不得被误归一为窗口
  const n = store.normalizeVirtual('x', {
    candidates: [{ provider: 'trae', model: 'glm-5.3' }],
    contextWindow: true,
  });
  assert.strictEqual(n.contextWindow, null);
  const n2 = store.normalizeVirtual('x', {
    candidates: [{ provider: 'trae', model: 'glm-5.3' }],
    contextWindow: ['168000'],
  });
  assert.strictEqual(n2.contextWindow, null);
  store.removeVirtual('vm/win-test');
});
t('checkContextLimit：未声明/未超限放行，超限 400 且标记 context_length_exceeded', () => {
  const { checkContextLimit } = require('../model-router');
  // 未声明窗口：放行
  assert.strictEqual(checkContextLimit({ contextWindow: null }, [{ role: 'user', content: 'x'.repeat(100000) }]), null);
  // 声明 1000，输入约 3000 token（12000 ASCII 字符）：超 75% → 拒绝
  const err = checkContextLimit(
    { contextWindow: 1000, description: 'win' },
    [{ role: 'user', content: 'x'.repeat(12000) }],
  );
  assert.ok(err, '超限应返回错误');
  assert.strictEqual(err.status, 400);
  assert.strictEqual(err.code, 'context_length_exceeded');
  assert.ok(err.message.includes('estimated'), '错误信息应包含估算值');
  // 低于 75% 阈值：放行（700 token 以内）
  assert.strictEqual(
    checkContextLimit({ contextWindow: 1000 }, [{ role: 'user', content: 'x'.repeat(2400) }]),
    null,
  );
});

console.log('log.client-logs');
t('extractUsage 解析驼峰 usage 与 credit', () => {
  const { extractUsage } = require('../log/client-logs');
  const u = extractUsage({
    id: 'm1',
    timestamp: Date.UTC(2026, 8, 20, 10, 0, 0),
    providerData: {
      messageId: 'mid-1',
      requestModelId: 'deepseek-v4.1-flash',
      usage: { requests: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120, inputTokensDetails: [{ cached_tokens: 40 }] },
      rawUsage: { credit: 0.36, prompt_cache_write_tokens: 0 },
    },
  });
  assert.strictEqual(u.model, 'deepseek-v4.1-flash');
  assert.strictEqual(u.input, 100);
  assert.strictEqual(u.output, 20);
  assert.strictEqual(u.total, 120);
  assert.strictEqual(u.cacheRead, 40);
  assert.strictEqual(u.credit, 0.36);
  assert.strictEqual(u.dedupKey, 'mid-1');
});

t('extractUsage 无 usage 时返回 null', () => {
  const { extractUsage } = require('../log/client-logs');
  assert.strictEqual(extractUsage({ type: 'message', providerData: { model: 'x' } }), null);
  assert.strictEqual(extractUsage({ type: 'message' }), null);
  assert.strictEqual(extractUsage(null), null);
});

t('去重键用 messageId/callId，不用 conversationRequestId', () => {
  const { extractUsage } = require('../log/client-logs');
  const { scan } = require('../log/client-logs');
  const os2 = require('os');
  const fs2 = require('fs');
  const path2 = require('path');
  const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'wblog-'));
  // 一轮对话（同一 conversationRequestId）内的两次独立调用，必须计为 2
  const rows = [
    { id: 'a', callId: 'call-1', timestamp: 1000, providerData: { conversationRequestId: 'conv-1', callId: 'call-1', requestModelId: 'hy3', usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } } },
    { id: 'b', callId: 'call-2', timestamp: 2000, providerData: { conversationRequestId: 'conv-1', callId: 'call-2', requestModelId: 'hy3', usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 } } },
    // 同一 callId 重复写入，取较大 total，只计 1
    { id: 'c', callId: 'call-2', timestamp: 3000, providerData: { conversationRequestId: 'conv-1', callId: 'call-2', requestModelId: 'hy3', usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } } },
  ];
  fs2.writeFileSync(path2.join(dir, 's.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'), 'utf-8');
  const r = scan({ root: dir, force: true });
  assert.strictEqual(r.requests, 2, '两次独立调用应计 2 条');
  assert.strictEqual(r.tokens, 11 + 25, '重复 callId 取终值');
  fs2.rmSync(dir, { recursive: true, force: true });
});

t('客户端日志目录不存在时返回 available=false', () => {
  const { scan } = require('../log/client-logs');
  const r = scan({ root: 'C:/__no_such_dir_' + Date.now() });
  assert.strictEqual(r.available, false);
  assert.strictEqual(r.requests, 0);
});

t('扫描不落盘消息正文（隐私约束）', () => {
  const { scan } = require('../log/client-logs');
  const os3 = require('os');
  const fs3 = require('fs');
  const path3 = require('path');
  const dir = fs3.mkdtempSync(path3.join(os3.tmpdir(), 'wblog-priv-'));
  fs3.writeFileSync(path3.join(dir, 'p.jsonl'), JSON.stringify({
    id: 'x', timestamp: 5000, type: 'message', content: [{ type: 'output_text', text: 'SECRET_BODY_MARKER' }],
    providerData: { messageId: 'm-1', requestModelId: 'hy3', usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } },
  }), 'utf-8');
  const r = scan({ root: dir, force: true });
  const json = JSON.stringify(r);
  assert.ok(json.indexOf('SECRET_BODY_MARKER') === -1, '结果中不应出现消息正文');
  assert.strictEqual(r.requests, 1);
  fs3.rmSync(dir, { recursive: true, force: true });
});

console.log('workbuddy.billing-usage');
t('normalizeRows 只保留四字段并按 requestId 去重', () => {
  const { normalizeRows } = require('../workbuddy/billing-usage');
  const rows = normalizeRows([
    { requestId: 'r1', model: 'm', credit: 0.36, requestTime: '2026-10-03 02:27:00', input: 'SECRET', agentPurpose: 'x' },
    { requestId: 'r1', model: 'm', credit: 0.36, requestTime: '2026-10-03 02:27:00' },
    { requestId: 'r2', model: 'n', credit: '1.5', requestTime: '2026-10-03 02:28:00' },
  ]);
  assert.strictEqual(rows.length, 2, '同 requestId 应折叠为一条');
  assert.deepStrictEqual(Object.keys(rows[0]).sort(), ['credit', 'model', 'requestId', 'requestTime']);
  assert.strictEqual(rows[1].credit, 1.5, '字符串 credit 应转数字');
  assert.ok(JSON.stringify(rows).indexOf('SECRET') === -1, '不得保留请求正文');
});

t('normalizeRows 缺 requestId 时用时间+模型兜底', () => {
  const { normalizeRows } = require('../workbuddy/billing-usage');
  const rows = normalizeRows([{ model: 'm', credit: 1, requestTime: '2026-10-03 02:27:00' }]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].requestId, '2026-10-03 02:27:00-m');
});

t('recentDayKeys 生成 N 个连续本地日期（新→旧）', () => {
  const { recentDayKeys } = require('../workbuddy/billing-usage');
  const keys = recentDayKeys(3, new Date(2026, 9, 3, 12, 0, 0));
  assert.deepStrictEqual(keys, ['2026-10-03', '2026-10-02', '2026-10-01']);
});

t('非 workbuddy 账号不发起扫描', async () => {
  const { scanAccount } = require('../workbuddy/billing-usage');
  const r = await scanAccount('__no_such_account__', 1);
  assert.strictEqual(r.available, false);
  assert.strictEqual(r.credit, 0);
});

console.log('lib/atomic-write');
t('原子写入：内容正确落盘且无临时文件残留', () => {
  const { writeFileAtomic } = require('../lib/atomic-write');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
  const f = path.join(dir, 'cfg.json');
  assert.strictEqual(writeFileAtomic(f, '{"a":1}'), true);
  assert.strictEqual(fs.readFileSync(f, 'utf-8'), '{"a":1}');
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
  assert.deepStrictEqual(leftovers, [], '不应残留临时文件');
});

t('原子写入：父目录不存在时自动创建', () => {
  const { writeFileAtomic } = require('../lib/atomic-write');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
  const f = path.join(dir, 'nested', 'deep', 'cfg.json');
  assert.strictEqual(writeFileAtomic(f, 'x'), true);
  assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'x');
});

t('原子写入：覆写既有文件不产生半截内容', () => {
  const { writeFileAtomic } = require('../lib/atomic-write');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
  const f = path.join(dir, 'cfg.json');
  writeFileAtomic(f, 'old-content');
  writeFileAtomic(f, 'new-content');
  assert.strictEqual(fs.readFileSync(f, 'utf-8'), 'new-content');
});

t('原子写入 JSON：缩进与末尾换行', () => {
  const { writeJsonAtomic } = require('../lib/atomic-write');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
  const f = path.join(dir, 'cfg.json');
  assert.strictEqual(writeJsonAtomic(f, { a: 1 }), true);
  assert.strictEqual(fs.readFileSync(f, 'utf-8'), '{\n  "a": 1\n}\n');
});

t('原子写入：写入失败返回 false 且不抛出', () => {
  const { writeFileAtomic } = require('../lib/atomic-write');
  // 目标路径的父级是文件而非目录，mkdir 必失败
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  assert.strictEqual(writeFileAtomic(path.join(blocker, 'sub', 'cfg.json'), 'y'), false);
});

console.log('lib/round 与 lib/sse-lines');
t('round2 / round4：非有限值归 0，有限值按位舍入', () => {
  const { round2, round4 } = require('../lib/round');
  assert.strictEqual(round2(1.2345), 1.23);
  assert.strictEqual(round2(-1.2345), -1.23);
  assert.strictEqual(round4(1.23456), 1.2346);
  for (const bad of [null, undefined, NaN, Infinity, 'x']) {
    assert.strictEqual(round2(bad), 0, `round2(${String(bad)}) 应为 0`);
    assert.strictEqual(round4(bad), 0, `round4(${String(bad)}) 应为 0`);
  }
});

t('createLineFeeder：跨块残行被拼接后完整投递', () => {
  const { createLineFeeder } = require('../lib/sse-lines');
  const got = [];
  const f = createLineFeeder((line) => got.push(line));
  // 一个 JSON 事件被切成三块，中间块不含换行
  f.feed('data: {"a"');
  f.feed(':1}\ndata: {"b":2}\n');
  f.feed('data: {"c":');
  f.feed('3}');
  f.flush();
  assert.deepStrictEqual(got, ['data: {"a":1}', 'data: {"b":2}', 'data: {"c":3}']);
});

t('createLineFeeder：无换行的单行在 flush 时吐出', () => {
  const { createLineFeeder } = require('../lib/sse-lines');
  const got = [];
  const f = createLineFeeder((line) => got.push(line));
  f.feed('data: [DONE]');
  assert.deepStrictEqual(got, [], '未遇换行前不应投递');
  f.flush();
  assert.deepStrictEqual(got, ['data: [DONE]']);
});

console.log('credentials/oauth state');
t('未发起登录流程时任何 state 都被拒绝', () => {
  const oauth = require('../credentials/oauth');
  // 无 pending 流程时 pending.state 为空，任何输入都不得通过
  assert.strictEqual(oauth.verifyAndConsumeState('anything'), false);
  assert.strictEqual(oauth.verifyAndConsumeState(''), false);
  assert.strictEqual(oauth.verifyAndConsumeState(undefined), false);
  assert.strictEqual(oauth.verifyAndConsumeState(null), false);
});

t('oauth/url 返回体包含 state（前端需回传）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'credentials', 'oauth.js'), 'utf-8');
  const fn = src.slice(src.indexOf('function getLoginUrl'), src.indexOf('function verifyAndConsumeState'));
  assert.ok(/return\s*\{[\s\S]*?\bstate:\s*pending\.state/.test(fn), 'getLoginUrl 必须回传 state');
});

console.log('lib/util 确定性错峰');
t('stableHash32：同输入恒得同值，不同输入可区分', () => {
  const { stableHash32 } = require('../lib/util');
  assert.strictEqual(stableHash32('acct-001'), stableHash32('acct-001'));
  assert.notStrictEqual(stableHash32('acct-001'), stableHash32('acct-002'));
  assert.ok(stableHash32('acct-001') >= 0 && stableHash32('acct-001') < 2 ** 32);
});

t('deterministicOffsetMs：跨调用稳定且落在窗口内', () => {
  const { deterministicOffsetMs } = require('../lib/util');
  const win = 30 * 60 * 1000;
  const a = deterministicOffsetMs('2026-10-03:acct-001', win);
  const b = deterministicOffsetMs('2026-10-03:acct-001', win);
  assert.strictEqual(a, b, '同一键必须得到同一偏移（可重放）');
  assert.ok(a >= 0 && a < win, '偏移必须落在窗口内');
  assert.strictEqual(deterministicOffsetMs('k', 0), 0, '窗口为 0 时不做分散');
  assert.strictEqual(deterministicOffsetMs('k', -1), 0);
});

t('deterministicOffsetMs：不同账号在同一窗口内被分散开', () => {
  const { deterministicOffsetMs } = require('../lib/util');
  const win = 30 * 60 * 1000;
  const offsets = Array.from({ length: 20 }, (_, i) => deterministicOffsetMs(`2026-10-03:acct-${i}`, win));
  assert.ok(new Set(offsets).size >= 18, '20 个账号应分散到多数不同位置，避免同刻批量');
});

t('planSpread：按目标时刻升序，salt 变化会改变分布', () => {
  const { planSpread } = require('../lib/util');
  const items = ['a', 'b', 'c', 'd'];
  const plan = planSpread(items, { keyOf: (x) => x, salt: '2026-10-03', windowStartMs: 1000, windowMs: 60000 });
  assert.strictEqual(plan.length, 4);
  for (let i = 1; i < plan.length; i++) assert.ok(plan[i].targetMs >= plan[i - 1].targetMs, '必须升序');
  const plan2 = planSpread(items, { keyOf: (x) => x, salt: '2026-10-04', windowStartMs: 1000, windowMs: 60000 });
  assert.notDeepStrictEqual(plan.map((p) => p.targetMs), plan2.map((p) => p.targetMs), '换日应换分布');
});

t('planSpread：windowMs=0 时全部落在起点（退回批量行为）', () => {
  const { planSpread } = require('../lib/util');
  const plan = planSpread(['a', 'b'], { keyOf: (x) => x, salt: 's', windowStartMs: 5000, windowMs: 0 });
  assert.deepStrictEqual(plan.map((p) => p.targetMs), [5000, 5000]);
});

t('localDateKey：本地时区 YYYY-MM-DD，个位月日补零', () => {
  const { localDateKey } = require('../lib/util');
  assert.strictEqual(localDateKey(new Date(2026, 0, 5, 23, 59, 0)), '2026-01-05');
  assert.strictEqual(localDateKey(new Date(2026, 9, 3, 0, 0, 0)), '2026-10-03');
});

t('runPlanned：目标时刻已过时立即执行且顺序按计划', async () => {
  const { runPlanned } = require('../lib/util');
  const order = [];
  await runPlanned(['x', 'y'], {
    keyOf: (v) => v,
    run: async (v) => { order.push(v); },
    salt: 's',
    windowStartMs: Date.now() - 60_000, // 全部目标在过去 → 不等
    windowMs: 1000,
    gapMs: 0,
  });
  assert.strictEqual(order.length, 2);
});

console.log('platform/variant 单一事实源');
t('variantOf：Trae 侧历史 edition（cn/sg/us/manual）归一到 trae', () => {
  const v = require('../platform/variant');
  assert.strictEqual(v.variantOf('cn').id, 'trae');
  assert.strictEqual(v.variantOf('sg').id, 'trae');
  assert.strictEqual(v.variantOf('us').id, 'trae');
  assert.strictEqual(v.variantOf('manual').id, 'trae');
  assert.strictEqual(v.variantOf('workbuddy').id, 'workbuddy');
  assert.strictEqual(v.variantOf(undefined).id, 'trae', '缺失时默认 Trae 池');
  assert.strictEqual(v.variantOf('__unknown__').id, 'trae');
});

t('can：能力声明取代散落的 edition 比较', () => {
  const v = require('../platform/variant');
  assert.strictEqual(v.can('trae', 'growth'), false, 'Trae 无成长中心');
  assert.strictEqual(v.can('workbuddy', 'growth'), true);
  assert.strictEqual(v.can('workbuddy', 'billing'), true);
  assert.strictEqual(v.can('trae', 'oauthLogin'), true);
  assert.strictEqual(v.can('workbuddy', 'oauthLogin'), false);
  assert.strictEqual(v.can('trae', 'deviceFingerprint'), true);
  assert.strictEqual(v.can('workbuddy', 'deviceFingerprint'), false);
});

t('hostFor：多区域域名按 region 取值，字符串原样返回', () => {
  const v = require('../platform/variant');
  const wb = v.variantOf('workbuddy');
  assert.strictEqual(v.hostFor(wb.hosts.chat, 'cn'), 'https://copilot.tencent.com');
  assert.strictEqual(v.hostFor(wb.hosts.chat, 'global'), 'https://www.workbuddy.ai');
  assert.strictEqual(v.hostFor(wb.hosts.billing, 'cn'), 'https://www.codebuddy.cn');
  assert.strictEqual(v.hostFor(wb.hosts.growth, 'global'), 'https://www.workbuddy.cn', '字符串形态不受 region 影响');
  assert.strictEqual(v.hostFor(null, 'cn'), '');
});

t('regionOf / validRegion：按 regionPattern 识别，非法值归 cn', () => {
  const v = require('../platform/variant');
  assert.strictEqual(v.regionOf('www.workbuddy.ai'), 'global');
  assert.strictEqual(v.regionOf('copilot.tencent.com'), 'cn');
  assert.strictEqual(v.regionOf(''), 'cn');
  assert.strictEqual(v.validRegion('global'), 'global');
  assert.strictEqual(v.validRegion('anything'), 'cn');
});

t('域名常量无重复副本：各模块取值与 variant 一致', () => {
  const v = require('../platform/variant');
  const trae = v.variantOf('trae');
  const wb = v.variantOf('workbuddy');
  // 这些模块此前各自硬编码一份，现应全部取自 variant
  assert.strictEqual(require('../upstream/checkin').DEFAULT_UG_HOST, trae.hosts.ug);
  assert.strictEqual(require('../upstream/balance').DEFAULT_UG_HOST, trae.hosts.ug);
  assert.strictEqual(require('../upstream/checkin').DEFAULT_UG_HOST, require('../upstream/balance').DEFAULT_UG_HOST,
    'checkin 与 balance 的 UG 域不得分叉');
  assert.strictEqual(require('../workbuddy/auth').chatHost('cn'), v.hostFor(wb.hosts.chat, 'cn'));
  assert.strictEqual(require('../workbuddy/auth').chatHost('global'), v.hostFor(wb.hosts.chat, 'global'));
  assert.strictEqual(require('../workbuddy/auth').billingBase('cn'), v.hostFor(wb.hosts.billing, 'cn'));
});

t('业务码取自 variant：签到已签码与限流码', () => {
  const v = require('../platform/variant');
  assert.strictEqual(require('../upstream/checkin').CODE_ALREADY, v.variantOf('trae').errors.alreadyCheckedIn[0]);
  assert.strictEqual(require('../upstream/wb-checkin').CODE_ALREADY, v.variantOf('workbuddy').errors.alreadyCheckedIn[0]);
  const errs = require('../upstream/errors');
  const union = new Set([...v.variantOf('trae').errors.rateLimitCodes, ...v.variantOf('workbuddy').errors.rateLimitCodes]);
  assert.deepStrictEqual([...errs.RATE_LIMIT_CODES].sort(), [...union].sort(), '限流码应为两平台并集');
  assert.ok(errs.RATE_LIMIT_CODES.includes(3004), 'Trae 账号级限流码应保留');
  assert.ok(errs.RATE_LIMIT_CODES.includes(6004), 'WorkBuddy 模型级限流码应保留');
});

t('clientAuthDir：仅 WorkBuddy 有桌面凭据目录', () => {
  const v = require('../platform/variant');
  assert.strictEqual(v.clientAuthDir('trae'), null);
  const dir = v.clientAuthDir('workbuddy');
  assert.ok(dir && dir.endsWith(path.join('CodeBuddyExtension', 'Data', 'Public', 'auth')));
});

console.log('credentials/credits 纯计算');
t('roundCredits 消除浮点噪声', () => {
  const { roundCredits } = require('../credentials/credits');
  assert.strictEqual(roundCredits(13215.630000000001), 13215.63);
  assert.strictEqual(roundCredits(null), null);
  assert.strictEqual(roundCredits(NaN), NaN);
});

t('naturalDayDiff：今天为 0，明天为 1，非法输入返回 null', () => {
  const { naturalDayDiff } = require('../credentials/credits');
  const now = new Date(2026, 4, 10, 12, 0, 0).getTime();
  const sec = (offsetDays) => Math.floor(new Date(2026, 4, 10 + offsetDays, 12, 0, 0).getTime() / 1000);
  assert.strictEqual(naturalDayDiff(sec(0), now), 0);
  assert.strictEqual(naturalDayDiff(sec(1), now), 1);
  assert.strictEqual(naturalDayDiff(sec(-1), now), -1);
  assert.strictEqual(naturalDayDiff(null, now), null);
  assert.strictEqual(naturalDayDiff(0, now), null);
  assert.strictEqual(naturalDayDiff('abc', now), null);
});

t('权益包计算仅 credentials/credits 一个入口，upstream/balance 不再 re-export', () => {
  const b = require('../upstream/balance');
  assert.ok(!('summarizeExpiry' in b), 'balance 不应再导出 summarizeExpiry');
  assert.ok(!('roundCredits' in b), 'balance 不应再导出 roundCredits');
  const c = require('../credentials/credits');
  assert.strictEqual(typeof c.summarizeExpiry, 'function');
  assert.strictEqual(typeof c.roundCredits, 'function');
});

console.log('依赖方向不变量');
t('credentials 不再依赖 upstream/balance（反向依赖已消除）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'credentials', 'pool.js'), 'utf-8');
  assert.ok(!/require\('\.\.\/upstream\/balance'\)/.test(src), 'pool 不应 require upstream/balance');
  assert.ok(/require\('\.\/credits'\)/.test(src), 'pool 应从 credentials/credits 取权益包计算');
});

t('rotate-seed 与 rotate-accounts 不再互相 require', () => {
  const seed = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'rotate-seed.js'), 'utf-8');
  const acct = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'rotate-accounts.js'), 'utf-8');
  assert.ok(!/require\('\.\/rotate-accounts'\)/.test(seed), 'rotate-seed 不应 require rotate-accounts');
  assert.ok(!/require\('\.\/rotate-seed'\)\s*;/.test(acct.replace(/seedAll: \(\) => require\('\.\/rotate-seed'\)\.seedAll\(\)/, '')),
    'rotate-accounts 不应在加载期 require rotate-seed（惰性调用除外）');
});

t('model-access 不再 require model-router 的 index（避免加载期循环）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'model-access.js'), 'utf-8');
  assert.ok(!/require\('\.\.\/model-router'\)/.test(src), 'model-access 应直接依赖 model-router/store');
  assert.ok(/require\('\.\.\/model-router\/store'\)/.test(src));
});

t('全库无双向依赖（静态扫描）', () => {
  const SRC = path.join(__dirname, '..');
  const all = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'test') walk(full); }
      else if (e.name.endsWith('.js')) all.push(full);
    }
  };
  walk(SRC);
  const rel = (p) => path.relative(SRC, p).split(path.sep).join('/');
  const known = new Set(all.map(rel));
  const deps = new Map();
  for (const f of all) {
    const set = new Set();
    for (const m of fs.readFileSync(f, 'utf-8').matchAll(/require\('(\.[^']+)'\)/g)) {
      const base = path.resolve(path.dirname(f), m[1]);
      for (const cand of [`${base}.js`, path.join(base, 'index.js')]) {
        if (known.has(rel(cand))) { set.add(rel(cand)); break; }
      }
    }
    deps.set(rel(f), set);
  }
  const cycles = [];
  for (const [a, ds] of deps) {
    for (const b of ds) {
      if (deps.get(b) && deps.get(b).has(a)) cycles.push([a, b].sort().join(' <-> '));
    }
  }
  assert.deepStrictEqual([...new Set(cycles)], [], `存在双向依赖: ${[...new Set(cycles)].join(', ')}`);
});

console.log('config.resolveModelOptions 热重载');
t('reload 前后返回形态一致（scene / reasoning 不丢）', () => {
  const cfg = require('../config');
  const cases = [
    ['auto', undefined],
    ['glm-5', undefined],
    ['glm-5', 'override-name'],
    ['__unregistered-model__', undefined],
  ];
  const before = cases.map(([m, o]) => cfg.resolveModelOptions(m, o));
  cfg.reload();
  const after = cases.map(([m, o]) => cfg.resolveModelOptions(m, o));
  for (const [i, v] of before.entries()) {
    assert.deepStrictEqual(after[i], v, `case ${cases[i][0]} 重载后形态应一致`);
    assert.ok('scene' in after[i] && 'reasoning' in after[i], `case ${cases[i][0]} 应含 scene/reasoning`);
  }
});

t('reload 后已登记模型的 reasoning 与 scene 取值正确', () => {
  const cfg = require('../config');
  const meta = cfg.resolveModelOptions('doubao-1-6');
  assert.strictEqual(meta.scene, 'chat');
  assert.strictEqual(meta.reasoning, true);
});

console.log('middleware/auth checkAdminToken');
t('checkAdminToken：空 token 与错 token 均拒绝', () => {
  const { checkAdminToken } = require('../middleware/auth');
  assert.strictEqual(checkAdminToken('').ok, false);
  assert.strictEqual(checkAdminToken(null).ok, false);
  assert.strictEqual(checkAdminToken('__wrong__').ok, false);
});

t('checkAdminToken：env ADMIN_KEY 通过', () => {
  const { checkAdminToken } = require('../middleware/auth');
  assert.strictEqual(checkAdminToken(process.env.ADMIN_KEY).ok, true);
});

console.log('workbuddy/chat modelCatalog');
t('parseRate：兼容旧格式 x2.5 与新格式 x0.00 credits', async () => {
  // parseRate 未导出，经 modelCatalog 的解析路径验证：mock fetch 返回两种格式
  const wbAuth = require('../workbuddy/auth');
  const wbChat = require('../workbuddy/chat');
  const origFetch = global.fetch;
  const origReadAuthFile = wbAuth.readAuthFile;
  wbAuth.readAuthFile = () => ({ accessToken: 'tok', uid: 'u1', region: 'cn' });
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [
      { id: 'm-old', name: 'M Old', credits: 'x2.5' },
      { id: 'm-new', name: 'M New', credits: 'x0.00 credits' },
      { id: 'm-free', name: 'M Free', credits: 'x1' },
      { id: 'm-none', name: 'M None' },
      { id: 'm-bad', name: 'M Bad', credits: 'x.' },
    ] }),
  });
  try {
    const models = await wbChat.modelCatalog(true);
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    assert.strictEqual(byId['m-old'].rate, 2.5);
    assert.strictEqual(byId['m-old'].rateText, 'x2.5');
    assert.strictEqual(byId['m-new'].rate, 0);
    assert.strictEqual(byId['m-new'].rateText, 'x0.00 credits');
    assert.strictEqual(byId['m-free'].rate, 1);
    assert.strictEqual(byId['m-none'].rateText, null);
    assert.strictEqual(byId['m-none'].rate, null);
    // 畸形倍率（解析为 NaN）归一为 null，不得流入费率链路
    assert.strictEqual(byId['m-bad'].rate, null);
  } finally {
    global.fetch = origFetch;
    wbAuth.readAuthFile = origReadAuthFile;
  }
});

t('modelCatalog：本机登录态 401 时回退账号库凭据拉取成功', async () => {
  const wbAuth = require('../workbuddy/auth');
  const wbChat = require('../workbuddy/chat');
  const store = require('../credentials/store');
  const origFetch = global.fetch;
  const origReadAuthFile = wbAuth.readAuthFile;
  const origStoreList = store.list;
  const origStoreGet = store.get;
  global.fetch = async (url, opts) => {
    if (opts.headers.Authorization === 'Bearer broken-token') {
      return { ok: false, status: 401, json: async () => { throw new Error('not json'); } };
    }
    return {
      ok: true,
      json: async () => ({ data: [{ id: 'hy3', name: 'Hy3', credits: 'x0.00 credits' }] }),
    };
  };
  wbAuth.readAuthFile = () => ({ accessToken: 'broken-token', uid: 'u1', region: 'cn' });
  store.list = () => [{ id: 'a1', enabled: true, edition: 'workbuddy' }];
  store.get = () => ({ token: 'good-token', userId: 'u2', host: 'https://copilot.tencent.com' });
  try {
    const models = await wbChat.modelCatalog(true);
    assert.strictEqual(models.length, 1);
    assert.strictEqual(models[0].id, 'hy3');
    assert.strictEqual(models[0].rate, 0);
  } finally {
    global.fetch = origFetch;
    wbAuth.readAuthFile = origReadAuthFile;
    store.list = origStoreList;
    store.get = origStoreGet;
  }
});

console.log('model-router/dispatch 真流式（M-P1）');
t('dispatchTraeStream：文本事件逐块写出（首帧先于上游流结束，非整段聚合）', async () => {
  const dispatch = require('../model-router/dispatch');
  const pool = require('../credentials/pool');
  const client = require('../upstream/client');
  const origRun = pool.run;
  const origChat = client.llmUtilsChat;
  const origConsume = client.consumeStream;
  // 事件到达顺序记录：sse:xxx 追加于事件下发时刻，consumeEnd 追加于上游流
  // 读取结束时刻。真流式 ⇒ 首个内容帧先于 consumeEnd。
  const timeline = [];
  const line = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
  const firstPromise = new Promise((r) => { global.__probeFirstWrite = r; });
  pool.run = async (fn) => fn('acct-1');
  client.llmUtilsChat = async () => ({ body: {} });
  client.consumeStream = async (body, onText) => {
    onText(line({ event: 'output', response: '第一段' }));
    onText(line({ event: 'output', response: '第二段' }));
    onText(line({ event: 'done', finish_reason: 'stop' }));
    timeline.push('consumeEnd');
  };
  const chunks = [];
  const res = {
    writableEnded: false,
    headersSent: false,
    setHeader() {}, flushHeaders() {},
    write(s) {
      chunks.push(s);
      timeline.push(`sse:${String(s).slice(5, 12)}`);
      if (global.__probeFirstWrite) { const r = global.__probeFirstWrite; delete global.__probeFirstWrite; r(); }
      return true;
    },
    end() { this.writableEnded = true; },
  };
  try {
    const r = await dispatch.dispatchStream(
      { type: 'builtin', builtin: 'trae' },
      'glm-5.3',
      { messages: [{ role: 'user', content: 'hi' }] },
      res,
      { echoModel: 'vm/unified-chat' },
    );
    assert.strictEqual(r.streamed, true);
    assert.strictEqual(r.finishReason, 'stop');
    // 真流式分界断言：首个 SSE 内容帧写出必须早于上游流读取结束
    const firstContent = timeline.findIndex((x) => typeof x === 'string' && x.startsWith('sse:'));
    const endIdx = timeline.indexOf('consumeEnd');
    assert.ok(firstContent !== -1, '应有 SSE 输出');
    assert.ok(endIdx !== -1, 'consumeStream 应正常结束');
    assert.ok(firstContent < endIdx, `首个内容帧（#${firstContent}）必须先于上游流结束（#${endIdx}）——假流式会整段聚合后一次性下发`);
    // 末帧契约：finish_reason=stop + [DONE]
    const datas = chunks.filter((c) => c.startsWith('data: ')).map((c) => c.slice(6).trim());
    assert.strictEqual(datas[datas.length - 1], '[DONE]');
    const parsed = datas.slice(0, -1).map((d) => JSON.parse(d));
    const fin = parsed.find((o) => o.choices[0].finish_reason);
    assert.ok(fin, '应有 finish 帧');
    assert.strictEqual(fin.choices[0].finish_reason, 'stop');
  } finally {
    pool.run = origRun;
    client.llmUtilsChat = origChat;
    client.consumeStream = origConsume;
    delete global.__probeFirstWrite;
  }
});

t('dispatchTraeStream：上游 error 事件抛错（未写头时可切换候选），不静默吞', async () => {
  const dispatch = require('../model-router/dispatch');
  const pool = require('../credentials/pool');
  const client = require('../upstream/client');
  const origRun = pool.run;
  const origChat = client.llmUtilsChat;
  const origConsume = client.consumeStream;
  pool.run = async (fn) => fn('acct-1');
  client.llmUtilsChat = async () => ({ body: {} });
  client.consumeStream = async (body, onText) => {
    // error 事件需经 SSE event: 行设置 currentEvent（sse.js feedLine:319 → normalizeChunk:258）
    onText('event: error\n');
    onText('data: ' + JSON.stringify({ message: 'rate limited' }) + '\n\n');
  };
  const res = {
    writableEnded: false, headersSent: false,
    setHeader() {}, flushHeaders() {}, write() { return true; }, end() { this.writableEnded = true; },
  };
  try {
    await assert.rejects(
      () => dispatch.dispatchStream({ type: 'builtin', builtin: 'trae' }, 'glm-5.3', { messages: [{ role: 'user', content: 'hi' }] }, res, {}),
      (e) => e.code === 'UPSTREAM_STREAM_ERROR',
    );
  } finally {
    pool.run = origRun;
    client.llmUtilsChat = origChat;
    client.consumeStream = origConsume;
  }
});

console.log('log/retention（m-29）');
t('ageInDays：合法日期目录计算天数，非法名返回 null', () => {
  const { ageInDays } = require('../log/retention');
  const now = new Date('2026-10-06T00:00:00Z');
  assert.strictEqual(ageInDays('2026-10-01', now), 5);
  assert.strictEqual(ageInDays('2026-10-06', now), 0);
  assert.strictEqual(ageInDays('2026-13-99', now), null);
  assert.strictEqual(ageInDays('traffic', now), null);
  assert.strictEqual(ageInDays('', now), null);
});
t('pruneLogDirs：只删超期日期目录，保留新目录与非日期目录', () => {
  const { pruneLogDirs } = require('../log/retention');
  const os = require('os');
  const dir = path.join(os.tmpdir(), `logret-${Date.now()}`);
  fs.mkdirSync(path.join(dir, '2026-09-01'), { recursive: true });   // 35 天前 → 删
  fs.mkdirSync(path.join(dir, '2026-10-01'), { recursive: true });   // 5 天前 → 留
  fs.mkdirSync(path.join(dir, 'traffic'), { recursive: true });      // 非日期名 → 留
  fs.writeFileSync(path.join(dir, 'relay.out.log'), 'x');
  try {
    const r = pruneLogDirs(dir, new Date('2026-10-06T00:00:00Z'));
    assert.deepStrictEqual(r.removed, ['2026-09-01']);
    assert.ok(fs.existsSync(path.join(dir, '2026-10-01')));
    assert.ok(fs.existsSync(path.join(dir, 'traffic')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
t('retentionDays：默认 30，0 表示关闭，非法回落默认', () => {
  const retention = require('../log/retention');
  const orig = process.env.LOG_RETENTION_DAYS;
  try {
    delete process.env.LOG_RETENTION_DAYS;
    assert.strictEqual(retention.retentionDays(), 30);
    process.env.LOG_RETENTION_DAYS = '0';
    assert.strictEqual(retention.retentionDays(), 0);
    process.env.LOG_RETENTION_DAYS = '7';
    assert.strictEqual(retention.retentionDays(), 7);
    process.env.LOG_RETENTION_DAYS = 'abc';
    assert.strictEqual(retention.retentionDays(), 30);
  } finally {
    if (orig === undefined) delete process.env.LOG_RETENTION_DAYS;
    else process.env.LOG_RETENTION_DAYS = orig;
  }
});

main();


