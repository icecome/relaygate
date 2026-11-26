'use strict';
/**
 * raccoon/input-budget.js —— Raccoon 请求的**单次输入预算**守门。
 *
 * ## 为什么需要它（2026-11-26 实测）
 *
 * 修完账号粘性之后，网关的存活时间从 4 分钟提升到 4 小时 47 分钟，缓存命中
 * 也从 82.2% 提升到 88.6%。但下午仍然在 16:02 撞了一次 3 小时风控。
 *
 * 把重启后的 100 次请求拉出来看，问题换了一副面孔：
 *
 *   | 指标 | 网关（11-26 下午） | 官方客户端 |
 *   |---|---|---|
 *   | prompt 中位数 | **513,950** | 133,591 |
 *   | prompt 最大 | **563,082** | 228,418 |
 *   | >400K 的请求 | **78 / 100** | 0 |
 *   | 单次未缓存均值 | 52,276 | 3,572 |
 *
 * 也就是说：请求数降下来了、缓存命中上去了，但**每一个请求都在 20-56 万 token**。
 * 官方客户端的量级是 13 万，网关是它的 4 倍。
 *
 * ## 为什么没有更早挡住
 *
 * `model-router` 的窗口守门（`checkContextLimit`）只作用于**虚拟模型**路径。
 * 而直连 `sn-*` 模型名的请求走的是 `routes/openai.js` 的 `isRaccoonModel()`
 * 早返回分支，**完全不经过**那套守门 —— 于是 56 万 token 的请求被原样发给上游。
 *
 * ## 阈值怎么来的
 *
 * Raccoon 目录里 `sn-deepseek-v4-1-flash-1017` 声明 `contextWindow: 1000000`，
 * 但那是**理论上限**，不是「经济上限」。上游的风控判据是**实算 token 累计量**，
 * 请求越大、越容易在短时间内堆出大量实算 token。
 *
 * 取「官方客户端实测最大值的 1.5 倍」= 345,600 作为默认软上限：
 *   - 官方实测最大 228,418（40 分钟 182 次调用里最高的一次）；
 *   - 留 1.5 倍余量，正常的长上下文任务不会被误拦；
 *   - 超过它的请求，本身就是「异常调用」画像的一部分。
 *
 * 超限时**拒绝而不是截断**：静默截掉头部会让模型丢失 system 与早期上下文，
 * 产出看似合理实则错乱的回答 —— 那比 400 更难排查。
 *
 * @module src/raccoon/input-budget
 */

const { estimateRequestTokens } = require('../lib/token-estimate');

/**
 * 单次请求输入 token 的默认软上限。
 *
 * 依据见文件头：官方客户端实测最大 228,418 × 1.5 ≈ 345,600。
 * 可用 `RACCOON_MAX_INPUT_TOKENS` 覆盖；设为 0 或负数表示关闭守门。
 */
const DEFAULT_MAX_INPUT_TOKENS = 345_600;

/**
 * 每账号每小时未缓存（实算）token 的默认预算。
 *
 * 依据：11-26 下午 56.5 分钟跑掉 5,227,605 未缓存 token 后被风控。
 * 官方客户端同一量级是 650,175 / 40 分钟 ≈ 975,000/小时。
 * 取 3,000,000/小时作为「明显高于正常、但低于本次触发量」的软预算
 * （本次是 5.2M / 56 分钟 ≈ 5.5M/小时）。
 *
 * 预算只管「实算」部分：`prompt - cacheRead`。缓存命中不消耗算力，
 * 也就不会推动风控 —— 把总量算进预算会让长对话被误杀。
 *
 * 可用 `RACCOON_HOURLY_UNCACHED_BUDGET` 覆盖；0 或负数表示关闭。
 */
const DEFAULT_HOURLY_UNCACHED_BUDGET = 3_000_000;

/** 预算窗口（毫秒）。 */
const BUDGET_WINDOW_MS = 60 * 60 * 1000;

