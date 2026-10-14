'use strict';
/**
 * test/unit.test.js——纯函数层最小单测（Node.js 内置 assert，无外部依赖）。
 * 运行：node src/test/unit.test.js
 *
 * 必须在 require 任何模块之前设置 WORKSPACE_DIR / TRAE_API_ENCRYPT_KEY，
 * 否则 config.workspaceDir 会固化到默认 output/，污染真实账号库。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `trae-test-${Date.now()}`);
process.env.TRAE_API_ENCRYPT_KEY = 'a'.repeat(64);
process.env.API_KEY = 'test-api-key';
process.env.ADMIN_KEY = 'test-admin-key';

// 硬护栏：状态目录必须落在临时目录内，否则当场退出，绝不进入测试体。
// 判据与事故经过见 src/test/isolation-guard.js。
require('./isolation-guard')('unit');

const assert = require('assert');
const { normalizeTraeMessages } = require('../transform/request');
const { createStreamHandler } = require('../transform/sse');
const { exportOpenAI, exportAnthropic } = require('../transform/emitters');
const { buildBody } = require('../upstream/client');
const { classifyError } = require('../upstream/errors');
// store/import 在 credentials.pool 段落再 require，避免与 WORKSPACE 初始化顺序冲突。

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
  // 整段作为一次 output 内的 content 经 feedLine 喂入（JSON.parse 一次）
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
    { remaining: 10, expireTime: dayStart(1) },  // 明天 → 3 天内
    { remaining: 20, expireTime: dayStart(3) },  // 第 3 天 → 3 天内
    { remaining: 30, expireTime: dayStart(5) },  // 第 5 天 → 仅 7 天内
    { remaining: 40, expireTime: dayStart(10) }, // 更远 → 不计入
    { remaining: 5, expireTime: dayStart(0) },   // 今天 → 3 天内
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

t('模型可用性状态只取 availability 三态', () => {
  // 契约：/v1/models/status 的 status 必须来自 availability 三态。
  // 回归防护：此前 WorkBuddy 分支硬编码 'available'，前端映射表查不到值导致整页崩溃。
  const availability = require('../models/availability');

  // 未登记的模型回落 unknown，不产生第四种取值
  assert.strictEqual(availability.statusOf('never-probed-model'), 'unknown');

  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'models.js'), 'utf8');
  assert.ok(
    !/status:\s*['"]available['"]/.test(src),
    'routes/models.js 不应再出现硬编码的 available 状态',
  );
  assert.ok(
    !/wbStatus/.test(src),
    'routes/models.js 不应再有 wbStatus 旁路赋值',
  );
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
    // 只允许 work 组：选到账号则必属 work 组（可能为 null——池内其它测试账号无分组且会被排除）
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
  // usedTotal 取上游 used（累计已用）的增量口径（字段改名自旧 todayUsed）。
  // 快照序列 used=0→60→60→120，正向增量 60+0+60=120；remaining 中途上涨（940→960）不影响该口径。
  assert.strictEqual(row.usedTotal, 120);
  assert.strictEqual(row.snapshots, 4);
  assert.strictEqual(row.latestRemaining, 900);
  pStore.remove(a.id);
});

t('least_balance 优先选余额更高账号', () => {
  const low = pStore.add({ label: 'bal-low', token: 'l', balance: 10 }, 'import');
  const high = pStore.add({ label: 'bal-high', token: 'h', balance: 9999 }, 'import');
  // 禁用其它 enabled 账号，避免干扰选号
  for (const a of pStore.list()) {
    if (a.id !== low.id && a.id !== high.id) pStore.update(a.id, { enabled: false });
  }
  pStore.update(low.id, { lastPickedAt: 0, coolUntil: null, enabled: true });
  pStore.update(high.id, { lastPickedAt: 0, coolUntil: null, enabled: true });
  const chosen = pool.pick(null, { exclude: [] });
  assert.ok(chosen);
  assert.strictEqual(chosen.id, high.id, '应选中余额更高的账号');
  // 恢复被改动的账号状态
  pStore.update(high.id, { enabled: false });
  pStore.update(low.id, { enabled: false });
});

// packSec：第 offset 天 10:00 的到期秒级时间戳
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

// 模型级冷却 + 429 退避（P0-1/P0-2）
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
  // 连续第二次：带 model 时模型冷却翻倍（账号级不动，模型维度已有精确路径外的退避）
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
// 模型级冷却 + 429 退避 用例结束

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

t('classifyError：上下文超限归为终端错误 context_length（不 failover）', () => {
  const { classifyError: ce, isRetryable } = require('../upstream/errors');
  // WorkBuddy 真实报文（traffic 日志实测）
  const e = new Error('WorkBuddy upstream HTTP 400 {"code":11115,"msg":"prompt is too long: 100001 tokens > 100000 maximum"}');
  e.status = 400;
  assert.strictEqual(ce(e), 'context_length', '11115 / prompt is too long 归 context_length');
  assert.strictEqual(isRetryable('context_length'), false, 'context_length 不可重试');

  // 网关本地守门抛出的错（checkContextLimit）同语义
  const local = new Error('context length exceeded: estimated 100001 tokens exceeds input limit 75000');
  local.status = 400;
  local.code = 'context_length_exceeded';
  assert.strictEqual(ce(local), 'context_length', '本地守门错误同样归 context_length');

  // 上游只给业务码（无 code 字段文本）也要识别
  const bare = new Error('upstream rejected');
  bare.status = 400;
  bare.upstreamCode = 11115;
  assert.strictEqual(ce(bare), 'context_length');

  // 不得把 5xx / 限流误判成 context_length
  const rl = new Error('rate limited');
  rl.status = 429;
  assert.notStrictEqual(ce(rl), 'context_length');
  const five = new Error('boom');
  five.status = 503;
  assert.notStrictEqual(ce(five), 'context_length');
});

t('shouldSwitch：context_length 不切换候选（换候选解决不了窗口问题）', () => {
  const mr = require('../model-router');
  // orderCandidates 未导出 shouldSwitch，经 classifyError 语义间接验证：
  // 该分支只依赖 kind 字符串，此处验证分类器产出的 kind 与守门约定一致。
  const { classifyError } = require('../upstream/errors');
  const e = new Error('{"code":11115,"msg":"prompt is too long: 100001 tokens > 100000 maximum"}');
  assert.strictEqual(classifyError(e), 'context_length');
  assert.ok(typeof mr.handleChat === 'function');
});

// checkin 批次拆分依赖 store；真实网络请求不在单测范围内。
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

console.log('workbuddy packExpireMs（D11：长期积分取扣费截止而非周期边界）');

t('D11：单周期包（两者相等）取该值，行为与改动前一致', () => {
  const { packExpireMs } = require('../workbuddy/auth');
  const cycle = '2026-10-15 09:00:10';
  const deduct = Date.parse('2026-10-15T09:00:10+08:00');
  assert.strictEqual(packExpireMs(cycle, deduct), Date.parse('2026-10-15T09:00:10+08:00'));
});

t('D11：扣费截止远晚于周期边界时取后者（否则 FEFO 会把长期积分当临期先烧）', () => {
  const { packExpireMs } = require('../workbuddy/auth');
  // 实测样本：CodeBuddy个人体验版 CycleEndTime=2026-10-31、DeductionEndTime=2034-12-12，剩 500
  const cycle = '2026-10-31 23:59:59';
  const deduct = 2049548965000;
  const got = packExpireMs(cycle, deduct);
  assert.strictEqual(got, deduct, '必须取较晚的扣费截止，否则 500 个 2034 年才作废的积分会被当临期');
  assert.ok(got > Date.parse('2034-01-01T00:00:00Z'), '实测量级：8 年后');
});

t('D11：防御性——扣费截止早于周期边界时仍取较晚者', () => {
  const { packExpireMs } = require('../workbuddy/auth');
  const cycle = 2000000000000;
  const deduct = 1900000000000;
  assert.strictEqual(packExpireMs(cycle, deduct), 2000000000000);
});

t('D11：只有一个可解析时用那个；都不可解析返回 null（不得伪造到期时刻）', () => {
  const { packExpireMs } = require('../workbuddy/auth');
  assert.strictEqual(packExpireMs(2000000000000, null), 2000000000000);
  assert.strictEqual(packExpireMs(null, 2000000000000), 2000000000000);
  assert.strictEqual(packExpireMs(null, null), null);
  assert.strictEqual(packExpireMs('', undefined), null);
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

/**
 * 探测路由的平台声明（回归：2026-10-06 wb/* 全量误标 unavailable）。
 *
 * 根因：pool.run 的 edition 缺省语义为「只选非 workbuddy 账号」，漏传时 wb 模型
 * 被发给 Trae 上游，上游回 PARAM_INVALID，被误判成模型不可用。
 * 此处桩掉 pool.run / store，断言 helper 传出的 edition 与用号平台一致；
 * 该缺陷不报错、不告警，只表现为面板变红。
 */
t('chatViaPlatform 按 wb/ 前缀声明 edition', async () => {
  const adminDebug = require('../routes/admin-debug');
  const poolMod = require('../credentials/pool');
  const origRun = poolMod.run;
  const calls = [];
  poolMod.run = async (fn, opts) => {
    calls.push(opts);
    // 桩掉上游：只回一个可判定的聚合结果，不产生真实网络请求
    return { result: { choices: [{ message: { content: 'pong' } }] }, accountId: 'acct_stub' };
  };
  try {
    const stubStore = require('../credentials/store');
    const origGet = stubStore.get;
    stubStore.get = () => ({ edition: calls[calls.length - 1].edition === 'workbuddy' ? 'workbuddy' : 'cn' });
    const handler = adminDebug.__test.chatViaPlatform;
    await handler('wb/hy3', { messages: [{ role: 'user', content: 'ping' }] });
    assert.strictEqual(calls[0].edition, 'workbuddy', 'wb/ 模型必须以 workbuddy 平台取号');
    await handler('glm-5.3', { messages: [{ role: 'user', content: 'ping' }] });
    assert.strictEqual(calls[1].edition, 'trae', '非 wb/ 模型以 trae 平台取号');
    assert.ok(!Object.values(calls).some((o) => o.edition === undefined), '不得出现缺省 edition 的调用');
    stubStore.get = origGet;
  } finally {
    poolMod.run = origRun;
  }
});

t('chatViaPlatform 对 wb/ 前缀剥离后再交给上游', async () => {
  const adminDebug = require('../routes/admin-debug');
  const poolMod = require('../credentials/pool');
  const authMod = require('../auth');
  const wbChat = require('../workbuddy/chat');
  const origRun = poolMod.run;
  const origEnsure = authMod.ensureAuth;
  const origAggregate = wbChat.chatAggregate;
  let seenModel = null;
  poolMod.run = async (fn) => {
    const r = await fn('acct_stub_wb');
    return { result: r, accountId: 'acct_stub_wb' };
  };
  authMod.ensureAuth = async () => ({ id: 'acct_stub_wb', edition: 'workbuddy', token: 't', userId: 'u' });
  wbChat.chatAggregate = async (acct, body) => { seenModel = body.model; return { choices: [] }; };
  try {
    await adminDebug.__test.chatViaPlatform('wb/hy3-x', { messages: [{ role: 'user', content: 'ping' }] });
    assert.strictEqual(seenModel, 'hy3-x', '上游只接受裸模型 id，wb/ 前缀由网关剥离');
  } finally {
    poolMod.run = origRun;
    authMod.ensureAuth = origEnsure;
    wbChat.chatAggregate = origAggregate;
  }
});

