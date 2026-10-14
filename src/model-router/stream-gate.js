'use strict';
/**
 * model-router/stream-gate.js —— 流式出口的「答案提交闸门」。
 *
 * ## 解决什么
 *
 * 候选降级（failover）能否继续，取决于**客户端是否已收到无法撤回的答案内容**，
 * 而不是「HTTP 响应头是否已发」。原判据是 `res.headersSent`，而 dispatchTraeStream
 * 在上游吐第一个增量时就会 flushHeaders——**哪怕那个增量只是思考（reasoning）**。
 * 于是「模型先思考、随后在上游失败」这一整类场景无法降级：客户端已经"看到"了
 * 东西（头已发），可实际一个字的答案都没有。
 *
 * ## 为什么是「残行」而不是「整段扣留」
 *
 * 参照项目 A 的做法是把 reasoning 整段 held 住、换候选时丢弃，客户端全程看不到
 * 思考过程（只发 `:` 心跳）。那是它的取舍，但代价是**每一个**reasoning 模型请求
 * 的思考显示都被推迟到首个答案帧——用确定的 UX 损失去换一个未观测到的失败场景。
 *
 * 本项目的实测错误画像不支持这个代价：近 7 天 12,695 次请求里错误率 1.8%，
 * 而错误耗时 p50 = 1 ms（95% 的失败发生在准入阶段，今天就已能正常降级），
 * 「已产出 token 却报错」的行数为 0。所以这里不扣留 reasoning，改为只扣留
 * **最后一个换行之后的不完整行**：
 *
 *   - 完整帧（我们的 emitter 每次 write 都是 `...\n\n`）**原样立即下发**，
 *     因此正常路径的字节流、时序、TTFT 与改动前完全一致（零 UX 回归）；
 *   - 未成行的尾巴留在闸门里，换候选时丢弃。这才是真正会「跨候选拼接成坏 JSON」
 *     的字节——上游若在帧中间断掉，那半行残片绝不能拼到下一个候选的流里。
 *
 * 于是可切换窗口从「上游响应头之前」扩大到「首个**完整答案帧**之前」，
 * 而唯一可观测的差异是：若 A 只输出了思考就失败，客户端会先看到 A 的思考、
 * 再接上 B 的答案（今天这种情况下客户端只会收到一个错误帧，什么都没有）。
 *
 * ## 提交语义
 *
 * `commit()` 由「承载答案的帧」触发（见 commitsAnswerEvent）：
 *   - `content` 非空白 → 提交
 *   - `tool_call` → 提交
 *   - 只有 `reasoning` → **不提交**（与 A 的 commitsAnswer 同义）
 */

/** SSE 注释帧心跳间隔。仅在「已发头且长时间没写出字节」时发，避免长静默被中间层掐断。 */
const DEFAULT_KEEPALIVE_MS = 15_000;

/**
 * 该事件是否「承载答案」——一旦下发就无法再换候选。
 *
 * 只认归一化后的 stream event（transform/sse.js 的产物），不认原始字节：
 * 解析层已经把 reasoning 与 content 分开（sse.js:242-252），无需另写解析器。
 */
function commitsAnswerEvent(evt) {
  if (!evt || typeof evt !== 'object') return false;
  if (evt.type === 'tool_call') return true;
  if (evt.type === 'text') return String(evt.content == null ? '' : evt.content).trim() !== '';
  return false;
}

/**
 * 该行（已含换行的完整 SSE 行）是否承载答案。供原样透传的 provider 判定用。
 * @param {string} line
 */
function commitsAnswerLine(line) {
  const t = String(line || '').trim();
  if (!t.startsWith('data:')) return false;
  const payload = t.slice(5).trim();
  if (!payload || payload === '[DONE]') return false;
  let ev;
  try {
    ev = JSON.parse(payload);
  } catch {
    return false;
  }
  const choice = (ev.choices && ev.choices[0]) || null;
  const delta = (choice && choice.delta) || null;
  const msg = (choice && choice.message) || null;
  if (delta) {
    if (typeof delta.content === 'string' && delta.content.trim() !== '') return true;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) return true;
    if (typeof delta.function_call === 'object' && delta.function_call) return true;
  }
  if (msg) {
    if (typeof msg.content === 'string' && msg.content.trim() !== '') return true;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) return true;
  }
  // Anthropic 形态（少数透传端点）
  if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
    return String(ev.delta.text || '').trim() !== '';
  }
  if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') return true;
  return false;
}

