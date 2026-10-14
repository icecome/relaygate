'use strict';
/**
 * models/pricing-calib.js — 从官方账单反向标定「积分/token」系数，把 estimatedCost
 * 从「tier 猜测倍率」升级为账单实测的分模型费率。沿用 DSH @deepseek-ai/dsh-token-meter
 * 的四桶口径（uncachedInput / output / cacheRead / cacheWrite 互斥，usage 仅在四桶可精确
 * 加和时被采纳，normalizeUsage 拒绝总量对不上的样本），积分建模为
 * credits ≈ a·uncachedInput + b·output + c·cacheRead（系数单位：积分/token）。
 *
 * 数据源两路（官方口径，自动合并）：Trae 逐会话账单（trae-usage-cache/，行含 extra_info
 * 四桶与 credits_float，usage_group_details 单模型时可直接配对）；WorkBuddy 逐请求账单
 * （official-usage-cache/，行只含 credit + model + requestId，token 需与客户端日志
 * log/client-logs.js 的 usage、rawUsage.credit 按模型 + 时间窗配对）。当前先落地 Trae 一路。
 * 模型名查找前先归一化（小写、去空格、去正式版后缀与 @max 档位）再前缀匹配。
 * 取用顺序（peekCalibration）：标定系数 → catalog.consumption_rate → tier 倍率（rates.js）。
 *
 * 已验证标定质量（2026-10 实测，最小二乘，credits = a·unc + b·out + c·cacheRead）：
 *   GLM-5.3-Flash     n=780   R²=1.000000  maxAbsErr=0.0048 credit
 *   Qwen3.8-Flash     n=582   R²=1.000000  maxAbsErr=0.0002
 *   GLM-5.3-FlashX    n=78    R²=1.000000  maxAbsErr=0.0002
 *   DeepSeek-V4-Flash n=4730  R²=0.897（上游会话级聚合行有抹零与阶梯定价噪声，
 *                            逐请求账单平台（WB）同模型 R² 可到 0.94+）
 */
const fs = require('fs');
const path = require('path');
const { stateDir, legacyStateDir } = require('../lib/paths');
const { round4, round6, round8 } = require('../lib/round');

const CALIB_VERSION = 1;
const CALIB_TTL_MS = 6 * 60 * 60 * 1000; // 标定结果每 6 小时复算一次（账单是日级滞后数据）

let cache = null; // { at, map: { [normModel]: {uncached, output, cacheRead, n, r2} } }
let inflight = null;

/**
 * 模型名归一化：展示名 → 匹配键。
 *
 * 必须剥掉平台前缀：`wb/` 是 WorkBuddy 客户端约定的模型别名（请求里带、响应里也保留），
 * 而账单侧的模型名没有这个前缀（"glm-5.3-flash"）。不剥则归一化键成 "wb/glm5.3flash"，
 * 与标定表的 "wb:glm5.3flash" 前缀匹配失败，该模型的估算成本恒为 null——
 * 实测这让 WorkBuddy 全部请求的成本显示为 0。
 */
function normModel(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^wb\//, '')        // WorkBuddy 别名前缀
    .replace(/^openai:/, '')      // 内置 provider 标签前缀
    .replace(/@max$/, '')         // 档位后缀不参与费率区分（实测同价）
    .replace(/正式版|官方版/g, '')
    .replace(/[\s_-]+/g, '');
}

/**
 * 标定键 = 平台 + 模型名。
 *
 * 必须带平台：实测同名模型的费率跨平台不同（2026-10 账单标定，「glm-5.3-flash」
 * 在 Trae 未缓存输入 0.016/1k、在 WorkBuddy 0.0114/1k，相差约 30%）。
 * 只按模型名归一会把两个平台的样本混进同一次回归，产出谁都偏 15% 的系数。
 * 平台未知（'all'）时才退化为跨平台合并键。
 *
 * Qoder 也独立成键：它的模型名与 Trae/WorkBuddy 不重叠（qfmodel / qmodel_38max /
 * ultimate / smodel …），混键不会误命中，但归一化会把 "qmodel_38max" 与
 * "qmodel38max" 之类都压成同一串，独立前缀让日志与回归样本的可读性保持。
 */
