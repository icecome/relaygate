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

function todayDir() {
  const d = new Date();
  return path.join(ROOT, 'logs', d.toISOString().slice(0, 10));
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

    // 控制台一行
    console.log(JSON.stringify(line));

    // jsonl 追加
    const dir = todayDir();
    fs.mkdirSync(dir, { recursive: true });
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

module.exports = { logRequest, sanitize };
