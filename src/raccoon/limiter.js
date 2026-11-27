'use strict';
/**
 * raccoon/limiter.js —— 上游**并发闸门** + 限流熔断（本渠道专属）。
 *
 * ## 2026-11-25 更正：此前「出站 IP 维度限流」的结论是**错的**
 *
 * 本文件头部曾有一整节论证「上游按出站公网 IP 计并发」，并据此把冷却做成
 * 「全局出口级 + 账号级」两级。**那个结论已被实测推翻**，保留这段历史是因为
 * 它解释了下述代码里几处看似冗余的结构，避免有人「顺手简化」又踩回去。
 *
 * 推翻它的决定性证据（同机、同 IP、同 headers、间隔 400ms 的对照）：
 *
 * ```
 * 账号 7651371  → 200
 * 账号 7651374  → 429 200108      ← 同 IP，一个通一个不通
 * ```
 *
 * 若是 IP 墙，同 IP 的第二个号不可能通。原结论的错因是**共因误判**：
 * 11-09 那次观测到「换号、换模型都 429」是真的，但当时几个号都在同一台机器
 * 用同一套请求形状高频调用 —— 真正被拦的是「这套行为」，不是 IP。
 *
 * ## 上游的三种 429（处置完全不同，判错就会加深风控）
 *
 * | 形态 | 语义 | 作用域 | 恢复窗口 | 正确动作 |
 * |---|---|---|---|---|
 * | `200108` `accountRiskControlled` | **账号被风控处置**（文案「检测到当前账号存在异常调用」） | **账号**（该账号全模型都拦） | 实测 **10800s = 3h**（`Retry-After`） | 按真值长冷 + **停手**，不换模型、不换号 |
 * | `user_model_rate_limited` | 并发/额度用尽 | 账号或出口 | 数分钟 | 长冷 + 停手 |
 * | `200103` `limiter_request_error` | 内部 limiter 排队超时（`retry after: 0s`） | 瞬时 | 秒级 | 短冷后重试 |
 *
 * **2026-11-25 事故就是 `200108` 被当成 `unknown` 处理**：只冷 300s，而上游说
 * 3 小时 ⇒ 冷却到点即撞 ⇒ 再被处置 ⇒ 越撞越深。同时 `Retry-After` 真值被
 * 本地 300s 覆盖（见 `lib/upstream-error.js`），客户端也按 5 分钟重试。
 *
 * ## 保留「出口级冷却」的理由（不是因为它叫 IP 墙）
 *
 * 现在把 `200108` 判成**账号级**事实（`scope` 默认仍是 `'both'`，但
 * `account_risk` 会显式传 `scope:'account'`，见 `dispatch.coolAccount`）。
 * 出口级冷却仍保留给「同一台机器上官方客户端也在跑」这类**共享出口**场景 ——
 * 它不是上游的判定维度，而是**本机的部署事实**：两个进程各开 3 并发，
 * 实际就是 6 并发打同一个账号/出口，本进程无法感知对方。
 *
 * ⚠️ 只做账号级冷却的后果是**放大**故障：一个号撞墙 → 换号 → 再撞一次 →
 * 再换 → …… 一次限流被放大成 N 次撞墙，而每次撞墙都可能延长恢复窗口。
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
 * ## 判据为什么读 `code` 而不是 HTTP 状态码
 *
 * 同一个 429 下藏着三种完全不同的原因（账号风控 / 并发超限 / 排队超时），
 * 而它们的处置不同：`200108` 要按 3 小时长冷且**不换号**，`200103` 的
 * `retry after: 0s` 说明是**瞬时**排队超时，短冷即可。只看状态码会把三者
 * 混成同一件事，于是要么冷太久（用户干等），要么冷太短（反复撞墙）。
 *
 * ⚠️ 判据依赖 `err.upstreamCode` / `err.body`。历史上 `upstream/errors.js` 的
 * 业务码正则只吃 3~5 位，6 位码被截断成 5 位（`200108`→`20010`），
 * 于是这里永远匹配不上。改本文件前先确认那条正则仍是 `(\d{4,9})`。
 *
 * @module src/raccoon/limiter.js
 */

