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
    if (/authorization|token|password|secret|api[_-]?key/i.test(k)) {
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
      const c = estimateCost(base.model, pt, ct);
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
 */
function usageToLogFields(u) {
  if (!u || typeof u !== 'object') return {};
  const pt = Number(u.prompt_tokens ?? u.inputTokens) || 0;
  const ct = Number(u.completion_tokens ?? u.outputTokens) || 0;
  const tt = Number(u.total_tokens ?? u.totalTokens) || (pt + ct);
  if (!pt && !ct && !tt) return {};
  return { promptTokens: pt, completionTokens: ct, totalTokens: tt };
}

module.exports = { logRequest, sanitize, usageToLogFields };