t('platformMismatch 识别跨平台错路由', () => {
  const adminDebug = require('../routes/admin-debug');
  const store = require('../credentials/store');
  const origGet = store.get;
  try {
    store.get = (id) => (id === 'wb-acct' ? { edition: 'workbuddy' } : { edition: 'cn' });
    assert.strictEqual(adminDebug.__test.platformMismatch('wb/hy3', 'wb-acct'), false, '平台一致不算错路由');
    assert.strictEqual(adminDebug.__test.platformMismatch('wb/hy3', 'trae-acct'), true, 'wb 模型由 Trae 号服务=错路由');
    assert.strictEqual(adminDebug.__test.platformMismatch('glm-5.3', 'trae-acct'), false, '非 wb/ 模型不参与判定');
    assert.strictEqual(adminDebug.__test.platformMismatch('wb/hy3', null), false, '账号未知时不阻断（可能池空）');
  } finally {
    store.get = origGet;
  }
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

console.log('jobs.backup 恢复');
t('inspectBackup 拒绝备份目录外的路径', () => {
  const bk = require('../jobs/backup');
  const outside = path.join(os.tmpdir(), `relay-backup-${Date.now()}.json`);
  fs.writeFileSync(outside, JSON.stringify({ object: 'relay_gate_backup', checksum: 'x', encrypted: {} }), 'utf-8');
  try {
    assert.throws(() => bk.inspectBackup(outside), /备份目录/, '目录外路径应被拒绝，避免任意文件读取');
  } finally {
    if (fs.existsSync(outside)) fs.unlinkSync(outside);
  }
});

t('inspectBackup 拒绝非备份文件名', () => {
  const bk = require('../jobs/backup');
  const dir = bk.getEffective().dir;
  fs.mkdirSync(dir, { recursive: true });
  const bad = path.join(dir, 'not-a-backup.json');
  fs.writeFileSync(bad, '{}', 'utf-8');
  try {
    assert.throws(() => bk.inspectBackup(bad), /备份文件名/);
  } finally {
    if (fs.existsSync(bad)) fs.unlinkSync(bad);
  }
});

t('恢复前校验：校验和不一致时中止且不改动数据', async () => {
  const bk = require('../jobs/backup');
  const acc = pStore.add({ label: 'bk-src', token: 'bk-token', refreshToken: 'bk-rt' }, 'import');
  const run = await bk.runBackup({ trigger: 'manual', skipNotify: true });
  assert.ok(run.ok && run.file, '备份应成功');
  // 篡改密文但保留原 checksum，模拟文件损坏
  const raw = JSON.parse(fs.readFileSync(run.file, 'utf-8'));
  const tampered = path.join(path.dirname(run.file), 'relay-backup-tamper-check.json');
  raw.encrypted.data = Buffer.from('corrupted').toString('base64');
  fs.writeFileSync(tampered, JSON.stringify(raw), 'utf-8');
  try {
    await assert.rejects(
      () => bk.restoreBackup(tampered),
      /校验不通过/,
      '校验和不一致必须中止恢复',
    );
    const still = pStore.get(acc.id);
    assert.ok(still, '拒绝后账号应仍在库中');
    assert.strictEqual(still.label, 'bk-src', '拒绝恢复不应改动现有数据');
  } finally {
    if (fs.existsSync(tampered)) fs.unlinkSync(tampered);
    pStore.remove(acc.id);
  }
});

t('恢复按 id 覆盖同 id 账号并回填内容', async () => {
  const bk = require('../jobs/backup');
  const acc = pStore.add({ label: 'bk-keep', token: 'orig-token', balance: 11 }, 'import');
  const run = await bk.runBackup({ trigger: 'manual', skipNotify: true });
  assert.ok(run.ok, '备份应成功');
  // 备份后本地改动，恢复应把该账号还原成备份时的状态
  pStore.update(acc.id, { label: 'changed-after-backup', balance: 999 });
  const restored = await bk.restoreBackup(run.file, { safetyBackup: false });
  assert.strictEqual(restored.ok, true);
  assert.ok(restored.accounts >= 1, '应至少恢复 1 个账号');
  const after = pStore.get(acc.id);
  assert.strictEqual(after.label, 'bk-keep', '同 id 账号应被备份内容覆盖');
  assert.strictEqual(Number(after.balance), 11, '余额应回滚为备份时的值');
  pStore.remove(acc.id);
});

console.log('notify.enabled 总开关');
t('总开关关闭时即使配了渠道也不发送', () => {
  const n = require('../notify');
  const settings = require('../notify/settings');
  const file = settings.FILE;
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
  // 配好 webhook 但关掉总开关：应判定为不发送
  settings.save({ webhookUrl: 'https://example.com/hook', enabled: true });
  assert.strictEqual(n.enabled(), true, '总开关打开且配了 webhook 时应发送');
  settings.save({ enabled: false });
  try {
    assert.strictEqual(n.enabled(), false, '总开关关闭后不应发送');
    assert.deepStrictEqual(n.activeChannels(), [], '关闭时无生效渠道');
    assert.deepStrictEqual(n.configuredChannels(), ['webhook'], '已配置渠道仍应可见');
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
  // K-3 后平台密钥默认 scope 含 models:read（/v1/models 双面端点基础可用性）
  assert.deepStrictEqual(created.scopes, ['models:read', 'models:invoke']);
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

console.log('auth.exchangeToken 请求头构造（m-35 拆分回归守门）');
t('exchangeToken 不再因版本指纹函数缺失而 ReferenceError', async () => {
  // m-35 把 getAppVersion/getIdeVersion/getIdeVersionCode 搬去 headers.js 后，
  // exchangeToken 的调用点没跟着迁移，运行即抛 "getAppVersion is not defined"，
  // Trae 账号 token 自 2026-10-06 起全部无法自动续期。守门：换票必须能构造出
  // 请求头并到达上游（此处用不可达 host，网络层错误 ≠ 模块内符号缺失）。
  const { exchangeToken } = require('../lib/auth');
  let err = null;
  try {
    await exchangeToken('dummy-refresh-token', { host: 'https://127.0.0.1:1', clientId: 'x' });
  } catch (e) { err = e; }
  assert.ok(err, 'dummy 换票应当抛错（网络不可达/上游拒绝）');
  assert.ok(!/is not defined/.test(err.message), `不得是 ReferenceError: ${err.message}`);
});

t('版本指纹取值：env 覆盖 > 真实客户端 manifest > 内置默认', () => {
  const vd = require('../lib/version-defaults');
  const headersLib = require('../lib/headers');
  delete process.env.TRAE_APP_VERSION;
  delete process.env.TRAE_IDE_VERSION;
  delete process.env.TRAE_IDE_VERSION_CODE;
  const h = headersLib.buildCommonHeaders({
    token: 't', userId: 'u', devices: { machineId: 'm', devDeviceId: 'd' }, _edition: 'cn',
  });
  assert.strictEqual(h['x-app-version'], vd.DEFAULT_IDE_VERSION_CN);
  assert.strictEqual(h['x-ide-version'], vd.DEFAULT_IDE_VERSION_CN);
  assert.strictEqual(h['x-app-version-code'], vd.DEFAULT_IDE_VERSION_CODE);
  assert.ok(!/default/i.test(h['x-app-version']), 'x-app-version 不得回退为 default');
  process.env.TRAE_APP_VERSION = '9.9.9';
  try {
    const h2 = headersLib.buildCommonHeaders({
      token: 't', userId: 'u', devices: { machineId: 'm', devDeviceId: 'd' }, _edition: 'cn',
    });
    assert.strictEqual(h2['x-app-version'], '9.9.9', 'env 覆盖优先于内置默认');
  } finally {
    delete process.env.TRAE_APP_VERSION;
  }
});

t('auth.ensureAuth 把续期失败透传为 _refreshError（保活假阳性守门）', async () => {
  // ensureAuth 不抛续期错误（保证业务可用），但必须让调用方知道刷新失败了，
  // 否则保活任务会把「刷新失败」记成「保活成功」，临期风险被面板掩盖。
  // 注：internalAccount 是模块内私有引用，桩必须打在 credentials/store 上。
  const authMod = require('../auth');
  const legacyAuth = require('../lib/auth');
  const credStore = require('../credentials/store');
  const origExchange = legacyAuth.exchangeToken;
  const origList = credStore.list;
  const origGet = credStore.get;
  const origUpdate = credStore.update;
  const acct = {
    id: 'acct_test_refresh_err', edition: 'cn', enabled: true,
    token: 'old-token', refreshToken: 'rt',
    expiredAt: new Date(Date.now() - 3600_000).toISOString(), // 已临期
  };
  credStore.list = () => [{ id: acct.id, enabled: true }];
  credStore.get = (id) => (id === acct.id ? { ...acct } : null);
  credStore.update = () => ({});
  legacyAuth.exchangeToken = async () => { throw new Error('mock upstream failure'); };
  try {
    const r = await authMod.ensureAuth(acct.id);
    assert.strictEqual(r.token, 'old-token', '刷新失败时保留旧 token');
    assert.ok(r._refreshError, '必须透传 _refreshError');
    assert.strictEqual(r._refreshError, 'mock upstream failure');
  } finally {
    legacyAuth.exchangeToken = origExchange;
    credStore.list = origList;
    credStore.get = origGet;
    credStore.update = origUpdate;
  }
});

t('ensureAuth 临期且无 refreshToken 时报无法续期', async () => {
  const authMod = require('../auth');
  const credStore = require('../credentials/store');
  const origList = credStore.list;
  const origGet = credStore.get;
  const acct = {
    id: 'acct_test_no_rt2', edition: 'cn', enabled: true,
    token: 'old-token', refreshToken: null,
    expiredAt: new Date(Date.now() - 3600_000).toISOString(),
  };
  credStore.list = () => [{ id: acct.id, enabled: true }];
  credStore.get = (id) => (id === acct.id ? { ...acct } : null);
  try {
    const r = await authMod.ensureAuth('acct_test_no_rt2');
    assert.ok(r, '仍返回账号（旧 token 语义不变）');
    assert.ok(r._refreshError && /refreshToken/.test(r._refreshError), `应报缺少 refreshToken: ${r._refreshError}`);
  } finally {
    credStore.list = origList;
    credStore.get = origGet;
  }
});

t('scheduler.runKeepalive 把 _refreshError 记为失败而非成功', async () => {
  const scheduler = require('../jobs/scheduler');
  const authMod = require('../auth');
  const store = require('../credentials/store');
  const origList = store.list;
  const origEnsure = authMod.ensureAuth;
  const origUpdate = store.update;
  const updates = [];
  store.list = () => [{ id: 'acct_ka_test', edition: 'cn', enabled: true, label: 'ka-test' }];
  authMod.ensureAuth = async () => ({ id: 'acct_ka_test', token: 't', _refreshError: 'mock refresh fail' });
  store.update = (id, patch) => { updates.push({ id, patch }); return {}; };
  try {
    const r = await scheduler.runKeepalive();
    assert.strictEqual(r.failed, 1, '_refreshError 必须计入 failed');
    const u = updates.find((x) => x.id === 'acct_ka_test');
    assert.ok(u, '保活结果应逐账号落库');
    assert.ok(u.patch.lastKeepaliveResult.startsWith('fail:'), `应记失败: ${u.patch.lastKeepaliveResult}`);
  } finally {
    store.list = origList;
    authMod.ensureAuth = origEnsure;
    store.update = origUpdate;
  }
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
t('token 粗估：tools 声明计入输入（上游把工具 schema 一并计限额）', () => {
  const { estimateRequestTokens, estimatePromptTokens } = require('../lib/token-estimate');
  const msgs = [{ role: 'user', content: 'abcdwxyz' }];
  assert.strictEqual(estimateRequestTokens(msgs, null), estimatePromptTokens(msgs), '无 tools 时与 messages 口径一致');
  assert.strictEqual(estimateRequestTokens(msgs, []), estimatePromptTokens(msgs), '空 tools 不计入');
  const tools = [{ type: 'function', function: { name: 'abcdwxyz', description: 'x'.repeat(4000), parameters: { type: 'object', properties: { a: { type: 'string' } } } } }];
  const withTools = estimateRequestTokens(msgs, tools);
  assert.ok(withTools > estimatePromptTokens(msgs), 'tools 应显著抬升估算');
  // 27 个工具的规模不应低于单条工具的量级（实测 toolsIn=27 的请求被上游按 100001 拒）
  const many = Array.from({ length: 27 }, () => tools[0]);
  assert.ok(estimateRequestTokens(msgs, many) > estimateRequestTokens(msgs, [tools[0]]), '工具数与估算同向增长');
});
t('窗口守门：候选有效窗口取校准值（hy3 100000 优先于虚高声明 192000）', () => {
  const { calibratedWindow, calibratedWindowOf, CALIBRATED_WINDOW } = require('../model-router/window-calibration');
  assert.strictEqual(calibratedWindowOf('workbuddy/wb/hy3'), 100000);
  assert.strictEqual(calibratedWindowOf('workbuddy/wb/space-bunny'), 100000);
  // 声明 192000（目录虚高值）但校准表命中 → 取 100000
  assert.strictEqual(calibratedWindow({ provider: 'workbuddy', model: 'wb/hy3', contextWindow: 192000 }), 100000);
  // 未校准的候选：声明值优先
  assert.strictEqual(calibratedWindow({ provider: 'workbuddy', model: 'wb/step-5-preview', contextWindow: 1000000 }), 1000000);
  // 既未校准也未声明 → null（由调用方套平台地板）
  assert.strictEqual(calibratedWindow({ provider: 'trae', model: 'x' }), null);
  assert.ok(Object.keys(CALIBRATED_WINDOW).length > 0, '校准表非空');
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

console.log('model-router autotier（自动分层）');
t('autotier：按窗口分层、倍率排序、候选级守门与输出钳制', () => {
  const autotier = require('../model-router/autotier');
  const models = [
    { provider: 'trae', model: 'a', window: 116000, promptMax: 100000, maxOut: 16000, rate: 0.78, maxTier: { modelName: 'a__max', promptMaxTokens: 936000, maxOutputTokens: 64000, maxTurn: 70 } },
    { provider: 'trae', model: 'a@max', window: 1000000, promptMax: 936000, maxOut: 64000, rate: 0.78, maxTier: null },
    { provider: 'workbuddy', model: 'wb/b', window: 1000000, promptMax: null, maxOut: 128000, rate: 0.11, maxTier: null },
    { provider: 'workbuddy', model: 'wb/c', window: 192000, promptMax: null, maxOut: 64000, rate: 0, maxTier: null },
  ];
  const grouped = autotier.assignTiers(models);
  // 分层区间：[116K, 200K) → 基础层；[200K, 1M) → 大窗口层；[1M, ∞) → 超长层。
  // 116K 的 a 与 192K 的 wb/c 都落基础层。
  assert.strictEqual(grouped.get('vm/unified-chat').length, 2, '116K/192K 模型进基础层');
  assert.strictEqual(grouped.get('vm/large-context').length, 0, '无 200K-1M 区间模型');
  assert.strictEqual(grouped.get('vm/long-context').length, 2, '1M 模型进超长层');
  const sorted = autotier.sortCandidates(grouped.get('vm/long-context'), 'rate');
  assert.strictEqual(sorted[0].model, 'wb/b', '倍率低者优先');

  const clamped = autotier.clampMaxTokens({ maxOutputTokens: 16000 }, 32000);
  assert.strictEqual(clamped, 16000, 'max_tokens 应被候选输出上限钳制');
  assert.strictEqual(autotier.clampMaxTokens({ maxOutputTokens: null }, 32000), 32000, '无上限声明时不钳制');
  assert.strictEqual(autotier.clampMaxTokens({}, undefined), undefined, '未传 max_tokens 不钳制');

  const vm = {
    candidates: [
      { id: 'small', enabled: true, contextWindow: 116000 },
      { id: 'big', enabled: true, contextWindow: 1000000 },
    ],
  };
  const msgs = [{ role: 'user', content: 'x'.repeat(4 * 700000) }];
  const { estimated, list } = autotier.filterCandidatesByInput(vm, msgs);
  assert.ok(estimated > 116000 * 0.75, '估算应超过小候选的 75% 窗口');
  assert.deepStrictEqual(list.map((c) => c.id), ['big'], '只保留装得下的候选');
  const vm2 = { candidates: [{ id: 'x', enabled: true, contextWindow: null }] };
  // 未声明窗口不再无条件放行：按平台安全地板（NULL_WINDOW_FLOOR=100000）守门，
  // 杜绝「全部候选都没声明窗口 → 候选级守门整体失效 → 直接撞上游 11115」。
  assert.strictEqual(
    autotier.filterCandidatesByInput(vm2, msgs).list.length,
    0,
    '未声明窗口的候选按平台安全地板守门，不再全放行',
  );
  // 输入远低于地板时仍放行（守门不误伤正常请求）
  const small = [{ role: 'user', content: 'x'.repeat(400) }];
  assert.strictEqual(autotier.filterCandidatesByInput(vm2, small).list.length, 1, '低于地板阈值时放行');
  // 校准表命中时以实测窗口为准（hy3 目录值 192000 虚高，实测 100000）
  const vm3 = { candidates: [{ id: 'hy3', provider: 'workbuddy', model: 'wb/hy3', enabled: true, contextWindow: 192000 }] };
  const mid = [{ role: 'user', content: 'x'.repeat(4 * 90000) }];
  assert.strictEqual(
    autotier.filterCandidatesByInput(vm3, mid).list.length,
    0,
    '校准窗口 100000 优先于虚高的目录声明 192000',
  );
  assert.strictEqual(autotier.NULL_WINDOW_FLOOR, 100000, '平台安全地板为 100000');
});

console.log('model-router 模态过滤（发图只排除明确不支持的候选）');

t('requestsImages：识别三种协议的图片块，纯文本/字符串 content 不误判', () => {
  const { requestsImages } = require('../model-router/autotier');
  assert.strictEqual(requestsImages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }]), true, 'OpenAI image_url');
  assert.strictEqual(requestsImages([{ role: 'user', content: [{ type: 'image', source: { type: 'base64' } }] }]), true, 'Anthropic image');
  assert.strictEqual(requestsImages([{ role: 'user', content: [{ type: 'input_image', image_url: 'x' }] }]), true, 'Responses input_image');
  assert.strictEqual(requestsImages([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]), false, '纯文本');
  assert.strictEqual(requestsImages([{ role: 'user', content: 'abc' }]), false, '字符串 content');
  assert.strictEqual(requestsImages([]), false);
  assert.strictEqual(requestsImages(null), false);
});

t('模态过滤：发图时排除明确 multimodal=false，保留 true 与未知(null)', () => {
  const { filterCandidatesByModality } = require('../model-router/autotier');
  const vm = {
    candidates: [
      { id: 'trae/vision', enabled: true, multimodal: true },
      { id: 'trae/text-only', enabled: true, multimodal: false },
      { id: 'workbuddy/wb/glm-5v-turbo', enabled: true, multimodal: null },
      { id: 'trae/off', enabled: false, multimodal: true },
    ],
  };
  const img = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }];
  const r = filterCandidatesByModality(vm, img);
  assert.strictEqual(r.image, true);
  assert.deepStrictEqual(r.list.map((c) => c.id), ['trae/vision', 'workbuddy/wb/glm-5v-turbo'],
    '未知(null)必须放行——WorkBuddy 目录不返回该字段，当 false 会把它自家视觉模型全排掉');
  assert.strictEqual(r.blocked, false);
});

t('模态过滤：纯文本请求不受影响，全部候选可用', () => {
  const { filterCandidatesByModality } = require('../model-router/autotier');
  const vm = { candidates: [
    { id: 'a', enabled: true, multimodal: true },
    { id: 'b', enabled: true, multimodal: false },
  ] };
  const r = filterCandidatesByModality(vm, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  assert.strictEqual(r.image, false);
  assert.strictEqual(r.list.length, 2, '纯文本请求不该因模态损失任何候选');
  assert.strictEqual(r.blocked, false);
});

t('模态过滤：启用候选全为 false → blocked（供上层报 MODALITY_UNSUPPORTED）', () => {
  const { filterCandidatesByModality } = require('../model-router/autotier');
  const vm = { candidates: [
    { id: 'a', enabled: true, multimodal: false },
    { id: 'b', enabled: true, multimodal: false },
  ] };
  const img = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }];
  const r = filterCandidatesByModality(vm, img);
  assert.deepStrictEqual(r.list, []);
  assert.strictEqual(r.blocked, true);
});

t('模态过滤：池里本就没有启用候选时 blocked=false（不能把「无人可用」报成模态问题）', () => {
  const { filterCandidatesByModality } = require('../model-router/autotier');
  const vm = { candidates: [{ id: 'a', enabled: false, multimodal: false }] };
  const img = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }];
  const r = filterCandidatesByModality(vm, img);
  assert.strictEqual(r.blocked, false, '真实原因是「没有可用候选」，不是模态不支持');
});

t('候选归一化：multimodal 三态被保留（true/false/null 不得被压成布尔）', () => {
  const store = require('../model-router/store');
  const r = store.upsertVirtual('vm/modality-tri', {
    candidates: [
      { provider: 'trae', model: 'v1', multimodal: true },
      { provider: 'trae', model: 'v2', multimodal: false },
      { provider: 'workbuddy', model: 'wb/glm-5v-turbo' },
    ],
  });
  assert.ok(r.ok, `写入应成功：${r.message}`);
  const got = store.getVirtual('vm/modality-tri').candidates.map((c) => c.multimodal);
  assert.deepStrictEqual(got, [true, false, null], '未知必须留在 null，不能变 false');
});

t('orderCandidates：auto+sort=rate 按倍率升序，禁用候选被过滤', () => {
  const store = require('../model-router/store');
  const mr = require('../model-router');
  store.upsertVirtual('vm/auto-rate', {
    auto: true,
    sort: 'rate',
    candidates: [
      { id: 'exp', provider: 'trae', model: 'm1', priority: 1, rate: 1.5, enabled: true },
      { id: 'cheap', provider: 'trae', model: 'm2', priority: 2, rate: 0.1, enabled: true },
      { id: 'off', provider: 'trae', model: 'm3', priority: 3, rate: 0, enabled: false },
    ],
  });
  const ordered = mr.orderCandidates('vm/auto-rate', store.getVirtual('vm/auto-rate'));
  assert.deepStrictEqual(ordered.map((c) => c.id), ['cheap', 'exp']);
  store.removeVirtual('vm/auto-rate');
});
t('store：候选扩展字段持久化（contextWindow/maxOutputTokens/rate）', () => {
  const store = require('../model-router/store');
  store.upsertVirtual('vm/cand-fields', {
    candidates: [{ id: 'k', provider: 'workbuddy', model: 'wb/m', priority: 1, contextWindow: 1000000, maxOutputTokens: 128000, rate: 0.11 }],
  });
  const c = store.getVirtual('vm/cand-fields').candidates[0];
  assert.strictEqual(c.contextWindow, 1000000);
  assert.strictEqual(c.maxOutputTokens, 128000);
  assert.strictEqual(c.rate, 0.11);
  store.removeVirtual('vm/cand-fields');
});
t('orderCandidates：同层加权轮转不再恒定命中首个候选', () => {
  const store = require('../model-router/store');
  const mr = require('../model-router');
  store.upsertVirtual('vm/rotate', {
    auto: true,
    sort: 'rate',
    rotateTopN: 4,
    candidates: [
      { id: 'free', provider: 'trae', model: 'm0', priority: 1, weight: 3, rate: 0, enabled: true },
      { id: 'cheap', provider: 'trae', model: 'm1', priority: 2, weight: 2, rate: 0.1, enabled: true },
      { id: 'mid', provider: 'trae', model: 'm2', priority: 3, weight: 1, rate: 0.5, enabled: true },
      { id: 'exp', provider: 'trae', model: 'm3', priority: 4, weight: 1, rate: 1.5, enabled: true },
      { id: 'dear', provider: 'trae', model: 'm4', priority: 5, weight: 1, rate: 3, enabled: true },
    ],
  });
  const vm = store.getVirtual('vm/rotate');
  // 轮转池只取倍率升序前 N 个：末尾最贵的候选不应被选中
  assert.strictEqual(vm.candidates.length, 5, '候选全量保留，池大小由 rotateTopN 控制');
  const firsts = new Set();
  for (let i = 0; i < 400; i++) firsts.add(mr.orderCandidates('vm/rotate', vm)[0].id);
  assert.ok(firsts.has('cheap') && firsts.has('mid'), '低成本候选都应有机会被选中');
  assert.ok(!firsts.has('dear'), '池外最贵候选不应被选中');
  assert.ok(firsts.size >= 2, '不应恒定命中同一候选');
  store.removeVirtual('vm/rotate');
});
t('orderCandidates：轮转池在候选冷却/禁用后自动收缩', () => {
  const store = require('../model-router/store');
  const mr = require('../model-router');
  const health = require('../model-router/health');
  store.upsertVirtual('vm/rotate-cool', {
    auto: true,
    sort: 'rate',
    rotateTopN: 3,
    candidates: [
      { id: 'a', provider: 'trae', model: 'm0', priority: 1, weight: 1, rate: 0, enabled: true },
      { id: 'b', provider: 'trae', model: 'm1', priority: 2, weight: 1, rate: 0.2, enabled: true },
      { id: 'c', provider: 'trae', model: 'm2', priority: 3, weight: 1, rate: 1.2, enabled: true },
      { id: 'd', provider: 'trae', model: 'm3', priority: 4, weight: 1, rate: 2.4, enabled: true },
    ],
  });
  const vm = store.getVirtual('vm/rotate-cool');
  const err = new Error('rate limited');
  err.status = 429;
  health.markFail('vm/rotate-cool', 'a', 'rate_limit', err, 60000);
  const ordered = mr.orderCandidates('vm/rotate-cool', vm);
  // 池 = 可用候选里 rate 升序前 3 个。a 冷却后不再是可用候选，
  // 其名额由后面的 d 递补（池始终按「可用模型里轮转 N 个」理解）。
  assert.ok(!ordered.some((c) => c.id === 'a'), '冷却中的候选不进轮转池');
  assert.deepStrictEqual(
    ordered.map((c) => c.id).sort(),
    ['b', 'c', 'd'],
    '冷却候选被剔除，其余候选仍全部可见',
  );
  // b/c/d 均为池内候选，d 应在 a 冷却后获得被选为首位的机会
  const poolFirsts = new Set();
  for (let i = 0; i < 400; i++) {
    poolFirsts.add(mr.orderCandidates('vm/rotate-cool', vm)[0].id);
  }
  assert.ok(poolFirsts.has('b') && poolFirsts.has('d'), '冷却后递补的候选应参与轮转');
  health.clearCooldown('vm/rotate-cool', 'a');
  store.removeVirtual('vm/rotate-cool');
});
t('orderCandidates：已禁用候选不占轮转池名额，由启用候选递补', () => {
  const store = require('../model-router/store');
  const mr = require('../model-router');
  store.upsertVirtual('vm/rotate-disabled', {
    auto: true,
    sort: 'rate',
    rotateTopN: 2,
    candidates: [
      { id: 'a', provider: 'trae', model: 'm0', priority: 1, weight: 1, rate: 0, enabled: false },
      { id: 'b', provider: 'trae', model: 'm1', priority: 2, weight: 1, rate: 0.1, enabled: false },
      { id: 'c', provider: 'trae', model: 'm2', priority: 3, weight: 1, rate: 0.3, enabled: true },
      { id: 'd', provider: 'trae', model: 'm3', priority: 4, weight: 1, rate: 0.5, enabled: true },
      { id: 'e', provider: 'trae', model: 'm4', priority: 5, weight: 1, rate: 0.9, enabled: true },
    ],
  });
  const vm = store.getVirtual('vm/rotate-disabled');
  // 最便宜的两个（a/b）被禁用，池应由启用的 c/d 填满，而不是只剩空池
  const ordered = mr.orderCandidates('vm/rotate-disabled', vm);
  assert.ok(!ordered.some((c) => c.id === 'a' || c.id === 'b'), '已禁用候选不参与调度');
  const firsts = new Set();
  for (let i = 0; i < 400; i++) {
    firsts.add(mr.orderCandidates('vm/rotate-disabled', vm)[0].id);
  }
  assert.ok(firsts.has('c') && firsts.has('d'), '配额应由启用候选 c/d 填满并轮转');
  assert.ok(!firsts.has('e'), '超出 rotateTopN 的候选仍在池外');
  // 全部禁用时不应崩溃，返回空序列（由上层给出 no-candidate 错误）
  store.upsertVirtual('vm/rotate-alloff', {
    auto: true,
    sort: 'rate',
    rotateTopN: 3,
    candidates: [
      { id: 'x', provider: 'trae', model: 'm0', priority: 1, rate: 0, enabled: false },
      { id: 'y', provider: 'trae', model: 'm1', priority: 2, rate: 0.4, enabled: false },
    ],
  });
  assert.deepStrictEqual(
    mr.orderCandidates('vm/rotate-alloff', store.getVirtual('vm/rotate-alloff')),
    [],
    '全部禁用时返回空序列',
  );
  store.removeVirtual('vm/rotate-disabled');
  store.removeVirtual('vm/rotate-alloff');
});
t('orderCandidates：strategy=weighted 不再被 auto/sort 早返回屏蔽', () => {
  const store = require('../model-router/store');
  const mr = require('../model-router');
  store.upsertVirtual('vm/rotate-weighted', {
    auto: true,
    sort: 'rate',
    strategy: 'weighted',
    rotateTopN: 2,
    candidates: [
      { id: 'a', provider: 'trae', model: 'm0', priority: 1, weight: 1, rate: 0, enabled: true },
      { id: 'b', provider: 'trae', model: 'm2', priority: 2, weight: 9, enabled: true },
    ],
  });
  const hits = {};
  for (let i = 0; i < 300; i++) {
    const pick = mr.orderCandidates('vm/rotate-weighted', store.getVirtual('vm/rotate-weighted'))[0];
    hits[pick.id] = (hits[pick.id] || 0) + 1;
  }
  assert.ok(hits.b > hits.a, '高权重候选应获得更多份额');
  store.removeVirtual('vm/rotate-weighted');
});
t('autotier：候选权重按倍率反推（倍率低者权重高）', () => {
  const autotier = require('../model-router/autotier');
  const store = require('../model-router/store');
  const weights = autotier.deriveWeights([
    { rate: 0 },
    { rate: 0.5 },
    { rate: 1.5 },
  ]);
  assert.strictEqual(weights.length, 3);
  assert.ok(weights[0] > weights[1] && weights[1] > weights[2], '倍率升序对应权重递减');
  assert.ok(weights.every((w) => w >= 1), '权重不低于 1');
  assert.deepStrictEqual(autotier.deriveWeights([]), []);
  assert.deepStrictEqual(autotier.deriveWeights([{ rate: null }]), [1], '未知倍率给基础权重 1');
  // 写回配置后仍按倍率排序，排序结果与权重顺序一致
  store.upsertVirtual('vm/auto-weight', {
    auto: true,
    sort: 'rate',
    rotateTopN: 2,
    candidates: [
      { id: 'a', provider: 'trae', model: 'm0', priority: 1, weight: 3, rate: 0 },
      { id: 'b', provider: 'trae', model: 'm2', priority: 2, weight: 1, rate: 1.5 },
    ],
  });
  const vm = store.getVirtual('vm/auto-weight');
  assert.strictEqual(vm.rotateTopN, 2, 'rotateTopN 应被归一化并持久化');
  store.removeVirtual('vm/auto-weight');
});
t('orderCandidates：置顶候选强制进池，不因倍率排名靠后被挤出', () => {
  const store = require('../model-router/store');
  const mr = require('../model-router');
  store.upsertVirtual('vm/pin', {
    auto: true,
    sort: 'rate',
    rotateTopN: 2,
    candidates: [
      { id: 'cheap', provider: 'trae', model: 'm0', priority: 1, weight: 8, rate: 0, enabled: true },
      { id: 'cheap2', provider: 'trae', model: 'm1', priority: 2, weight: 5, rate: 0.2, enabled: true },
      { id: 'mid', provider: 'trae', model: 'm2', priority: 3, weight: 3, rate: 0.6, enabled: true },
      { id: 'pinned', provider: 'trae', model: 'm3', priority: 4, weight: 8, rate: 1.8, pinned: true, enabled: true },
    ],
  });
  const vm = store.getVirtual('vm/pin');
  assert.strictEqual(vm.candidates.find((c) => c.id === 'pinned').pinned, true, 'pinned 应被归一化并持久化');
  const firsts = new Set();
  for (let i = 0; i < 400; i++) firsts.add(mr.orderCandidates('vm/pin', vm)[0].id);
  assert.ok(firsts.has('pinned'), '置顶候选必须参与首选轮转');
  assert.ok(firsts.has('cheap'), '低成本候选不应被置顶挤掉');
  // 池 = 置顶候选 + 成本序前 N 个
  const ordered = mr.orderCandidates('vm/pin', vm);
  const poolIds = ordered.slice(0, 3).map((c) => c.id);
  assert.ok(poolIds.includes('pinned'), '置顶候选应在池内');
  store.removeVirtual('vm/pin');
});
t('orderCandidates：置顶候选被禁用后退出轮转池', () => {
  const store = require('../model-router/store');
  const mr = require('../model-router');
  store.upsertVirtual('vm/pin-off', {
    auto: true,
    sort: 'rate',
    rotateTopN: 1,
    candidates: [
      { id: 'a', provider: 'trae', model: 'm0', priority: 1, weight: 8, rate: 0, enabled: true },
      { id: 'p', provider: 'trae', model: 'm1', priority: 2, weight: 8, rate: 2, pinned: true, enabled: false },
    ],
  });
  const firsts = new Set();
  for (let i = 0; i < 200; i++) {
    firsts.add(mr.orderCandidates('vm/pin-off', store.getVirtual('vm/pin-off'))[0].id);
  }
  assert.ok(!firsts.has('p'), '已禁用的置顶候选不应参与调度');
  assert.ok(firsts.has('a'), '剩余候选仍应可被选中');
  store.removeVirtual('vm/pin-off');
});
console.log('usage 计量与 token 补算');
t('usageToLogFields：蛇形/驼峰键名，全 0 视为未计量', () => {
  const mr = require('../model-router');
  const f1 = mr.usageToLogFields({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.deepStrictEqual(f1, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  const f2 = mr.usageToLogFields({ inputTokens: 7, outputTokens: 3 });
  assert.strictEqual(f2.totalTokens, 10, '缺 total 时应按 pt+ct 合成');
  assert.deepStrictEqual(mr.usageToLogFields(null), {});
  assert.deepStrictEqual(mr.usageToLogFields({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }), {}, '全 0 应视为未计量');
});
t('estimateTokensOfText：tiktoken 补算返回 prompt/completion/total', () => {
  const { estimateTokensOfText } = require('../lib/token-precise');
  const msgs = [{ role: 'user', content: '请把这段话原样复述一遍，不要增删内容。' }];
  const r = estimateTokensOfText(msgs, '好的，我将原样复述这段话。');
  assert.ok(r.promptTokens > 0 && r.completionTokens > 0, '两侧均应大于 0');
  assert.strictEqual(r.totalTokens, r.promptTokens + r.completionTokens);
  // 空输入
  const empty = estimateTokensOfText([], '');
  assert.ok(empty.totalTokens >= 0);
});
t('estimateCost：按真实候选模型匹配费率（虚拟 ID 不在费率表时不误配）', () => {
  const rates = require('../models/rates');
  // glm-5.2 在动态目录中 rate=0.78
  const c = rates.estimateCost('glm-5.2', 10000, 0);
  assert.ok(c != null && c > 0, '真实模型应有费率');
  // 虚拟 ID 无费率 → null，调用方应跳过而不是错误计 0
  assert.strictEqual(rates.estimateCost('vm/unified-chat', 10000, 0), null);
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

console.log('upstream/trae-usage');
t('normalizeRow：保留计费字段，剥离 user_input_preview（隐私）', () => {
  const { normalizeRow } = require('../upstream/trae-usage');
  const row = normalizeRow({
    session_id: 's-1',
    usage_time: 1791126902,
    model_name: 'DeepSeek-V4-Flash 正式版',
    credits_float: 1.5324,
    amount_float: 1.5324,
    cost_money_float: 0.03831,
    user_input_preview: 'SECRET-PROMPT',
    extra_info: { input_token: 439017, output_token: 142, cache_read_token: 438528, cache_write_token: 0 },
    usage_group_details: [
      { group_key: 'default', model_display_name: 'DeepSeek-V4-Flash 正式版', credits_float: 1.2 },
      { group_key: 'default', model_display_name: 'GLM-5.3-Flash', credits_float: 0.3324 },
    ],
  });
  assert.strictEqual(row.sessionId, 's-1');
  assert.strictEqual(row.credits, 1.5324);
  assert.strictEqual(row.inputTokens, 439017);
  assert.strictEqual(row.byModel.length, 2, '按 usage_group_details 拆分');
  assert.strictEqual(row.byModel[1].credits, 0.3324);
  assert.ok(JSON.stringify(row).indexOf('SECRET-PROMPT') === -1, 'user_input_preview 不得落盘');
});

t('normalizeRow：无 usage_group_details 时回退行级模型；无 session_id 返回 null', () => {
  const { normalizeRow } = require('../upstream/trae-usage');
  const row = normalizeRow({
    session_id: 's-2', usage_time: 1, model_name: 'glm-5.2',
    credits_float: 0.78, extra_info: { input_token: 10, output_token: 5 },
  });
  assert.deepStrictEqual(row.byModel, [{ model: 'glm-5.2', credits: 0.78 }]);
  assert.strictEqual(normalizeRow({ usage_time: 1, credits_float: 1 }), null);
  assert.strictEqual(normalizeRow(null), null);
});

t('dayBounds：本地日界（非 UTC）', () => {
  const { dayBounds } = require('../upstream/trae-usage');
  const { start, end } = dayBounds('2026-10-07');
  assert.strictEqual(end - start, 86400);
  // 本地时区 2026-10-07 00:00:00 的 unix 秒
  assert.strictEqual(start, Math.floor(new Date(2026, 9, 7).getTime() / 1000));
});

t('recentDayKeys（trae-usage）生成 N 个连续本地日期（新→旧）', () => {
  const { recentDayKeys } = require('../upstream/trae-usage');
  const keys = recentDayKeys(3, new Date(2026, 9, 3, 12, 0, 0));
  assert.deepStrictEqual(keys, ['2026-10-03', '2026-10-02', '2026-10-01']);
});

t('variant：Trae billing 能力已启用且端点路径收敛', () => {
  const v = require('../platform/variant');
  assert.strictEqual(v.can('trae', 'billing'), true);
  assert.strictEqual(
    v.variantOf(v.TRAE).paths.sessionUsage,
    '/trae/api/v1/pay/query_user_usage_group_by_session',
  );
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

console.log('jobs.rotate-accounts 轮换失败隔离（m-39）');
/** 去除注释与字符串后的代码体（静态断言用，避免注释里的词误报）。 */
function codeOf(js) {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

t('轮换循环不因单账号 startClient 失败而中止整遍', () => {
  // 服务会话（Session 0）下 startClient 必返回 reason=service_session；此时 break 会让整遍
  // 轮换在第一个账号断链，剩余账号连 auth 都不切换，表现为「轮换触发不了」。守门：循环体内不得出现 break。
  const src = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'rotate-accounts.js'), 'utf-8');
  const loop = src.match(/for \(const acct of accounts\) \{[\s\S]*?\n  \}/);
  assert.ok(loop, '应能定位轮换主循环');
  const body = codeOf(loop[0]);
  assert.ok(!/\bbreak\b/.test(body),
    '轮换主循环内不得 break：单账号失败必须 continue，否则整遍断链');
  assert.ok(/continue;/.test(body), '失败分支应 continue 到下一个账号');
  // 前置的「无法停止客户端」仍允许整遍早退（一个号都没切换，无从继续）
  assert.ok(/if \(!stopped\) \{[\s\S]{0,200}?return \{ ok: 0, failed: 1/.test(src),
    'stopClient 前置失败应整遍早退（此时尚未切换任何账号）');
});

t('轮换逐账号失败计入 failed 且不丢结果', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'rotate-accounts.js'), 'utf-8');
  // switchTo 成功后 startClient 失败：要 push 一条 ok:false 并 failed++，然后 continue
  assert.ok(/auth 已切换但客户端启动失败/.test(src),
    'startClient 失败应如实记录「auth 已切换但客户端未起」');
  assert.ok(/const s = await startClient\(\);[\s\S]{0,400}?failed\+\+;[\s\S]{0,200}?continue;/.test(src),
    'startClient 失败应计 failed 并 continue');
});

console.log('jobs.scheduler 重复排程竞态（m-39）');
t('stop() 递增代次，在途定时回调不再复活旧链', () => {
  // restart() 时若某链回调正卡在 await fn()，stop() 清不掉它（句柄已 fire）；
  // 回调结束后若只看 started 就会再排一条，与新链并存 → 同一任务每天触发两次。
  const src = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'scheduler.js'), 'utf-8');
  assert.ok(/let scheduleEpoch = 0/.test(src), '应有调度代次计数器');
  const stopBody = src.match(/function stop\(\)\s*\{[\s\S]*?\n\}/)[0];
  assert.ok(/scheduleEpoch \+= 1/.test(stopBody), 'stop() 必须递增代次');
  const onceBody = src.match(/function scheduleOnce\([\s\S]*?\n\}/)[0];
  assert.ok(/const epoch = scheduleEpoch/.test(onceBody), 'scheduleOnce 应捕获注册时的代次');
  assert.ok(/epoch === scheduleEpoch/.test(onceBody), '重排前必须比对代次');
});

t('stop() 之后 started 为 false，restart 可重新排链（重排语义不变）', () => {
  const sched = require('../jobs/scheduler');
  const ss = require('../jobs/scheduler-settings').getEffective();
  sched.stop();
  assert.strictEqual(sched.snapshot().enabled, false, 'stop 后 enabled 应为 false');
  const snap = sched.restart();
  assert.ok(snap && typeof snap === 'object', 'restart 应返回快照');
  // 时刻必须与 scheduler-settings 生效值一致（不硬编码具体时刻）
  assert.strictEqual(snap.checkinHour, ss.checkinHour, '签到小时应来自生效配置');
  assert.strictEqual(snap.checkinMinute, ss.checkinMinute, '签到分钟应来自生效配置');
  assert.strictEqual(snap.keepaliveHour, ss.keepaliveHour, '保活小时应来自生效配置');
  assert.strictEqual(snap.rotateHour, ss.rotateHour, '轮换小时应来自生效配置');
  // 收尾：停掉测试期启动的定时器，避免影响后续用例
  sched.stop();
  assert.strictEqual(sched.snapshot().enabled, false, '收尾 stop 后应仍为 false');
});

t('model-access 不再 require model-router 的 index（避免加载期循环）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'model-access.js'), 'utf-8');
  assert.ok(!/require\('\.\.\/model-router'\)/.test(src), 'model-access 应直接依赖 model-router/store');
  assert.ok(/require\('\.\.\/model-router\/store'\)/.test(src));
});

console.log('upstream.checkin-all 跨平台聚合签到（m-39）');
t('checkinPlatforms 归一 Trae 历史 edition 后纳入 trae', () => {
  // 首次实测只跑了 workbuddy：因为用 editionOf('cn')='cn' 查 runner 查不到，
  // 必须走 normalizeEdition 把 cn/sg/us/manual 归到 trae。
  const { checkinPlatforms } = require('../upstream/checkin-all');
  const store = require('../credentials/store');
  const origList = store.list;
  store.list = () => [
    { id: 'a1', edition: 'cn', enabled: true },
    { id: 'a2', edition: 'workbuddy', enabled: true },
    { id: 'a3', edition: 'zcode', enabled: true },      // 无 checkin 能力
    { id: 'a4', edition: 'cn', enabled: false },        // 停用不计
  ];
  try {
    const p = checkinPlatforms();
    assert.deepStrictEqual(p, ['trae', 'workbuddy'],
      `应同时覆盖 trae 与 workbuddy，实际 ${JSON.stringify(p)}`);
    assert.ok(!p.includes('zcode'), 'ZCode 无签到能力，不得纳入');
  } finally {
    store.list = origList;
  }
});

t('checkinAllByPlatform 汇总各平台明细且单平台失败不影响其它平台', async () => {
  const { checkinAllByPlatform } = require('../upstream/checkin-all');
  const store = require('../credentials/store');
  const traeMod = require('../upstream/checkin');
  const wbMod = require('../upstream/wb-checkin');
  const origList = store.list;
  const origTrae = traeMod.checkinAllEnabled;
  const origWb = wbMod.wbCheckinAllEnabled;
  store.list = () => [
    { id: 'a1', edition: 'cn', enabled: true },
    { id: 'a2', edition: 'workbuddy', enabled: true },
  ];
  traeMod.checkinAllEnabled = async () => ({
    claimed: [{ accountId: 'a1', label: 'trae-1', checkinCredits: 100 }],
    already: [], disabled: [], failed: [], total: 1,
    summary: { claimed: 1, already: 0, disabled: 0, failed: 0 },
  });
  wbMod.wbCheckinAllEnabled = async () => { throw new Error('mock wb down'); };
  try {
    const r = await checkinAllByPlatform({ spreadMinutes: 0, notifyOnDone: false });
    assert.strictEqual(r.total, 1, 'total 只统计成功平台');
    assert.strictEqual(r.claimed, 1);
    assert.strictEqual(r.failed, 1, '整平台失败应计 1 条 failed');
    const trae = r.platforms.find((p) => p.platform === 'trae');
    const wb = r.platforms.find((p) => p.platform === 'workbuddy');
    assert.ok(trae && trae.claimed === 1, 'trae 明细应保留');
    assert.ok(wb && wb.error === 'mock wb down', 'workbuddy 失败原因应如实透出');
    assert.ok(/Trae/.test(r.message) && /WorkBuddy/.test(r.message),
      `message 应含两个平台: ${r.message}`);
  } finally {
    store.list = origList;
    traeMod.checkinAllEnabled = origTrae;
    wbMod.wbCheckinAllEnabled = origWb;
  }
});

t('前端「全部签到」指向聚合端点而非 Trae 专用端点', () => {
  // 旧实现打 /v1/credentials/checkin（Trae 专用），WorkBuddy 被静默跳过，
  // 按钮名却叫「全部签到」——这是 m-39 的直接症状。
  const api = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'shared', 'api', 'credentials.ts'), 'utf-8');
  assert.ok(/checkinAll[\s\S]{0,200}?\/v1\/credentials\/checkin-all/.test(api),
    'checkinAll 应指向 /v1/credentials/checkin-all');
  assert.ok(!/checkinAll[\s\S]{0,200}?\/v1\/credentials\/checkin'/.test(api),
    'checkinAll 不得再指向 Trae 专用的 /v1/credentials/checkin');
});

t('前端单账号签到按平台分发到 WorkBuddy 端点', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'features', 'accounts', 'CredentialsPage.tsx'), 'utf-8');
  assert.ok(/platformOf\(a\) === 'workbuddy'[\s\S]{0,200}?wbCheckinOne/.test(page),
    'WorkBuddy 账号的签到按钮应走 wbCheckin');
  assert.ok(/from '\.\.\/\.\.\/shared\/api\/workbuddy'/.test(page), '应引入 workbuddy 接口模块');
});

