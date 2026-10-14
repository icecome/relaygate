'use strict';
/**
 * lib/request-context.js —— 请求级上下文（AsyncLocalStorage）。
 *
 * 目前承载一个字段：**回合同 id**（`turnId`）。
 *
 * 为什么需要它：一次客户端请求会产出**多行** traffic —— 虚拟模型降级换候选时
 * 每个候选各写一行，因此「降级 3 次后成功」在日志里是 3 行失败 + 1 行成功。
 * 统计层要算「按回合的成功率」就必须知道哪些行属于同一次客户端请求，而这些行
 * 散落在 openai / anthropic / responses / model-router 的十余处 `logRequest`。
 *
 * 逐个调用点显式传 `turnId` 的问题：容易漏、且将来新增的调用点会绕过它（这类
 * 「漏一处就静默失真」的口径，最怕靠自觉）。改用 AsyncLocalStorage 让「同一次
 * 请求」由运行上下文承载，`logRequest` 自动继承，新调用点零成本。
 *
 * 边界：只在 Express 请求链内有效。定时任务、脚本等没有 HTTP 请求的路径取不到
 * 上下文——这是对的，那些调用本来就不属于任何客户端回合，统计层会把每行各算
 * 一个回合（等价于「无降级的单次尝试」，与历史数据口径一致）。
 *
 * 本模块**不得依赖任何业务模块**：它被 log/traffic.js 引用，若反过来依赖
 * log/traffic 就成环（newTurnId 因此放在这里而不是 traffic 里）。
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

/**
 * 生成一个回合同 id。
 *
 * 只需在单日内唯一（统计按日聚合）。时间戳 + 随机后缀足够，且比 UUID 短，
 * 每天上千行日志体积可控。
 */
function newTurnId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 在给定上下文里运行 fn（Express 中间件写法：`run({turnId}, next)`）。 */
function run(store, fn) {
  return storage.run(store, fn);
}

/** 当前请求的上下文；不在请求链内时为 null。 */
function current() {
  return storage.getStore() || null;
}

module.exports = { run, current, newTurnId };
