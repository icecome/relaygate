'use strict';
/**
 * raccoon/dispatch.js —— Raccoon 对话面的**账号池分派**（统一 /v1/chat/completions 用）。
 *
 * ## 与 routes/raccoon.js 的关系（两条入口，一套语义）
 *
 * | 入口 | 语义 | 谁在用 |
 * |---|---|---|
 * | `POST /v1/raccoon/chat/completions` | 显式渠道端点，只服务 `sn-*` 模型 | 想固定走小浣熊的调用方 |
 * | `POST /v1/chat/completions`（`sn-*` 模型） | 统一端点按模型名分派到这里 | DSH / Claude Code 等只配一个 baseURL 的客户端 |
 *
 * 两条入口共用本模块，所以「并发闸门 + 冷却 + 换号 + 流式透传」只有一份实现。
 * 此前统一端点对 `sn-*` 直接 403（提示「请用 Raccoon 端点」），那是刻意的边界，
 * 但它把「换一个 baseURL」这件事强加给了用户 —— 一个客户端配两个 baseURL
 * 基本不可行，故本期改为分派。
 *
 * ## 为什么必须经过 limiter（而不是直接发）
 *
 * 实测（见 `limiter.js` 头部表格）：上游按**账号瞬时并发**判定，4 并发稳、5 并发挂，
 * 且撞墙后整号 5 分钟起不可用（换模型也拦）。所以每一次上游调用都必须先拿令牌，
 * 撞墙后写冷却，而不是「撞了再重试」。重试在这条链路上是负收益：
 * 上游秒回 429（实测 150-270ms），重试等于在墙上多撞一次。
 *
 * ## 换号语义（与 pool.run 的差异）
 *
 * `credentials/pool.js` 的 `run()` 是给 Trae/WorkBuddy 用的，它的冷却写进 `accounts`
 * 表（跨请求可见）。Raccoon 这里**双层**：
 * - 进程内 `limiter`：并发槽位 + 冷却快速判定（零 IO，在热路径上）；
 * - 账号库 `coolUntil`：跨进程/跨重启可见的冷却事实（面板能显示、重启不丢）。
 * 两者都写，因为只写内存会让重启后的第一波请求又去撞墙。
 *
 * @module src/raccoon/dispatch.js
 */

const store = require('../credentials/store');
const variant = require('../platform/variant');
const product = require('./product');
const inputBudget = require('./input-budget');
const chat = require('./chat');
const auth = require('./auth');
const { shared: limiter, classifyThrottle } = require('./limiter');

const V = variant.variantOf(variant.RACCOON);

/**
 * 最多尝试几个账号（换号次数）。
 *
 * ## 2026-11-25：3 → 2，且只在 `auth` 分支真的换号
 *
 * 原值 3 的前提是「换号能绕开限流」，而那个前提已被推翻：`200108` 是**账号级
 * 风控**，撞墙后换号只会换个号撞同一堵墙，并把「异常调用」特征做实。
 * 现在 `throttled` / `account_risk` 分支都**立刻上抛**（不 continue），
 * 唯一还会走到下一轮的是 `auth`（登录态失效，另一个号确实可能健康）。
 *
 * 保留 2 而不是降到 1：池里通常有 2 个号，其中一个 token 被上游单方面作废时
 * （实测会发生，且本地 JWT 的 exp 看不出来），必须允许试第二个。
 * 每多一轮就是一次真实的上游调用，没有证据支持的轮次一律不留。
 */
const MAX_ACCOUNT_SWITCHES = 2;

/**
 * 该模型是否属于 Raccoon 对话面。
 *
 * 判据与 `middleware/model-access.js#isRaccoonOnlyModel` **必须同源**（都是 `sn-` 前缀）：
 * 两处判据漂移的后果是「ACL 放行但分派不认」→ 请求落到 Trae 上游拿 4001，
 * 或者反过来「分派认但 ACL 拒」→ 403 而模型明明可用。这里直接复用那个函数，
 * 不重写一个正则。
 */
function isRaccoonModel(model) {
  // 延迟 require：model-access 会 require 本模块（经 routes），顶部 require 会成环。
  const { isRaccoonOnlyModel } = require('../middleware/model-access');
  return isRaccoonOnlyModel(model);
}