/** 上游「并发超限」的两种业务码（字符串/数字都要认，上游两种都出现过）。 */
const CONCURRENCY_CODES = Object.freeze(['user_model_rate_limited', 'limiter_request_error']);
/** 数字形态：200103 = limiter_request_error。 */
const CONCURRENCY_NUMERIC_CODES = Object.freeze([200103]);

/**
 * 账号级异常调用风控（200108）。与并发超限**必须分开**：
 * 作用域是账号、恢复窗口以小时计、且换号换模型都无效。
 */
const RISK_CONTROL_NUMERIC_CODES = Object.freeze([200108]);

/**
 * 默认并发上限（每账号）。
 *
 * ## 2026-11-26 从 3 降到 1（改之前必读）
 *
 * 早期取 3 的依据是「4 并发稳定、5 并发开始挂」——那测的是**能不能通**，
 * 不是**会不会被风控**。把官方客户端的真实调用面拉出来对比才发现：
 *
 *   | 指标 | 网关（11-25 事故，纯 deepseek 期） | 官方客户端 |
 *   |---|---|---|
 *   | 请求速率 | 13.5 次/分 | 4.5 次/分 |
 *   | 未缓存 token | 193,017/分 | 15,995/分 |
 *   | **并发峰值** | **3** | **2** |
 *
 * 官方 40 分钟 182 次调用里并发峰值只有 2，而网关把每账号并发开到 3、
 * 两个号合计 6。并发本身不会直接触发 200108，但它让「同一时刻有 N 条
 * 长上下文请求在算」成为常态，实算 token 速率因此翻上去 —— 那才是风控判据。
 *
 * ## 2026-11-27 再修正：1 → 2
 *
 * 取 1 之后出现了新问题（实测 09:13-09:19，131 条请求里 **52 个 502**）：
 * 每账号只允许一条在途，客户端并行发起多个任务时，第二条起就被
 * `pickAccount` 直接排除 → `run()` 立刻抛 502，`durationMs` 只有 2~3ms，
 * **一次上游请求都没发**。用户看到的是「限速墙」，实际是网关自己扔请求。
 *
 * 真正的并发控制应由 `limiter.acquire` 的 FIFO 队列承担（满了是**等**，不是**拒**）。
 * 这一处已同步修正（见 `raccoon/dispatch.js#pickAccount` 注释）。
 *
 * 为什么最终取 2 而不是回到 3：
 *   - 官方客户端单会话并发峰值 2（40 分钟 182 次调用实测）；
 *   - 11-27 实测客户端 1 秒窗口峰值请求数 5 —— 但那是**多任务并行**，
 *     靠队列消化即可，不需要把每账号并发开到 5；
 *   - 2 与官方形态一致，且比 3 保守 33%。
 *
 * 取 1 的教训写在 `docs/02-technical/channels/raccoon-integration.md`：
 * 「并发上限」压太低会让网关自己变成故障源，而它看起来和上游限流一模一样。
 */
const DEFAULT_MAX_CONCURRENT = 2;

/**
 * 撞墙后的基础冷却（毫秒）。
 *
 * 用于 `user_model_rate_limited` 这类并发超限（实测恢复窗口 > 200s）。
 * 取 300s 作为**首次**冷却：低于实测下界就等于「冷却结束即撞墙」。
 *
 * ⚠️ **不适用于 `200108`**：那是 3 小时量级，见 {@link RISK_CONTROL_FALLBACK_MS}。
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

/**
 * `200108` 的**兜底**冷却：3 小时。
 *
 * 正常路径不用它 —— 上游每次都带 `Retry-After: 10800`，`classifyThrottle` 会
 * 把真值放进 `cooldownMs`。这个常量只在「上游忽然不发 Retry-After」时兜底。
 * 取 3 小时而不是 5 分钟：200108 是账号被处置，冷短了等于到期即撞。
 */
const RISK_CONTROL_FALLBACK_MS = 3 * 3600_000;

