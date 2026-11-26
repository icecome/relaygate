'use strict';
/**
 * src/test/raccoon-proxy.test.js —— Raccoon 代理分派 + 并发闸门 + 限流熔断的单元测试。
 *
 * ## 为什么不打真上游
 *
 * 真上游的限流是**账号级**的（一旦撞墙，整个账号 5 分钟起不可用），拿它做测试
 * 等于用真实额度换断言。这里全部用内存 mock：mock 的 fetch、mock 的 store、
 * 可控的时钟。真上游的边界值来自 `scripts/probes/probe-raccoon-ratelimit.js`
 * 的实测（见 `src/raccoon/limiter.js` 头部表格），本测试只验证**代码是否按那些
 * 实测结论实现**，不重新测量它们。
 *
 * ## 覆盖的四个不变量（每一个都对应过线上的真实故障形态）
 *
 * 1. **并发闸门**：超过上限的请求排队而不是并发冲上去（否则第 5 条必挂）。
 * 2. **撞墙冷却**：429 之后该账号进入冷却，且**换模型也拦**（上游是账号级）。
 * 3. **指数退避**：连续撞墙冷却翻倍，且封顶。
 * 4. **成功解冻**：一次成功就清掉冷却（否则账号会被永久冻死）。
 *
 * 另外覆盖：
 * 5. `classifyThrottle` 对两种上游报文的分类（`user_model_rate_limited` vs `200103`）。
 * 6. 分派层换号：主号在冷却时自动用备号。
 * 7. SSE 旁路计量（usage / finish_reason 被取到，且不改变转发的字节）。
 */
const assert = require('node:assert');

// 隔离状态目录与密钥（与其余测试同款）
const os = require('node:os');
const path = require('node:path');
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `trae-raccoon-proxy-${Date.now()}`);
process.env.TRAE_API_ENCRYPT_KEY = 'f'.repeat(64);
process.env.SCHEDULER_ENABLED = 'false';
process.env.RACCOON_KEEPALIVE_ENABLED = 'false';

const { AccountLimiter, classifyThrottle, DEFAULT_MAX_CONCURRENT } = require('../raccoon/limiter');
const streamMod = require('../raccoon/stream');

let pass = 0;
let fail = 0;
const failures = [];
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 1. 限流分类 ---------- */

t('classifyThrottle：user_model_rate_limited → 长冷却（实测恢复 >200s，故 ≥300s）', () => {
  const r = classifyThrottle({
    status: 429,
    body: JSON.stringify({
      error: {
        code: 'user_model_rate_limited',
        message: '您的模型请求频率超限，请稍后重试',
        type: 'rate_limit_error',
      },
    }),
  });
  assert.strictEqual(r.limited, true);
  assert.strictEqual(r.kind, 'concurrency');
  assert.ok(r.cooldownMs >= 300_000, `长冷必须 ≥300s，实际 ${r.cooldownMs}`);
});

t('classifyThrottle：200103 limiter_request_error → 短冷却（retry after: 0s 是瞬时拥塞）', () => {
  const r = classifyThrottle({
    status: 429,
    body: JSON.stringify({
      code: 200103,
      message: 'limiter_request_error',
      details: 'request exceed max time, retry after:0s',
    }),
  });
  assert.strictEqual(r.limited, true);
  assert.strictEqual(r.kind, 'transient');
  assert.ok(r.cooldownMs <= 30_000, `瞬时拥塞不该冷 5 分钟，实际 ${r.cooldownMs}`);
});

t('classifyThrottle：非限流错误不误判（400 请求体非法）', () => {
  const r = classifyThrottle({
    status: 400,
    body: JSON.stringify({
      error: { code: '400', message: 'The request is invalid: rejected by an internal MaaS component' },
    }),
  });
  assert.strictEqual(r.limited, false);
});

t('classifyThrottle：上游改码后退路仍能识别（文案命中）', () => {
  const r = classifyThrottle({ status: 429, body: '' });
  assert.strictEqual(r.limited, true);
  const r2 = classifyThrottle({ status: 200, body: '{"msg":"您的模型请求频率超限，请稍后重试"}' });
  assert.strictEqual(r2.limited, true);
});

/* ---------- 1b. 账号级风控（200108）与 Retry-After（2026-11-25 新增） ---------- */

t('classifyThrottle：200108 账号风控 → kind=account_risk，冷到上游 Retry-After（3h）而不是 5 分钟', () => {
  const body = JSON.stringify({
    error: {
      code: 200108,
      message: '系统检测到当前账号存在异常调用，模型调用功能已暂时受限。请稍后重试；如仍未恢复，或你认为是误判，请点击左下角头像，选择「问题反馈」提交说明。',
      type: 'rate_limit_error',
    },
  });
  // 上游实测每次都带 Retry-After: 10800
  const withHeader = classifyThrottle({ status: 429, body, retryAfterMs: 10_800_000 });
  assert.strictEqual(withHeader.limited, true);
  assert.strictEqual(withHeader.kind, 'account_risk', '200108 是账号风控，不能归成并发/未知');
  assert.strictEqual(withHeader.cooldownMs, 10_800_000, '必须用上游 Retry-After 真值');

  // 上游不发 Retry-After 时兜底 3h（而不是 5 分钟）
  const noHeader = classifyThrottle({ status: 429, body });
  assert.strictEqual(noHeader.kind, 'account_risk');
  assert.strictEqual(noHeader.cooldownMs, 3 * 3600_000, '没有真值也要兜底 3h，不能退回 5 分钟');
});