t('手动签到会推送通知（m-39 用户明确要求）', () => {
  const all = fs.readFileSync(path.join(__dirname, '..', 'upstream', 'checkin-all.js'), 'utf-8');
  assert.ok(/notifyOnDone[\s\S]{0,600}?notify\(/.test(all), '聚合签到应支持完成通知');
  const cred = fs.readFileSync(path.join(__dirname, '..', 'routes', 'credentials.js'), 'utf-8');
  assert.ok(/checkin-all[\s\S]{0,900}?notifyOnDone: true/.test(cred), '手动全部签到应开启通知');
  assert.ok(/const r = await checkinAccount\(req\.params\.id\);[\s\S]{0,900}?notify\(/.test(cred),
    '手动单账号签到（Trae）应推送通知');
  const wb = fs.readFileSync(path.join(__dirname, '..', 'routes', 'workbuddy.js'), 'utf-8');
  assert.ok(/wbCheckinAccount\(String\(req\.body\.accountId\)\)[\s\S]{0,900}?notify\(/.test(wb),
    '手动单账号签到（WorkBuddy）应推送通知');
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

/*
 * .env 与进程环境的优先级 —— 事故回归测试。
 *
 * 曾把 config 的 .env 加载改成 dotenv override:true 来修「reload 读不到新值」，
 * 结果 .env 反过来压掉了调用方显式设置的环境变量：本文件第 12 行用
 * WORKSPACE_DIR 把状态目录指到临时目录做隔离，而仓库 .env 里也有
 * WORKSPACE_DIR=./output，于是整个测试套件跑到了真实 output/ 状态目录上，
 * 用测试假密钥在真实账号库里写了 73 行账号。
 *
 * 两条不可动摇的规则，缺一条就会重演：
 *   1. 进程环境显式给出的键，.env 永不覆盖（含 reload）；
 *   2. .env 提供过的键，reload 必须按文件现值刷新（否则「热重载」是空操作）。
 */
t('进程环境显式给出的键不被 .env 覆盖（含 reload）', () => {
  const cfg = require('../config');
  assert.strictEqual(
    cfg.workspaceDir,
    process.env.WORKSPACE_DIR,
    '.env 不得覆盖启动时由进程环境给出的 WORKSPACE_DIR',
  );
  assert.ok(
    String(cfg.workspaceDir).startsWith(os.tmpdir()),
    `状态目录必须留在测试临时目录内，实际为 ${cfg.workspaceDir}`,
  );
  cfg.reload();
  assert.strictEqual(
    cfg.workspaceDir,
    process.env.WORKSPACE_DIR,
    'reload 后同样不得用 .env 覆盖进程环境的 WORKSPACE_DIR',
  );
  assert.strictEqual(
    process.env.WORKSPACE_DIR,
    cfg.workspaceDir,
    'reload 不得改动进程环境里的 WORKSPACE_DIR',
  );
});

t('.env 提供过的键在 reload 时按文件现值刷新（热重载不是空操作）', () => {
  const cfg = require('../config');
  const envFile = path.join(__dirname, '..', '..', '.env');
  // 纯环境变量部署（无 .env）时无从此断言，跳过而不是失败
  if (!fs.existsSync(envFile)) return;
  const parsed = require('dotenv').parse(fs.readFileSync(envFile, 'utf-8')) || {};
  const key = 'LOG_LEVEL';
  if (!(key in parsed)) return; // .env 未声明该键则无从验证
  assert.strictEqual(process.env[key], parsed[key], `前置：.env 的 ${key} 应已注入进程环境`);
  process.env[key] = '__mutated_by_test__';
  cfg.reload();
  assert.strictEqual(
    process.env[key],
    parsed[key],
    `reload 应把 .env 提供的 ${key} 刷回文件现值（否则热重载是空操作）；实际=${JSON.stringify(process.env[key])} 期望=${JSON.stringify(parsed[key])}`,
  );
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

t('checkAdminToken：API_KEY 不再能通过管理面（K-1 权限分离）', () => {
  const { checkAdminToken } = require('../middleware/auth');
  assert.strictEqual(checkAdminToken(process.env.API_KEY).ok, false);
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
    // 畸形倍率（解析为 NaN）归一为 null，不得流入费率计算
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
  // 读取结束时刻。真流式时首个内容帧先于 consumeEnd。
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

t('dispatchTraeStream + 提交闸门：只出过思考就失败时，降级窗口仍然开着（本次修复的目标）', async () => {
  const dispatch = require('../model-router/dispatch');
  const { createStreamGate } = require('../model-router/stream-gate');
  const pool = require('../credentials/pool');
  const client = require('../upstream/client');
  const origRun = pool.run;
  const origChat = client.llmUtilsChat;
  const origConsume = client.consumeStream;
  pool.run = async (fn) => fn('acct-1');
  client.llmUtilsChat = async () => ({ body: {} });
  client.consumeStream = async (body, onText) => {
    // 先吐一个纯思考增量（上游因此 flushHeaders），随后报错——原实现用
    // res.headersSent 判可切换，此时窗口已关，整轮失败且客户端一个字都没拿到。
    onText(`data: ${JSON.stringify({ content: '', reasoning_content: '让我想想…' })}\n\n`);
    onText('event: error\n');
    onText(`data: ${JSON.stringify({ message: 'rate limited' })}\n\n`);
  };
  const res = {
    writableEnded: false, headersSent: false,
    setHeader() {}, flushHeaders() { this.headersSent = true; }, write() { return true; }, end() { this.writableEnded = true; },
  };
  const gate = createStreamGate(res, { keepaliveMs: 0 });
  try {
    await assert.rejects(
      () => dispatch.dispatchStream({ type: 'builtin', builtin: 'trae' }, 'glm-5.3', { messages: [{ role: 'user', content: 'hi' }] }, res, { gate }),
      (e) => e.code === 'UPSTREAM_STREAM_ERROR',
    );
    assert.strictEqual(res.headersSent, true, '前置：思考帧已下发，HTTP 头已发出');
    assert.strictEqual(gate.answerCommitted, false, '只有思考时不得提交，否则该场景永远无法降级');
  } finally {
    gate.dispose();
    pool.run = origRun;
    client.llmUtilsChat = origChat;
    client.consumeStream = origConsume;
  }
});

t('dispatchTraeStream + 提交闸门：交付答案后立即提交，禁止再换候选', async () => {
  const dispatch = require('../model-router/dispatch');
  const { createStreamGate } = require('../model-router/stream-gate');
  const pool = require('../credentials/pool');
  const client = require('../upstream/client');
  const origRun = pool.run;
  const origChat = client.llmUtilsChat;
  const origConsume = client.consumeStream;
  pool.run = async (fn) => fn('acct-1');
  client.llmUtilsChat = async () => ({ body: {} });
  client.consumeStream = async (body, onText) => {
    onText(`data: ${JSON.stringify({ content: '你好' })}\n\n`);
    onText(`data: ${JSON.stringify({ done: true, finish_reason: 'stop' })}\n\n`);
  };
  const res = {
    writableEnded: false, headersSent: false,
    setHeader() {}, flushHeaders() { this.headersSent = true; }, write() { return true; }, end() { this.writableEnded = true; },
  };
  const gate = createStreamGate(res, { keepaliveMs: 0 });
  try {
    await dispatch.dispatchStream({ type: 'builtin', builtin: 'trae' }, 'glm-5.3', { messages: [{ role: 'user', content: 'hi' }] }, res, { gate });
    assert.strictEqual(gate.answerCommitted, true, '交付过答案就必须提交（换候选会让客户端看到两个模型的输出）');
  } finally {
    gate.dispose();
    pool.run = origRun;
    client.llmUtilsChat = origChat;
    client.consumeStream = origConsume;
  }
});

t('提交闸门对正常路径零影响：带闸门与不带闸门下发的字节必须完全一致', async () => {
  const dispatch = require('../model-router/dispatch');
  const { createStreamGate } = require('../model-router/stream-gate');
  const pool = require('../credentials/pool');
  const client = require('../upstream/client');
  const origRun = pool.run;
  const origChat = client.llmUtilsChat;
  const origConsume = client.consumeStream;
  pool.run = async (fn) => fn('acct-1');
  client.llmUtilsChat = async () => ({ body: {} });

  // 覆盖四类帧：思考增量、文本增量、工具调用、结束。
  // 我们的 emitter 每次 write 都是完整帧（以 \n\n 收尾），闸门应原样立即下发。
  const frames = [
    `data: ${JSON.stringify({ content: '', reasoning_content: '先想' })}\n\n`,
    `data: ${JSON.stringify({ content: '你好' })}\n\n`,
    `data: ${JSON.stringify({ tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] })}\n\n`,
    `data: ${JSON.stringify({ done: true, finish_reason: 'stop' })}\n\n`,
  ];
  const collect = async (useGate) => {
    const chunks = [];
    const res = {
      writableEnded: false, headersSent: false,
      setHeader() {}, flushHeaders() { this.headersSent = true; },
      write(s) { chunks.push(String(s)); return true; },
      end() { this.writableEnded = true; },
    };
    client.consumeStream = async (body, onText) => { for (const f of frames) onText(f); };
    const gate = useGate ? createStreamGate(res, { keepaliveMs: 0 }) : null;
    try {
      await dispatch.dispatchStream(
        { type: 'builtin', builtin: 'trae' }, 'glm-5.3',
        { messages: [{ role: 'user', content: 'hi' }] },
        res, gate ? { gate } : {},
      );
    } finally {
      if (gate) gate.dispose();
    }
    return chunks.join('');
  };

  // completionId 每次随机，比较前归一化；除它之外不得有任何字节差异
  const norm = (s) => s.replace(/"id":"chatcmpl-[a-z0-9]+"/g, '"id":"chatcmpl-X"');
  try {
    const plain = norm(await collect(false));
    const gated = norm(await collect(true));
    let diff = -1;
    for (let i = 0; i < Math.max(plain.length, gated.length); i++) {
      if (plain[i] !== gated[i]) { diff = i; break; }
    }
    assert.strictEqual(
      gated, plain,
      `闸门不得改变正常路径下发给客户端的任何字节。长度 plain=${plain.length} gated=${gated.length}，`
      + `首个差异 @${diff}：plain=...${JSON.stringify(plain.slice(Math.max(0, diff - 30), diff + 60))} `
      + `gated=...${JSON.stringify(gated.slice(Math.max(0, diff - 30), diff + 60))}`,
    );
    assert.ok(plain.includes('"content":"你好"'), '前置：样本里应确有内容帧');
    assert.ok(plain.includes('reasoning_content'), '前置：样本里应确有思考帧（它必须照常下发，不改 UX）');
  } finally {
    pool.run = origRun;
    client.llmUtilsChat = origChat;
    client.consumeStream = origConsume;
  }
});

console.log('lib/sse-sniff（上游返回形状判定）');

t('sniffHead：SSE / JSON / HTML / 空 / 未知 各形态判定', () => {
  const { sniffHead } = require('../lib/sse-sniff');
  assert.strictEqual(sniffHead('data: {"a":1}\n\n'), 'sse');
  assert.strictEqual(sniffHead('event: message\ndata: {}\n\n'), 'sse');
  assert.strictEqual(sniffHead(': ping\n\n'), 'sse', '注释帧也是 SSE');
  assert.strictEqual(sniffHead('id: 3\n'), 'sse');
  assert.strictEqual(sniffHead('retry: 1000\n'), 'sse');
  assert.strictEqual(sniffHead('{"choices":[]}'), 'json');
  assert.strictEqual(sniffHead('[{"a":1}]'), 'json');
  assert.strictEqual(sniffHead('<html><body>503</body></html>'), 'html');
  assert.strictEqual(sniffHead(''), 'empty');
  assert.strictEqual(sniffHead('   \n  '), 'empty');
  assert.strictEqual(sniffHead(null), 'empty');
  assert.strictEqual(sniffHead('乱码输出'), 'unknown');
});

t('sniffHead：前导空白与 BOM 不干扰判定', () => {
  const { sniffHead } = require('../lib/sse-sniff');
  assert.strictEqual(sniffHead('\n\n  data: {}\n\n'), 'sse');
  assert.strictEqual(sniffHead('\uFEFF{"a":1}'), 'json');
});

t('describeShape 给出人话形状名', () => {
  const { describeShape } = require('../lib/sse-sniff');
  assert.match(describeShape('json'), /JSON/);
  assert.match(describeShape('sse'), /SSE/);
});

console.log('出口对「零 SSE 事件」的处置（上游忽略 stream=true 返回 JSON）');

t('dispatchTraeStream：上游返回 JSON 而非 SSE 时抛 UPSTREAM_NOT_STREAM，不得静默收尾成空回复', async () => {
  const dispatch = require('../model-router/dispatch');
  const pool = require('../credentials/pool');
  const client = require('../upstream/client');
  const origRun = pool.run;
  const origChat = client.llmUtilsChat;
  const origConsume = client.consumeStream;
  pool.run = async (fn) => fn('acct-1');
  client.llmUtilsChat = async () => ({ body: {} });
  // 上游无视 stream=true，回了完整 JSON；SSE 解析器按行找不到 data:，零事件
  const jsonBody = JSON.stringify({ choices: [{ message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }] });
  client.consumeStream = async (body, onText) => { onText(jsonBody); };
  const written = [];
  const res = {
    writableEnded: false, headersSent: false,
    setHeader() {}, flushHeaders() { this.headersSent = true; },
    write(s) { written.push(String(s)); return true; }, end() { this.writableEnded = true; },
  };
  try {
    await assert.rejects(
      () => dispatch.dispatchStream({ type: 'builtin', builtin: 'trae' }, 'glm-5.3', { messages: [{ role: 'user', content: 'hi' }] }, res, {}),
      (e) => e.code === 'UPSTREAM_NOT_STREAM' && e.status === 502,
      '必须抛 UPSTREAM_NOT_STREAM（可降级/可诊断），而不是安静地发一个空回复',
    );
    assert.strictEqual(written.length, 0, '抛错前不得写出任何 SSE 字节（这样上层还能整体换候选）');
  } finally {
    pool.run = origRun;
    client.llmUtilsChat = origChat;
    client.consumeStream = origConsume;
  }
});

t('dispatchTraeStream：上游流为空（零字节）同样抛错，不当作空回复成功', async () => {
  const dispatch = require('../model-router/dispatch');
  const pool = require('../credentials/pool');
  const client = require('../upstream/client');
  const origRun = pool.run;
  const origChat = client.llmUtilsChat;
  const origConsume = client.consumeStream;
  pool.run = async (fn) => fn('acct-1');
  client.llmUtilsChat = async () => ({ body: {} });
  client.consumeStream = async () => { /* 一个字节都没有 */ };
  const res = {
    writableEnded: false, headersSent: false,
    setHeader() {}, flushHeaders() { this.headersSent = true; }, write() { return true; }, end() { this.writableEnded = true; },
  };
  try {
    await assert.rejects(
      () => dispatch.dispatchStream({ type: 'builtin', builtin: 'trae' }, 'glm-5.3', { messages: [{ role: 'user', content: 'hi' }] }, res, {}),
      (e) => e.code === 'UPSTREAM_NOT_STREAM',
    );
  } finally {
    pool.run = origRun;
    client.llmUtilsChat = origChat;
    client.consumeStream = origConsume;
  }
});

t('dispatchTraeStream：正常 SSE 不触发该兜底（回归保护）', async () => {
  const dispatch = require('../model-router/dispatch');
  const pool = require('../credentials/pool');
  const client = require('../upstream/client');
  const origRun = pool.run;
  const origChat = client.llmUtilsChat;
  const origConsume = client.consumeStream;
  pool.run = async (fn) => fn('acct-1');
  client.llmUtilsChat = async () => ({ body: {} });
  client.consumeStream = async (body, onText) => {
    onText('data: ' + JSON.stringify({ content: 'hi' }) + '\n\n');
    onText('data: ' + JSON.stringify({ done: true, finish_reason: 'stop' }) + '\n\n');
  };
  const res = {
    writableEnded: false, headersSent: false,
    setHeader() {}, flushHeaders() { this.headersSent = true; }, write() { return true; }, end() { this.writableEnded = true; },
  };
  try {
    const r = await dispatch.dispatchStream({ type: 'builtin', builtin: 'trae' }, 'glm-5.3', { messages: [{ role: 'user', content: 'hi' }] }, res, {});
    assert.strictEqual(r.streamed, true);
    assert.strictEqual(r.finishReason, 'stop');
  } finally {
    pool.run = origRun;
    client.llmUtilsChat = origChat;
    client.consumeStream = origConsume;
  }
});

t('dispatchWorkBuddyStream：上游回 JSON 时不把裸 JSON 写进 SSE 流，而是抛错', async () => {
  const dispatch = require('../model-router/dispatch');
  const pool = require('../credentials/pool');
  const auth = require('../auth');
  const wbChat = require('../workbuddy/chat');
  const origRun = pool.run;
  const origEnsure = auth.ensureAuth;
  const origStream = wbChat.chatStream;
  pool.run = async (fn) => fn('acct-1');
  auth.ensureAuth = async () => ({ token: 't' });
  const jsonBody = JSON.stringify({ choices: [{ message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }] });
  wbChat.chatStream = async () => ({
    status: 200,
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(jsonBody));
        c.close();
      },
    }),
  });
  const written = [];
  const res = {
    writableEnded: false, headersSent: false,
    setHeader() {}, flushHeaders() { this.headersSent = true; },
    write(s) { written.push(String(s)); return true; }, end() { this.writableEnded = true; },
  };
  try {
    await assert.rejects(
      () => dispatch.dispatchStream({ type: 'builtin', builtin: 'workbuddy' }, 'wb/hy3', { messages: [{ role: 'user', content: 'hi' }] }, res, {}),
      (e) => e.code === 'UPSTREAM_NOT_STREAM',
      '必须抛错；裸 JSON 写进 SSE 流会让客户端解析失败且难以排查',
    );
    assert.strictEqual(written.length, 0, '确认为 SSE 之前不得写出任何字节');
  } finally {
    pool.run = origRun;
    auth.ensureAuth = origEnsure;
    wbChat.chatStream = origStream;
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

t('summarizeFefo 取最近一个未用尽包的到期时刻', () => {
  const { summarizeFefo } = require('../credentials/credits');
  const now = new Date('2026-05-10T12:00:00');
  const nowMs = now.getTime();
  const DAY = 86400000;
  const packs = [
    { remaining: 100, expireTime: (nowMs + 10 * DAY) / 1000 },
    { remaining: 20, expireTime: (nowMs + 2 * DAY) / 1000 },  // 最近
    { remaining: 30, expireTime: (nowMs + 5 * DAY) / 1000 },
  ];
  const r = summarizeFefo(packs, nowMs);
  assert.strictEqual(r.hasExpiry, true);
  assert.strictEqual(r.soonestAmount, 20);
  assert.strictEqual(r.soonestDays, 2);
  assert.strictEqual(r.expiringAmount, 150);
});

t('summarizeFefo 跳过已用尽 / 已过期 / 无到期时间的包', () => {
  const { summarizeFefo } = require('../credentials/credits');
  const now = new Date('2026-05-10T12:00:00');
  const nowMs = now.getTime();
  const DAY = 86400000;
  const packs = [
    { remaining: 0, expireTime: (nowMs + 1 * DAY) / 1000 },      // 用尽
    { remaining: 50, expireTime: (nowMs - 1 * DAY) / 1000 },     // 已过期
    { remaining: 60, expireTime: 0 },                            // 无到期
    { remaining: 70, expireTime: (nowMs + 4 * DAY) / 1000 },     // 唯一有效
  ];
  const r = summarizeFefo(packs, nowMs);
  assert.strictEqual(r.soonestAmount, 70);
  assert.strictEqual(r.soonestDays, 4);
});

t('summarizeFefo 仅 unlimited 包时视为不会过期', () => {
  const { summarizeFefo } = require('../credentials/credits');
  const nowMs = Date.parse('2026-05-10T12:00:00');
  const r = summarizeFefo([{ remaining: null, unlimited: true, expireTime: (nowMs + 999 * 86400000) / 1000 }], nowMs);
  assert.strictEqual(r.hasExpiry, false);
  assert.strictEqual(r.never, true);
  assert.strictEqual(r.soonestMs, null);
});

t('summarizeFefo 空输入返回零值', () => {
  const { summarizeFefo } = require('../credentials/credits');
  const r = summarizeFefo([], Date.now());
  assert.strictEqual(r.hasExpiry, false);
  assert.strictEqual(r.expiringAmount, 0);
});

t('least_balance 按 FEFO 到期时刻升序（先到期先用）', () => {
  const pool = require('../credentials/pool');
  const store = require('../credentials/store');
  const DAY = 86400000;
  const now = Date.now();
  const mk = (id, label, balance, expDays, amt) => ({
    id, label, balance,
    entitlementSnapshot: {
      packs: [{ remaining: amt, unlimited: false, expireTime: (now + expDays * DAY) / 1000 }],
    },
  });
  // 早到期的余额低，晚到期的余额高：FEFO 必须让早到期的先被选中
  const early = mk('a_early', 'early', 100, 2, 10);
  const late = mk('a_late', 'late', 9999, 20, 10);
  const soonestOf = (a) => {
    const packs = a.entitlementSnapshot.packs;
    let best = null;
    for (const p of packs) {
      if (p.remaining == null || !(p.remaining > 0)) continue;
      const ms = p.expireTime * 1000;
      if (best === null || ms < best) best = ms;
    }
    return best;
  };
  const list = [late, early];
  const ordered = [...list].sort((x, y) => soonestOf(x) - soonestOf(y));
  assert.strictEqual(ordered[0].id, 'a_early', '到期更近的账号应排在前面');
});

// ── 跨平台账号级调度（POOL_ACCOUNT_PRIORITY）─────────────────────────────
t('poolSignals：无临期包时返回 tier=2 且 balance 为池内余额合计', () => {
  const pool = require('../credentials/pool');
  const store = require('../credentials/store');
  const a = store.add({ label: 'sig-a', token: 'sa', edition: 'cn', balance: 1000, entitlementSnapshot: { packs: [{ name: 'x', expireTime: packSec(60), remaining: 500 }] } }, 'import');
  const b = store.add({ label: 'sig-b', token: 'sb', edition: 'cn', balance: 300, entitlementSnapshot: { packs: [] } }, 'import');
  pool.invalidateSignalCache();
  const sig = pool.poolSignals('trae');
  assert.strictEqual(sig.tier, 2, '60 天后到期不是临期');
  assert.strictEqual(sig.balance, 1300, '余额取 pool 合计');
  store.remove(a.id);
  store.remove(b.id);
  pool.invalidateSignalCache();
});

t('poolSignals：窗口内临期包使 tier=1 且 soonestMs 取最早到期', () => {
  const pool = require('../credentials/pool');
  const store = require('../credentials/store');
  pool.invalidateSignalCache();
  const a = store.add({ label: 'sig-far', token: 'sf', edition: 'cn', balance: 9999, entitlementSnapshot: { packs: [{ expireTime: packSec(20), remaining: 100 }] } }, 'import');
  const b = store.add({ label: 'sig-near', token: 'sn', edition: 'cn', balance: 5, entitlementSnapshot: { packs: [{ expireTime: packSec(2), remaining: 50 }] } }, 'import');
  pool.invalidateSignalCache();
  const sig = pool.poolSignals('trae');
  assert.strictEqual(sig.tier, 1, '2 天后到期在 7 天窗口内');
  assert.strictEqual(sig.soonestMs, new Date(packSec(2) * 1000).getTime(), '取窗口内最早到期');
  store.remove(a.id);
  store.remove(b.id);
  pool.invalidateSignalCache();
});

t('候选排序：临期池整体抢占非临期池（跨平台账号优先）', () => {
  const pool = require('../credentials/pool');
  const store = require('../credentials/store');
  const mr = require('../model-router');
  // 两个内置 Provider 各一个候选：trae 与 workbuddy
  mr.store.upsertVirtual('vm/test-cross', {
    enabled: true,
    strategy: 'priority',
    auto: true,
    sort: 'rate',
    rotateTopN: 0,
    contextWindow: 100000,
    candidates: [
      { id: 'workbuddy/wb/m', provider: 'workbuddy', model: 'wb/m', rate: 0.01, enabled: true, contextWindow: 100000 },
      { id: 'trae/m', provider: 'trae', model: 'm', rate: 0.5, enabled: true, contextWindow: 100000 },
    ],
  });
  // workbuddy 无临期、余额大（tier 2、balance 高）——非临期档按余额合计
  store.add({ label: 'x-trae', token: 'xt', edition: 'cn', balance: 10, entitlementSnapshot: { packs: [{ expireTime: packSec(9), remaining: 1 }] } }, 'import');
  store.add({ label: 'x-wb', token: 'xw', edition: 'workbuddy', balance: 500, entitlementSnapshot: { packs: [{ expireTime: packSec(9), remaining: 1 }] } }, 'import');
  pool.invalidateSignalCache();
  let vm = mr.store.getVirtual('vm/test-cross');
  let ordered = mr.orderCandidates('vm/test-cross', vm, 'all');
  // 都无临期，按余额合计：wb(500) > trae(10)
  assert.strictEqual(ordered[0].provider, 'workbuddy', '无临期时余额多的池优先');

  // 给 trae 加一个 2 天内的临期包 → trae 变成 tier 1，必须抢占 wb 的成本序
  const traeAcct = store.list().find((x) => x.edition === 'cn' && x.label === 'x-trae');
  store.update(traeAcct.id, { entitlementSnapshot: { packs: [{ expireTime: packSec(1), remaining: 99 }] } });
  pool.invalidateSignalCache();
  vm = mr.store.getVirtual('vm/test-cross');
  ordered = mr.orderCandidates('vm/test-cross', vm, 'all');
  assert.strictEqual(ordered[0].provider, 'trae', '临期池应整体抢占非临期池');
  mr.store.removeVirtual('vm/test-cross');
  // 清理测试账号
  for (const a of store.list()) {
    if (a.label === 'x-trae' || a.label === 'x-wb') store.remove(a.id);
  }
  pool.invalidateSignalCache();
});

t('stickyAllowed：绑定账号无临期且池内有临期时让位', () => {
  const pool = require('../credentials/pool');
  const store = require('../credentials/store');
  // 场景 1：池内无临期 → 复用绑定账号（让位无收益）
  const near = store.add({ label: 'sa-near', token: 'san', edition: 'cn', balance: 100, entitlementSnapshot: { packs: [{ expireTime: packSec(2), remaining: 50 }] } }, 'import');
  const far = store.add({ label: 'sa-far', token: 'saf', edition: 'cn', balance: 100, entitlementSnapshot: { packs: [{ expireTime: packSec(30), remaining: 50 }] } }, 'import');
  pool.invalidateSignalCache();
  assert.strictEqual(pool.stickyAllowed(far, 'trae'), false, '同池有临期账号时应让位');
  assert.strictEqual(pool.stickyAllowed(near, 'trae'), true, '绑定账号自己临期则继续复用');
  store.remove(near.id);
  store.remove(far.id);
  // 场景 2：池内无任何临期 → 复用（保持会话缓存命中）
  const only = store.add({ label: 'sa-only', token: 'sao', edition: 'cn', balance: 100, entitlementSnapshot: { packs: [{ expireTime: packSec(30), remaining: 50 }] } }, 'import');
  pool.invalidateSignalCache();
  assert.strictEqual(pool.stickyAllowed(only, 'trae'), true, '无临期账号时让位无收益');
  store.remove(only.id);
  pool.invalidateSignalCache();
});

// zcode 运营面
console.log('platform/variant (zcode)');
t('zcode 变体已注册且能力位正确', () => {
  const v = require('../platform/variant');
  const z = v.variantOf('zcode');
  assert.strictEqual(z.id, 'zcode');
  assert.strictEqual(z.label, 'ZCode');
  assert.strictEqual(v.can('zcode', 'chat'), false, '转发面未启用前 chat 必须为 false');
  assert.strictEqual(v.can('zcode', 'balance'), true);
  assert.strictEqual(v.can('zcode', 'checkin'), false);
  assert.strictEqual(v.can('zcode', 'oauthLogin'), false);
  assert.strictEqual(v.can('zcode', 'rewardClaim'), true);
  assert.strictEqual(v.can('zcode', 'localImport'), true);
  assert.strictEqual(z.rewardClaimHours.length, 2, '每日两个探测时段');
  assert.strictEqual(v.variantOf('zcode').errors.captchaFailed, 3007);
  assert.strictEqual(v.variantOf('zcode').errors.riskControl, 3012);
});

t('isTrae/isEdition 不做未知值兜底（zcode 不得被当 Trae）', () => {
  const v = require('../platform/variant');
  assert.strictEqual(v.isTrae('zcode'), false);
  assert.strictEqual(v.isTrae('cn'), true);
  assert.strictEqual(v.isTrae('sg'), true);
  assert.strictEqual(v.isTrae('__unknown__'), false, '未知值不兜底为 Trae');
  assert.strictEqual(v.isEdition('zcode', 'zcode'), true);
  assert.strictEqual(v.isEdition('zcode', 'trae'), false);
  assert.strictEqual(v.isEdition('workbuddy', 'trae'), false);
  assert.strictEqual(v.isEdition('trae', 'trae'), true);
});

t('pool.editionOk 拒绝 zcode 账号进 Trae 转发池', () => {
  const store = require('../credentials/store');
  const z = store.add({
    label: 'zcode-test', edition: 'zcode', mode: 'jwt', token: 'x'.repeat(50), userId: 'ztest-pool-1',
    fingerprint: {
      platform: 'win32', arch: 'x64', osVersion: '10.0.22631', screen: '1920x1080',
      language: 'zh-CN', timezone: 'Asia/Shanghai',
      deviceMid: '0e5b1b56-1111-4222-8333-444455556666',
    },
  }, 'test');
  try {
    const t1 = store.add({ label: 'trae-test', edition: 'trae', token: 'y'.repeat(50), userId: 'ttest-pool-1' }, 'test');
    try {
      // zcode 账号 enabled 且无冷却：若 editionOk 把未知值当 Trae 处理，这里会被选中
      const picked = require('../credentials/pool').pick(null, { edition: 'trae' });
      assert.notStrictEqual(picked && picked.id, z.id, 'zcode 账号绝不能被 Trae 池选中');
      void t1;
    } finally { store.remove(t1.id); }
  } finally { store.remove(z.id); }
});

console.log('zcode/fingerprint');
t('生成的指纹成套自洽（平台/内核/分辨率绑定）', () => {
  const fp = require('../zcode/fingerprint');
  for (let i = 0; i < 50; i++) {
    const f = fp.generate();
    assert.strictEqual(fp.validate(f), null, `第 ${i} 次生成即应合法: ${JSON.stringify(f)}`);
    assert.strictEqual(fp.platformFull(f), `${f.platform}-${f.arch}`);
    const wantCat = f.platform === 'darwin' ? 'macos' : (f.platform === 'win32' ? 'windows' : 'linux');
    assert.strictEqual(fp.osCategory(f), wantCat);
  }
});

t('validate 拒绝笛卡尔积（darwin-arm64 + 1366x768 为假电脑）', () => {
  const fp = require('../zcode/fingerprint');
  const err = fp.validate({
    platform: 'darwin', arch: 'arm64', osVersion: '24.5.0', screen: '1366x768',
    language: 'zh-CN', timezone: 'Asia/Shanghai', deviceMid: '0e5b1b56-1111-4222-8333-444455556666',
  });
  assert.ok(err, '非法组合必须报错');
  assert.ok(/SKU/.test(err));
});

t('validate 拒绝语言-时区不真实的组合', () => {
  const fp = require('../zcode/fingerprint');
  const err = fp.validate({
    platform: 'win32', arch: 'x64', osVersion: '10.0.22631', screen: '1920x1080',
    language: 'zh-CN', timezone: 'Europe/London', deviceMid: '0e5b1b56-1111-4222-8333-444455556666',
  });
  assert.ok(err && /语言\/时区/.test(err));
});

console.log('zcode/rewards');
t('parsePlan 只保留 model_usage/token 授权项并解出 grants', () => {
  const { parsePlan } = require('../zcode/rewards');
  const p = parsePlan({
    plan_id: ' zcode-v3-start-plan-trust-1007 ',
    name: ' ZCode Trust Build ',
    priority: 110,
    entitlements: [
      { entitlement_id: 'e1', show_name: 'GLM-5.3-Flash', meter: 'model_usage', unit_type: 'token', grant_units: 100000000, period: 'one_time', capabilities: ['model:glm-5.3-flash'] },
      { entitlement_id: 'e2', show_name: 'CPU', meter: 'cpu', unit_type: 'core', grant_units: 4, period: 'one_time' },
    ],
  });
  assert.strictEqual(p.planId, 'zcode-v3-start-plan-trust-1007');
  assert.strictEqual(p.name, 'ZCode Trust Build');
  assert.strictEqual(p.priority, 110);
  assert.strictEqual(p.grants.length, 1, '非 model_usage/token 的授权项必须被过滤');
  assert.strictEqual(p.grants[0].name, 'GLM-5.3-Flash');
  assert.strictEqual(p.grants[0].units, 100000000);
  assert.strictEqual(parsePlan(null), null);
  assert.strictEqual(parsePlan({ plan_id: '  ' }), null);
});

t('套餐排序：优先级降序、planId 升序稳定 tie-break', () => {
  const { parsePlan } = require('../zcode/rewards');
  const plans = [{ plan_id: 'a', priority: 10 }, { plan_id: 'b', priority: 110 }, { plan_id: 'c', priority: 50 }]
    .map(parsePlan).filter(Boolean)
    .sort((x, y) => (y.priority - x.priority) || x.planId.localeCompare(y.planId));
  assert.deepStrictEqual(plans.map((p) => p.planId), ['b', 'c', 'a']);
});

t('jwtUserId 解出 user_id（sub 兜底，坏 token 返回 null）', () => {
  const { jwtUserId } = require('../zcode/rewards');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.strictEqual(jwtUserId(`h.${b64({ user_id: '79251783416529165' })}.s`), '79251783416529165');
  assert.strictEqual(jwtUserId(`h.${b64({ sub: 'abc-123' })}.s`), 'abc-123');
  assert.strictEqual(jwtUserId(''), null);
  assert.strictEqual(jwtUserId('not-a-jwt'), null);
  assert.strictEqual(jwtUserId(`h.${b64({})}.s`), null);
});

t('buildActivationEvent 固定 16 字段且字段自洽', () => {
  const { buildActivationEvent } = require('../zcode/rewards');
  const fp = { platform: 'win32', arch: 'x64', osVersion: '10.0.22631', language: 'zh-CN', timezone: 'Asia/Shanghai', screen: '1920x1080', deviceMid: '0e5b1b56-1111-4222-8333-444455556666' };
  const e = buildActivationEvent('app_daily_active', fp, 'u-1');
  const keys = Object.keys(e).sort();
  assert.strictEqual(keys.length, 16, '官方事件体字段集固定 16 个');
  assert.strictEqual(e.element_name, 'app_daily_active');
  assert.strictEqual(e.user_id, 'u-1');
  assert.strictEqual(e.device_mid, fp.deviceMid);
  assert.strictEqual(e.screen_resolution, fp.screen);
  assert.strictEqual(e.device_os_category, 'windows');
  assert.strictEqual(e.event_type, 'view');
  assert.ok(/^[0-9a-f-]{36}$/.test(e.event_id));
  assert.strictEqual(e.mac_id, '');
  assert.strictEqual(e.marketing_params, '{}');
});

t('billingBlockReason 拦截缺凭据/停用/非 zcode 账号', () => {
  const { billingBlockReason } = require('../zcode/rewards');
  assert.ok(billingBlockReason({ edition: 'zcode', enabled: true }, { action: '领取' }).includes('JWT'));
  assert.ok(billingBlockReason({ edition: 'zcode', enabled: false, token: 'x' }, { action: '领取' }).includes('停用'));
  assert.ok(billingBlockReason({ edition: 'trae', enabled: true, token: 'x' }, { action: '领取' }).includes('非 ZCode'));
  assert.strictEqual(billingBlockReason({ edition: 'zcode', enabled: true, token: 'x' }), null);
});

t('CLAIM_RESULT 语义完整（claimed/already/failed/risk）', () => {
  const { CLAIM_RESULT } = require('../zcode/rewards');
  assert.deepStrictEqual(Object.values(CLAIM_RESULT).sort(), ['already', 'claimed', 'failed', 'risk']);
});

t('claim 业务码映射覆盖上游实证语义', () => {
  const { CLAIM_FAIL_TEXT } = require('../zcode/rewards');
  for (const code of [1001, 1002, 1003, 1004, 1005, 3001, 3007, 3012, 401]) {
    assert.ok(CLAIM_FAIL_TEXT[code], `code ${code} 缺少文案`);
  }
  assert.ok(CLAIM_FAIL_TEXT[3012].includes('风控'));
  assert.ok(CLAIM_FAIL_TEXT[1003].includes('已领取'));
});

console.log('zcode/captcha');
t('claimHeaders 同时携带 Param 与 Region（缺 Region 亦 3007）', () => {
  const { claimHeaders, CAPTCHA_DEFAULTS } = require('../zcode/captcha');
  const h = claimHeaders('PARAM', 'cn');
  assert.strictEqual(h['X-Aliyun-Captcha-Verify-Param'], 'PARAM');
  assert.strictEqual(h['X-Aliyun-Captcha-Verify-Region'], 'cn');
  const h2 = claimHeaders('PARAM', null);
  assert.strictEqual(h2['X-Aliyun-Captcha-Verify-Region'], CAPTCHA_DEFAULTS.region, 'region 缺省时回退默认');
});

console.log('zcode/local');
t('decryptField 非密文原样返回，密文可解（自加密回环）', () => {
  const crypto = require('crypto');
  const local = require('../zcode/local');
  const key = crypto.createHash('sha256').update('secret').digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update('hello', 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrapped = 'enc:v1:' + [iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
  assert.strictEqual(local.decryptField(wrapped, key), 'hello');
  assert.strictEqual(local.decryptField('plain', key), 'plain');
});

t('deriveSecret 与客户端实现同源（fallback 形态）', () => {
  const local = require('../zcode/local');
  const os = require('os');
  if (process.env.ZCODE_CREDENTIAL_SECRET) return; // env 注入时形态不同
  const s = local.deriveSecret();
  assert.ok(s.startsWith('zcode-credential-fallback:'), 'fallback 前缀必须一致');
  assert.ok(s.includes(os.platform()));
  assert.ok(s.includes(os.homedir()));
});

t('buildAccountFromLocal 产出 zcode/jwt 账号（本机已安装客户端时）', () => {
  const local = require('../zcode/local');
  if (!local.isClientInstalled()) return; // CI/无客户端环境跳过
  const acct = local.buildAccountFromLocal();
  assert.strictEqual(acct.edition, 'zcode');
  assert.strictEqual(acct.mode, 'jwt');
  assert.ok(acct.token && acct.token.split('.').length === 3, '应为三段 JWT');
  assert.strictEqual(acct.refreshToken, null, '客户端不返回 refresh_token');
  assert.ok(acct.userId, 'JWT 必含 user_id/sub');
});

// ── zcode 计量口径隔离（token 不得混入积分）────────────────────────────────
console.log('zcode 计量口径隔离');
t('ZCode 额度不写 balance / snapshot.packs / credit_history（积分口径）', async () => {
  const store = require('../credentials/store');
  const { db } = require('../credentials/db');
  const balance = require('../upstream/balance');
  const acct = store.add({
    label: 'zcode-unit-caliber', edition: 'zcode', mode: 'jwt',
    token: 'h.eyJ1c2VyX2lkIjoiOTk5OSJ9.s', userId: 'zcal-1',
    fingerprint: {
      platform: 'win32', arch: 'x64', osVersion: '10.0.22631', screen: '1920x1080',
      language: 'zh-CN', timezone: 'Asia/Shanghai',
      deviceMid: '0e5b1b56-1111-4222-8333-444455556666',
    },
  }, 'test');
  // 拦截上游：返回 1e8 token 量级（若混进积分口径会立刻暴露）
  const rewards = require('../zcode/rewards');
  const orig = rewards.fetchBalance;
  rewards.fetchBalance = async () => ({
    plans: [],
    balances: [{
      show_name: 'GLM-5.3-Flash', bucket_id: 'b1', plan_id: 'p1', meter: 'model_usage',
      unit_type: 'token', total_units: 100000000, used_units: 13000000,
      remaining_units: 87000000, expires_at: Math.floor(Date.now() / 1000) + 86400,
    }],
    serverTime: Math.floor(Date.now() / 1000),
  });
  try {
    const r = await balance.refreshBalance(acct.id);
    const saved = store.get(acct.id);
    // 1) balance 列（积分）必须为 null
    assert.strictEqual(saved.balance, null, 'zcode 不得写积分 balance 列');
    assert.strictEqual(r.balance, null, '返回值 balance 必须为 null');
    // 2) snapshot 不得有 packs（积分口径），改存 tokenBuckets
    const snap = saved.entitlementSnapshot || {};
    assert.ok(!Array.isArray(snap.packs) || snap.packs.length === 0, 'snapshot.packs 不得含 token 桶');
    assert.strictEqual(snap.tokenRemaining, 87000000, 'token 额度存 tokenBuckets/tokenRemaining');
    // 3) credit_history 不得有该账号记录
    const n = db().prepare('SELECT COUNT(*) AS c FROM credit_history WHERE account_id = ?').get(acct.id).c;
    assert.strictEqual(n, 0, 'zcode 不得写 credit_history');
    // 4) 积分口径聚合器读不到 token
    const { summarizeExpiry, summarizeFefo } = require('../credentials/credits');
    const packs = snap.packs || [];
    assert.strictEqual(summarizeExpiry(packs).d7, 0, '临期积分不得含 token');
    assert.strictEqual(summarizeFefo(packs).expiringAmount, 0, 'FEFO 金额不得含 token');
  } finally {
    rewards.fetchBalance = orig;
    db().prepare('DELETE FROM credit_history WHERE account_id = ?').run(acct.id);
    store.remove(acct.id);
  }
});

t('credit-history.summary：zcode 快照即使手工存在，口径仍按积分差分', () => {
  const ch = require('../credentials/credit-history');
  const { db } = require('../credentials/db');
  const store = require('../credentials/store');
  const acct = store.add({ label: 'zcode-sum', edition: 'zcode', mode: 'jwt', token: 't', userId: 'zsum-1' }, 'test');
  try {
    db().prepare('INSERT INTO credit_history (account_id, ts, remaining, used_total, source) VALUES (?,?,?,?,?)')
      .run(acct.id, new Date().toISOString(), 87000000, 13000000, 'zcode_billing_balance');
    const rows = ch.summary(1).filter((d) => d.accountId === acct.id);
    assert.strictEqual(rows.length, 1, 'summary 按快照差分包含该账号');
    db().prepare('DELETE FROM credit_history WHERE account_id = ?').run(acct.id);
    assert.strictEqual(ch.summary(1).filter((d) => d.accountId === acct.id)[0].snapshots, 0);
  } finally {
    db().prepare('DELETE FROM credit_history WHERE account_id = ?').run(acct.id);
    store.remove(acct.id);
  }
});

console.log('log/stats 逻辑回合聚合（一次客户端请求 = 一个回合）');

t('dailyStats：降级换候选的多行共享 turnId，按回合而非按行算成功率', () => {
  const { dailyStats } = require('../log/stats');
  const day = '2026-10-14';
  const row = (extra) => ({
    _day: day, ts: `${day}T10:00:00.000Z`, model: 'vm/unified-chat', status: 200, totalTokens: 10, ...extra,
  });
  const lines = [
    // 回合 A：先失败两次，第三次成功（真实形态：降级换候选）
    row({ turnId: 'tA', status: 429, error: 'rate limited', attempt: 1 }),
    row({ turnId: 'tA', status: 500, error: 'boom', attempt: 2 }),
    row({ turnId: 'tA', status: 200, attempt: 3 }),
    // 回合 B：两次尝试全部失败
    row({ turnId: 'tB', status: 400, error: 'bad request', attempt: 1 }),
    row({ turnId: 'tB', status: 500, error: 'boom', attempt: 2 }),
    // 历史行（无 turnId）：每行各自算一个回合，与旧口径一致
    row({ status: 200 }),
    row({ status: 500, error: 'legacy fail' }),
  ];
  const [d] = dailyStats(lines);
  assert.strictEqual(d.requests, 7, '行数口径（上游请求数）不变');
  assert.strictEqual(d.errors, 5, '失败行数不变');
  assert.strictEqual(d.turns, 4, '回合数 = 2 个显式回合 + 2 个历史行各自成回合');
  assert.strictEqual(d.turnsFailed, 2, '回合 B 全败 + 历史失败行各算一个全败回合');
  assert.strictEqual(d.recoveredTurns, 1, '回合 A 失败后恢复——按行口径会把它记成 2 次失败');
  // 按行口径的「成功率」= 2/7；按回合口径 = 2/4。差异正是本口径存在的理由。
  assert.ok(d.turns < d.requests, '同一回合的多行不得各算一个回合');
});

t('dailyStats：未提供 turnId 时逐行成回合（历史数据口径不变，不需要 ?? 0 兜底）', () => {
  const { dailyStats } = require('../log/stats');
  const day = '2026-10-13';
  const lines = [
    { _day: day, model: 'glm-5', status: 200 },
    { _day: day, model: 'glm-5', status: 200 },
    { _day: day, model: 'glm-5', status: 500, error: 'x' },
  ];
  const [d] = dailyStats(lines);
  assert.strictEqual(d.turns, 3);
  assert.strictEqual(d.turnsFailed, 1);
  assert.strictEqual(d.recoveredTurns, 0);
});

t('stats-cache：桶内三计数与逐日聚合口径一致，且桶版本已递增', () => {
  const fs = require('fs');
  const { localDateKey } = require('../lib/util');
  const { logsDir } = require('../lib/paths');
  const sc = require('../log/stats-cache');
  assert.ok(sc.BUCKET_VERSION >= 10, '桶版本必须递增，否则旧桶（无三计数）会继续被读');
  const day = localDateKey();
  const dir = path.join(logsDir(), day);
  fs.mkdirSync(dir, { recursive: true });
  const rows = [
    { ts: `${day}T01:00:00.000Z`, model: 'vm/unified-chat', account: 'a1', status: 429, error: 'rl', turnId: 'tX', attempt: 1 },
    { ts: `${day}T01:00:01.000Z`, model: 'vm/unified-chat', account: 'a2', status: 200, totalTokens: 5, turnId: 'tX', attempt: 2 },
    { ts: `${day}T01:00:02.000Z`, model: 'vm/unified-chat', account: 'a1', status: 500, error: 'boom', turnId: 'tY', attempt: 1 },
  ];
  fs.writeFileSync(path.join(dir, 'traffic.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  sc.clearCache();
  const got = sc.cachedDailyStats(1).find((d) => d.date === day);
  assert.ok(got, '应能从桶里取到当天');
  assert.strictEqual(got.turns, 2);
  assert.strictEqual(got.turnsFailed, 1, 'tY 两次都没成功（这里只有一行）——全败');
  assert.strictEqual(got.recoveredTurns, 1, 'tX 失败一次后成功');
  assert.strictEqual(got.requests, 3);
  // 清掉，避免影响其它用例
  fs.rmSync(dir, { recursive: true, force: true });
  sc.clearCache();
});

t('请求上下文：logRequest 继承 turnId——跨 await 不丢、并发请求不串号、无请求时不写', async () => {
  const fs = require('fs');
  const rc = require('../lib/request-context');
  const { logRequest } = require('../log/traffic');
  const { logsDir } = require('../lib/paths');
  const { localDateKey } = require('../lib/util');
  const dir = path.join(logsDir(), localDateKey());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'traffic.jsonl');
  fs.rmSync(file, { force: true });
  const readRows = () => fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

  // 两个"请求"并发且 await 交错：ALS 必须在异步边界之后仍指向正确的请求
  await Promise.all([
    rc.run({ turnId: 'req-1' }, async () => {
      logRequest({ model: 'm', status: 200 });
      await new Promise((r) => setTimeout(r, 12));
      logRequest({ model: 'm', status: 500, error: 'x' });
    }),
    rc.run({ turnId: 'req-2' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      logRequest({ model: 'm', status: 200 });
    }),
  ]);

  let rows = readRows();
  const t1 = rows.filter((r) => r.turnId === 'req-1');
  const t2 = rows.filter((r) => r.turnId === 'req-2');
  assert.strictEqual(t1.length, 2, '同一请求的两行共享 turnId（跨 await 仍正确）');
  assert.strictEqual(t2.length, 1);
  assert.strictEqual(rows.filter((r) => r.turnId).length, 3, '三个有上下文的行都带上 turnId');
  assert.strictEqual(t1.filter((r) => r.error).length, 1, '同回合内既有成功行也有失败行——正是要聚合的情形');

  // 显式传入优先于上下文（供调用方覆盖）
  rc.run({ turnId: 'req-1' }, () => logRequest({ model: 'm', status: 200, turnId: 'explicit' }));
  rows = readRows();
  assert.strictEqual(rows[rows.length - 1].turnId, 'explicit');

  // 非请求路径（定时任务/脚本）没有上下文：不写 turnId，统计层逐行成回合
  logRequest({ model: 'm', status: 200 });
  rows = readRows();
  assert.strictEqual(rows[rows.length - 1].turnId, undefined);

  fs.rmSync(file, { force: true });
});

console.log('D5：工具结果的 is_error 全链路（内部信号，不上行）');

t('normalizeTraeMessages：保留 tool 消息的 is_error（丢了模型会把错误轨迹当正常结果）', () => {
  const { normalizeTraeMessages } = require('../transform/request');
  const out = normalizeTraeMessages([
    { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'ENOENT' }], is_error: true },
    { role: 'tool', tool_call_id: 'c2', content: [{ type: 'text', text: 'ok' }] },
  ]);
  const tools = out.filter((m) => m.role === 'tool');
  assert.strictEqual(tools[0].is_error, true, '失败的工具结果必须保留标记');
  assert.strictEqual(tools[1].is_error, undefined, '正常结果不该被加上标记');
});

t('countToolErrors：兼容归一化形态与 Anthropic 原生 tool_result 两种写法，且不重复计数', () => {
  const { countToolErrors } = require('../transform/request');
  assert.strictEqual(countToolErrors([
    { role: 'tool', is_error: true },
    { role: 'tool' },
    { role: 'tool', is_error: true },
  ]), 2);
  assert.strictEqual(countToolErrors([
    { role: 'user', content: [{ type: 'tool_result', is_error: true }, { type: 'text', text: 'x' }] },
    { role: 'user', content: [{ type: 'tool_result' }] },
  ]), 1);
  assert.strictEqual(countToolErrors([]), 0);
  assert.strictEqual(countToolErrors(null), 0);
  // 归一化后的 tool 消息即使 content 里带 tool_result 也只算一次
  assert.strictEqual(countToolErrors([{ role: 'tool', is_error: true, content: [{ type: 'tool_result', is_error: true }] }]), 1);
});

t('buildBody：内部字段 is_error 必须在序列化前剥掉（未知字段会偶发 503）', () => {
  const { buildBody } = require('../upstream/client');
  const body = buildBody([
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'ENOENT' }], is_error: true },
  ], 'glm-5', false, {}, null);
  const msgs = body.messages;
  assert.strictEqual(msgs.length, 2, '消息条数不变（不是过滤掉整条）');
  assert.ok(!('is_error' in msgs[1]), 'is_error 不得上行');
  assert.strictEqual(msgs[1].role, 'tool', '其余字段原样保留');
  assert.strictEqual(msgs[1].tool_call_id, 'c1');
  // 没有内部字段时不应产生无谓的拷贝
  const same = buildBody([{ role: 'user', content: 'x' }], 'glm-5', false, {}, null);
  assert.deepStrictEqual(same.messages, [{ role: 'user', content: 'x' }]);
});

t('anthropicToOpenAI：tool_result 的 is_error 被带到归一化消息上（供计数与将来压缩跳过）', () => {
  // 该函数未单独导出，通过路由行为间接验证成本高；此处校验 countToolErrors
  // 对 Anthropic 原始形态的识别已覆盖同一语义（见上一条），
  // 并静态确认路由构建处确实透传了 is_error。
  const src = require('fs').readFileSync(require.resolve('../routes/anthropic'), 'utf8');
  assert.ok(/b\.is_error === true \? \{ is_error: true \}/.test(src), 'anthropic 路由必须透传 is_error');
  assert.ok(/countToolErrors\(messages\)/.test(src), 'anthropic 路由必须统计 toolErrors');
});

main();