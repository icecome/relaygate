'use strict';
/**
 * raccoon/limiter.js —— 上游**并发闸门** + 限流熔断（本渠道专属）。
 *
 * ## 为什么这个文件存在（2026-11-09 实测，改代码前必读）
 *
 * 「raccoon: 您的模型请求频率超限，请稍后重试」不是本仓库的文案，是上游原文：
 *
 * ```
 * HTTP 429
 * {"error":{"code":"user_model_rate_limited",
 *           "message":"您的模型请求频率超限，请稍后重试",
 *           "type":"rate_limit_error"}}
 * ```
 *
 * 还有第二种形态（同一堵墙的另一个门房）：
 *
 * ```
 * HTTP 429 {"code":200103,"message":"limiter_request_error",
 *           "details":"request exceed max time, retry after:0s"}
 * ```
 *
 * ## 实测结论（这五条直接决定下面的参数与结构）
 *
 * | 事实 | 实测数据 | 对设计的约束 |
 * |---|---|---|
 * | 判据是**瞬时并发**，不是 RPM | 串行 15 次 / 43.8s **全通过**；并发 5 次第 3 轮全挂 | 所以闸门必须是**并发信号量**，不是令牌桶 |
 * | 并发槽位约 **4** | 4 并发 ×3 轮稳定通过；5 并发出现限流；6/8 并发直接全挂 | 默认上限取 **3**（留一格给手动探测/其它进程） |
 * | 限流**跨账号** | 两个不同的 Raccoon 账号 + 本机客户端的第三个账号，**同时**全部 429 | 只按账号冷却**不够**：换号绕不过去 |
 * | 限流**跨模型** | `sn-kimi-k3` / `sn-sensenova-6-8-flash` / `sn-glm-5-3` 同时 429 | 只按 (账号,模型) 冷却**不够** |
 * | 恢复窗口 **> 8 分钟** | 每 5s/15s 探一次，473s 仍未恢复；期间全部秒回 429（56-200ms） | 冷却默认 **300s** 起步且指数退避，必须**全局**生效 |
 *
 * ## 结论：这是「出站 IP 维度」的限流
 *
 * 三条独立证据指向同一个结论 —— 上游按**出站公网 IP** 计并发，不是按账号：
 *
 * 1. 撞墙后换**另一个账号**照样 429（两个账号是不同手机号注册的）；
 * 2. 撞墙后换**另一个模型**照样 429；
 * 3. 恢复窗口远超任何单一账号的冷却窗口，且期间所有请求**同生共死**。
 *
 * 于是冷却必须是**两级**的：
 * - **全局（出口级）**：一次 429 就把整条链路冷住，因为换谁都没用；
 * - **账号级**：仍然保留，用于「这个号单独出问题」的场景（如凭据失效），
 *   以及将来若上游改回按账号判定时无需重构。
 *
 * ⚠️ 只做账号级冷却的后果是**放大**故障：一个号撞墙 → 换号 → 再撞一次 →
 * 再换 → …… 一次限流被放大成 N 次撞墙，而每次撞墙都可能延长恢复窗口。
 * 这正是「用 OFM 插件时频繁被限流」的机理之一。
 *
 * ## 为什么不是「重试」
 *
 * 撞墙后立刻重试是净损失：
 * - 上游秒回 429（实测 56-270ms），重试不增加成功率，只增加「已撞墙次数」；
 * - 参考项目 `dsh-our-free-model` 在 issue #13 里给出的结论相同 —— 它把 429
 *   从 `retryableCodes` 里**移除**（原文：`the two automatic retries turned every
 *   quota wall into three walls — the same turn, paid thrice, arriving later`）；
 * - 本项目 `src/config.js` 的 `rateCooldownMs` 也已经在做冷却而非重试。
 *
 * ⚠️ 但本项目此前的 `raccoon/dispatch.js` **没有**任何冷却就换号重试：那是
 * 「把一次撞墙放大成三次」的形态。现在改为撞墙即全局冷却 + 立即停止本请求的换号。
 *
 * ## 判据为什么读 `code` 而不是 HTTP 状态码
 *
 * 同一个 429 下藏着三种完全不同的原因（并发超限 / 内部 limiter 超时 / 未知），
 * 而它们的处置不同：`user_model_rate_limited` 要退避整条链路，`200103` 的
 * `retry after: 0s` 说明是**瞬时**排队超时，短冷即可。只看状态码会把两者
 * 混成同一件事，于是要么冷太久（用户干等 5 分钟），要么冷太短（反复撞墙）。
 *
 * @module src/raccoon/limiter.js
 */

