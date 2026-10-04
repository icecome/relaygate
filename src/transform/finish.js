'use strict';
/**
 * transform/finish.js — finish_reason 语义判定（共享叶子模块，无内部 require）。
 *
 * 上游因输出上限/内容策略提前中断时的结束原因集合。这些信号必须原样透传给
 * 客户端：截断时工具参数可能只下发了一半，若网关误报 tool_calls，客户端会执行
 * 一个参数残缺的工具调用（agentic 场景下表现为「任务做了一半就停」）。
 *
 * 放在独立叶子模块：upstream/client 与 model-router/dispatch 都需引用，且
 * dispatch 已懒加载 client —— 若放 dispatch 里会让 client 顶层 require dispatch 形成环。
 */
const TRUNCATED_FINISH = new Set(['length', 'max_tokens', 'content_filter']);

/** 是否为「被截断/被中断」的结束原因（大小写无关）。 */
function isTruncatedFinish(finish) {
  return !!finish && TRUNCATED_FINISH.has(String(finish));
}

module.exports = { isTruncatedFinish, TRUNCATED_FINISH };