/** 可调度的 Raccoon 账号（启用 + 本平台）。 */
function candidates() {
  return store.list()
    .filter((a) => a.enabled && variant.isEdition(a.edition, variant.RACCOON));
}

/**
 * 返回一个可用账号（含明文 token：store.list 已剥 token）。
 *
 * 排序口径是**最近用过的优先**（见函数体注释：这与 Trae 的「最久未选优先」
 * 相反，因为 Raccoon 上游有 prompt cache）。
 *
 * 为什么不直接用 pool.pick：pool 的 editionOk 默认分支刻意**只取 Trae 系**
 * （Raccoon 不进 Trae 转发池，这是既有红线）。Raccoon 有自己的池，且它的准入
 * 条件不是「余额/FEFO」而是「没在冷却 + 并发没满」，所以这里单独实现。
 *
 * @param {{exclude?:Set<string>|string[], stickyAccountId?:string|null}} [opts]
 * @returns {object|null} 完整账号记录
 */
function pickAccount(opts = {}) {
  const exclude = new Set(opts.exclude ? Array.from(opts.exclude) : []);

  // 出口级冷却期间**一个号都不给**：换谁都会撞同一堵墙（实测跨账号/跨模型同时 429）。
  // 在这里挡而不是只靠 limiter.acquire 挡，是为了让「无号可用」的报错文案能说清
  // 真正原因（出口限流），而不是笼统地说「账号都在冷却」。
  limiter.pruneGlobal();
  if (limiter.globalCoolingFor() > 0) return null;

  const all = candidates().filter((a) => !exclude.has(a.id));
  if (!all.length) return null;

  // 粘性优先：同一会话尽量复用同一账号，避免上下文与缓存失效。
  // ⚠️ 但仍要过 `blockedFor`（出口级 + 账号级冷却）：粘性是「偏好」，不是
  // 「豁免」。不给它判冷却的话，粘性会话会在冷却期间持续撞墙。
  if (opts.stickyAccountId && !exclude.has(opts.stickyAccountId)) {
    const bound = all.find((a) => a.id === opts.stickyAccountId);
    if (bound && limiter.blockedFor(bound.id) === 0
      && limiter.inFlightOf(bound.id) < limiter.maxConcurrent) {
      return store.get(bound.id);
    }
  }

  // 排除：正在冷却 / 并发已满 / 库里 coolUntil 未到 / 已吃满小时预算
  const now = Date.now();
  const usable = all.filter((a) => {
    if (limiter.blockedFor(a.id, now) > 0) return false;
    if (a.coolUntil && new Date(a.coolUntil).getTime() > now) return false;
    if (limiter.inFlightOf(a.id) >= limiter.maxConcurrent) return false;
    // 每小时未缓存 token 预算（2026-11-26 新增）。
    //
    // 依据：11-26 下午 56.5 分钟跑掉 5,227,605 未缓存 token 后被 200108 风控。
    // 上游判据是**实算 token 累计量**，而单次请求的守门（input-budget#checkInputSize）
    // 只挡「一个大请求」，挡不住「一堆中等请求在半小时里累计超标」。
    //
    // 预算只计 `prompt - cacheRead`：缓存命中不消耗算力，也不推动风控。
    if (inputBudget.checkHourlyBudget(a.id, now).exhausted) return false;
    return true;
  });
  if (!usable.length) return null;

  // 选号排序：**优先复用最近用过的号**，而不是「最久未选优先」。
  //
  // ## 为什么这里与 Trae 的口径相反（改之前必读）
  //
  // 「最久未选优先」对**无状态**的上游是对的：Trae 的轮换目标是分摊额度，
  // 谁久没用就用谁，天然均匀。
  //
  // 但 Raccoon 的上游有 **prompt cache**，而缓存是「账号 × 模型」维度的。
  // 同一段对话如果每轮都换号，上下文就被劈成两半分别缓存在两个账号上：
  // 每次请求都只能用一半缓存，另一半全额重算。2026-11-25 实测（两个账号、
  // 单一模型 sn-deepseek-v4-1-flash-1017）：
  //
  //   | 相邻请求是否同号 | 缓存命中 | 平均未缓存 token |
  //   |---|---|---|
  //   | 同号 | 90.3% |  8,356 |
  //   | 换号 | 79.3% | 15,856 |   ← 单次最高 107,415
  //
  // 而「异常调用」风控看的正是实算 token 量。换号越频繁，实算量越高，
  // 越容易撞 200108 —— 也就是说旧的排序策略在**主动加速**风控触发。
  //
  // 现在的口径：按 lastPickedAt **降序**（最近用过的排前面）。
  // 粘性（stickyAccountId）是更强的偏好，已在上方单独处理；这里是
  // 「没有粘性时」的兜底，效果是「会话之间也倾向复用同一个号」。
  // 均匀分摊额度的诉求由 limiter 的并发闸门与冷却机制保证，不靠换号实现。
  usable.sort((x, y) => (y.lastPickedAt || 0) - (x.lastPickedAt || 0));
  return store.get(usable[0].id);
}

