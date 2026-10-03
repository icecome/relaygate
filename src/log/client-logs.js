'use strict';
/**
 * log/client-logs.js — WorkBuddy 客户端会话日志扫描与 token 聚合。
 *
 * 背景：上游不回传 usage 时，网关侧统计覆盖率长期偏低（WorkBuddy 平台尤甚）。
 * 客户端会把每次调用的 usage 写进自己的会话日志，该数据源接近全量，
 * 因此单独作为「客户端消耗」一侧，与「网关转发」并列展示，两者不混算。
 *
 * 数据源：%USERPROFILE%\.workbuddy\projects\**\*.jsonl
 *   每条 assistant 行含 providerData.usage（驼峰）与 providerData.rawUsage（蛇形），
 *   两者实测完全等值，故 token 只取 usage 一份，避免重复计数；
 *   credit 仅存在于 rawUsage。
 *
 * 隐私约束：只提取 usage 数字与时间戳，绝不落盘消息正文、arguments 或认证信息。
 *
 * 性能：单机实测 235 个 jsonl、约 291 MB。按文件 mtime+size 做增量缓存，
 * 缓存粒度是「单文件聚合桶」，未变更的文件直接复用，避免每次全量读盘。
 */
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../lib/atomic-write');
const { stateDir, legacyStateDir } = require('../lib/paths');

/** 日志根目录。可用 WB_LOG_DIR 覆盖（测试或多机部署）。 */
function logRoot() {
  if (process.env.WB_LOG_DIR) return process.env.WB_LOG_DIR;
  return path.join(process.env.USERPROFILE || process.env.HOME || '', '.workbuddy', 'projects');
}

// 读优先新位置，旧位置兜底（缓存可重建，不做逐文件迁移）
const CACHE_DIR = () => {
  const fresh = path.join(stateDir(), 'client-log-cache');
  if (fs.existsSync(fresh)) return fresh;
  const legacy = path.join(legacyStateDir(), 'client-log-cache');
  return fs.existsSync(legacy) ? legacy : fresh;
};
const WRITE_DIR = () => path.join(stateDir(), 'client-log-cache');
/** 缓存结构版本。解析口径变更时递增，使旧缓存失效。 */
const CACHE_VERSION = 4;
const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);
const round4 = (n) => (Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0);

/** 递归收集 jsonl 文件（含 mtime/size，用于增量判定）。 */
function listJsonlFiles(root) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      try {
        const st = fs.statSync(p);
        out.push({ file: p, mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* 文件在枚举后被删除，跳过 */ }
    }
  };
  walk(root);
  return out;
}

/** 缓存文件名：路径哈希，避免层级与非法字符问题。 */
function cacheFileFor(file, dir) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha1').update(file).digest('hex').slice(0, 16);
  const base = path.basename(file, '.jsonl').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40);
  return path.join(dir || CACHE_DIR(), `${base}-${h}.json`);
}

/** 写入用的缓存路径：固定新目录，避免与旧目录交替读写出错。 */
function writeCacheFileFor(file) {
  return cacheFileFor(file, WRITE_DIR());
}

/**
 * 从一行日志中提取 usage（不读正文）。
 * 返回 { ts, model, requestId, input, output, cacheRead, cacheWrite, credit, total } 或 null。
 */
function extractUsage(o) {
  const pd = o && o.providerData;
  if (!pd || typeof pd !== 'object') return null;
  const u = pd.usage;
  if (!u || typeof u !== 'object') return null;

  const input = Number(u.inputTokens);
  const output = Number(u.outputTokens);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;

  // 缓存读：inputTokens 已含缓存读，单独记出仅用于算命中率，不并入合计
  const details = Array.isArray(u.inputTokensDetails) ? u.inputTokensDetails[0] : null;
  const cacheRead = details && Number.isFinite(Number(details.cached_tokens))
    ? Number(details.cached_tokens)
    : null;

  const raw = pd.rawUsage && typeof pd.rawUsage === 'object' ? pd.rawUsage : {};
  const creditRaw = Number(raw.credit);
  const cacheWriteRaw = Number(raw.prompt_cache_write_tokens);

  const ts = Number(o.timestamp);
  const totalRaw = Number(u.totalTokens);
  const total = Number.isFinite(totalRaw)
    ? totalRaw
    : (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);

  return {
    ts: Number.isFinite(ts) ? ts : null,
    model: pd.requestModelId || pd.model || 'unknown',
    // 去重键：一次 LLM 调用对应一条。注意不能用 conversationRequestId——
    // 那是「整轮对话」的 id，一轮 agentic 会含数十次独立调用，用它去重会把整轮压成 1 条。
    dedupKey: pd.messageId || o.callId || o.id || null,
    input: Number.isFinite(input) ? input : 0,
    output: Number.isFinite(output) ? output : 0,
    total,
    cacheRead: cacheRead || 0,
    cacheWrite: Number.isFinite(cacheWriteRaw) && cacheWriteRaw > 0 ? cacheWriteRaw : 0,
    credit: Number.isFinite(creditRaw) && creditRaw > 0 ? creditRaw : 0,
  };
}

