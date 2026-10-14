'use strict';
/**
 * lib/rtk/index.js —— RTK 工具输出压缩器（源项目 ESM 版 → 本项目 CommonJS 的移植）。
 *
 * 一轮很长的 agent 回合，内容大部分是工具输出 —— diff、目录清单、搜索结果、构建日志
 * —— 而其中几乎全是模型不需要的冗余：每个匹配都重复一遍的路径、每个 crate 一行的进度、
 * 比变更本身大得多的 hunk 正文。本模块在请求交给上游之前，把这些 blob 改写成 RTK
 * 定义好的紧凑形状。
 *
 * 三条规则限定它能碰什么：
 *
 * - 只压缩工具**输出**。system prompt、user 轮、assistant 文本是手写上下文，改写它们
 *   等于改了用户问的东西。
 * - 错误结果永不压缩（本项目的内部标记 `is_error`，见 src/transform/request.js）。
 *   错误轨迹是模型判断「哪一步失败了」的唯一证据；把它藏起来，模型会重试同一次调用，
 *   用户为这个循环付钱。
 * - 只有「非空且严格更小」的替换才会被采用。空结果读起来像「工具什么都没输出」，与
 *   工具报告的事实不同；更大的结果则花掉了它本该省的上下文。
 *
 * 任何过滤器失败都是 fail-open：原文本照发，notes 里记一条。本模块夹在用户回合与上游
 * 之间，最坏的、可接受的结局是「什么都没省」。
 *
 * 【与源实现的差异①：只保留一条 walker】
 * 源实现有 Anthropic blocks / OpenAI Responses / Kiro conversationState 等多套喂法。
 * 本项目内部只有一种消息形态（由 src/transform/request.js#normalizeTraeMessages 归一化）
 * ：
 *
 *   { role: 'tool', tool_call_id, content: [{ type: 'text', text: '...' }] }
 *
 * 因此这里只保留「遍历 messages → 找到 role==='tool' → 遍历 content → 压缩
 * type==='text' 块的 text」这一条路径；源里其它 walker 分支没有搬过来，不是遗漏。
 * 连带的行为差异：
 *   - 源实现形态 1「`content` 是字符串的 OpenAI tool 消息」不再被压缩；
 *     本项目形态下这种消息不该出现，出现就逐字节放过，也不计入 stats.calls。
 *   - 源实现在这里返回 `null` 表示「别用」；本模块返回新数组 + stats，
 *     由 `opts.enabled === false` 表达「别用」。
 *
 * 【与源实现的差异②：字节口径统一为 UTF-8】
 * 源实现用 `text.length`（UTF-16 码元）算体量，中文下把真实字节低估 2-3 倍，
 * 于是它报出来的「省了 N 字节」是假数。本模块一律用 `Buffer.byteLength(text, 'utf8')`：
 * bytesBefore / bytesAfter / saved 都是真实 UTF-8 字节，并且恒有
 *
 *   bytesBefore - bytesAfter === saved === Σ hits[].saved
 *
 * （这里 `hits[].saved` 就是每次 `compressToolOutput` 返回的 `saved`。）
 * 两个体量闸门按字节判定带来的方向性影响见 constants.js 顶部。
 *
 * @module src/lib/rtk/index.js
 */

const { RAW_CAP, MIN_COMPRESS_SIZE, FILTERS } = require('./constants');
const { autoDetectFilter } = require('./autodetect');
const { safeApply } = require('./applyFilter');
const { resolveFilter, allFilters } = require('./registry');
const { splitGrepHit, isGrepHit, parseGrepOutput } = require('./hitLine');
const constants = require('./constants');

/** 全模块唯一的体量口径：UTF-8 字节数。 */
function utf8Bytes(text) {
  return Buffer.byteLength(String(text), 'utf8');
}

/**
 * 归一化 `opts`：缺省 / undefined / null 视为**开启**；显式 false（或 `{enabled:false}`）
 * 关闭。与源实现的 resolveEnabled 同义，只是参数从「第三个位置参数」变成 opts 对象。
 */
function resolveEnabled(opts) {
  if (opts === undefined || opts === null) return true;
  if (typeof opts === 'object') return opts.enabled !== false;
  return opts !== false;
}

/** 取 opts.resolve 钩子（仅当它是函数）。 */
function resolveHook(opts) {
  if (opts && typeof opts === 'object' && typeof opts.resolve === 'function') return opts.resolve;
  return undefined;
}

/**
 * 压缩**单个 blob** —— 单测原语，也是「调用方自己知道这是什么输出」的入口。
 *
 * 体量闸门在这里而不在过滤器里，好让所有调用方共用一个口径：太小就放过（marker 比
 * 省下的还长），超过 RAW_CAP 就放过（在失控 dump 上跑正则纯买延迟），认不出形状就
 * 放过（没有过滤器合适）。过滤器真的跑了之后，它的输出仍然必须「非空且严格更小」
 * —— 这是防住过滤器 bug 到达线上的最后一道关。
 *
 * @param {string} text 候选 blob
 * @param {{filter?:string, resolve?:Function, notes?:string[]}} [ctx]
 *   - `filter`：强制使用注册表里的具名过滤器（已知 blob 是什么，不必猜）；
 *   - `resolve`：替换自动检测的解析钩子 `(text) => fn|null`（单测/扩展注入点）；
 *   - `notes`：fail-open 的记录写进这个数组。
 * @returns {{text:string, saved:number, filter:string|null, note?:string}} `saved` 是
 *   UTF-8 字节差；没有压缩时是 0 且 `filter` 为 null
 */