function calibKey(model, platform) {
  const p = String(platform || 'all').toLowerCase();
  const scope = p === 'workbuddy' || p === 'wb'
    ? 'wb'
    : (p === 'qoder' ? 'qoder' : 'trae');
  return `${scope}:${normModel(model)}`;
}

/** 由归一化名找标定行：先全等，再前缀（账单名常比路由名长或短）。 */
function lookupIn(map, model, platform) {
  const key = normModel(model);
  if (!key) return null;
  const scoped = calibKey(model, platform);
  if (map[scoped]) return map[scoped];
  // 同平台内前缀匹配
  for (const [k, v] of Object.entries(map)) {
    if (!k.startsWith(`${scoped.split(':')[0]}:`)) continue;
    const rest = k.split(':').slice(1).join(':');
    if (rest.startsWith(key) || key.startsWith(rest)) return v;
  }
  // 平台未知或未命中：跨平台合并键
  const any = Object.entries(map)
    .map(([k, v]) => [k.split(':').slice(1).join(':'), v])
    .sort((a, b) => b[0].length - a[0].length);
  for (const [rest, v] of any) {
    if (rest.startsWith(key) || key.startsWith(rest)) return v;
  }
  return null;
}

// 数据源 1：Trae 会话账单缓存

function traeCacheDir() {
  const fresh = path.join(stateDir(), 'trae-usage-cache');
  if (fs.existsSync(fresh)) return fresh;
  const legacy = path.join(legacyStateDir(), 'trae-usage-cache');
  return fs.existsSync(legacy) ? legacy : fresh;
}

/** 读全部 Trae 账单行（单模型会话才可用于标定）。 */
function readTraeRows() {
  const dir = traeCacheDir();
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (!raw || !Array.isArray(raw.rows)) continue;
      for (const r of raw.rows) {
        if (!r || !Number.isFinite(Number(r.credits)) || Number(r.credits) <= 0) continue;
        if (!Array.isArray(r.byModel) || r.byModel.length !== 1) continue; // 混合模型会话不可配对
        rows.push({
          model: r.byModel[0].model,
          platform: 'trae',
          uncached: (Number(r.inputTokens) || 0) - (Number(r.cacheReadTokens) || 0),
          output: Number(r.outputTokens) || 0,
          cacheRead: Number(r.cacheReadTokens) || 0,
          credits: Number(r.credits),
        });
      }
    } catch { /* 单文件损坏跳过 */ }
  }
  return rows;
}

// 最小二乘（无截距；3 变量共线时自动降维）

/** 正规方程高斯消元；返回 null 表示奇异（样本不足或共线）。 */
function lstsq(A, b) {
  const n = A[0].length;
  if (A.length < n * 3) return null; // 样本量下限：每变量至少 3 行
  const ATA = Array.from({ length: n }, () => new Array(n).fill(0));
  const ATb = new Array(n).fill(0);
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < n; j++) {
      ATb[j] += A[i][j] * b[i];
      for (let k = 0; k < n; k++) ATA[j][k] += A[i][j] * A[i][k];
    }
  }
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(ATA[r][i]) > Math.abs(ATA[p][i])) p = r;
    if (Math.abs(ATA[p][i]) < 1e-12) return null;
    [ATA[i], ATA[p]] = [ATA[p], ATA[i]];
    [ATb[i], ATb[p]] = [ATb[p], ATb[i]];
    for (let r = i + 1; r < n; r++) {
      const f = ATA[r][i] / ATA[i][i];
      for (let k = i; k < n; k++) ATA[r][k] -= f * ATA[i][k];
      ATb[r] -= f * ATb[i];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = ATb[i];
    for (let k = i + 1; k < n; k++) s -= ATA[i][k] * x[k];
    x[i] = s / ATA[i][i];
  }
  return x;
}

