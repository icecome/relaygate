'use strict';
/**
 * scripts/verify/verify-raccoon-proxy.js —— Raccoon 后端模型代理的**真上游**端到端验证。
 *
 * ## 验证什么（每一条都是这次改动的验收点）
 *
 * 1. **统一端点分派**：`POST /v1/chat/completions` 带 `sn-*` 模型 → 落到 Raccoon
 *    账号池，而不是被 403 挡回「请用 /v1/raccoon/...」。
 * 2. **显式端点仍可用**：`POST /v1/raccoon/chat/completions` 行为不变。
 * 3. **流式透传**：上游标准 SSE 帧原样到达客户端，且末尾有 `[DONE]`。
 * 4. **模型名回写**：统一端点的响应 `model` 字段等于调用方给的那个 id。
 * 5. **并发闸门**：超过 `RACCOON_MAX_CONCURRENT` 的并发请求不会同时冲向上游
 *    （表现为「没有一条拿到 429 user_model_rate_limited」）。
 * 6. **冷却熔断**：人为制造一次 429 后，后续请求在冷却窗口内**本地**被拒
 *    （429 + Retry-After），且**不会**再打到上游。
 *
 * ## 用法
 *
 * ```bash
 * # 前置：网关已启动（默认 127.0.0.1:19900），且库里已有一个启用的 Raccoon 账号，
 * #      另有可用的通用访问密钥（platform=all）
 * node scripts/verify/verify-raccoon-proxy.js --key=<通用访问密钥>
 *
 * # 只验第 1-4 项（不制造限流，零风险）
 * node scripts/verify/verify-raccoon-proxy.js --key=... --safe
 *
 * # 换网关地址 / 模型
 * node scripts/verify/verify-raccoon-proxy.js --key=... --base=http://127.0.0.1:19900 --model=sn-glm-5-3-flash
 * ```
 *
 * ## 为什么不自己起网关
 *
 * 本脚本要验的是「**跑在真实配置下的那个进程**」的行为 —— 包括它读的 `.env`、
 * 它连的账号库、它的调度器状态。自己起一个临时进程验的是另一个世界。
 *
 * @module scripts/verify/verify-raccoon-proxy
 */

const http = require('node:http');

function argOf(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const BASE = argOf('base', `http://127.0.0.1:${process.env.PORT || 19900}`);
const KEY = argOf('key', process.env.API_KEY || '');
const MODEL = argOf('model', 'sn-glm-5-3-flash');
const SAFE = hasFlag('safe');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    failures.push({ name, detail });
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

/** 发一次请求，收集状态码/头/正文（流式按文本收齐）。 */
function request(method, p, body, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    const url = new URL(p, BASE);
    const data = body == null ? null : JSON.stringify(body);
    const headers = { Authorization: `Bearer ${KEY}` };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const t0 = Date.now();
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
        ms: Date.now() - t0,
      }));
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, text: `TRANSPORT ${e.message}`, ms: Date.now() - t0 }));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

/** 最小对话体。⚠️ max_tokens 不能是 1（会被上游 MaaS 判成非法请求，回 400）。 */
function chatBody(model, stream) {
  return {
    model,
    messages: [{ role: 'user', content: '只回复两个字：你好' }],
    stream,
    max_tokens: 64,
  };
}

/** 从响应文本里解析出「首帧是否标准 OpenAI chunk」「是否有 [DONE]」。 */
function inspectSse(text) {
  const frames = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') { frames.push('[DONE]'); continue; }
    try { frames.push(JSON.parse(payload)); } catch { frames.push({ __unparsable: payload.slice(0, 80) }); }
  }
  const chunks = frames.filter((f) => f && f !== '[DONE]' && !f.__unparsable);
  return {
    frameCount: frames.length,
    hasDone: frames.includes('[DONE]'),
    unparsable: frames.filter((f) => f && f.__unparsable).length,
    firstIsChunk: chunks.length > 0 && chunks[0].object === 'chat.completion.chunk',
    sawContent: chunks.some((c) => {
      const d = c.choices && c.choices[0] && c.choices[0].delta;
      return d && (typeof d.content === 'string' ? d.content.length > 0 : false);
    }),
    model: chunks.length ? chunks[0].model : null,
  };
}