t('classifyThrottle：200108 的文案兜底（上游换码时仍能识别）', () => {
  const r = classifyThrottle({ status: 429, body: JSON.stringify({ message: '系统检测到当前账号存在异常调用' }) });
  assert.strictEqual(r.kind, 'account_risk');
});

t('AccountLimiter：account_risk 不参与指数退避，连续两次仍是 3h（不能被 30min 封顶砍短）', () => {
  const lim = new AccountLimiter({ cooldownMs: 300_000 });
  const r1 = lim.throttle('acct_x', { kind: 'account_risk', cooldownMs: 10_800_000, scope: 'account' });
  const r2 = lim.throttle('acct_x', { kind: 'account_risk', cooldownMs: 10_800_000, scope: 'account' });
  // cooldownMs 是 `until - Date.now()` 的差值，跨毫秒边界会掉 1~2ms，用容差断言。
  const near = (actual, expected) => Math.abs(actual - expected) <= 50;
  assert.ok(near(r1.cooldownMs, 10_800_000), `首次应约 3h，实际 ${r1.cooldownMs}`);
  // 若走指数退避会被 cooldownMaxMs（30min）封顶砍成 1800000 —— 必须不是
  assert.ok(near(r2.cooldownMs, 10_800_000), `风控时长由上游给定，不得被本地封顶砍短；实际 ${r2.cooldownMs}`);
  assert.strictEqual(r2.scope, 'account', '风控是账号级事实，不该连带冻住出口');
});

t('AccountLimiter：riskCoolingReason 能回答「有号正被风控、还剩多久」', () => {
  const lim = new AccountLimiter({ cooldownMs: 300_000 });
  assert.strictEqual(lim.riskCoolingReason(), null);
  lim.throttle('acct_r', { kind: 'account_risk', cooldownMs: 10_800_000, scope: 'account' });
  const risk = lim.riskCoolingReason();
  assert.ok(risk, '必须能查到风控中的账号');
  assert.strictEqual(risk.accountId, 'acct_r');
  assert.ok(risk.msLeft > 10_000_000, `剩余应接近 3h，实际 ${risk.msLeft}`);
});

t('failureKind：200108 → account_risk（不是 throttled），超时 → timeout（不是 other）', () => {
  const dispatch = require('../raccoon/dispatch');
  const risk = dispatch.failureKind({
    status: 429,
    body: JSON.stringify({ error: { code: 200108, message: '系统检测到当前账号存在异常调用' } }),
  });
  assert.strictEqual(risk, 'account_risk');
  const to = dispatch.failureKind(Object.assign(new Error('Raccoon 对话超时（1200s 未完成）'), { status: 504, timedOut: true }));
  assert.strictEqual(to, 'timeout', '超时不能被判成 other（other 曾是可切换的）');
  const limited = dispatch.failureKind({ status: 429, body: JSON.stringify({ error: { code: 'user_model_rate_limited' } }) });
  assert.strictEqual(limited, 'throttled');
});

/* ---------- 2. 并发闸门 ---------- */

t('并发闸门：上限内直接通过，超出后排队而不是并发冲上去', async () => {
  const lim = new AccountLimiter({ maxConcurrent: 3, cooldownMs: 1000 });
  const a = await lim.acquire('acct_a');
  const b = await lim.acquire('acct_a');
  const c = await lim.acquire('acct_a');
  assert.strictEqual(lim.inFlightOf('acct_a'), 3);

  // 第 4 条必须排队（不 resolve）
  let fourth = null;
  const p = lim.acquire('acct_a').then((x) => { fourth = x; });
  await sleep(20);
  assert.strictEqual(fourth, null, '第 4 条必须排队，不能直接拿到令牌');

  // 放掉一个 → 第 4 条应被唤醒
  a.release();
  await p;
  assert.ok(fourth, '释放令牌后等待者必须被唤醒');
  assert.strictEqual(lim.inFlightOf('acct_a'), 3);

  b.release();
  c.release();
  fourth.release();
  assert.strictEqual(lim.inFlightOf('acct_a'), 0);
});

/*
 * 冷却期间唤醒必须被拒（LR-003 回归保护）。
 *
 * 旧实现只在 acquire 入队前判一次 blockedFor，release() 唤醒 waiter 时
 * 不复核：撞 429 的请求在 finally 里释放令牌 → 后面排队的逐个放行再撞墙，
 * 把一次撞墙放大成 N 次。这里用「先排队、再开冷却、最后 release」复现
 * 该闭环；把 release 换回旧实现，本用例会失败。
 */
t('冷却期间 release 唤醒排队者：批量拒绝，不再放行撞墙', async () => {
  const lim = new AccountLimiter({ maxConcurrent: 1, cooldownMs: 60_000 });
  const held = await lim.acquire('acct_cool');

  let resolved = false;
  let rejection = null;
  const queued = lim.acquire('acct_cool')
    .then(() => { resolved = true; })
    .catch((e) => { rejection = e; });
  await sleep(20);
  assert.strictEqual(resolved, false, '并发满时第 2 条必须仍在排队');

  // 模拟「当前在途请求撞 429」：开启出口级 + 账号级冷却
  lim.throttle('acct_cool', { kind: 'user_model_rate_limited', scope: 'both' });
  assert.ok(lim.blockedFor('acct_cool') > 0, '冷却已生效，release 必须看见它');

  held.release();
  await queued;

  assert.strictEqual(resolved, false, '冷却期间排队者不得被放行');
  assert.ok(rejection, '排队者必须收到明确的拒绝错误');
  assert.strictEqual(rejection.status, 429);
  assert.strictEqual(rejection.code, 'RACCOON_GLOBAL_COOLING');
  assert.ok(rejection.retryAfterMs > 0, '拒绝必须带 Retry-After 供客户端退避');
  assert.strictEqual(lim.inFlightOf('acct_cool'), 0, '释放后不应残留令牌');
  assert.strictEqual(lim.snapshot().accounts.acct_cool.queued ?? 0, 0, '等待队列必须被清空');
});