/** 对一组样本标定三系数；任一桶共线时降维重试。系数为负（物理不可能）也判失败。 */
function calibrateOne(samples) {
  const mk = (keys) => lstsq(samples.map((s) => keys.map((k) => s[k])), samples.map((s) => s.credits));
  let x = mk(['uncached', 'output', 'cacheRead']);
  let used = ['uncached', 'output', 'cacheRead'];
  if (!x) { x = mk(['uncached', 'output']); used = ['uncached', 'output']; }
  if (!x) { x = mk(['uncached', 'output'].slice(0, 1)); used = ['uncached']; }
  if (!x) return null;
  if (x.some((v) => !Number.isFinite(v) || v < 0)) return null;
  // R²
  const mean = samples.reduce((s, v) => s + v.credits, 0) / samples.length;
  let ssr = 0, sst = 0;
  samples.forEach((s, i) => {
    const pred = used.reduce((acc, k, j) => acc + s[k] * x[j], 0);
    ssr += (s.credits - pred) ** 2;
    sst += (s.credits - mean) ** 2;
  });
  const r2 = sst > 0 ? 1 - ssr / sst : 0;
  const out = { n: samples.length, r2: Math.round(r2 * 1e6) / 1e6 };
  // 系数单位是「积分/token」（解出的 x 直接乘 token 数），量级 1e-5，round6 保留有效位
  used.forEach((k, j) => { out[k] = round6(x[j]); });
  // 未使用的桶补 0，保证调用方按键读取不出错
  for (const k of ['uncached', 'output', 'cacheRead']) if (!(k in out)) out[k] = 0;
  return out;
}

/** 主标定入口：两路账单合并标定，逐请求账单优先覆盖同模型会话账单结果。 */
function calibrateAll() {
  const map = {};
  // 低优先级：Trae 会话账单（会话级聚合行有抹零噪声，先占位）
  Object.assign(map, calibrateFromRows(readTraeRows()));
  // 高优先级：WorkBuddy 逐请求账单（粒度与单次调用一致，R² 更高）
  Object.assign(map, calibrateFromRows(readWorkbuddyRows()));
  return map;
}

/** 泛化的分组标定，供两路数据源复用（行需带 platform 字段）。 */
function calibrateFromRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = calibKey(r.model, r.platform);
    if (!normModel(r.model)) continue; // 空模型名（key 形如 'trae:'）无法标定
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const map = {};
  for (const [k, samples] of groups) {
    const c = calibrateOne(samples);
    if (c) map[k] = c;
  }
  return map;
}

/** 兼容旧调用名。 */
function calibrateFromTrae() {
  return calibrateFromRows(readTraeRows());
}

// 数据源 2：WorkBuddy 逐请求账单 × 客户端日志 usage

function wbCacheDir() {
  const fresh = path.join(stateDir(), 'official-usage-cache');
  if (fs.existsSync(fresh)) return fresh;
  const legacy = path.join(legacyStateDir(), 'official-usage-cache');
  return fs.existsSync(legacy) ? legacy : fresh;
}

/**
 * WorkBuddy 侧标定样本：来自客户端会话日志的逐请求 usage 与 rawUsage.credit。
 *
 * 官方账单接口（get-user-request-usage）只回 credit 不回 token，
 * 而客户端日志的 providerData 同时带 usage 与 rawUsage.credit——
 * 二者在同一行天然配对，无需按时间戳猜测，因此直接取客户端日志口径。
 *
 * 数据不可用（无日志目录或解析失败）时返回空集，标定自动只剩 Trae 一路。
 */
function readWorkbuddyRows() {
  try {
    const samples = require('../log/client-logs').collectCreditSamples();
    return samples
      .filter((s) => Number(s.credit) > 0 && (Number(s.input) + Number(s.output)) > 0)
      .map((s) => {
        const input = Number(s.input) || 0;
        const cacheRead = Math.min(Number(s.cacheRead) || 0, input);
        return {
          model: s.model,
          platform: 'workbuddy',
          uncached: input - cacheRead,
          output: Number(s.output) || 0,
          cacheRead,
          credits: Number(s.credit),
        };
      });
  } catch {
    return [];
  }
}

/**
 * 同步读取标定结果（无缓存则触发一次同步标定；文件 IO 小，可接受）。
 * @param {string} model 路由模型名
 * @param {string} [platform] 'trae'|'workbuddy'|...；未知则跨平台查找
 * @returns {{uncached:number, output:number, cacheRead:number, n:number, r2:number}|null}
 *   系数单位：积分 / token。
 */