/**
 * 把账号级冷却同时写进内存闸门（默认还会开出口级冷却）。
 *
 * `account_risk`（200108 风控）例外：它传 `scope:'account'`，只冻这个号。
 * 理由是实测证据 —— 同机同 IP 的另一个号在被处置期间**完全正常**，
 * 连带冻出口会把健康的号一起排掉，等于自己制造一次假故障。
 */
function coolAccount(accountId, info) {
  const r = limiter.throttle(accountId, info);
  // 账号库只记账号维度的冷却。出口级冷却不落库：它是「此刻这台机器上还有
  // 别的进程在共用同一账号/出口」，重启即失效，落库反而会让重启后误判成还在冷却。
  const left = Math.max(0, r.until - Date.now());
  store.update(accountId, {
    coolUntil: new Date(Date.now() + left).toISOString(),
    rateStreak: r.streak,
  });
  return r;
}

/** 账号成功一次：清内存冷却（库里 coolUntil 由 pool.record('ok') 的等价动作清掉）。 */
function markAccountOk(accountId) {
  limiter.cleared(accountId);
  try {
    store.update(accountId, { coolUntil: null, rateStreak: 0, errorCount: 0 });
  } catch { /* 清理失败不影响主流程 */ }
}

/**
 * 判断一次上游失败是否属于「该换号」的类别。
 *
 * - 限流（429/concurrency）：换号**有效**（另一个账号有不同的并发额度）；
 * - 鉴权失败（401/200003）：**也换号**。见下方注释 —— 这是实测出来的结论；
 * - 其余（400 请求错、5xx）：换号无效，直接上抛。
 *
 * ## 为什么 401 也换号（2026-11-09 实测教训）
 *
 * 原本这里把 auth 排除在换号之外，理由是「token 是账号自己的问题，换号没用」。
 * 但实测发现上游会**单方面**让一个 token 失效（回 `200003 authorization_verify_error`），
 * 而本地 JWT 的 `exp` 仍然显示「还有 8 天」—— 本地判据完全看不出来。
 * 此时 refresh 也可能已经一起失效（实测一个号 rescues 成功、另一个号 refresh
 * 同样回 200003）。
 *
 * 结论：一个账号的登录态被上游作废是**单账号**事实，池里其他号照样能用。
 * 这时把它判成「不可换号」会让整池看起来全挂 —— 而实际上只挂了一个。
 * 正确动作是：换号 + 把该号标成需要重新登录，而不是让本次请求失败。
 */
/**
 * 本次失败属于哪一类（决定「换号 / 冷却 / 上抛」）。
 *
 * 四类处置，互不重叠：
 *   - `throttled`：并发/额度限流 → 冷却 + **立刻上抛**（不换号，见下方注释）
 *   - `account_risk`：账号被风控处置（200108）→ 长冷该账号 + **立刻上抛**
 *   - `auth`：登录态失效 → 换号（另一个号可能健康）
 *   - `other`：其余（含 400 参数错、模型名过期）→ 上抛，**不重试**
 *
/**
 * 把不同形态的 usage 归一成 `{promptTokens, cacheReadTokens}`。
 *
 * 为什么必须归一：小时预算的记账点在 `run()` 里，而 `runOnce` 的返回值有两种形状 ——
 *   - 流式（`stream.js#pipeToClient`）：`{streamed:true, usage:{promptTokens, cacheReadTokens}}`
 *   - 非流式（`chat.js#chatNonStream`）：`{streamed:false, data:{usage:{prompt_tokens, prompt_tokens_details:{cached_tokens}}}}`
 *
 * 不归一的话，非流式请求会被记成 0，预算就是摆设。
 */