/**
 * 创建闸门。它实现 dispatch 侧用到的那一小部分 `res` 接口
 * （setHeader / flushHeaders / write / end / headersSent / writableEnded），
 * 因此可以**直接当作 res 传给流式 dispatch**，不需要改动它们的写入代码形状。
 *
 * @param {import('http').ServerResponse} res
 * @param {{keepaliveMs?:number, onCommit?:(reason:string)=>void}} [opts]
 */
function createStreamGate(res, opts = {}) {
  const keepaliveMs = Number.isFinite(opts.keepaliveMs) ? opts.keepaliveMs : DEFAULT_KEEPALIVE_MS;

  let answerCommitted = false;
  let ended = false;
  let headersFlushed = false;
  /** 最后一个换行之后的字节（未成行）。换候选时丢弃，绝不与下一个候选拼接。 */
  let tail = '';
  let keepaliveTimer = null;
  let lastWriteAt = 0;

  function stopKeepalive() {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  function ensureHeaders() {
    if (headersFlushed || res.headersSent) {
      headersFlushed = true;
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    headersFlushed = true;
    lastWriteAt = Date.now();
    if (keepaliveMs > 0) {
      keepaliveTimer = setInterval(() => {
        if (ended || res.writableEnded) {
          stopKeepalive();
          return;
        }
        // 只有「静默超过一个心跳周期」才补注释帧：正常有字节流动时一个都不发，
        // 不给客户端与中间层增加任何额外帧。
        if (Date.now() - lastWriteAt < keepaliveMs) return;
        try {
          res.write(': ping\n\n');
          lastWriteAt = Date.now();
        } catch {
          stopKeepalive();
        }
      }, keepaliveMs);
      if (keepaliveTimer.unref) keepaliveTimer.unref();
    }
  }

  /**
   * 下行字节。整行之前的部分原样立即写出，只把末尾未成行的残片扣住。
   * 这样调用方的分块形态被保留（最多把一次 write 拆成两次），时序不变。
   */
  function write(chunk) {
    if (chunk == null || chunk === '') return true;
    ensureHeaders();
    if (ended || res.writableEnded) return false;
    tail += typeof chunk === 'string' ? chunk : String(chunk);
    const nl = tail.lastIndexOf('\n');
    if (nl === -1) return true;
    const ready = tail.slice(0, nl + 1);
    tail = tail.slice(nl + 1);
    lastWriteAt = Date.now();
    return res.write(ready);
  }

  return {
    /** 已有承载答案的完整帧交给客户端；此后换候选会让客户端看到两个模型的输出，必须停止。 */
    get answerCommitted() {
      return answerCommitted;
    },
    get headersSent() {
      return res.headersSent;
    },
    get writableEnded() {
      return ended || res.writableEnded;
    },
    /** 仅用于诊断/测试：当前扣住的未成行字节。 */
    peekHeld: () => tail,

    setHeader(name, value) {
      if (!headersFlushed && !res.headersSent) res.setHeader(name, value);
    },
    flushHeaders: ensureHeaders,

    /** 标记答案已提交。可重复调用；只有第一次触发回调。流已结束后不再受理。 */
    commit(reason) {
      if (answerCommitted || ended) return false;
      answerCommitted = true;
      if (typeof opts.onCommit === 'function') {
        try {
          opts.onCommit(reason || 'answer');
        } catch { /* 观测回调不得影响主流程 */ }
      }
      return true;
    },

    write,

    /**
     * 换候选前丢弃未成行的残片。只可能丢弃「从未下发的半行」，
     * 完整帧早已写出，因此这个操作不会让客户端少收到任何东西。
     * @returns {number} 丢弃的字节数
     */
    discardHeld() {
      const n = tail.length;
      tail = '';
      return n;
    },

    end() {
      if (ended) return;
      ended = true;
      stopKeepalive();
      ensureHeaders();
      if (tail && !res.writableEnded) {
        const rest = tail;
        tail = '';
        res.write(rest);
      }
      if (!res.writableEnded) res.end();
    },

    /** 异常路径兜底：停掉心跳定时器，避免泄漏到进程退出。 */
    dispose() {
      stopKeepalive();
    },
  };
}

module.exports = {
  createStreamGate,
  commitsAnswerEvent,
  commitsAnswerLine,
  DEFAULT_KEEPALIVE_MS,
};