/**
 * 解析单个 jsonl 文件的聚合桶。
 * 去重：同一 messageId/callId 在流式写入中可能重复出现（实测占比极低），
 * 保留 total 较大的一条。注意不能用 conversationRequestId 去重——那是整轮
 * 对话的 id，一轮 agentic 含数十次独立调用，用它去重会把整轮压成一条。
 * 只保留数字与日期键，不留正文。
 */
function parseFile(file, stat) {
  const bucket = {
    version: CACHE_VERSION,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    requests: 0,
    dupSkipped: 0,
    tokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    credit: 0,
    byDay: {},
    byModel: {},
    minTs: null,
    maxTs: null,
  };

  let text;
  try { text = fs.readFileSync(file, 'utf-8'); } catch { return bucket; }

  // 先按行抽取，再按 dedupKey 折叠成「每调用一条」
  const seen = new Map(); // dedupKey -> usage 记录
  let orphan = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const u = extractUsage(o);
    if (!u) continue;
    if (u.dedupKey) {
      const prev = seen.get(u.dedupKey);
      if (prev) bucket.dupSkipped++;
      if (!prev || u.total > prev.total) seen.set(u.dedupKey, u);
    } else {
      // 无去重键时按独立调用计入（极少见）
      seen.set(`_orphan_${orphan++}`, u);
    }
  }

  for (const u of seen.values()) {
    bucket.requests++;
    bucket.tokens += u.total;
    bucket.input += u.input;
    bucket.output += u.output;
    bucket.cacheRead += u.cacheRead;
    bucket.cacheWrite += u.cacheWrite;
    bucket.credit += u.credit;
    if (u.ts != null) {
      if (bucket.minTs == null || u.ts < bucket.minTs) bucket.minTs = u.ts;
      if (bucket.maxTs == null || u.ts > bucket.maxTs) bucket.maxTs = u.ts;
    }
    // 按日：用本地日期键，与网关侧 logs/<date> 口径一致
    if (u.ts != null) {
      const d = new Date(u.ts);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const bd = bucket.byDay[day] || (bucket.byDay[day] = { requests: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, credit: 0, byModel: {} });
      bd.requests++;
      bd.tokens += u.total;
      bd.input += u.input;
      bd.output += u.output;
      bd.cacheRead += u.cacheRead;
      bd.credit += u.credit;
      const dm = bd.byModel[u.model] || (bd.byModel[u.model] = { requests: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, credit: 0 });
      dm.requests++; dm.tokens += u.total; dm.input += u.input;
      dm.output += u.output; dm.cacheRead += u.cacheRead; dm.credit += u.credit;
    }
    const bm = bucket.byModel[u.model] || (bucket.byModel[u.model] = { requests: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, credit: 0 });
    bm.requests++;
    bm.tokens += u.total;
    bm.input += u.input;
    bm.output += u.output;
    bm.cacheRead += u.cacheRead;
    bm.credit += u.credit;
  }

  // 避免桶无限膨胀：按日明细只保留 400 天
  const days = Object.keys(bucket.byDay).sort();
  if (days.length > 400) {
    for (const d of days.slice(0, days.length - 400)) delete bucket.byDay[d];
  }
  return bucket;
}