/** 上游「并发超限」的两种业务码（字符串/数字都要认，上游两种都出现过）。 */
const CONCURRENCY_CODES = Object.freeze(['user_model_rate_limited', 'limiter_request_error']);
/** 数字形态：200103 = limiter_request_error。 */
const CONCURRENCY_NUMERIC_CODES = Object.freeze([200103]);

/**
 * 默认并发上限。
 *
 * 实测 4 并发稳定、5 并发开始挂，故取 3：留一格机动给「面板手动探测」「同一账号
 * 在官方客户端也开着」这两种会与本网关共享同一账号额度的情况。
 * 注意这是**每账号**的上限，不是全局。
 */
const DEFAULT_MAX_CONCURRENT = 3;

/**
 * 撞墙后的基础冷却（毫秒）。
 *
 * 实测恢复窗口 > 200s（探到 202s 仍未恢复）。取 300s 作为**首次**冷却：
 * 低于实测下界就等于「冷却结束即撞墙」，那会让熔断形同虚设。
 */
const DEFAULT_COOLDOWN_MS = 300_000;

/** 指数退避封顶：连续撞墙最多冷 30 分钟（与 pool.js 的 rateCooldownMaxMs 同口径）。 */
const DEFAULT_COOLDOWN_MAX_MS = 30 * 60 * 1000;

/**
 * `200103 limiter_request_error` 的短冷却。
 *
 * 它的 details 明确写 `retry after: 0s` —— 语义是「排队等待超时」而不是
 * 「额度用尽」。给 15s 而不是 300s：这类瞬时拥塞通常几秒就散，冷 5 分钟是
 * 纯粹的可用性损失。
 */
const TRANSIENT_COOLDOWN_MS = 15_000;

/** 等待队列上限（超出的请求直接 429，不堆积连接）。 */
const DEFAULT_MAX_QUEUE = 64;

