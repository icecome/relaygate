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
const chat = require('./chat');
const auth = require('./auth');
const { shared: limiter, classifyThrottle } = require('./limiter');

const V = variant.variantOf(variant.RACCOON);

/** 最多尝试几个账号（换号次数）。小浣熊是独立小池，3 个足够覆盖「主号在冷却」。 */
const MAX_ACCOUNT_SWITCHES = 3;

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
 * 按「最久没被选」排序，返回第一个可用账号（含明文 token：store.list 已剥 token）。
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

  // 排除：正在冷却 / 并发已满 / 库里 coolUntil 未到
  const now = Date.now();
  const usable = all.filter((a) => {
    if (limiter.blockedFor(a.id, now) > 0) return false;
    if (a.coolUntil && new Date(a.coolUntil).getTime() > now) return false;
    if (limiter.inFlightOf(a.id) >= limiter.maxConcurrent) return false;
    return true;
  });
  if (!usable.length) return null;

  // 最久未选优先（与 routes/raccoon.js#pickAccount 同口径）
  usable.sort((x, y) => (x.lastPickedAt || 0) - (y.lastPickedAt || 0));
  return store.get(usable[0].id);
}

/** 把账号级冷却同时写进内存闸门（它内部还会开出口级冷却）。 */
function coolAccount(accountId, info) {
  const r = limiter.throttle(accountId, info);
  // 账号库只记账号维度的冷却。出口级冷却不落库：它是「此刻这台机器的出口
  // 被上游限流」，重启/换 IP 就失效，落库反而会让重启后误判成还在冷却。
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
 * 结论：一个账号的登录态被上游作废是**单账号**事实，池里其它号照样能用。
 * 这时把它判成「不可换号」会让整池看起来全挂 —— 而实际上只挂了一个。
 * 正确动作是：换号 + 把该号标成需要重新登录，而不是让本次请求失败。
 */
function failureKind(err) {
  if (!err) return 'other';
  const t = classifyThrottle({ status: err.status, body: err.body, message: err.message });
  if (t.limited) return 'throttled';
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
          + '上游按出站 IP 计并发，实测换账号、换模型都绕不过去 —— '
          + '请按 Retry-After 退避，不要反复重试（每次撞墙都会延长恢复窗口）。',
        );
        e.code = 'RACCOON_GLOBAL_COOLING';
        e.status = 429;
        e.retryAfterMs = gLeft;
        e.gatewayError = true;
        throw e;
      }
      const e = new Error(
        'Raccoon 账号全部在冷却或并发已满。上游按账号瞬时并发判定'
        + '（实测 4 并发即触发限流，撞墙后 5 分钟起才恢复），请稍后重试或降低并发。',
      );
      e.code = 'RACCOON_NO_ACCOUNT';
      e.status = 429;
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
      return { result, accountId: use.id };
    } catch (err) {
      lastErr = err;
      // 客户端主动取消不是账号问题：不冷却、不换号，直接上抛（换号只会多烧一次）
      if (err && err.aborted) throw err;
      const kind = failureKind(err);
      if (kind === 'throttled') {
        const t = classifyThrottle({ status: err.status, body: err.body, message: err.message });
        const cooled = coolAccount(use.id, { kind: t.kind, cooldownMs: t.cooldownMs });
        err.raccoonCooldown = cooled;

        // ⚠️ **撞墙后立刻停手，不换号**（2026-11-09 实测修正）。
        //
        // 原实现是 `continue` 换下一个号再来一次。实测证明那是错的：
        // 一个号撞 429 之后，**另外两个账号 + 本机客户端**同时全部 429，
        // 换模型也照样 429 —— 墙在出口 IP 上，不在账号上。
        //
        // 于是「换号重试」的效果是：一次撞墙 → 换号 → 再撞一次 → 再换 →
        // 第三次撞墙。3 次撞墙而非 1 次，而每次撞墙都可能把恢复窗口推长。
        // 这正是「同一个账号在官方客户端好用、经插件却很频繁被限流」的一部分机理。
        //
        // 正确动作：把出口级冷却开上（已在 coolAccount 里做），然后**立刻**
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
};
