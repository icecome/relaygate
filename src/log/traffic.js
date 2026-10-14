'use strict';
/**
 * log/traffic.js — 请求级流量日志。
 * 1) 控制台一行 JSON（结构化）
 * 2) 追加到 logs/YYYY-MM-DD/traffic.jsonl
 * 3) 仍可选逐条 JSON（LEGACY_TRAFFIC_FILES=true）
 */
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../lib/atomic-write');
const { maskSecret } = require('../lib/mask');
const config = require('../config');
const { estimateCost } = require('../models/rates');
const { localDateKey } = require('../lib/util');
const { logsDir } = require('../lib/paths');
const requestContext = require('../lib/request-context');

let seq = 0;
// 已确认存在的日志目录，仅跨日时变化，避免每请求一次 mkdir syscall。
let ensuredDir = null;

/**
 * 当日日志目录，按**本地**日期切分。
 *
 * 早期实现用 `toISOString().slice(0,10)`（UTC），而统计缓存与面板的
 * 「今天」用的是本地日期，两者在东八区相差 8 小时：本地 00:00-08:00 的请求
 * 会被写进前一天的目录，按本地日历画热力图就整体错位一格。
 * 目录名与读取端（stats.readTrafficLines）必须同为本地日期键。
 */
function todayDir() {
  return path.join(logsDir(), localDateKey());
}

/** 确保目录存在（同一天只 mkdir 一次）。 */
function ensureDir(dir) {
  if (ensuredDir === dir) return;
  fs.mkdirSync(dir, { recursive: true });
  ensuredDir = dir;
}