function readCached(file, stat) {
  try {
    const f = cacheFileFor(file);
    if (!fs.existsSync(f)) return null;
    const raw = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if (!raw || raw.version !== CACHE_VERSION) return null;
    if (raw.mtimeMs !== stat.mtimeMs || raw.size !== stat.size) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCached(file, bucket) {
  writeJsonAtomic(writeCacheFileFor(file), bucket, { indent: 0, newline: false });
}

/**
 * 扫描全部日志并合并为一个结果。
 * @param {{root?:string, force?:boolean}} opts force=true 忽略缓存全量重解析
 */
function scan(opts = {}) {
  const root = opts.root || logRoot();
  if (!root || !fs.existsSync(root)) {
    return {
      available: false,
      root,
      reason: 'log directory not found',
      requests: 0, dupSkipped: 0, tokens: 0, input: 0, output: 0,
      cacheRead: 0, cacheWrite: 0, credit: 0,
      files: 0, cachedFiles: 0, parsedFiles: 0,
      byDay: [], byModel: [],
    };
  }

  const files = listJsonlFiles(root);
  const agg = {
    requests: 0, dupSkipped: 0, tokens: 0, input: 0, output: 0,
    cacheRead: 0, cacheWrite: 0, credit: 0,
    byDay: {}, byModel: {},
  };
  let cachedFiles = 0;
  let parsedFiles = 0;

  for (const f of files) {
    let bucket = opts.force ? null : readCached(f.file, f);
    if (bucket) cachedFiles++;
    else {
      bucket = parseFile(f.file, f);
      writeCached(f.file, bucket);
      parsedFiles++;
    }
    agg.requests += bucket.requests;
    agg.dupSkipped += bucket.dupSkipped;
    agg.tokens += bucket.tokens;
    agg.input += bucket.input;
    agg.output += bucket.output;
    agg.cacheRead += bucket.cacheRead;
    agg.cacheWrite += bucket.cacheWrite;
    agg.credit += bucket.credit;
    for (const [day, v] of Object.entries(bucket.byDay || {})) {
      const t = agg.byDay[day] || (agg.byDay[day] = { requests: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, credit: 0, byModel: {} });
      t.requests += v.requests; t.tokens += v.tokens; t.input += v.input;
      t.output += v.output; t.cacheRead += v.cacheRead; t.credit += v.credit;
      for (const [m, mv] of Object.entries(v.byModel || {})) {
        const tm = t.byModel[m] || (t.byModel[m] = { requests: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, credit: 0 });
        tm.requests += mv.requests; tm.tokens += mv.tokens; tm.input += mv.input || 0;
        tm.output += mv.output || 0; tm.cacheRead += mv.cacheRead || 0; tm.credit += mv.credit || 0;
      }
    }
    for (const [m, v] of Object.entries(bucket.byModel || {})) {
      const t = agg.byModel[m] || (agg.byModel[m] = { requests: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, credit: 0 });
      t.requests += v.requests; t.tokens += v.tokens; t.input += v.input;
      t.output += v.output; t.cacheRead += v.cacheRead; t.credit += v.credit;
    }
  }

  return {
    available: true,
    root,
    files: files.length,
    cachedFiles,
    parsedFiles,
    requests: agg.requests,
    dupSkipped: agg.dupSkipped,
    tokens: agg.tokens,
    input: agg.input,
    output: agg.output,
    cacheRead: agg.cacheRead,
    cacheWrite: agg.cacheWrite,
    credit: round2(agg.credit),
    cacheHitRate: agg.input ? round4(agg.cacheRead / agg.input) : 0,
    byDay: Object.entries(agg.byDay)
      .map(([date, v]) => ({
        date,
        requests: v.requests,
        tokens: v.tokens,
        input: v.input,
        output: v.output,
        cacheRead: v.cacheRead,
        credit: round2(v.credit),
        byModel: Object.fromEntries(Object.entries(v.byModel).map(([k, mv]) => [k, { requests: mv.requests, tokens: mv.tokens, credit: round2(mv.credit || 0) }])),
      }))
      .sort((a, b) => b.date.localeCompare(a.date)),
    byModel: Object.entries(agg.byModel)
      .map(([model, v]) => ({
        model,
        requests: v.requests,
        tokens: v.tokens,
        input: v.input,
        output: v.output,
        cacheRead: v.cacheRead,
        credit: round2(v.credit),
      }))
      .sort((a, b) => b.tokens - a.tokens),
  };
}

/** 清空解析缓存。 */
function clearCache() {
  try {
    // 两处都清，避免旧目录残留继续被读取
    fs.rmSync(WRITE_DIR(), { recursive: true, force: true });
    fs.rmSync(path.join(legacyStateDir(), 'client-log-cache'), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = { scan, clearCache, logRoot, CACHE_DIR, WRITE_DIR, CACHE_VERSION, extractUsage };