/** `200108` 冷却上限（6h）：防止上游发出异常大的 Retry-After 把账号永久排掉。 */
const RISK_CONTROL_MAX_MS = 6 * 3600_000;

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

  // 账号级异常调用风控（200108）。**必须早于下面的泛化 429 兜底**，
  // 否则会拿到 DEFAULT_COOLDOWN_MS（300s）—— 而上游真值是 10800s（3h）。
  // 2026-11-25 事故就是这么发生的：冷 5 分钟 → 到点即撞 → 再被处置 → 越撞越深。
  if (RISK_CONTROL_NUMERIC_CODES.includes(codeNum) || /异常调用/.test(body)) {
    return {
      limited: true,
      kind: 'account_risk',
      cooldownMs: riskControlCooldownMs(p),
    };
  }

  // 退路：文案命中「频率超限」但拿不到 code（上游改了 code 时的保底判据）。
  if (status === 429 || /请求频率超限|频率限制|rate.?limit|too many requests/i.test(body)) {
    // 上游若发了 Retry-After，即便码认不出也按它冷 —— 那是最权威的恢复时刻。
    const hinted = riskControlCooldownMs(p, 0);
    return { limited: true, kind: 'unknown', cooldownMs: hinted || DEFAULT_COOLDOWN_MS };
  }
  return { limited: false, kind: 'unknown', cooldownMs: 0 };
}

/**
 * `200108` 的冷却时长：**上游 `Retry-After` 优先**，兜底 3 小时。
 *
 * 上游实测每次都发 `Retry-After: 10800`。此前完全不读这个头，一律用本地
 * 300s —— 于是「上游说 3 小时、网关冷 5 分钟」，到点即撞。
 *
 * 上限 6h 防异常值把账号永久排掉；下限 60s 防 `0` 把冷却写没。
 * `fallbackMs` 传 0 表示「没有真值就返回 0」（供 unknown 分支判断用）。
 *
 * @param {{retryAfterMs?:number, headers?:object}} p
 * @param {number} [fallbackMs]
 * @returns {number}
 */