t('并发闸门：不同账号互不影响（上游是账号级计数）', async () => {
  const lim = new AccountLimiter({ maxConcurrent: 1 });
  const a = await lim.acquire('acct_a');
  // acct_b 有独立槽位，不该被 acct_a 占满而阻塞
  const b = await lim.acquire('acct_b');
  assert.strictEqual(lim.inFlightOf('acct_a'), 1);
  assert.strictEqual(lim.inFlightOf('acct_b'), 1);
  a.release();
  b.release();
});

t('并发闸门：队列满时直接拒绝（429 语义），不无限堆积', async () => {
  const lim = new AccountLimiter({ maxConcurrent: 1, maxQueue: 2 });
  const held = await lim.acquire('acct_a');
  const w1 = lim.acquire('acct_a');
  const w2 = lim.acquire('acct_a');
  // 第 3 个等待者超上限
  await assert.rejects(() => lim.acquire('acct_a'), (e) => {
    assert.strictEqual(e.status, 429);
    assert.strictEqual(e.code, 'RACCOON_QUEUE_FULL');
    return true;
  });
  held.release();
  await w1;
  held.release();
  await w2;
});

/* ---------- 3. 冷却与退避 ---------- */

t('冷却：撞墙后整条链路被拒（出口级冷却优先于账号级）', async () => {
  const lim = new AccountLimiter({ cooldownMs: 5000 });
  lim.throttle('acct_a', { kind: 'concurrency', cooldownMs: 5000 });
  const left = lim.coolingFor('acct_a');
  assert.ok(left > 4000, `冷却剩余应接近 5000ms，实际 ${left}`);
  await assert.rejects(() => lim.acquire('acct_a'), (e) => {
    assert.strictEqual(e.status, 429);
    // ⚠️ 这里是**出口级**冷却，不是账号级：实测换账号换模型都照样 429，
    // 说明墙在出站 IP 上。用 RACCOON_GLOBAL_COOLING 而不是 RACCOON_COOLING
    // 是为了让调用方能区分「这个号不行」与「整条链路不行」。
    assert.strictEqual(e.code, 'RACCOON_GLOBAL_COOLING');
    assert.ok(e.retryAfterMs > 0);
    return true;
  });
});

t('出口级冷却：撞墙后换账号也进不来（这是关键修复）', async () => {
  const lim = new AccountLimiter({ cooldownMs: 5000 });
  // acct_a 撞墙
  lim.throttle('acct_a', { cooldownMs: 5000 });
  // acct_b **没有任何冷却记录**，但同样必须被拒 —— 因为墙在出口上
  assert.strictEqual(lim.coolingFor('acct_b'), 0, 'acct_b 自身没有账号级冷却');
  await assert.rejects(() => lim.acquire('acct_b'), (e) => {
    assert.strictEqual(e.code, 'RACCOON_GLOBAL_COOLING');
    return true;
  });
  // 全局冷却详情可读
  const g = lim.globalCoolingReason();
  assert.ok(g && g.msLeft > 0);
  assert.ok(g.streak >= 1);
});

t('出口级冷却：scope=account 时只冷该账号（凭据类问题用）', async () => {
  const lim = new AccountLimiter({ cooldownMs: 5000 });
  lim.throttle('acct_a', { cooldownMs: 5000, scope: 'account' });
  assert.strictEqual(lim.globalCoolingFor(), 0, 'scope=account 不该开出口级冷却');
  assert.ok(lim.coolingFor('acct_a') > 0);
  assert.strictEqual(lim.coolingFor('acct_b'), 0);
});

t('冷却：连续撞墙按次翻倍，且封顶 cooldownMaxMs', () => {
  const lim = new AccountLimiter({ cooldownMs: 1000, cooldownMaxMs: 5000 });
  // cooldownMs 返回的是 `until - Date.now()`，跨毫秒边界会掉 1~2ms ——
  // 之前用 strictEqual 会随机失败（实测 3999 !== 4000）。这里只断言量级。
  const near = (actual, expected) => Math.abs(actual - expected) <= 50;
  const r1 = lim.throttle('acct_a', { cooldownMs: 1000 });
  assert.strictEqual(r1.streak, 1);
  assert.ok(near(r1.cooldownMs, 1000), `实际 ${r1.cooldownMs}`);
  const r2 = lim.throttle('acct_a', { cooldownMs: 1000 });
  assert.strictEqual(r2.streak, 2);
  assert.ok(near(r2.cooldownMs, 2000), `实际 ${r2.cooldownMs}`);
  const r3 = lim.throttle('acct_a', { cooldownMs: 1000 });
  assert.ok(near(r3.cooldownMs, 4000), `实际 ${r3.cooldownMs}`);
  const r4 = lim.throttle('acct_a', { cooldownMs: 1000 });
  assert.ok(near(r4.cooldownMs, 5000), `必须封顶；实际 ${r4.cooldownMs}`);
  const r9 = lim.throttle('acct_a', { cooldownMs: 1000 });
  assert.ok(near(r9.cooldownMs, 5000), `继续撞墙也不超过封顶；实际 ${r9.cooldownMs}`);
});