function sanitize(obj, depth = 0) {
  if (depth > 3 || obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((v) => sanitize(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    // 数值不脱敏：totalTokens/promptTokens 等计量字段的键名含 "token"，
    // 曾被下方正则整批打成 "***"，统计层把字符串当 0，token 与费用恒为 0。
    // 敏感值只可能是字符串（Authorization 头、JWT、apiKey），数字原样保留。
    if (typeof v === 'number' || typeof v === 'boolean' || v == null) {
      out[k] = v;
    } else if (/authorization|token|password|secret|api[_-]?key/i.test(k)) {
      out[k] = maskSecret(v);
    } else if (typeof v === 'object') {
      out[k] = sanitize(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 记录一个请求：一行控制台 + jsonl。
 *
 * `turnId`（逻辑回合）：优先取 `entry.turnId`，否则从请求上下文继承
 * （见 lib/request-context.js）。同一次客户端请求产生的多行 traffic 共享它，
 * 统计层据此按回合而非按行算成功率——否则降级换候选会把一次请求记成多次失败。
 * @param {object} entry
 */
function logRequest(entry) {
  try {
    seq += 1;
    // 回合同 id：entry 显式给的优先（可覆盖），否则继承当前请求上下文
    const ctx = requestContext.current();
    const base = {
      ts: new Date().toISOString(),
      seq,
      tag: 'traffic',
      ...(ctx && ctx.turnId ? { turnId: ctx.turnId } : {}),
      ...entry,
    };
    // 费用估算：有 token 用量且未显式提供时按模型费率估算积分
    if (base.estimatedCost == null && (base.promptTokens || base.completionTokens || base.totalTokens)) {
      const pt = Number(base.promptTokens) || 0;
      const ct = Number(base.completionTokens) || 0;
      const c = estimateCost(base.model, pt, ct, {
        cacheRead: Number(base.cacheReadTokens) || 0,
        platform: base.platform,
      });
      if (c != null) base.estimatedCost = c;
    }
    const line = sanitize(base);

    // 控制台一行：仅在 LOG_LEVEL=debug 时输出。
    // start.bat 把 stdout 重定向到 logs/relay.out.log 且该文件无上限，默认每请求
    // 打一行会让它持续增长；traffic.jsonl 已完整留存，面板也有流量视图，
    // 故默认不重复写 stdout。
    if (config.logLevel === 'debug') console.log(JSON.stringify(line));

    // jsonl 追加：保持同步写（面板读取与缓存失效判定都依赖「写完即可见」），
    // 但去掉每请求一次的 mkdir syscall
    const dir = todayDir();
    ensureDir(dir);
    fs.appendFileSync(path.join(dir, 'traffic.jsonl'), JSON.stringify(line) + '\n', 'utf-8');
    // 使当日统计缓存失效（下次面板请求时重建聚合）
    try {
      require('./stats-cache').invalidateDay();
    } catch { /* 缓存失效失败不影响日志写入 */ }

    // 可选的旧格式逐文件写入
    if (config.legacyTrafficFiles) {
      const d = path.join(dir, 'traffic');
      writeJsonAtomic(path.join(d, `traffic-${String(seq).padStart(5, '0')}.json`), line, { newline: false });
    }

    return seq;
  } catch (e) {
    console.error(JSON.stringify({ tag: 'traffic_err', message: e.message }));
    return null;
  }
}

/**
 * 上游 usage → 日志字段。无 usage 或全 0 时返回空对象，
 * 让统计层把该请求记为「未计量」而不是「消耗 0 token」。
 * 兼容 OpenAI 蛇形与 Trae 驼峰两种键名。
 *
 * cacheReadTokens（缓存读）单独抽出：标定费率对未缓存输入、输出与缓存读
 * 三类 token 分别计价，缺这个字段就只能按全量输入估，会系统性高估。
 * 上游键名实测三套：prompt_tokens_details.cached_tokens（OpenAI）、
 * inputTokensDetails[0].cached_tokens（WB 客户端）、cache_read_input_tokens（Anthropic）。
 */
function usageToLogFields(u) {
  if (!u || typeof u !== 'object') return {};
  const pt = Number(u.prompt_tokens ?? u.inputTokens) || 0;
  const ct = Number(u.completion_tokens ?? u.outputTokens) || 0;
  const tt = Number(u.total_tokens ?? u.totalTokens) || (pt + ct);
  if (!pt && !ct && !tt) return {};
  const fields = { promptTokens: pt, completionTokens: ct, totalTokens: tt };
  const cr = Number(u.cached_tokens) > 0
    ? Number(u.cached_tokens) // dispatch.peekUsageDetail 已抽出的扁平字段
    : cacheReadOf(u);
  if (cr > 0) fields.cacheReadTokens = Math.min(cr, pt);
  const cw = Number(u.cache_write_input_tokens ?? u.cacheWriteTokens
    ?? u.prompt_cache_write_tokens ?? (u.usage && u.usage.cacheWriteTokens)) || 0;
  if (cw > 0) fields.cacheWriteTokens = cw;
  return fields;
}

/** 从 usage 的多种细节形态里取缓存读 token；取不到返回 0。 */
function cacheReadOf(u) {
  const d = u.prompt_tokens_details ?? u.inputTokensDetails ?? u.input_tokens_details;
  if (Array.isArray(d) && d.length) {
    const first = d[0] || {};
    const v = Number(first.cached_tokens ?? first.cachedTokens);
    if (Number.isFinite(v) && v > 0) return v;
  }
  if (d && typeof d === 'object') {
    const v = Number(d.cached_tokens ?? d.cache_read_input_tokens ?? d.cachedTokens);
    if (Number.isFinite(v) && v > 0) return v;
  }
  const flat = Number(u.cache_read_input_tokens ?? u.cacheReadTokens ?? u.cached_tokens);
  return Number.isFinite(flat) && flat > 0 ? flat : 0;
}

/**
 * 工具输出压缩（RTK）节省的日志字段。
 *
 * 两条硬约束，都是被这个项目的既有实现教训逼出来的：
 *   1. **单位是 UTF-8 字节，不是 token**：中文下一个字符占 3 字节，用字符数报会
 *      小看三倍；而分词后字节与 token 也不成比例。日志字段名与界面都要写明。
 *   2. **键名必须避开 `token`**：`sanitize` 会把键名匹配 `authorization|token|
 *      password|secret|api[_-]?key` 的**字符串值**掩码成 `***`，统计层会把
 *      `***` 判成不可还原。这里的值都是数字（数字不脱敏），名字也刻意不含 token。
 *
 * `calls` 是**检查过的 blob 数（含未命中）**——不这么记的话「压缩有效率」的分母
 * 会失真。全部为 0 时返回空对象：宁可整个字段缺席，也不写一个会被读成
 * 「压缩没效果」的 0。
 *
 * @param {{calls?:number, bytesBefore?:number, bytesAfter?:number, saved?:number,
 *          blocks?:number, filters?:string[]}} stats
 */
function rtkLogFields(stats) {
  if (!stats || !(Number(stats.calls) > 0)) return {};
  return {
    rtkCalls: Number(stats.calls) || 0,
    rtkBytesBefore: Number(stats.bytesBefore) || 0,
    rtkBytesAfter: Number(stats.bytesAfter) || 0,
    rtkSavedBytes: Number(stats.saved) || 0,
    rtkBlocks: Number(stats.blocks) || 0,
    ...(Array.isArray(stats.filters) && stats.filters.length
      ? { rtkFilters: stats.filters.join(',') } : {}),
  };
}

module.exports = { logRequest, sanitize, usageToLogFields, cacheReadOf, rtkLogFields };