function riskControlCooldownMs(p = {}, fallbackMs = RISK_CONTROL_FALLBACK_MS) {
  const raw = Number(p.retryAfterMs);
  const base = Number.isFinite(raw) && raw > 0 ? raw : fallbackMs;
  if (!(base > 0)) return 0;
  return Math.min(Math.max(base, 60_000), RISK_CONTROL_MAX_MS);
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
   * 「是否有一个号正处于**风控**处置」及其剩余时长；没有返回 null。
   *
   * 为什么要单独一个查询而不是复用 {@link coolingReason}：面板与错误文案
   * 必须能区分「风控 3 小时（换模型无效，只能等/换号/申诉）」与
   * 「并发 5 分钟（降并发即可）」—— 两者的用户动作完全不同，
   * 用同一句「账号在冷却」等于什么都不说。
   *
   * @param {number} [now]
   * @returns {{accountId:string, reason:string, until:number, msLeft:number}|null}
   */
  riskCoolingReason(now = Date.now()) {
    let best = null;
    for (const [id, rec] of this.cooldowns) {
      if (!rec || rec.reason !== 'account_risk' || rec.until <= now) continue;
      const msLeft = rec.until - now;
      if (!best || msLeft > best.msLeft) {
        best = { accountId: id, reason: rec.reason, until: rec.until, msLeft };
      }
    }
    return best;
  }

  /**
   * 记录一次撞墙。
   *
   * `scope` 默认 `'both'`（出口级 + 账号级），但 `account_risk`（200108）
   * 会由调用方显式传 `scope:'account'` —— 因为实测它是**账号级**事实
   * （同机同 IP 的另一个号完全正常），而且它自带 3 小时的解禁时刻，
   * 再叠出口级冷却只会把健康的号也一起冻住。
   *
   * ## `account_risk` 不参与指数退避（2026-11-25 修）
   *
   * 退避的语义是「反复撞同一堵墙就等更久」，前提是**冷却时长由本地估算**。
   * 而 `account_risk` 的时长是上游**明确给出**的（`Retry-After`），没有估算
   * 余地：拿它去乘 2、或按 `cooldownMaxMs`（30 分钟）封顶，都会得到一个
   * 与上游事实矛盾的数 —— 后者尤其致命：3 小时会被砍成 30 分钟，于是
   * 「上游说 3h、网关冷 30min」，到点即撞。
   *
   * 故 `account_risk` 走独立分支：**原样使用传入的 cooldownMs**，
   * 只按 {@link RISK_CONTROL_MAX_MS}（6h）封顶防异常值。
   *
   * @param {string} accountId
   * @param {{kind?:string, cooldownMs?:number, scope?:'global'|'account'|'both'}} [info]
   *   `scope` 默认 `'both'`；`account_risk` 应传 `'account'`。
   * @returns {{until:number, streak:number, cooldownMs:number, scope:string}}
   */
  throttle(accountId, info = {}) {
    const id = String(accountId);
    const scope = info.scope === 'account' || info.scope === 'global' ? info.scope : 'both';
    const riskControlled = info.kind === 'account_risk';

    const base = Number.isFinite(info.cooldownMs) && info.cooldownMs > 0 ? info.cooldownMs : this.cooldownMs;
    let streak = 1;
    let until = 0;

    /**
     * 单次冷却时长。`account_risk` 原样（只封顶 6h），其余走指数退避 + 30min 封顶。
     * @param {number} s 本次 streak
     */
    const waitFor = (s) => (riskControlled
      ? Math.min(base, RISK_CONTROL_MAX_MS)
      : Math.min(base * Math.pow(2, s - 1), this.cooldownMaxMs));

    if (scope === 'global' || scope === 'both') {
      const gPrev = this.globalCooldown;
      const gStreak = Math.min((gPrev ? gPrev.streak : 0) + 1, 16);
      // 首次用实测下界，之后翻倍（300s→600s→1200s…），封顶 cooldownMaxMs
      const gWait = waitFor(gStreak);
      until = Date.now() + gWait;
      this.globalCooldown = { until, streak: gStreak, reason: info.kind || 'concurrency' };
      streak = gStreak;
      this.stats.globalLocked += 1;
    }

    if (scope === 'account' || scope === 'both') {
      const prev = this.cooldowns.get(id);
      const aStreak = Math.min((prev ? prev.streak : 0) + 1, 16);
      // 账号级用同一个「已翻倍过」的等待时长，避免两套退避互相打架
      const aWait = waitFor(aStreak);
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
          // 文案不再说「上游按出站 IP 计并发」—— 那是已被推翻的结论（见文件头）。
          // 出口级冷却现在表达的是**本机部署事实**：同机还有别的进程（官方客户端）
          // 在共享同一个账号/出口，本进程无法感知对方，故整条链路一起退避。
          + '本机可能有其他进程（官方客户端）在共用同一账号，请等冷却结束再试。',
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
    const risk = this.riskCoolingReason(now);
    return {
      maxConcurrent: this.maxConcurrent,
      cooldownMs: this.cooldownMs,
      cooldownMaxMs: this.cooldownMaxMs,
      maxQueue: this.maxQueue,
      global: this.globalCoolingReason(),
      // 风控状态单独一列：面板/脚本要能区分「风控 3 小时（只能等/换号/申诉）」
      // 与「并发 5 分钟（降并发即可）」—— 用同一句「在冷却」等于什么都不说。
      riskControl: risk ? { accountId: risk.accountId, msLeft: risk.msLeft, until: risk.until } : null,
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
  riskControlCooldownMs,
  shared,
  CONCURRENCY_CODES,
  CONCURRENCY_NUMERIC_CODES,
  RISK_CONTROL_NUMERIC_CODES,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_COOLDOWN_MAX_MS,
  TRANSIENT_COOLDOWN_MS,
  RISK_CONTROL_FALLBACK_MS,
  RISK_CONTROL_MAX_MS,
};