/** 读环境变量里的正整数；非法或未设返回默认值。 */
function envNum(key, dflt) {
  const raw = process.env[key];
  if (raw == null || String(raw).trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.trunc(n);
}

/** 当前生效的单次输入上限（0 = 关闭守门）。 */
function maxInputTokens() {
  return envNum('RACCOON_MAX_INPUT_TOKENS', DEFAULT_MAX_INPUT_TOKENS);
}

/** 当前生效的每小时未缓存预算（0 = 关闭）。 */
function hourlyUncachedBudget() {
  return envNum('RACCOON_HOURLY_UNCACHED_BUDGET', DEFAULT_HOURLY_UNCACHED_BUDGET);
}

/**
 * 估算一次请求的输入 token，并判断是否超过单次上限。
 *
 * 复用 `lib/token-estimate`（含 tools schema 开销）—— 上游把工具 JSON schema
 * 一并计入输入，只算 messages 会让守门在边界失效。
 *
 * @param {Array} messages 请求消息
 * @param {Array} [tools] 工具声明
 * @returns {{estimated:number, limit:number, exceeded:boolean}}
 */
function checkInputSize(messages, tools) {
  const limit = maxInputTokens();
  const estimated = estimateRequestTokens(messages, tools);
  if (limit <= 0) return { estimated, limit: 0, exceeded: false };
  return { estimated, limit, exceeded: estimated > limit };
}

/**
 * 构造一个 400 错误（客户端据此走自己的压缩逻辑或分段）。
 *
 * 文案要**可执行**：告诉用户当前估算值、上限、以及该怎么做。
 * 只报「输入过大」等于把一个 400 扔回去，用户不知道要减到多少。
 */
function inputTooLargeError(estimated, limit) {
  const e = new Error(
    `raccoon 输入过大：估算 ${estimated.toLocaleString('en-US')} tokens，`
    + `超过网关单次上限 ${limit.toLocaleString('en-US')}。`
    + 'Raccoon 上游按「实算 token 累计量」判定异常调用，单个超大请求会直接推动账号进入 3 小时风控。'
    + '请减少本轮上下文（分段提交、或让客户端先压缩历史）后重试。'
    + '如需调整上限，设置环境变量 RACCOON_MAX_INPUT_TOKENS。',
  );
  e.status = 400;
  e.code = 'raccoon_input_too_large';
  /** 供路由层写进响应体，客户端能读到具体数值。 */
  e.estimatedTokens = estimated;
  e.limitTokens = limit;
  return e;
}

/* ---------- 每账号每小时未缓存预算（SQLite 持久化） ---------- */

const { db: getDb } = require('../credentials/db');

/** 清理超过 staleMs 的过期记录（周期任务调用，默认 2h 保留期）。 */
function pruneStale(staleMs) {
  const ms = Number(staleMs) > 0 ? Number(staleMs) : 2 * 60 * 60 * 1000;
  const info = getDb().prepare('DELETE FROM input_budget_spend WHERE ts < ?').run(Date.now() - ms);
  return info.changes;
}

/**
 * 记一次成功请求的实算 token。
 *
 * @param {string} accountId
 * @param {{promptTokens?:number, cacheReadTokens?:number}} usage
 * @param {number} [now]
 * @returns {number} 该账号最近一小时的累计未缓存 token
 */
function recordUsage(accountId, usage, now = Date.now()) {
  const id = String(accountId || '');
  if (!id) return 0;
  const prompt = Number(usage && usage.promptTokens) || 0;
  const cached = Number(usage && usage.cacheReadTokens) || 0;
  const uncached = Math.max(0, prompt - cached);
  if (uncached > 0) {
    const d = getDb();
    // 插入前清理超出预算窗口的旧行，避免 scheduler 未运行时表无限增长
    d.prepare('DELETE FROM input_budget_spend WHERE account_id = ? AND ts <= ?').run(id, now - BUDGET_WINDOW_MS);
    d.prepare('INSERT INTO input_budget_spend (account_id, ts, uncached) VALUES (?, ?, ?)').run(id, now, uncached);
  }
  return usedLastHour(id, now);
}

/** 该账号最近一小时已用掉的未缓存 token。 */
function usedLastHour(accountId, now = Date.now()) {
  const id = String(accountId || '');
  if (!id) return 0;
  const row = getDb().prepare(
    'SELECT COALESCE(SUM(uncached), 0) AS total FROM input_budget_spend WHERE account_id = ? AND ts > ?',
  ).get(id, now - BUDGET_WINDOW_MS);
  return Number(row ? row.total : 0);
}

/**
 * 该账号是否已超出每小时预算。
 *
 * @returns {{exhausted:boolean, used:number, budget:number}}
 */
function checkHourlyBudget(accountId, now = Date.now()) {
  const budget = hourlyUncachedBudget();
  const used = usedLastHour(accountId, now);
  if (budget <= 0) return { exhausted: false, used, budget: 0 };
  return { exhausted: used >= budget, used, budget };
}

/** 清空预算记录（测试与「手动重置」用）。传 accountId 清指定账号，不传清全表。 */
function resetBudget(accountId) {
  if (accountId) {
    getDb().prepare('DELETE FROM input_budget_spend WHERE account_id = ?').run(String(accountId));
  } else {
    getDb().prepare('DELETE FROM input_budget_spend').run();
  }
}

module.exports = {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_HOURLY_UNCACHED_BUDGET,
  BUDGET_WINDOW_MS,
  maxInputTokens,
  hourlyUncachedBudget,
  checkInputSize,
  inputTooLargeError,
  recordUsage,
  usedLastHour,
  checkHourlyBudget,
  resetBudget,
  pruneStale,
};
