'use strict';
/**
 * log/traffic.js — 请求级流量日志。
 * 1) 控制台一行 JSON（结构化）
 * 2) logs/YYYY-MM-DD/traffic.jsonl 追加
 * 3) 仍可选逐条 JSON（LEGACY_TRAFFIC_FILES=true）
 */
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../lib/atomic-write');
const { maskSecret } = require('../lib/mask');
const config = require('../config');
const { estimateCost } = require('../models/rates');

const ROOT = path.resolve(__dirname, '..', '..');
let seq = 0;
// 已确认存在的日志目录。跨日时才变化，避免每请求一次 mkdir syscall。
let ensuredDir = null;

function todayDir() {
  const d = new Date();
  return path.join(ROOT, 'logs', d.toISOString().slice(0, 10));
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
 * @param {object} entry
 */
function logRequest(entry) {
  try {
    seq += 1;
    const base = {
      ts: new Date().toISOString(),
      seq,
      tag: 'traffic',
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
    // 打一行会让它持续增长；traffic.jsonl 已完整留档，面板也有流量视图，
    // 故默认不重复写 stdout。
    if (config.logLevel === 'debug') console.log(JSON.stringify(line));

    // jsonl 追加：保持同步写（面板读取与失效判定都依赖「写完即可见」），
    // 但去掉每请求一次的 mkdir syscall
    const dir = todayDir();
    ensureDir(dir);
    fs.appendFileSync(path.join(dir, 'traffic.jsonl'), JSON.stringify(line) + '\n', 'utf-8');
    // 增量失效统计缓存（当日聚合失效，下次面板请求时重建）
    try {
      require('./stats-cache').invalidateDay();
    } catch { /* 缓存失效失败不影响日志 */ }

    // 可选旧格式逐文件
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
 * cacheReadTokens（缓存读）单独抽出：标定费率对「未缓存输入 / 输出 / 缓存读」
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

module.exports = { logRequest, sanitize, usageToLogFields, cacheReadOf };