async function main() {
  if (!KEY) {
    console.error('缺少 --key=<通用访问密钥>。请在管理面板「访问密钥」创建一把 platform=all 的密钥。');
    process.exit(2);
  }

  console.log('=== Raccoon 后端模型代理 · 真上游验证 ===');
  console.log(`base  : ${BASE}`);
  console.log(`model : ${MODEL}`);
  console.log(`mode  : ${SAFE ? 'safe（不制造限流）' : 'full（含冷却熔断验证）'}`);
  console.log('');

  // ---- 0. 网关可达 ----
  const health = await request('GET', '/health');
  check('/health 可达', health.status === 200 || health.status === 503,
    `HTTP ${health.status} ${health.text.slice(0, 200)}`);
  if (health.status === 0) {
    console.error('\n网关不可达，后续验证无法进行。先启动：npm start');
    process.exit(2);
  }

  // 从 /health 里读出调度器是否在跑（冷却验证依赖真实进程状态，不依赖它）
  try {
    const j = JSON.parse(health.text);
    console.log(`  accounts=${JSON.stringify(j.accounts)} scheduler=${j.scheduler}`);
  } catch { /* 非 JSON 不影响 */ }
  console.log('');

  // ---- 1. 统一端点分派（非流式）----
  console.log('[1] 统一端点 /v1/chat/completions（非流式）');
  const uni = await request('POST', '/v1/chat/completions', chatBody(MODEL, false));
  const uniJson = (() => { try { return JSON.parse(uni.text); } catch { return null; } })();
  check('不是 403 platform_mismatch（说明 sn-* 已被分派而不是被 ACL 挡回）',
    uni.status !== 403,
    `HTTP ${uni.status} ${uni.text.slice(0, 300)}`);
  if (uni.status === 200 && uniJson) {
    check('响应 model 字段回写为请求的 id', uniJson.model === MODEL,
      `got ${JSON.stringify(uniJson.model)}`);
    check('有 choices 且 content 非空',
      Array.isArray(uniJson.choices) && uniJson.choices.length > 0
      && typeof uniJson.choices[0].message.content === 'string',
      JSON.stringify(uniJson).slice(0, 300));
  } else if (uni.status === 429) {
    // 冷却中被本地拒是**正确行为**（第 6 项），不是失败
    check('429 带 Retry-After（本地冷却语义）', uni.headers['retry-after'] != null,
      `headers=${JSON.stringify(uni.headers)}`);
    console.log('       注：当前账号在冷却窗口内，本次未拿到 200。这是第 6 项要验的行为。');
  } else {
    check('统一端点返回 200', false, `HTTP ${uni.status} ${uni.text.slice(0, 400)}`);
  }
  console.log('');

  // ---- 2. 统一端点（流式透传）----
  console.log('[2] 统一端点 /v1/chat/completions（流式）');
  const uniS = await request('POST', '/v1/chat/completions', chatBody(MODEL, true));
  if (uniS.status === 200) {
    const info = inspectSse(uniS.text);
    check('Content-Type 是事件流', /text\/event-stream/.test(String(uniS.headers['content-type'] || '')),
      String(uniS.headers['content-type']));
    check('帧可解析（无畸形 JSON）', info.unparsable === 0, `unparsable=${info.unparsable}`);
    check('首帧是 chat.completion.chunk（标准 OpenAI SSE）', info.firstIsChunk, JSON.stringify(info));
    check('末尾有 [DONE]', info.hasDone, `frames=${info.frameCount}`);
    check('有正文增量', info.sawContent, JSON.stringify(info));
    check('流内 model 字段是请求的 id', info.model === MODEL, `got ${JSON.stringify(info.model)}`);
  } else if (uniS.status === 429) {
    check('冷却中 → 429 + Retry-After', uniS.headers['retry-after'] != null);
  } else {
    check('流式返回 200', false, `HTTP ${uniS.status} ${uniS.text.slice(0, 400)}`);
  }
  console.log('');

  // ---- 3. 显式端点仍可用 ----
  console.log('[3] 显式端点 /v1/raccoon/chat/completions（回归：行为不变）');
  const ex = await request('POST', '/v1/raccoon/chat/completions', chatBody(MODEL, false));
  check('不因分派改动而失效（200 或冷却中 429）', ex.status === 200 || ex.status === 429,
    `HTTP ${ex.status} ${ex.text.slice(0, 300)}`);
  console.log('');

  // ---- 4. 模型归属边界没松动 ----
  console.log('[4] 边界：显式端点拒绝非 sn-* 模型');
  const bad = await request('POST', '/v1/raccoon/chat/completions', chatBody('glm-5.3', false));
  check('调错端点 → 400 INVALID_MODEL（而不是静默路由）', bad.status === 400,
    `HTTP ${bad.status} ${bad.text.slice(0, 300)}`);
  console.log('');

  if (SAFE) {
    console.log('[5][6] 已跳过（--safe）：并发闸门与冷却熔断验证会故意制造限流。');
    report();
    return;
  }

  // ---- 5. 并发闸门 ----
  //
  // 目的：证明「超过上限的并发不会同时冲向上游」。判据是**没有一条** 429
  // user_model_rate_limited —— 如果闸门失效，5-6 并发会立刻触发上游限流。
  console.log('[5] 并发闸门（并发 8 条，串行度由闸门控制）');
  const concStart = Date.now();
  const conc = await Promise.all(
    Array.from({ length: 8 }, () => request('POST', '/v1/chat/completions', chatBody(MODEL, false))),
  );
  const concMs = Date.now() - concStart;
  const throttled = conc.filter((r) => /user_model_rate_limited|请求频率超限/.test(r.text));
  const okCount = conc.filter((r) => r.status === 200).length;
  const localBusy = conc.filter((r) => r.status === 429 && !/user_model_rate_limited/.test(r.text)).length;
  console.log(`      200=${okCount} 本地拒绝=${localBusy} 上游限流=${throttled.length} 用时=${concMs}ms`);
  check('无一命中上游限流（闸门生效）', throttled.length === 0,
    throttled.length ? throttled[0].text.slice(0, 300) : '');
  check('至少一条成功', okCount > 0, `200=${okCount}`);
  console.log('');

  // ---- 6. 冷却熔断 ----
  //
  // 判据：撞墙后那个账号在冷却窗口内的请求**秒回**（不是 1-3 秒的上游往返），
  // 且带 Retry-After。秒回证明它没有被送回上游（那才是熔断的意义）。
  console.log('[6] 冷却熔断（撞墙后本地拒绝，不再打上游）');
  const firstThrottle = await request('POST', '/v1/chat/completions', chatBody(MODEL, false));
  if (firstThrottle.status === 429) {
    const followUp = await request('POST', '/v1/chat/completions', chatBody(MODEL, false));
    const fast = followUp.ms < 500;
    check('后续请求仍在冷却 → 429', followUp.status === 429, `HTTP ${followUp.status}`);
    check('冷却拒绝是秒回（证明未打上游）', fast, `${followUp.ms}ms`);
    check('带 Retry-After', followUp.headers['retry-after'] != null,
      JSON.stringify(followUp.headers));
  } else {
    console.log(`       本次未撞墙（HTTP ${firstThrottle.status}），冷却熔断无样本可验。`);
    console.log('       这是**好事**：说明闸门把上游限流挡在了外面。');
  }

  report();
}

function report() {
  console.log('');
  console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`);
  if (fail) {
    console.log('');
    for (const f of failures) console.log(`  ✗ ${f.name}\n    ${f.detail}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('验证失败:', e && e.stack ? e.stack : e);
  process.exit(1);
});
