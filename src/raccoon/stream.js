'use strict';
/**
 * raccoon/stream.js —— 把 Raccoon 的上游 SSE **原样**转发给客户端，同时旁路计量。
 *
 * ## 为什么单独抽一层
 *
 * 两条入口（`/v1/raccoon/chat/completions` 与统一端点分派）要做完全相同的事：
 *
 * 1. 上游是**标准 OpenAI SSE**（`chat.completion.chunk` + `data: [DONE]`），
 *    所以**一个字节都不改写** —— 改写会引入「我们自己造帧」的风险，而这条
 *    链路的稳定性全靠上游原样（参考项目同结论）。
 * 2. 顺带读 `usage` 与 `finish_reason` 写进 traffic 日志。**只读不改**：
 *    通过 `createLineFeeder` 做旁路，转发的是原始 chunk，不是重新序列化的帧。
 * 3. 客户端断开时立即中止上游 —— 否则一次「用户按了停止」会继续把整轮
 *    上游 token 烧完（那是真金白银的积分）。
 *
 * ## 为什么不能在 headersSent 之后写错误 JSON
 *
 * SSE 头一旦下发，响应体的形状就固定成事件流了。此时再 `res.json()` 会抛
 * `ERR_HTTP_HEADERS_SENT`（或更糟：把 JSON 混进事件流，客户端解析失败）。
 * 所以失败路径统一走「补一个 error 帧 + [DONE]」，这是 OpenAI 客户端的
 * 通用兜底形状，DSH / Claude Code / Cline 都认。
 *
 * @module src/raccoon/stream.js
 */

const { createLineFeeder } = require('../lib/sse-lines');

/**
 * 从一行 SSE 里抽出可观测信息（usage / finish_reason）。
 *
 * 上游的 usage 出现在 `[DONE]` 前的最后一帧（`stream_options.include_usage`
 * 语义）。但小浣熊**不一定**每次都发 —— 实测部分轮次没有任何 usage 帧，
 * 所以调用方拿到的可能是 null，必须按「未计量」处理而不是按 0 处理。
 *
 * @param {string} line
 * @param {{usage:any, finishReason:string|null}} sink
 */
function sniffLine(line, sink) {
  const t = String(line || '').trim();
  if (!t.startsWith('data:')) return;
  const payload = t.slice(5).trim();
  if (!payload || payload === '[DONE]') return;
  let ev;
  try {
    ev = JSON.parse(payload);
  } catch {
    return;
  }
  if (ev && ev.usage && (ev.usage.prompt_tokens || ev.usage.completion_tokens || ev.usage.total_tokens)) {
    sink.usage = ev.usage;
  }
  const choice = ev && Array.isArray(ev.choices) ? ev.choices[0] : null;
  if (choice && typeof choice.finish_reason === 'string' && choice.finish_reason) {
    sink.finishReason = choice.finish_reason;
  }
}

/**
 * 下发 SSE 头（幂等）。
 */
function setSseHeaders(res) {
  if (res.headersSent) return;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // 关掉 nginx 类中间层的缓冲：不关会让流式变成「攒满一包才发」，TTFT 直接消失。
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

/** 在已下发的流里补一个错误帧（+ [DONE]），然后结束。 */
function writeErrorFrame(res, message, extra = {}) {
  if (res.writableEnded) return;
  try {
    res.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error', ...extra } })}\n\n`);
    res.write('data: [DONE]\n\n');
  } catch { /* 客户端已断开 */ }
  try { res.end(); } catch { /* 已结束 */ }
}

/**
 * 把上游响应体泵给客户端。
 *
 * @param {ReadableStream} body 上游 `resp.body`
 * @param {import('http').ServerResponse} res 客户端响应
 * @param {{onClose?:()=>void, signal?:AbortSignal, onDone?:(sink:object)=>void}} [opts]
 * @returns {Promise<{usage:any, finishReason:string|null, bytes:number, aborted:boolean}>}
 */
async function pipeToClient(body, res, opts = {}) {
  const sink = { usage: null, finishReason: null };
  const feeder = createLineFeeder((line) => sniffLine(line, sink));
  const reader = body.getReader();
  const dec = new TextDecoder();
  let bytes = 0;
  let aborted = false;

  // 客户端断开 → 立刻取消上游 reader。不这么做的话，用户点「停止」后
  // 上游还会把整轮 token 生成完，积分照扣。
  const onClientGone = () => {
    aborted = true;
    reader.cancel().catch(() => {});
    if (typeof opts.onClose === 'function') opts.onClose();
  };
  res.once('close', onClientGone);

  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      if (aborted || res.writableEnded) break;
      const text = dec.decode(value, { stream: true });
      if (!text) continue;
      bytes += text.length;
      feeder.feed(text);
      res.write(text);
    }
    if (!aborted) feeder.flush();
  } catch (err) {
    console.error('[raccoon] stream pipe error:', err && err.message ? err.message : err);
    // 连接被上游掐断（ECONNRESET / aborted）不是「我们的错误」：
    // 已经下发的内容照常保留，只补一个错误帧让客户端知道这轮不完整。
    // 流中断只回泛化文案：err.message 可能含上游响应片段（ECONNRESET 细节等），
    // 详情留在服务端日志，不写进 SSE 错误帧。
    if (!aborted && !res.writableEnded) {
      writeErrorFrame(res, '上游流中断，本轮回复不完整');
    }
  } finally {
    res.removeListener('close', onClientGone);
    try { reader.releaseLock(); } catch { /* 已释放 */ }
  }

  if (!res.writableEnded) {
    try { res.end(); } catch { /* 已结束 */ }
  }
  if (typeof opts.onDone === 'function') opts.onDone(sink);
  return { ...sink, bytes, aborted };
}

module.exports = {
  setSseHeaders,
  writeErrorFrame,
  pipeToClient,
  sniffLine,
};