function normalizeUsageForBudget(result) {
  if (!result || typeof result !== 'object') return { promptTokens: 0, cacheReadTokens: 0 };
  const u = (result.usage && typeof result.usage === 'object')
    ? result.usage
    : (result.data && result.data.usage && typeof result.data.usage === 'object' ? result.data.usage : null);
  if (!u) return { promptTokens: 0, cacheReadTokens: 0 };
  const prompt = Number(u.promptTokens != null ? u.promptTokens : u.prompt_tokens) || 0;
  const cache = Number(
    u.cacheReadTokens != null
      ? u.cacheReadTokens
      : (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
  ) || 0;
  return { promptTokens: prompt, cacheReadTokens: cache };
}

/**
 * 把一次上游失败分类成「该换号」还是「直接上抛」。
 *
 * ## 2026-11-25：`account_risk` 必须独立于 `throttled`
 *
 * `classifyThrottle` 现在把 200108 归成 `kind:'account_risk'`，而本函数此前
 * 只判 `t.limited` 就一律返回 `'throttled'` —— 那会把「账号被处置 3 小时」
 * 和「并发超了 5 分钟」混成一件事。虽然两者的即时动作（冷却 + 上抛）恰好
 * 相同，但**冷却作用域不同**：风控是账号级事实，不该连带把出口级也冻住，
 * 否则同机另一个健康账号会被无辜拖下水。
 */
function failureKind(err) {
  if (!err) return 'other';
  // 超时是**本请求自己的时间用完了**，不是账号或上游的错：
  // 换号重试等于把已经跑满一轮的成本再付一次，而结果大概率还是超时。
  // 必须判在一切分类之前 —— 否则它会落到 'other'，而 'other' 曾是可切换的。
  if (err.timedOut) return 'timeout';
  const t = classifyThrottle({ status: err.status, body: err.body, message: err.message });
  if (t.limited) return t.kind === 'account_risk' ? 'account_risk' : 'throttled';
  if (err.status === 401 || err.status === 403) return 'auth';
  if (err.status === 429) return 'throttled';
  // 上游用 HTTP 200 + 业务码表达失败时，错误体里仍有 200003
  if (/200003|authorization_verify_error|authorization verify failed/i.test(String(err.body || err.message || ''))) {
    return 'auth';
  }
  return 'other';
}

/**
 * 统一入口：取号 → 拿并发令牌 → 调上游 → 撞墙冷却/换号。
 *
 * `runOnce` 由调用方给（流式与非流式的差别只在它里面），本函数只管调度语义。
 *
 * @param {(acct:object)=>Promise<any>} runOnce
 * @param {{stickyAccountId?:string|null, model?:string, signal?:AbortSignal, onAccount?:(id:string)=>void, queueTimeoutMs?:number}} [opts]
 * @returns {Promise<{result:any, accountId:string}>}
 */
async function run(runOnce, opts = {}) {
  const tried = new Set();
  let lastErr = null;

  for (let attempt = 0; attempt < MAX_ACCOUNT_SWITCHES; attempt += 1) {
    const acct = pickAccount({ exclude: tried, stickyAccountId: opts.stickyAccountId });
    if (!acct) {
      if (lastErr) throw lastErr;
      // ⚠️ 两种「没号可用」必须分开表达，否则用户会去做错的事：
      //
      //   a) 库里**一个** Raccoon 账号都没有 → 503 + 指引去扫码。
      //      这是**永久性**的（在用户动手之前不会自己好），给 429「稍后重试」
      //      会让他一直等一个永远不会来的恢复。
      //   b) 有账号但全在冷却/并发满 → 429 + Retry-After。
      //      这是**暂时性**的，重试就会好。
      //
      // 把两者混成一个码，等于让「没登录的人去重试」和「在冷却的人去重登录」，
      // 两种建议都是错的。
      if (!candidates().length) {
        const e = new Error(
          '没有可用的 Raccoon 账号。请在「凭据池 → 渠道接入 → Raccoon」用微信扫码登录，'
          + '或从本机已登录的小浣熊桌面客户端导入凭据。',
        );
        e.code = 'NO_RACCOON_ACCOUNT';
        e.status = 503;
        // 网关自产的可行动指引，不是上游报文：统一错误出口据此保留原文。
        e.gatewayError = true;
        throw e;
      }
      // c) 出口整体在冷却 → 429 + Retry-After，且文案必须点明「换号没用」，
      //    否则用户会去反复切换账号（那是无效动作，还会延长恢复窗口）。
      const gLeft = limiter.globalCoolingFor();
      if (gLeft > 0) {
        const g = limiter.globalCoolingReason() || {};
        const e = new Error(
          `Raccoon 出口整体处于限流冷却（剩余 ${Math.ceil(gLeft / 1000)}s，第 ${g.streak || 1} 次退避）。`
          // 不再说「上游按出站 IP 计并发」（已推翻，见 limiter.js 文件头）。
          + '本机可能有其他进程（官方客户端）在共用同一账号/出口 —— '
          + '请按 Retry-After 退避，不要反复重试（每次撞墙都会延长恢复窗口）。',
        );
        e.code = 'RACCOON_GLOBAL_COOLING';
        e.status = 429;
        e.retryAfterMs = gLeft;
        e.gatewayError = true;
        throw e;
      }
      // d) 账号全在冷却。区分两种量级，文案给出不同的等待建议 ——
      //    「风控 3 小时」与「并发 5 分钟」让用户做的事完全不同
      //    （前者只能等或换号/申诉，后者降并发即可）。
      const risk = limiter.riskCoolingReason();
      const e = new Error(
        risk
          ? `Raccoon 账号处于上游风控处置（剩余约 ${Math.ceil((risk.msLeft || 0) / 60000)} 分钟）。`
            + '这是账号级「异常调用」判定，换模型无效；请等解禁，或换一个未被处置的账号，'
            + '如认为是误判可在官方客户端「问题反馈」申诉。'
          : 'Raccoon 账号全部在冷却或并发已满。上游按账号瞬时并发判定'
            + '（实测 4 并发稳定、5 并发触发），请稍后重试或降低并发。',
      );
      e.code = risk ? 'RACCOON_ACCOUNT_RISK_CONTROLLED' : 'RACCOON_NO_ACCOUNT';
      e.status = 429;
      e.retryAfterMs = risk ? risk.msLeft : undefined;
      e.gatewayError = true;
      throw e;
    }
    tried.add(acct.id);
    if (typeof opts.onAccount === 'function') opts.onAccount(acct.id);

    // 凭据过期先续期（不在上游请求里做，避免「续期 + 重发」双倍撞墙）
    let use = acct;
    try {
      const cred = {
        access_token: acct.token,
        refresh_token: acct.refreshToken,
        expires_at: acct.expiredAt ? String(new Date(acct.expiredAt).getTime()) : undefined,
      };
      if (product.isExpired(cred)) {
        use = await auth.refreshAccount(acct);
      }
    } catch (e) {
      lastErr = e;
      // 续期失败属账号问题：换下一个号
      continue;
    }

    let ticket;
    try {
      ticket = await limiter.acquire(use.id, { signal: opts.signal, timeoutMs: opts.queueTimeoutMs });
    } catch (e) {
      lastErr = e;
      // 冷却/队列满：换号（别的号可能有空位）
      continue;
    }

    store.update(use.id, { lastPickedAt: Date.now() });
    try {
      const result = await runOnce(use, { signal: opts.signal });
      markAccountOk(use.id);
      // 记一次实算 token（prompt - cacheRead）到该账号的小时预算。
      try {
        inputBudget.recordUsage(use.id, normalizeUsageForBudget(result));
      } catch { /* 记账失败不影响本轮结果 */ }
      return { result, accountId: use.id };
    } catch (err) {
      lastErr = err;
      // 客户端主动取消不是账号问题：不冷却、不换号，直接上抛（换号只会多烧一次）
      if (err && err.aborted) throw err;
      const kind = failureKind(err);
      // 超时同样**不冷却、不换号**：账号是好的、上游也是好的，只是这轮太长。
      // 换号重试的期望收益是 0（大概率再超时），成本是整轮 token 再付一次。
      if (kind === 'timeout') throw err;
      if (kind === 'throttled' || kind === 'account_risk') {
        const t = classifyThrottle({
          status: err.status, body: err.body, message: err.message, retryAfterMs: err.retryAfterMs,
        });
        // 风控（200108）是**账号级**事实：只冻这个号，不连带出口。
        // 并发限流仍走 'both'（同机可能有别的进程在共用出口）。
        const scope = kind === 'account_risk' ? 'account' : 'both';
        const cooled = coolAccount(use.id, { kind: t.kind, cooldownMs: t.cooldownMs, scope });
        err.raccoonCooldown = cooled;

        // ⚠️ **撞墙后立刻停手，不换号**（2026-11-09 实测修正，2026-11-25 复核仍成立）。
        //
        // 原实现是 `continue` 换下一个号再来一次。实测证明那是错的：
        // 「换号重试」的效果是：一次撞墙 → 换号 → 再撞一次 → 再换 →
        // 第三次撞墙。3 次撞墙而非 1 次，而每次撞墙都可能把恢复窗口推长。
        //
        // 对 `account_risk` 尤其致命：200108 的判定依据就是「异常调用」，
        // 撞墙后继续换号重试本身就是在制造它要找的特征。
        //
        // 正确动作：把冷却开上（已在 coolAccount 里做），然后**立刻**
        // 把错误抛给客户端并带上 Retry-After，让它按标准语义退避。
        throw err;
      }
      if (kind === 'auth') {
        // 登录态被上游作废。两条路，**都不允许重新选中这个号**：
        //
        // ⚠️ 这里曾经 `tried.delete(use.id)` —— 那是错的。refreshAccount 成功后
        // 把它放回候选池，下一轮 pickAccount 很可能又选中它（它 lastPickedAt
        // 刚更新，排序上反而可能被选），于是 MAX_ACCOUNT_SWITCHES 全耗在同一个
        // 号上，另一个健康账号一次都没试。实测就是这个表现：3 次尝试全打
        // acct_mvdyj...，而 acct_mve0g... 的 token 明明是好的。
        //
        // 正确语义：**本次请求内不再试这个号**。续期与否只影响它下次请求的可用性，
        // 不影响本次应该「换个能用的号把请求做完」。
        try {
          await auth.refreshAccount(use);
          // 续期成功：该号下次请求可用；本次仍换号（不重放，避免双倍计费）
          store.update(use.id, { lastCheckinResult: 'refreshed' });
        } catch {
          // 续期也失败：标成需要重新登录。**不设 coolUntil** —— 冷却会过期，
          // 登录态不会自己好，让它在候选里持续显形（面板能提示去扫码）。
          try {
            store.update(use.id, { lastCheckinResult: 'login_expired' });
          } catch { /* 标记失败不影响换号 */ }
        }
        lastErr = err;
        continue;
      }
      throw err;
    } finally {
      ticket.release();
    }
  }

  if (lastErr) throw lastErr;
  const e = new Error('Raccoon 全部候选账号均不可用');
  e.code = 'RACCOON_NO_ACCOUNT';
  e.status = 429;
  throw e;
}

/**
 * 非流式对话（聚合后返回 JSON）。
 *
 * @param {object} acct
 * @param {object} body
 * @param {{signal?:AbortSignal}} [opts]
 * @returns {Promise<any>}
 */
async function chatNonStream(acct, body, opts = {}) {
  return chat.chatNonStream(acct, body, opts);
}

/**
 * 流式对话：返回**原始上游响应**，由调用方读流。
 *
 * 注意这里**不能**用 `chatNonStream`：它会 `await resp.text()` 缓冲全文，
 * 流式语义会被破坏（首字节延迟变成整轮耗时）。
 */
async function chatStream(acct, body, opts = {}) {
  return chat.chatStream(acct, body, opts);
}

module.exports = {
  isRaccoonModel,
  candidates,
  pickAccount,
  coolAccount,
  markAccountOk,
  failureKind,
  run,
  chatNonStream,
  chatStream,
  limiter,
  MAX_ACCOUNT_SWITCHES,
  V,
  normalizeUsageForBudget,
};