t('冷却：一次成功清掉账号级冷却，但**不**清出口级（一次成功不代表墙没了）', async () => {
  const lim = new AccountLimiter({ cooldownMs: 60_000 });
  lim.throttle('acct_a', { cooldownMs: 60_000 });
  assert.ok(lim.coolingFor('acct_a') > 0);

  // cleared 只清账号级
  lim.cleared('acct_a');
  assert.strictEqual(lim.cooldowns.has('acct_a'), false, '账号级冷却应被清掉');
  // 出口级仍在：这是刻意的 —— 单次成功不能推翻「整条链路被限流」这个事实，
  // 否则会出现「成功一次 → 立刻放开 → 又撞墙」的抖动。
  assert.ok(lim.globalCoolingFor() > 0, '出口级冷却不该被单次成功清掉');

  // 出口级到期后自动可用（pruneGlobal 在 acquire 里顺手调用）
  lim.globalCooldown = { until: Date.now() - 1, streak: 1, reason: 'concurrency' };
  const ticket = await lim.acquire('acct_a');
  assert.ok(ticket);
  ticket.release();
});

t('冷却：过期后自动可用（不需要外部清理）', async () => {
  const lim = new AccountLimiter();
  // 直接写一个已过期的冷却
  lim.cooldowns.set('acct_a', { until: Date.now() - 1, streak: 3, reason: 'concurrency' });
  assert.strictEqual(lim.coolingFor('acct_a'), 0);
  const ticket = await lim.acquire('acct_a');
  assert.ok(ticket);
  ticket.release();
});

/* ---------- 4. 排队超时与取消 ---------- */

t('排队超时：等不到令牌时按 429 拒绝（不让连接挂死）', async () => {
  const lim = new AccountLimiter({ maxConcurrent: 1 });
  const held = await lim.acquire('acct_a');
  await assert.rejects(
    () => lim.acquire('acct_a', { timeoutMs: 50 }),
    (e) => {
      assert.strictEqual(e.status, 429);
      assert.strictEqual(e.code, 'RACCOON_QUEUE_TIMEOUT');
      return true;
    },
  );
  held.release();
});

t('取消：客户端断开时等待者立刻被拒绝（不占着队列）', async () => {
  const lim = new AccountLimiter({ maxConcurrent: 1 });
  const held = await lim.acquire('acct_a');
  const ac = new AbortController();
  const p = lim.acquire('acct_a', { signal: ac.signal, timeoutMs: 60_000 });
  await sleep(10);
  ac.abort();
  await assert.rejects(() => p, (e) => {
    assert.strictEqual(e.status, 499);
    return true;
  });
  held.release();
});

t('快照：面板能读到在途/排队/冷却', async () => {
  const lim = new AccountLimiter({ maxConcurrent: 2 });
  await lim.acquire('acct_a');
  lim.throttle('acct_b', { cooldownMs: 10_000 });
  const snap = lim.snapshot();
  assert.strictEqual(snap.maxConcurrent, 2);
  assert.strictEqual(snap.accounts.acct_a.inFlight, 1);
  assert.ok(snap.accounts.acct_b.coolingMsLeft > 0);
  assert.ok(snap.stats.acquired >= 1);
  assert.ok(snap.stats.throttled >= 1);
});

/* ---------- 5. SSE 旁路计量 ---------- */

t('SSE 计量：usage 与 finish_reason 被取到', () => {
  const sink = { usage: null, finishReason: null };
  streamMod.sniffLine('data: {"choices":[{"delta":{"content":"hi"}}]}', sink);
  assert.strictEqual(sink.finishReason, null);
  streamMod.sniffLine('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}', sink);
  assert.strictEqual(sink.finishReason, 'tool_calls');
  streamMod.sniffLine('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}', sink);
  assert.strictEqual(sink.usage.total_tokens, 15);
  // [DONE] 与非 data 行不打扰
  streamMod.sniffLine('data: [DONE]', sink);
  streamMod.sniffLine(': ping', sink);
  assert.strictEqual(sink.usage.total_tokens, 15);
});

t('SSE 计量：非 JSON / 畸形帧不抛错（上游偶发半帧）', () => {
  const sink = { usage: null, finishReason: null };
  assert.doesNotThrow(() => streamMod.sniffLine('data: {broken', sink));
  assert.doesNotThrow(() => streamMod.sniffLine('data: {"choices":null}', sink));
});

t('SSE 计量：上游不发 usage 时保持 null（不能被当成 0）', () => {
  const sink = { usage: null, finishReason: null };
  streamMod.sniffLine('data: {"choices":[{"delta":{"content":"x"}}]}', sink);
  assert.strictEqual(sink.usage, null, '未计量与 0 消耗是两件事，统计层依赖这个区别');
});

/* ---------- 6. 流泵：字节不变 + 客户端断开取消上游 ---------- */

t('流泵：转发字节与上游一致（一个字节都不改写）', async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const upstream = new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(new TextEncoder().encode(f));
      c.close();
    },
  });
  const written = [];
  const fakeRes = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    flushHeaders() {},
    write(d) { written.push(d); return true; },
    end() { this.writableEnded = true; },
    once() {},
    removeListener() {},
  };
  const r = await streamMod.pipeToClient(upstream, fakeRes);
  assert.strictEqual(written.join(''), frames.join(''));
  assert.strictEqual(r.finishReason, 'stop');
  assert.strictEqual(r.aborted, false);
});

