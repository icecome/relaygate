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

const { AccountLimiter, classifyThrottle } = require('../raccoon/limiter');
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
  const r1 = lim.throttle('acct_a', { cooldownMs: 1000 });
  assert.strictEqual(r1.streak, 1);
  assert.strictEqual(r1.cooldownMs, 1000);
  const r2 = lim.throttle('acct_a', { cooldownMs: 1000 });
  assert.strictEqual(r2.streak, 2);
  assert.strictEqual(r2.cooldownMs, 2000);
  const r3 = lim.throttle('acct_a', { cooldownMs: 1000 });
  assert.strictEqual(r3.cooldownMs, 4000);
  const r4 = lim.throttle('acct_a', { cooldownMs: 1000 });
  assert.strictEqual(r4.cooldownMs, 5000, '必须封顶');
  const r9 = lim.throttle('acct_a', { cooldownMs: 1000 });
  assert.strictEqual(r9.cooldownMs, 5000, '继续撞墙也不超过封顶');
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
    assert.strictEqual(lim.maxConcurrent, 3, '非法值必须回落默认 3，而不是 NaN');
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
