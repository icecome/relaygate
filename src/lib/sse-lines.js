'use strict';
/**
 * lib/sse-lines.js — SSE 文本流的行缓冲。
 *
 * 上游 chunk 边界与行边界无关，一个 JSON 事件常被切成多块。若按块直接
 * split('\n') 而不保留残行，被切开的那个事件会整行解析失败并被丢弃。
 *
 * 用法：
 *   const feeder = createLineFeeder((line) => handler.feedLine(line));
 *   await consumeStream(body, (text) => feeder.feed(text));
 *   feeder.flush();
 */

/**
 * @param {(line: string) => void} onLine 收到完整行时回调（不含换行符）
 * @returns {{feed: (text: string) => void, flush: () => void}}
 */
function createLineFeeder(onLine) {
  let buffer = '';
  return {
    feed(text) {
      if (!text) return;
      buffer += text;
      const lines = buffer.split('\n');
      // 末段可能是被切断的残行，留到下一块拼接后再处理
      buffer = lines.pop() || '';
      for (const line of lines) onLine(line);
    },
    /** 流结束时吐出剩余残行（上游末行可能无换行符）。 */
    flush() {
      if (!buffer) return;
      const rest = buffer;
      buffer = '';
      onLine(rest);
    },
  };
}

module.exports = { createLineFeeder };