t('流泵：客户端断开时取消上游 reader（不再烧积分）', async () => {
  let cancelled = false;
  let pulled = 0;
  const upstream = new ReadableStream({
    pull(c) {
      pulled += 1;
      // 前两帧后一直挂着，模拟「上游还在生成」
      if (pulled <= 2) {
        c.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"x${pulled}"}}]}\n\n`));
      }
      // 之后不 close：等客户端断开
    },
    cancel() { cancelled = true; },
  });
  const listeners = {};
  const fakeRes = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    flushHeaders() {},
    write() { return true; },
    end() { this.writableEnded = true; },
    once(ev, fn) { listeners[ev] = fn; },
    removeListener() {},
  };
  // 断开：第 3 次 read 会挂住，我们在此时触发 close
  setTimeout(() => { if (listeners.close) listeners.close(); }, 30);
  const r = await streamMod.pipeToClient(upstream, fakeRes);
  assert.strictEqual(r.aborted, true, '断开必须被识别');
  assert.strictEqual(cancelled, true, '必须取消上游 reader');
});

t('流泵：断流时补错误帧（不静默结束，客户端能知道这轮不完整）', async () => {
  const upstream = new ReadableStream({
    pull(c) { c.error(new Error('ECONNRESET')); },
  });
  const written = [];
  const fakeRes = {
    headersSent: true,
    writableEnded: false,
    setHeader() {},
    flushHeaders() {},
    write(d) { written.push(d); return true; },
    end() { this.writableEnded = true; },
    once() {},
    removeListener() {},
  };
  const r = await streamMod.pipeToClient(upstream, fakeRes);
  const all = written.join('');
  assert.ok(/upstream_error/.test(all), `必须下发错误帧，实际: ${all}`);
  assert.ok(/\[DONE\]/.test(all), '必须补 [DONE] 让客户端收尾');
  assert.strictEqual(r.finishReason, null);
});

/* ---------- 7. 环境变量覆盖 ---------- */

t('超时默认 1200s（对齐官方客户端），而不是 60s', () => {
  const product = require('../raccoon/product');
  // 60s 会把 p99=127s / max=150s 的长回合全部砍断（实测 17/324 = 5.2% 坏回合）。
  // 官方客户端自己的 timeout 是 1200 秒，本网关必须同口径。
  assert.strictEqual(product.REQUEST_TIMEOUT_MS, 1_200_000, `默认超时应为 1200s，实际 ${product.REQUEST_TIMEOUT_MS}`);
});

t('参数可经环境变量覆盖（部署侧调参不必改代码）', () => {
  const old = { ...process.env };
  try {
    process.env.RACCOON_MAX_CONCURRENT = '7';
    process.env.RACCOON_COOLDOWN_MS = '123456';
    const lim = new AccountLimiter();
    assert.strictEqual(lim.maxConcurrent, 7);
    assert.strictEqual(lim.cooldownMs, 123456);
  } finally {
    process.env = old;
  }
});

t('非法环境变量回落默认（避免 parseInt 写出关不掉的开关）', () => {
  const old = { ...process.env };
  try {
    process.env.RACCOON_MAX_CONCURRENT = 'abc';
    const lim = new AccountLimiter();
    // 默认值从 3 降到 1（2026-11-26）：官方客户端并发峰值只有 2，网关每账号
    // 开到 3 会让「同时刻多条长上下文在算」成为常态，实算 token 速率翻倍，
    // 那正是 200108「异常调用」的判据。这里断言的是「回落到默认」这个行为，
    // 数值取 limiter 导出的常量，避免以后再调默认值时测试假失败。
    assert.strictEqual(
      lim.maxConcurrent,
      require('../raccoon/limiter').DEFAULT_MAX_CONCURRENT,
      '非法值必须回落默认值，而不是 NaN',
    );
    assert.strictEqual(Number.isFinite(lim.maxConcurrent), true);
  } finally {
    process.env = old;
  }
});

t('默认并发上限为 1（对齐官方客户端的串行调用形态）', () => {
  const old = { ...process.env };
  try {
    delete process.env.RACCOON_MAX_CONCURRENT;
    const lim = new AccountLimiter();
    assert.strictEqual(lim.maxConcurrent, DEFAULT_MAX_CONCURRENT, '每账号同一时刻只允许一条在途');
  } finally {
    process.env = old;
  }
});

/* ---------- 8. 虚拟模型 / Provider 注册（2026-11-09 前端"选不到 Raccoon"根因） ---------- */

t('Provider 注册：raccoon 出现在 listProviders（否则新增虚拟模型选不到它）', () => {
  process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || path.join(os.tmpdir(), `rg-mr-${Date.now()}`);
  const mrStore = require('../model-router/store');
  const ids = mrStore.listProviders().map((p) => p.id);
  assert.ok(ids.includes('raccoon'), `providers 必须含 raccoon，实际 [${ids.join(', ')}]`);
  const p = mrStore.getProvider('raccoon');
  assert.strictEqual(p.type, 'builtin');
  // ⚠️ builtin 不能被静默归一成 'trae' —— 那会让候选显示 sn-*、
  // 实际请求打到 Trae 上游拿 4001（本次修复的真实故障形态）。
  assert.strictEqual(p.builtin, 'raccoon');
});

t('Provider 归一：未知 builtin 仍回落 trae（不因新增白名单而放松）', () => {
  const mrStore = require('../model-router/store');
  // 通过 upsert 一个非法 builtin，验证白名单仍在起作用
  mrStore.upsertProvider('bogus_provider', { type: 'builtin', builtin: 'not_a_real_channel', label: 'bogus' });
  const p = mrStore.getProvider('bogus_provider');
  assert.strictEqual(p.builtin, 'trae', '未知 builtin 必须回落 trae');
  mrStore.removeProvider('bogus_provider');
});

t('Provider 保护：内置 provider（含 raccoon）不可删除', () => {
  const mrStore = require('../model-router/store');
  for (const id of ['trae', 'workbuddy', 'raccoon']) {
    const r = mrStore.removeProvider(id);
    assert.strictEqual(r.ok, false, `${id} 不该被删除`);
  }
});

t('虚拟模型候选：raccoon 候选可正常落库且 usable', () => {
  const mrStore = require('../model-router/store');
  const r = mrStore.upsertVirtual('vm/raccoon-ut', {
    description: 'UT',
    strategy: 'priority',
    candidates: [{ provider: 'raccoon', model: 'sn-glm-5-3-flash', priority: 100, weight: 1 }],
    enabled: true,
  });
  assert.strictEqual(r.ok, true);
  const vm = mrStore.getVirtual('vm/raccoon-ut');
  assert.strictEqual(vm.candidates[0].provider, 'raccoon');
  // 候选 id 由 normalize 兜底成 provider:model（前端不预置）
  assert.strictEqual(vm.candidates[0].id, 'raccoon:sn-glm-5-3-flash');
  // 清理
  mrStore.removeVirtual('vm/raccoon-ut');
});

t('dispatch 路由：raccoon provider 不走 Trae 分支（P0：否则拿错 token 打错上游）', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'model-router', 'dispatch.js'), 'utf8',
  );
  // 两个入口都必须有 raccoon 分支
  assert.ok(/builtin === 'raccoon'/.test(src), 'dispatch 必须有 raccoon 分支');
  assert.ok(/dispatchRaccoonNonStream/.test(src), '非流式必须有 Raccoon 实现');
  assert.ok(/dispatchRaccoonStream/.test(src), '流式必须有 Raccoon 实现');
});

/* ---------- 8.5 输入预算：单次上限 + 每小时未缓存预算（2026-11-26） ---------- */

t('input-budget：单次输入超上限时判超限，小请求放行', () => {
  const ib = require('../raccoon/input-budget');
  const small = ib.checkInputSize([{ role: 'user', content: 'hi' }], []);
  assert.strictEqual(small.exceeded, false, '小请求不该被拦');
  assert.ok(small.estimated > 0);

  const big = ib.checkInputSize([{ role: 'user', content: 'x'.repeat(2_000_000) }], []);
  assert.strictEqual(big.exceeded, true, '200 万字符必须判超限');
  assert.ok(big.estimated > big.limit);
});

t('input-budget：超限错误是 400 + 可执行文案（含估算值与上限）', () => {
  const ib = require('../raccoon/input-budget');
  const e = ib.inputTooLargeError(500_000, 345_600);
  assert.strictEqual(e.status, 400, '超限是客户端问题，不是 5xx');
  assert.strictEqual(e.code, 'raccoon_input_too_large');
  assert.strictEqual(e.estimatedTokens, 500_000);
  assert.strictEqual(e.limitTokens, 345_600);
  // 文案必须说清「该怎么办」，否则用户只看到 400 不知道减到多少
  assert.ok(/RACCOON_MAX_INPUT_TOKENS/.test(e.message), '要告诉用户怎么调整');
  assert.ok(e.message.includes('500,000'), '要给出估算值');
  assert.ok(e.message.includes('345,600'), '要给出上限');
});

t('input-budget：环境变量可覆盖，设 0 关闭守门', () => {
  const ib = require('../raccoon/input-budget');
  const old = process.env.RACCOON_MAX_INPUT_TOKENS;
  try {
    process.env.RACCOON_MAX_INPUT_TOKENS = '0';
    assert.strictEqual(ib.maxInputTokens(), 0);
    const r = ib.checkInputSize([{ role: 'user', content: 'x'.repeat(2_000_000) }], []);
    assert.strictEqual(r.exceeded, false, '0 = 关闭守门');

    process.env.RACCOON_MAX_INPUT_TOKENS = '1000';
    assert.strictEqual(ib.maxInputTokens(), 1000);
  } finally {
    if (old === undefined) delete process.env.RACCOON_MAX_INPUT_TOKENS;
    else process.env.RACCOON_MAX_INPUT_TOKENS = old;
  }
});

t('input-budget：小时预算只计未缓存部分（缓存命中不推风控）', () => {
  const ib = require('../raccoon/input-budget');
  ib.resetBudget('acct_budget_ut');
  // 100 万 prompt，其中 90 万命中缓存 → 只应记 10 万
  ib.recordUsage('acct_budget_ut', { promptTokens: 1_000_000, cacheReadTokens: 900_000 });
  assert.strictEqual(ib.usedLastHour('acct_budget_ut'), 100_000, '只计实算部分');
  ib.resetBudget('acct_budget_ut');
  assert.strictEqual(ib.usedLastHour('acct_budget_ut'), 0);
});

t('input-budget：超预算后 exhausted=true，pickAccount 不再分配该号', () => {
  const ib = require('../raccoon/input-budget');
  const store = require('../credentials/store');
  const dispatch = require('../raccoon/dispatch');
  const a = store.add({
    label: 'ut-budget', edition: 'raccoon', token: 't', refreshToken: 'r',
    userId: 'ut-budget-user', enabled: true,
  });
  try {
    ib.recordUsage(a.id, { promptTokens: 4_000_000, cacheReadTokens: 0 });
    const chk = ib.checkHourlyBudget(a.id);
    assert.strictEqual(chk.exhausted, true, '超过默认 3,000,000 预算');
    assert.strictEqual(dispatch.pickAccount(), null, '超预算的号不该被分配');
    ib.resetBudget(a.id);
    const back = dispatch.pickAccount();
    assert.ok(back, '重置预算后应恢复可分配');
  } finally {
    ib.resetBudget(a.id);
    try { store.remove(a.id); } catch { /* 清理失败不影响断言 */ }
  }
});

t('dispatch：usage 归一化覆盖流式与非流式两种形状', () => {
  const dispatch = require('../raccoon/dispatch');
  const s = dispatch.normalizeUsageForBudget({ streamed: true, usage: { promptTokens: 1000, cacheReadTokens: 800 } });
  assert.deepStrictEqual(s, { promptTokens: 1000, cacheReadTokens: 800 });
  const n = dispatch.normalizeUsageForBudget({
    streamed: false,
    data: { usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800 } } },
  });
  assert.deepStrictEqual(n, { promptTokens: 1000, cacheReadTokens: 800 }, '非流式不归一会被记成 0');
  assert.deepStrictEqual(dispatch.normalizeUsageForBudget(null), { promptTokens: 0, cacheReadTokens: 0 });
});

t('路由契约：两条 Raccoon 路径都在发上游前做输入预算守门', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const [file, label] of [['openai.js', '统一端点'], ['raccoon.js', '显式端点']]) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', file), 'utf8');
    assert.ok(/inputBudget\.checkInputSize\(/.test(src), `${label} 必须调 checkInputSize`);
    assert.ok(/inputTooLargeError\(/.test(src), `${label} 必须用统一的超限错误`);
  }
});

/* ---------- 9. 账号粘性 + 选号口径（2026-11-25 事故根因） ---------- */

t('pickAccount：无粘性时优先复用**最近用过**的号，而不是最久未选', () => {
  const store = require('../credentials/store');
  const dispatch = require('../raccoon/dispatch');
  const ids = [];
  try {
    // 造两个账号，lastPickedAt 差 10 秒
    for (const [uid, pickedAgo] of [['sticky-a', 10_000], ['sticky-b', 0]]) {
      const a = store.add({
        label: `ut-${uid}`, edition: 'raccoon', token: 't', refreshToken: 'r',
        userId: uid, enabled: true,
      });
      store.update(a.id, { lastPickedAt: Date.now() - pickedAgo });
      ids.push(a.id);
    }
    const picked = dispatch.pickAccount();
    assert.ok(picked, '必须有可选账号');
    // sticky-b 的 lastPickedAt 更近 → 应被选中（旧口径会选更久未用的 sticky-a）
    assert.strictEqual(
      picked.userId, 'sticky-b',
      '应优先复用最近用过的账号：换号会让 prompt cache 失效（2026-11-25 实测命中率 90.3%→79.3%）',
    );
  } finally {
    for (const id of ids) { try { store.remove(id); } catch { /* 清理失败不影响断言 */ } }
  }
});

t('pickAccount：粘性账号命中时直接返回它，不受 lastPickedAt 影响', () => {
  const store = require('../credentials/store');
  const dispatch = require('../raccoon/dispatch');
  const ids = [];
  try {
    for (const [uid, pickedAgo] of [['sticky-c', 0], ['sticky-d', 60_000]]) {
      const a = store.add({
        label: `ut-${uid}`, edition: 'raccoon', token: 't', refreshToken: 'r',
        userId: uid, enabled: true,
      });
      store.update(a.id, { lastPickedAt: Date.now() - pickedAgo });
      ids.push(a.id);
    }
    // 指定「最久未用」的那个作为粘性账号，仍应被选中
    const stickyId = ids[1];
    const picked = dispatch.pickAccount({ stickyAccountId: stickyId });
    assert.strictEqual(picked.id, stickyId, '粘性是偏好，优先于 lastPickedAt 排序');
  } finally {
    for (const id of ids) { try { store.remove(id); } catch { /* 同上 */ } }
  }
});

t('统一端点：sn-* 分支必须把 stickyKey/stickyAccountId 传给 handleRaccoonChat', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'routes', 'openai.js'), 'utf8',
  );
  // sn-* 是**提前 return** 的，后面虚拟模型段的 stickyKey 计算走不到。
  // 少了这段，Raccoon 直连路径完全没有粘性 → 两号严格轮流 → 缓存逐请求失效。
  const raccoonBranch = src.slice(src.indexOf('if (isRaccoonModel(model))'));
  const upToCall = raccoonBranch.slice(0, raccoonBranch.indexOf('});'));
  assert.ok(
    /stickyKey: raccoonStickyKey/.test(upToCall),
    'sn-* 分支必须传 stickyKey（否则走不到后面的 sticky 计算）',
  );
  assert.ok(
    /stickyAccountId: sticky\.lookup\(raccoonStickyKey\)/.test(upToCall),
    'sn-* 分支必须传 stickyAccountId',
  );
});

t('handleRaccoonChat：成功后回写 sticky 绑定，失败不绑', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'routes', 'openai.js'), 'utf8',
  );
  const fn = src.slice(src.indexOf('async function handleRaccoonChat'), src.indexOf('function lastUserText'));
  // bind 必须在 try 内、且在 run() 之后（失败会走 catch，不该绑到坏号上）
  assert.ok(/sticky\.bind\(stickyKey, usedAccountId\)/.test(fn), '成功后必须回写粘性绑定');
  const bindIdx = fn.indexOf('sticky.bind(stickyKey, usedAccountId)');
  const catchIdx = fn.indexOf('} catch (err)');
  assert.ok(bindIdx > 0 && bindIdx < catchIdx, 'bind 必须在 catch 之前（只在成功路径上）');
});

t('显式端点 /v1/raccoon/chat/completions 同样带粘性', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'routes', 'raccoon.js'), 'utf8',
  );
  assert.ok(/sticky\.lookup\(raccoonStickyKey\)/.test(src), '显式端点必须传 stickyAccountId');
  assert.ok(/sticky\.bind\(raccoonStickyKey, usedAccountId\)/.test(src), '显式端点成功后必须回写绑定');
});

t('SSE model 改写：只改 data 帧的 model 字段，其余字节原样', () => {
  const { rewriteSseModelLine } = require('../model-router/dispatch');
  const line = 'data: {"id":"x","model":"sn-glm-5-3-flash","choices":[]}';
  const out = rewriteSseModelLine(line, 'vm/raccoon-test');
  const obj = JSON.parse(out.slice(6));
  assert.strictEqual(obj.model, 'vm/raccoon-test');
  // 非 data 帧原样
  assert.strictEqual(rewriteSseModelLine('data: [DONE]', 'vm/x'), 'data: [DONE]');
  assert.strictEqual(rewriteSseModelLine(': ping', 'vm/x'), ': ping');
  // 非法 JSON 不吞字节
  assert.strictEqual(rewriteSseModelLine('data: {broken', 'vm/x'), 'data: {broken');
});

/* ---------- 10. 预算记账：run() 只认回调返回值里的 usage ---------- */

t('预算记账：模型路由器的虚拟模型流式路径必须把 usage 交回 run()', async () => {
  /*
   * 复现的是一条**静默**缺陷：`dispatchRaccoonStream` 的回调曾经返回 `{ok:true}`，
   * 而 `run()` 的记账点 `normalizeUsageForBudget(result)` 读的正是**回调返回值**。
   * 结果：虚拟模型（vm/raccoon-*）每一次流式请求都给账号记 0 个未缓存 token，
   * `RACCOON_HOURLY_UNCACHED_BUDGET` 的账号轮换语义在这条路径上完全失效 ——
   * 不报错、日志里的 cacheReadTokens 也正常（那来自另一条旁路），最难发现。
   *
   * 断言口径：一条 prompt=41686 / cached=38000 的流式回合，
   * 必须给 pickAccount 选中的那个账号记 3686 个未缓存 token。
   */
  const raccoonChat = require('../raccoon/chat');
  const raccoonDispatch = require('../raccoon/dispatch');
  const inputBudget = require('../raccoon/input-budget');
  const router = require('../model-router/dispatch');
  const PROMPT = 41686;
  const CACHED = 38000;
  const sse = [
    'data: {"id":"x","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
    `data: {"id":"x","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":${PROMPT},"completion_tokens":302,"total_tokens":41988,"prompt_tokens_details":{"cached_tokens":${CACHED}}}}`,
    'data: [DONE]',
    '',
  ].join('\n');
  const res = {
    writableEnded: false, headersSent: true,
    write() {}, end() { this.writableEnded = true; }, setHeader() {}, flushHeaders() {},
  };
  const origChatStream = raccoonChat.chatStream;
  const origRun = raccoonDispatch.run;
  const store = require('../credentials/store');
  // 测试隔离目录里本来没有账号，pickAccount 会直接抛「没有可用的 Raccoon 账号」
  const acct = store.add({
    label: 'ut-vm-budget', edition: 'raccoon', token: 't', refreshToken: 'r',
    userId: 'ut-vm-budget', enabled: true,
  });
  let spentOn = null;
  inputBudget.resetBudget();
  raccoonChat.chatStream = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); },
    }),
  });
  // 只旁听 run 的记账目标，记账逻辑本身仍走真实现
  raccoonDispatch.run = async (runOnce, opts) => {
    const r = await origRun(runOnce, opts);
    spentOn = r.accountId;
    return r;
  };
  try {
    const out = await router.dispatchRaccoonStream(
      'raccoon', 'sn-deepseek-v4-1-flash-1017',
      { messages: [{ role: 'user', content: 'hi' }] },
      res, {},
    );
    assert.ok(spentOn, '必须有账号被记账');
    assert.strictEqual(
      inputBudget.usedLastHour(spentOn), PROMPT - CACHED,
      '未缓存 token 必须来自本条流式回合的 usage；为 0 说明 usage 没随回调返回值交回 run()',
    );
    // 对外返回值仍要带 usage（traffic 日志与成本估算依赖它）
    assert.strictEqual(out.usage && out.usage.prompt_tokens, PROMPT, '对外返回值必须带上游 usage');
    // 归一化必须认得这个形状（报告的 snake_case 场景）
    assert.deepStrictEqual(
      raccoonDispatch.normalizeUsageForBudget(out),
      { promptTokens: PROMPT, cacheReadTokens: CACHED },
    );
  } finally {
    inputBudget.resetBudget();
    raccoonChat.chatStream = origChatStream;
    raccoonDispatch.run = origRun;
    try { store.remove(acct.id); } catch { /* 清理失败不影响断言 */ }
  }
});

/* ---------- 运行 ---------- */

(async () => {
  for (const { name, fn } of queue) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fn();
      pass += 1;
      console.log(`  ok  ${name}`);
    } catch (e) {
      fail += 1;
      failures.push({ name, error: e });
      console.log(`  FAIL ${name}`);
      console.log(`       ${e && e.message}`);
    }
  }
  console.log('');
  console.log(`Raccoon 代理测试：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`);
  if (fail > 0) {
    for (const f of failures) {
      console.log('');
      console.log(`--- ${f.name} ---`);
      console.log(f.error && f.error.stack ? f.error.stack.split('\n').slice(0, 8).join('\n') : String(f.error));
    }
    process.exit(1);
  }
  process.exit(0);
})();
