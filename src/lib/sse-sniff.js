'use strict';
/**
 * lib/sse-sniff.js —— 按**正文形状**判定上游回的是什么（不看 Content-Type）。
 *
 * 为什么不信 Content-Type：该车道实测会在 `application/json` 下返回**完整的 SSE
 * 帧序列**，依赖响应头判形状会让 `JSON.parse` 失败、整轮报废，且错误对象带着
 * `status: 200`，探测逻辑会把可用模型误判为不可路由。参照项目的 `http.js`
 * 因此改成「只读首个块（≤4KB）即判形状」，并把已嗅探的字节回灌，不丢一个 token。
 *
 * 反过来更阴的场景是：我们请求了 `stream: true`，上游却回了**完整 JSON**。
 * 此时 SSE 解析器按行找不到 `data:` 前缀，**什么都不产出**——而三条出口
 * （`routes/openai.js`、`routes/anthropic.js`、`model-router/dispatch.js`）都会
 * 照样收尾成「正常结束、内容为空」。这是最坏的一类失败：不报错、可重试的额度
 * 已经花掉、客户端拿到一个空答案。
 *
 * 所以本模块只做**判定**，不做形状转换；调用方在「一个事件都没解析出来」时
 * 用这里的结论把静默空回复变成一个可降级、可诊断的错误。
 */

/** 判定窗口：与参照项目一致的 4KB 上限（首块即判，不凑满）。 */
const SNIFF_MAX_BYTES = 4096;

/**
 * 判形状。只看开头，不做完整解析（调用方拿到的是**首块**，可能截断）。
 * @param {string} text
 * @returns {'sse'|'json'|'html'|'empty'|'unknown'}
 */
function sniffHead(text) {
  const s = String(text == null ? '' : text).replace(/^\uFEFF/, '').trimStart();
  if (!s) return 'empty';
  const c = s[0];
  if (c === '{' || c === '[') return 'json';
  if (c === '<') return 'html';
  // SSE 注释帧（心跳）以冒号开头
  if (c === ':') return 'sse';
  // SSE 字段名：data / event / id / retry（允许 `data:` 与 `data :` 两种写法）
  if (/^(data|event|id|retry)\s*:/.test(s)) return 'sse';
  return 'unknown';
}

const SHAPE_DESC = {
  sse: 'SSE 帧',
  json: 'JSON 正文',
  html: 'HTML 页面',
  empty: '空正文',
  unknown: '无法识别的正文',
};

/** 人话形状名，供错误文案用。 */
function describeShape(kind) {
  return SHAPE_DESC[kind] || String(kind);
}

module.exports = { sniffHead, describeShape, SNIFF_MAX_BYTES };
