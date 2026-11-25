'use strict';
/**
 * lib/sse-heartbeat.js —— 流式响应的「静默心跳」。
 *
 * ## 解决什么
 *
 * 直连 Trae 路径（routes/openai.js、anthropic.js、responses.js）在
 * `res.flushHeaders()` 之后到首个上游事件之间，**一个字节都不写**。而这段静默
 * 有多长是上游决定的：
 *
 *   - 近 6 天 3146 条 Trae 请求实测：p50 = 4.9s，p90 = 19.1s，p99 = 45.5s，
 *     max = 110s；26.8% 超过 10s，15% 超过 15s。
 *   - 打开 AUTO_CONTINUE 后更糟：整轮缓冲意味着静默期 = 整轮耗时（同一个分布，
 *     但**每一次**请求都付这个代价，而不是只有首 token 之前那段）。
 *
 * 对端不是一个简单的 HTTP 客户端：TraeWork 的自定义模型走
 * `cloud_agent` 编排 + 本地 `custom-model-proxy` WebSocket 隧道回传（见客户端
 * `harness.dll` 里的 `custom-model-proxy/tunnel_manager.rs`）。隧道上任何
 * 「长时间无进展」判据都会先在这段静默里踩线，踩线的结果就是客户端侧
 * `errorCode 4054 (CUSTOM_MODEL_INTERNAL_ERROR)`。
 *
 * 网关侧补 `: ping` 注释帧把静默切碎——SSE 规范里以 `:` 开头的行是注释，
 * 所有 OpenAI / Anthropic 兼容客户端一律忽略，不改语义、不改字节流内容。
 *
 * ## 为什么不复用 model-router/stream-gate.js 里的心跳
 *
 * 那个心跳绑在「答案提交闸门」上（它要扣留未成行残片以便换候选），只有虚拟模型
 * 路径经过它。直连路径没有闸门，把闸门塞进来会改变残片语义。所以这里只抽出
 * **心跳这一件事**，两条路径各自按需装配。周期与「只在静默时才发」的策略保持一致
 * （stream-gate.js 的 DEFAULT_KEEPALIVE_MS = 15s），避免同仓两套心跳口径。
 *
 * ## 实现方式：包装 res.write 而不是要求调用方逐点 touch
 *
 * 三条路由里 `res.write` 有十余个调用点（含 `write(bytes)` 这类转发封装）。
 * 要求每处都调 `heartbeat.touch()` 既容易漏，也会被将来新增的写入点绕过。
 * 包装 `res.write` / `res.end` 让「最后一次写出时刻」由运行期自动记录，
 * 新调用点天然被覆盖，调用方零改动。
 */

/** 默认心跳间隔。与 model-router/stream-gate.js 的 DEFAULT_KEEPALIVE_MS 同值。 */
const DEFAULT_HEARTBEAT_MS = 15_000;

/** 心跳帧。SSE 注释行，客户端解析器一律跳过。 */
const HEARTBEAT_FRAME = ': ping\n\n';

/**
 * 给一个已下发响应头的流式响应挂上静默心跳。
 *
 * 语义：
 *   - 只有「距最后一次写出 ≥ intervalMs」才补帧。正常有字节流动时一个都不发，
 *     不给客户端与中间层增加任何额外帧（与 stream-gate 的策略一致）。
 *   - `res.end()` 自动停表；`res.writableEnded` 时下一拍自停。
 *   - intervalMs ≤ 0 时返回空实现（测试与显式关闭用）。
 *
 * @param {import('http').ServerResponse} res
 * @param {{intervalMs?:number, frame?:string, now?:()=>number}} [opts]
 * @returns {{stop:()=>void, touch:()=>void, readonly stopped:boolean, sent:()=>number}}
 */
function attachSseHeartbeat(res, opts = {}) {
  /*
   * 三态语义，刻意区分「没给」与「给了个坏值」：
   *   - 未传 intervalMs      → 用默认 15s（调用方只是没表态，保护照上）；
   *   - 传了非有限值/≤0      → 关闭（调用方明确表达了「不要」或配置写坏了，
   *                            静默按默认开反而会掩盖配置错误）；
   *   - 传了正有限值         → 用该值。
   */
  const explicit = opts.intervalMs !== undefined && opts.intervalMs !== null;
  const raw = Number(opts.intervalMs);
  const intervalMs = explicit
    ? (Number.isFinite(raw) && raw > 0 ? raw : 0)
    : DEFAULT_HEARTBEAT_MS;
  const frame = typeof opts.frame === 'string' ? opts.frame : HEARTBEAT_FRAME;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  // 关闭态：返回同形状的空实现，调用方无需分支。
  if (!(intervalMs > 0) || !res || typeof res.write !== 'function') {
    return {
      stop() {},
      touch() {},
      stopped: true,
      sent: () => 0,
    };
  }

  const origWrite = res.write;
  const origEnd = res.end;
  let lastWriteAt = now();
  let stopped = false;
  let sentCount = 0;
  // 必须先声明再被 stop() 引用：res.end 的包装在定时器创建**之前**就装好了，
  // 若路由在 setInterval 执行前同步 end，stop() 会踩到 TDZ（ReferenceError）。
  let timer = null;

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  // 包装写出：记录时刻即可，其余行为原样透传（返回值与回调不能变）。
  res.write = function patchedWrite(chunk, ...rest) {
    lastWriteAt = now();
    return origWrite.call(this, chunk, ...rest);
  };

  // end 之后不再有心跳：流已结束，继续写会触发 ERR_STREAM_WRITE_AFTER_END。
  res.end = function patchedEnd(...args) {
    stop();
    return origEnd.apply(this, args);
  };

  timer = setInterval(() => {
    if (stopped) return;
    if (res.writableEnded) {
      stop();
      return;
    }
    if (now() - lastWriteAt < intervalMs) return;
    try {
      // 直接走原始 write：绕开上面那层记录，避免把「心跳自身」算成一次真实写出
      // （那会让静默判定永远成立，变成每拍都发）。
      origWrite.call(res, frame);
      lastWriteAt = now();
      sentCount += 1;
    } catch {
      // 连接已断（EPIPE/ERR_STREAM_DESTROYED）：停表即可，异常不能冒到路由层。
      stop();
    }
  }, intervalMs);
  // 不阻止进程退出（与 stream-gate 的处理一致）。
  if (timer.unref) timer.unref();

  return {
    stop,
    touch() {
      lastWriteAt = now();
    },
    get stopped() {
      return stopped;
    },
    sent: () => sentCount,
  };
}

module.exports = {
  attachSseHeartbeat,
  DEFAULT_HEARTBEAT_MS,
  HEARTBEAT_FRAME,
};