/** 取正数环境变量，非法值回落默认（`parseInt('0') || 5` 这类写法会把开关写死）。 */
function num(envKey, dflt) {
  const raw = process.env[envKey];
  if (raw == null || String(raw).trim() === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : dflt;
}

/**
 * 从上游错误报文里判定「是不是并发超限」，并给出该冷多久。
 *
 * @param {{status?:number, body?:string, message?:string}} p
 * @returns {{limited:boolean, kind:'concurrency'|'transient'|'unknown', cooldownMs:number}}
 */
function classifyThrottle(p = {}) {
  const body = String(p.body || p.message || '');
  const status = Number(p.status) || 0;

  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch { /* 非 JSON（可能是 SSE 帧或 HTML） */ }

  const codeRaw = parsed
    ? (parsed.error && parsed.error.code) ?? parsed.code
    : null;
  const codeNum = Number(codeRaw);
  const codeStr = typeof codeRaw === 'string' ? codeRaw : '';

  const isConcurrency = CONCURRENCY_CODES.includes(codeStr)
    || CONCURRENCY_NUMERIC_CODES.includes(codeNum);
  if (isConcurrency) {
    // 200103 是「排队超时」，短冷；user_model_rate_limited 是「额度/并发用尽」，长冷。
    const transient = codeNum === 200103 || /retry after:\s*0s/i.test(body);
    return {
      limited: true,
      kind: transient ? 'transient' : 'concurrency',
      cooldownMs: transient ? TRANSIENT_COOLDOWN_MS : DEFAULT_COOLDOWN_MS,
    };
  }

  // 退路：文案命中「频率超限」但拿不到 code（上游改了 code 时的保底判据）。
  if (status === 429 || /请求频率超限|频率限制|rate.?limit|too many requests/i.test(body)) {
    return { limited: true, kind: 'unknown', cooldownMs: DEFAULT_COOLDOWN_MS };
  }
  return { limited: false, kind: 'unknown', cooldownMs: 0 };
}

/**
 * 每账号的并发闸门 + 冷却熔断。
 *
 * 结构选择：**进程内 Map**，与 `credentials/pool.js` 的 `inFlight` 同构。
 * 不落库的理由：并发槽位是「此刻有多少条请求在路上」，进程重启后本就归零；
 * 落库只会让重启后读到一个陈旧的计数而永久卡死。
 *
 * 冷却**要**跨进程可见（账号被上游限流是服务端事实），故 `cooldownUntil` 由
 * 调用方写进账号库的 `coolUntil`，本模块只维护内存副本做快速判定。
 */
class AccountLimiter {
  /**
   * @param {{maxConcurrent?:number, cooldownMs?:number, cooldownMaxMs?:number, maxQueue?:number}} [opts]
   */
  constructor(opts = {}) {
    this.maxConcurrent = Number.isFinite(opts.maxConcurrent) && opts.maxConcurrent > 0
      ? opts.maxConcurrent
      : num('RACCOON_MAX_CONCURRENT', DEFAULT_MAX_CONCURRENT);
    this.cooldownMs = Number.isFinite(opts.cooldownMs) && opts.cooldownMs >= 0
      ? opts.cooldownMs
      : num('RACCOON_COOLDOWN_MS', DEFAULT_COOLDOWN_MS);
    this.cooldownMaxMs = Number.isFinite(opts.cooldownMaxMs) && opts.cooldownMaxMs > 0
      ? opts.cooldownMaxMs
      : num('RACCOON_COOLDOWN_MAX_MS', DEFAULT_COOLDOWN_MAX_MS);
    this.maxQueue = Number.isFinite(opts.maxQueue) && opts.maxQueue > 0
      ? opts.maxQueue
      : num('RACCOON_MAX_QUEUE', DEFAULT_MAX_QUEUE);

    /** accountId -> 当前在途数 */
    this.inFlight = new Map();
    /** accountId -> { until:number, streak:number, reason:string } */
    this.cooldowns = new Map();
    /** accountId -> 等待令牌的 FIFO */
    this.waiters = new Map();

    /**
     * **出口级**（全局）冷却。
     *
     * 为什么不放在账号维度：实测换账号、换模型都照样 429（见头部表格）。
     * 上游按**出站 IP** 计并发，所以「哪个账号撞的」这件事对恢复毫无意义 ——
     * 整条链路必须一起冷静，否则就是「换号再撞」的放大循环。
     *
     * `{ until:number, streak:number, reason:string }`，未冷却时为 null。
     */
    this.globalCooldown = null;

    /** 观测用计数 */
    this.stats = { acquired: 0, queued: 0, rejected: 0, throttled: 0, globalLocked: 0 };
  }

  /** 该账号当前在途数。 */
  inFlightOf(accountId) {
    return this.inFlight.get(String(accountId)) || 0;
  }

  /**
   * 该账号的**账号级**冷却剩余毫秒（0 = 不在冷却）。
   *
   * ⚠️ 这里刻意**不**合并出口级冷却：两者语义不同，合并后调用方就没法回答
   * 「是这个号不行，还是整条链路不行」。要判「现在能不能发请求」请用
   * {@link blockedFor}（它返回第一个生效的原因）。
   */
  coolingFor(accountId, now = Date.now()) {
    const rec = this.cooldowns.get(String(accountId));
    if (!rec) return 0;
    const left = rec.until - now;
    return left > 0 ? left : 0;
  }

  /**
   * 「现在能不能给这个号发请求」的统一判定：返回 0 表示可以，否则是**第一个**
   * 生效的阻塞原因的剩余毫秒（出口级优先）。
   *
   * 为什么要有这个函数：热路径上有三处都要判（pickAccount / acquire / 面板快照），
   * 各写一遍「先判全局再判账号」迟早分叉 —— 而分叉的表现是「某个入口忘了判全局，
   * 于是换号穿墙」。收口到这里，只写一份。
   */
  blockedFor(accountId, now = Date.now()) {
    this.pruneGlobal(now);
    const g = this.globalCoolingFor(now);
    if (g > 0) return g;
    return this.coolingFor(accountId, now);
  }

  /** 出口级冷却剩余毫秒（0 = 未冷却）。 */
  globalCoolingFor(now = Date.now()) {
    const g = this.globalCooldown;
    if (!g) return 0;
    const left = g.until - now;
    return left > 0 ? left : 0;
  }

  /** 出口级冷却详情（面板/日志用）；无冷却返回 null。 */
  globalCoolingReason() {
    const g = this.globalCooldown;
    if (!g || g.until <= Date.now()) return null;
    return { reason: g.reason, streak: g.streak, until: g.until, msLeft: g.until - Date.now() };
  }

  /** 冷却原因（面板/日志用）；无冷却返回 null。 */
  coolingReason(accountId) {
    const rec = this.cooldowns.get(String(accountId));
    return rec && rec.until > Date.now() ? { reason: rec.reason, streak: rec.streak, until: rec.until } : null;
  }

  /**
   * 记录一次撞墙。
   *
   * 默认**同时**开出口级冷却与账号级冷却 —— 理由是实测证据：换账号换模型都
   * 照样 429，说明墙在 IP 上。只冷账号会让下一次请求换个号再撞一次，
   * 而每次撞墙都可能延长恢复窗口（实测 473s 仍未恢复）。
   *
   * @param {string} accountId
   * @param {{kind?:string, cooldownMs?:number, scope?:'global'|'account'|'both'}} [info]
   *   `scope` 默认 `'both'`；当证据表明只是「这个号自己出问题」时可传 `'account'`。
   * @returns {{until:number, streak:number, cooldownMs:number, scope:string}}
   */
  throttle(accountId, info = {}) {
    const id = String(accountId);
    const scope = info.scope === 'account' || info.scope === 'global' ? info.scope : 'both';

    const base = Number.isFinite(info.cooldownMs) && info.cooldownMs > 0 ? info.cooldownMs : this.cooldownMs;
    let streak = 1;
    let until = 0;

    if (scope === 'global' || scope === 'both') {
      const gPrev = this.globalCooldown;
      const gStreak = Math.min((gPrev ? gPrev.streak : 0) + 1, 16);
      // 首次用实测下界，之后翻倍（300s→600s→1200s…），封顶 cooldownMaxMs
      const gWait = Math.min(base * Math.pow(2, gStreak - 1), this.cooldownMaxMs);
      until = Date.now() + gWait;
      this.globalCooldown = { until, streak: gStreak, reason: info.kind || 'concurrency' };
      streak = gStreak;
      this.stats.globalLocked += 1;
    }

    if (scope === 'account' || scope === 'both') {
      const prev = this.cooldowns.get(id);
      const aStreak = Math.min((prev ? prev.streak : 0) + 1, 16);
      // 账号级用同一个「已翻倍过」的等待时长，避免两套退避互相打架
      const aWait = Math.min(base * Math.pow(2, aStreak - 1), this.cooldownMaxMs);
      const aUntil = Date.now() + aWait;
      this.cooldowns.set(id, { until: aUntil, streak: aStreak, reason: info.kind || 'concurrency' });
      if (scope === 'account') {
        until = aUntil;
        streak = aStreak;
      }
    }

    this.stats.throttled += 1;
    return { until, streak, cooldownMs: Math.max(0, until - Date.now()), scope };
  }

  /** 上游明确成功一次：清掉该账号冷却。**不**清出口级冷却（那是链路级事实）。 */
  cleared(accountId) {
    this.cooldowns.delete(String(accountId));
  }

  /**
   * 出口级冷却到期后清空（供判定时顺手调用，不需要定时器）。
   * 只有「冷却窗口走完」才清，成功请求**不**清 —— 一次成功不代表墙没了。
   */
  pruneGlobal(now = Date.now()) {
    if (this.globalCooldown && this.globalCooldown.until <= now) this.globalCooldown = null;
  }

  /**
   * 取一个并发令牌。
   *
   * 语义与 `credentials/pool.js` 的 FIFO 等待队列同构：有位置立即进；
   * 满了就排队（有上限），拿到令牌时 resolve，超时或队列满则抛 429 语义的错误。
   *
   * @param {string} accountId
   * @param {{signal?:AbortSignal, timeoutMs?:number}} [opts]
   * @returns {Promise<{release:()=>void}>}
   */
  async acquire(accountId, opts = {}) {
    const id = String(accountId);

    this.pruneGlobal();
    const blocked = this.blockedFor(id);
    if (blocked > 0) {
      const gLeft = this.globalCoolingFor();
      if (gLeft > 0) {
        const g = this.globalCoolingReason() || {};
        const e = new Error(
          `raccoon 出口整体处于限流冷却（剩余 ${Math.ceil(gLeft / 1000)}s，第 ${g.streak || 1} 次退避）。`
          + '上游按出站 IP 计并发，换账号或换模型都绕不过去，请稍后重试。',
        );
        e.code = 'RACCOON_GLOBAL_COOLING';
        e.status = 429;
        e.retryAfterMs = gLeft;
        e.gatewayError = true;
        throw e;
      }
      const e = new Error(`raccoon 账号 ${id} 正在冷却（剩余 ${Math.ceil(blocked / 1000)}s），不发上游请求`);
      e.code = 'RACCOON_COOLING';
      e.status = 429;
      e.retryAfterMs = blocked;
      e.gatewayError = true;
      throw e;
    }

    if (this.inFlightOf(id) < this.maxConcurrent) {
      this.inFlight.set(id, this.inFlightOf(id) + 1);
      this.stats.acquired += 1;
      return { release: () => this.release(id) };
    }

    // 队列满：直接拒绝，避免连接无限堆积（与 pool.maxWaiters 同义）
    const q = this.waiters.get(id) || [];
    if (q.length >= this.maxQueue) {
      this.stats.rejected += 1;
      const e = new Error(`raccoon 账号 ${id} 的等待队列已满（${this.maxQueue}），请稍后重试`);
      e.code = 'RACCOON_QUEUE_FULL';
      e.status = 429;
      throw e;
    }

    this.stats.queued += 1;
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 60_000;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null, signal: opts.signal, onAbort: null };
      const cleanup = () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        const list = this.waiters.get(id) || [];
        const i = list.indexOf(waiter);
        if (i >= 0) list.splice(i, 1);
        if (opts.signal && waiter.onAbort) opts.signal.removeEventListener('abort', waiter.onAbort);
      };
      const onAbort = () => {
        cleanup();
        const e = new Error('raccoon 请求已取消（客户端断开）');
        e.code = 'ABORT_ERR';
        e.status = 499;
        reject(e);
      };
      waiter.onAbort = onAbort;
      waiter.timer = setTimeout(() => {
        cleanup();
        this.stats.rejected += 1;
        const e = new Error(`raccoon 账号 ${id} 排队超时（${timeoutMs}ms），并发已满`);
        e.code = 'RACCOON_QUEUE_TIMEOUT';
        e.status = 429;
        reject(e);
      }, timeoutMs);
      // ⚠️ 刻意**不** unref 这个定时器。
      //
      // unref 之后，Node 会认为「没有待处理的活跃句柄」：长驻网关里这是好事
      // （排队者都走掉后不拖住退出），但它同时会让**等待中的请求**在进程层面
      // 变成可退出的状态 —— 单测里表现为「等 timeoutMs 的 Promise 永不 resolve，
      // 进程直接退出」，运维视角则是「停机钩子等不到在途请求收尾」。
      //
      // 泄漏风险由 cleanup() 兜住：超时、取消、被唤醒三条路径都会 clearTimeout。
      // 唯一不清理的路径是「进程被 SIGKILL」，那种情况下定时器本就一起消失。
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      q.push(waiter);
      this.waiters.set(id, q);
    });
  }

  /** 归还令牌并唤醒下一个等待者。 */
  release(accountId) {
    const id = String(accountId);
    const cur = this.inFlightOf(id);
    if (cur > 0) this.inFlight.set(id, cur - 1);
    const q = this.waiters.get(id);
    if (!q || !q.length) return;

    /*
     * 唤醒前必须复核阻塞状态 —— 与 acquire() 的入队判据保持同一口径。
     *
     * 旧实现只在 acquire 入队前判一次 blockedFor；撞 429 的请求在 finally 里
     * 调 release() 唤醒下一个 waiter，那个 waiter 便直接放行。于是一次撞墙被
     * 已排队者放大成 N 次，每次都再触发 throttle（退避计数 +1、冷却翻倍），
     * 正是文件头声称要消除的「反复撞墙」故障模式。
     *
     * 冷却期间正确动作：把整队已排队者批量 reject 并带 Retry-After，
     * 而不是让他们逐个再去撞墙。
     */
    const blocked = this.blockedFor(id);
    if (blocked > 0) {
      for (const w of q.splice(0)) {
        if (w.timer) clearTimeout(w.timer);
        if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
        const e = new Error(
          `raccoon 冷却中（剩余 ${Math.ceil(blocked / 1000)}s），排队请求不再放行`,
        );
        e.code = 'RACCOON_GLOBAL_COOLING';
        e.status = 429;
        e.retryAfterMs = blocked;
        e.gatewayError = true;
        w.reject(e);
      }
      this.waiters.delete(id);
      this.stats.rejected += 1;
      return;
    }

    if (this.inFlightOf(id) >= this.maxConcurrent) return;
    const waiter = q.shift();
    if (!q.length) this.waiters.delete(id);
    this.inFlight.set(id, this.inFlightOf(id) + 1);
    this.stats.acquired += 1;
    if (waiter.timer) clearTimeout(waiter.timer);
    // 精确移除同一函数引用：传新箭头函数必定移除失败，会在 signal 上残留监听器。
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    waiter.resolve({ release: () => this.release(id) });
  }

  /** 面板/诊断快照。 */
  snapshot() {
    const now = Date.now();
    const accounts = {};
    for (const [id, n] of this.inFlight) accounts[id] = { inFlight: n, queued: (this.waiters.get(id) || []).length };
    for (const [id, rec] of this.cooldowns) {
      if (rec.until <= now) continue;
      accounts[id] = { ...(accounts[id] || { inFlight: 0, queued: 0 }), coolingMsLeft: rec.until - now, streak: rec.streak, reason: rec.reason };
    }
    return {
      maxConcurrent: this.maxConcurrent,
      cooldownMs: this.cooldownMs,
      cooldownMaxMs: this.cooldownMaxMs,
      maxQueue: this.maxQueue,
      global: this.globalCoolingReason(),
      stats: { ...this.stats },
      accounts,
    };
  }
}

/** 进程级单例（与 pool.js 的进程内计数同构）。 */
const shared = new AccountLimiter();

module.exports = {
  AccountLimiter,
  classifyThrottle,
  shared,
  CONCURRENCY_CODES,
  CONCURRENCY_NUMERIC_CODES,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_COOLDOWN_MAX_MS,
  TRANSIENT_COOLDOWN_MS,
};