function compressToolOutput(text, ctx) {
  const c = ctx || {};
  const input = typeof text === 'string' ? text : String(text == null ? '' : text);
  const bytesIn = utf8Bytes(input);
  const notes = Array.isArray(c.notes) ? c.notes : null;

  const passthrough = (note) => (note ? { text: input, saved: 0, filter: null, note } : { text: input, saved: 0, filter: null });

  // 体量闸门（按 UTF-8 字节）
  if (bytesIn < MIN_COMPRESS_SIZE || bytesIn > RAW_CAP) return passthrough(null);

  const fn = typeof c.filter === 'string' ? resolveFilter(c.filter)
    : typeof c.resolve === 'function' ? c.resolve(input)
    : autoDetectFilter(input);
  if (typeof fn !== 'function') return passthrough(null);

  let note = null;
  // 失败上报口给了 notes 就只记 notes（不打日志）；没给则由 safeApply 退回源实现的
  // console.warn（stderr）。
  const out = safeApply(fn, input, (message) => {
    note = message;
    if (notes) notes.push(message);
  });

  const name = fn.filterName || fn.name || null;

  // 安全网：绝不留空、绝不放大。
  if (!out || out.length === 0) return passthrough(note);
  const bytesOut = utf8Bytes(out);
  if (bytesOut >= bytesIn) return passthrough(note);

  return note
    ? { text: out, saved: bytesIn - bytesOut, filter: name, note }
    : { text: out, saved: bytesIn - bytesOut, filter: name };
}

/**
 * 压缩本项目消息形态里的全部工具输出。
 *
 * 只走一条路径：`role === 'tool'` 且 `content` 是数组时，压缩其中 `type === 'text'`
 * 块的 `text`。`is_error === true` 的 tool 消息整条跳过（一个字节都不碰，也不计入
 * stats）。非 tool 消息、非 text 块、content 非数组的消息一律逐字节不变。
 *
 * **不修改入参**：返回新的 messages 数组；被压缩的工具消息是新对象（未变的条目保持
 * 原引用）。调用方可以安全地复用原来的 messages。
 *
 * 不变量恒成立：`bytesBefore - bytesAfter === saved === Σ hits[].saved`，其中
 * `hits[].saved` 是逐个 blob 调用 {@link compressToolOutput} 得到的 `saved`。
 *
 * @param {Array} messages 本项目形态的 messages（可能含 role:'tool'）
 * @param {{enabled?:boolean, resolve?:Function}} [opts]
 * @returns {{messages:Array, stats:{
 *   bytesBefore:number, bytesAfter:number, saved:number,
 *   blocks:number, calls:number, filters:string[], notes:string[]
 * }}} `enabled=false`、messages 为空或不是数组时，原样返回、stats 全 0
 */
function compressMessages(messages, opts) {
  const stats = {
    bytesBefore: 0,
    bytesAfter: 0,
    saved: 0,
    blocks: 0,
    calls: 0,
    filters: [],
    notes: [],
  };

  if (!resolveEnabled(opts) || !Array.isArray(messages) || messages.length === 0) {
    return { messages, stats };
  }

  const resolve = resolveHook(opts);
  const out = new Array(messages.length);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    // 只有归一化后的工具消息才走压缩。错误轨迹整条跳过：错误输出是模型唯一的失败
    // 证据，藏起来会让它重试同一次调用。
    if (!msg || msg.role !== 'tool' || msg.is_error === true || !Array.isArray(msg.content)) {
      out[i] = msg;
      continue;
    }

    let changed = false;
    const content = new Array(msg.content.length);
    for (let k = 0; k < msg.content.length; k++) {
      const part = msg.content[k];
      if (!part || part.type !== 'text' || typeof part.text !== 'string') {
        content[k] = part; // 非 text 块逐字节不动
        continue;
      }

      const before = utf8Bytes(part.text);
      const r = compressToolOutput(part.text, { resolve, notes: stats.notes });
      stats.calls += 1;
      stats.bytesBefore += before;
      stats.bytesAfter += before - r.saved;
      if (r.filter) {
        stats.blocks += 1;
        if (!stats.filters.includes(r.filter)) stats.filters.push(r.filter);
      }
      if (r.text !== part.text) {
        changed = true;
        content[k] = { ...part, text: r.text };
      } else {
        content[k] = part;
      }
    }

    out[i] = changed ? { ...msg, content } : msg;
  }

  stats.saved = stats.bytesBefore - stats.bytesAfter;
  return { messages: out, stats };
}

/**
 * 一次压缩过后的单行日志，供调用方（或 UI）打印；没有任何 blob 被压缩时返回 null。
 *
 * 与源实现的 formatRtkLog 同构，只是把 `hits` 换成本项目的 `blocks`、把过滤器名换成
 * `stats.filters`。它是纯函数，不写任何日志。
 *
 * @param {ReturnType<typeof compressMessages>['stats']} stats
 * @returns {string|null}
 */
function formatRtkLog(stats) {
  if (!stats || !stats.blocks) return null;
  const pct = stats.bytesBefore > 0 ? ((stats.saved / stats.bytesBefore) * 100).toFixed(1) : '0';
  return `[RTK] saved ${stats.saved}B / ${stats.bytesBefore}B (${pct}%) via [${stats.filters.join(',')}] hits=${stats.blocks}`;
}

module.exports = {
  compressMessages,
  compressToolOutput,
  formatRtkLog,
  utf8Bytes,
  // 便于单测与调用方复用的内部件
  autoDetectFilter,
  resolveFilter,
  allFilters,
  safeApply,
  constants,
  FILTERS,
  splitGrepHit,
  isGrepHit,
  parseGrepOutput,
};
