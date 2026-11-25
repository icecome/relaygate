'use strict';
/**
 * lib/server-timeouts.js —— HTTP server 的空闲连接回收参数。
 *
 * ## 为什么必须调
 *
 * Node 默认 `keepAliveTimeout = 5000`（另有 1000ms 的 `keepAliveTimeoutBuffer`，
 * 实际生效约 6s）。而本服务的调用方是**同一个客户端进程反复发请求**，相邻两次
 * 请求的间隔远超 5 秒：
 *
 *   Trae 通道实测（近两天 1924 个间隔）：p50 = 11.5s，p75 = 19.6s，p90 = 35.3s；
 *   间隔 > 5s 占 **57.6%**，> 6s 占 **51.1%**。
 *
 * 也就是说：客户端连接池里那把 socket 有一半以上的概率在复用时早已被服务端
 * 单方面发过 FIN。若写入正好落在「服务端已关、客户端尚未感知」的竞态窗口里，
 * 客户端拿到的是「连接被重置、没有任何 HTTP 响应」——不是 4xx/5xx，而是传输层
 * 失败。这正是 TraeWork 侧 `4054 (CUSTOM_MODEL_INTERNAL_ERROR)` 文案里
 * 「Please check the proxy response」所指的那类失败。
 *
 * 实测取证（对本机运行实例，2026-11-25）：空闲 6015ms 后服务端发 FIN；
 * 6.0s 内复用正常，6.5s 后写入直接失败。6 次 4054 里有 4 次的相邻请求间隔 > 5s，
 * 其中 10:04:46 那次是 5.09s，正压在默认边界上。
 *
 * ## 取值约束
 *
 * `headersTimeout` 必须**严格大于** `keepAliveTimeout`，否则 Node 会在 headers
 * 阶段先切断空闲连接，`keepAliveTimeout` 形同虚设。这里固定取
 * `keepAlive + HEADERS_MARGIN_MS`，不暴露第二个旋钮——两者单独配置只会配错。
 */

/** headersTimeout 相对 keepAliveTimeout 的余量。 */
const HEADERS_MARGIN_MS = 5000;

/**
 * 调整 server 的空闲连接参数。
 *
 * @param {import('http').Server} server
 * @param {{keepAliveTimeoutMs?:number}} [opts]
 * @returns {{keepAliveTimeout:number, headersTimeout:number}|null} 实际生效值（未设置时 null）
 */
function tuneServerTimeouts(server, opts = {}) {
  if (!server || typeof server !== 'object') return null;
  const keepAlive = Number(opts.keepAliveTimeoutMs);
  // ≤0 或非法 = 显式关闭本项优化，保持 Node 默认。
  if (!Number.isFinite(keepAlive) || keepAlive <= 0) return null;
  const headers = keepAlive + HEADERS_MARGIN_MS;
  server.keepAliveTimeout = keepAlive;
  server.headersTimeout = headers;
  return { keepAliveTimeout: keepAlive, headersTimeout: headers };
}

module.exports = { tuneServerTimeouts, HEADERS_MARGIN_MS };