function peekCalibration(model, platform) {
  const now = Date.now();
  if (!cache || now - cache.at > CALIB_TTL_MS) {
    try {
      cache = { at: now, map: calibrateAll() };
    } catch {
      cache = { at: now, map: {} };
    }
  }
  return lookupIn(cache.map, model, platform);
}

/**
 * 按标定系数估算积分（优先精度最高的口径）。
 * @param {string} model 路由模型名（展示名与 ID 均可，内部归一化）
 * @param {{uncached?:number, promptTokens?:number, completionTokens?:number, cacheRead?:number}} buckets
 * @param {string} [platform] 'trae'|'workbuddy'；跨平台费率不同，传了更准
 * @returns {number|null} 估算积分（4 位小数）；无标定时 null（调用方回退 tier 费率）
 */
function estimateCalibratedCost(model, buckets = {}, platform) {
  const c = peekCalibration(model, platform);
  if (!c) return null;
  const uncached = Number(buckets.uncached ?? buckets.promptTokens ?? 0) || 0;
  const output = Number(buckets.completionTokens ?? buckets.output ?? 0) || 0;
  const cacheRead = Number(buckets.cacheRead ?? 0) || 0;
  // 系数已是「积分/token」，直接乘；不再除 1000
  const credits = uncached * c.uncached + output * c.output + cacheRead * c.cacheRead;
  return credits > 0 ? round4(credits) : null;
}

/** 标定快照（管理端展示与调试）。 */
function snapshot() {
  peekCalibration('');
  return {
    version: CALIB_VERSION,
    calibratedAt: cache ? new Date(cache.at).toISOString() : null,
    models: cache ? cache.map : {},
  };
}

/**
 * 汇总换算比：token ↔ 积分。
 *
 * 精确换算比须按模型逐个算（三系数线性），不存在单一全局比值；面板需要一个
 * 「今天约 X token ≈ Y 积分」的概览读数，故用各标定模型回归样本中最近一天的账单总量加权，
 * 产出当日实测 tokens-per-credit 与 credits-per-1k-token，并标注样本覆盖的模型数。
 * 无任何标定（两路账单都空）时返回 null，前端显示「暂无标定」。
 */
function summarizeRatio() {
  const map = snapshot().models;
  let credits = 0;
  let tokens = 0;
  let asOf = null;
  const dir = traeCacheDir();
  if (fs.existsSync(dir)) {
    // 最近一个账单日（上游按会话写入文件有滞后，最近一天常常还没入账）
    const days = new Set();
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/(\d{4}-\d{2}-\d{2})\.json$/);
      if (m) days.add(m[1]);
    }
    asOf = [...days].sort().pop() || null;
    if (asOf) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(`-${asOf}.json`)) continue;
        try {
          for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')).rows || []) {
            const t = (Number(r.inputTokens) || 0) + (Number(r.outputTokens) || 0);
            if (t > 0 && Number(r.credits) > 0) {
              tokens += t;
              credits += Number(r.credits);
            }
          }
        } catch { /* 单文件损坏跳过 */ }
      }
    }
  }
  if (credits <= 0 || tokens <= 0) return null;
  return {
    /** 最近账单日：换算比所属的数据日期（账单有滞后，不是实时值） */
    asOf,
    credits: Math.round(credits * 100) / 100,
    tokens: Math.round(tokens),
    /** 积分 / 千 token（账单实测均值；跨数量级，8 位小数） */
    creditsPer1k: round8((credits / tokens) * 1000),
    /** token / 积分（账单实测均值） */
    tokensPerCredit: Math.round(tokens / credits),
    /** 标定表中的模型数 */
    models: Object.keys(map).length,
  };
}

function clearCache() {
  cache = null;
}

module.exports = {
  normModel,
  // 标定键的构造规则（平台前缀 + 归一化模型名）单独导出：
  // 「平台必须进键」这条约束靠单测锁定（实测跨平台同模型费率差约 30%）。
  calibKey,
  peekCalibration,
  estimateCalibratedCost,
  calibrateFromTrae,
  calibrateAll,
  readWorkbuddyRows,
  snapshot,
  summarizeRatio,
  clearCache,
  CALIB_TTL_MS,
};
