'use strict';
/**
 * models/platform-ownership.js — 「某个模型名归哪个平台服务」的事实源与判定。
 *
 * ── 为什么需要它（2026-11-07 现场根因） ──
 * 本项目的「后端单个模型」调用此前被平台判定整片拒掉，症状是 403 + type=auth_error，
 * 客户端显示成「API 密钥失效」；而聚合虚拟模型（vm/*）照常可用——因为虚拟分支
 * 不做平台判定。两个叠加根因：
 *
 *   R1（数据侧，见 credentials/api-keys.js#ensureModelsReadScope）
 *      scope 迁移把 NULL scopes 写成 ["models:read"]，单模型调用缺 models:invoke。
 *
 *   R2（本模块负责）
 *      「WB 独有」判定只看 workbuddy/chat.js 的静态 WB_MODELS 名单。而实测
 *      （2026-11-07，scripts/probe-trae-models.js）：glm-5.3 / glm-5.2 / glm-5.1 /
 *      glm-4.7 / glm-4.6 / minimax-m3 / kimi-k2.6 / kimi-k2.5 / minimax-m2.5 ……
 *      **Trae 上游同样服务**（部分在 Trae 目录里是 hidden 项，但 llm_utils_chat 实测
 *      能正常返回）。只看 WB 名单 ⇒ 这些名字被误判成「WB 独占」⇒ Trae 平台密钥
 *      调它们一律 403 platform_mismatch ⇒ 「单个模型全废、只剩聚合模型可用」。
 *
 * ── 判定口径（证据优先，不靠单一硬编码名单） ──
 *   traeServes(id)   按证据强度取值：实测结论（最新事实，能推翻过期的登记表）
 *                    > Trae 上游目录（含 hidden 项）
 *                    > 本地 model-config 登记表
 *                    > 可用性表里「裸 id = usable」（调度探活写的就是 Trae 侧结论）
 *   wbServes(id)     同构：WB 实测结论 > WB 动态目录 > WB 静态名单
 *
 *   WB **独占** = wbServes ∧ ¬traeServes
 *     —— 判据单调：Trae 侧任何一条有效正向证据都会让它不再判独占。反向安全性
 *     由证据本身保证：hy3 / hunyuan-chat 这类名字 Trae 目录没有、登记表没有、
 *     实测明确失败（param is invalid），wbServes 成立而 traeServes 不成立，
 *     平台密钥调它们仍然被拒，不会越界消耗别家积分。
 *     不能只拿「Trae 目录没列」当独占证据——Trae 目录不完整（kimi-k2.6 /
 *     minimax-m2.5 不在里面，实测能调），那正是本次事故的形态。
 *
 * ── 为什么强调「证据」而不是「名单」 ──
 * 对标参照项目 Our Free Model 的做法：目录里出现「必然 401/400」的模型 id 比
 * 目录短更糟，所以它对每条候选做实测再决定是否展示。网关这边同一原则：平台归属
 * 判定必须建立在实测与上游目录之上，不能建立在一份会过期的硬编码名单上。
 *
 * ── 存储与热路径 ──
 * 事实存在 <workspaceDir>/.trae-api/model-ownership.json（目录快照 + 实测缓存）。
 * 本模块只读内存：平台判定在每请求热路径上，绝不能为了归属去发网络请求。
 * 冷启动读上一次运行留下的快照/实测记录，因此判定不随重启退化。
 *
 * 依赖方向：只依赖 config / lib/paths / lib/atomic-write / workbuddy/model-ids
 * （叶子），不依赖 catalog.js 与 model-access.js，无环。
 */
const fs = require('fs');
const config = require('../config');
const { stateFile } = require('../lib/paths');
const { writeJsonAtomic } = require('../lib/atomic-write');

const FILE = () => stateFile('model-ownership.json');
const STATE_VERSION = 2;

/** 实测结论的可用期限：超过则视为过期（仍可用，但不再算「明确不存在」）。 */
const PROBE_MAX_AGE_MS = Number(process.env.MODEL_OWNERSHIP_PROBE_TTL_MS || 7 * 24 * 3600 * 1000);

/** 目录快照的可用期限（仅用于诊断展示，不参与判定）。 */
const SNAPSHOT_MAX_AGE_MS = Number(process.env.MODEL_OWNERSHIP_TTL_MS || 3 * 24 * 3600 * 1000);

/** @type {null | {version:number, updatedAt?:string, trae?:{at:number, ids:string[], source?:string}, workbuddy?:{at:number, ids:string[], source?:string}, probes?:Record<string,{at:number, ok:boolean, platform:string, note?:string}>}} */
let state = null;
let stateLoaded = false;

/** 归一模型名：剥 `wb/` 前缀、剥 `@max` 档位后缀、转小写。 */
function normalizeId(model) {
  return String(model == null ? '' : model)
    .trim()
    .toLowerCase()
    .replace(/^wb\//, '')
    .replace(/@max$/i, '');
}

function loadState() {
  if (stateLoaded) return state;
  stateLoaded = true;
  try {
    if (fs.existsSync(FILE())) {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf-8'));
      if (raw && typeof raw === 'object') state = raw;
    }
  } catch { /* 坏文件按空状态处理，静态事实源仍然生效 */ }
  if (!state || typeof state !== 'object') state = { version: STATE_VERSION };
  if (!state.probes || typeof state.probes !== 'object') state.probes = {};
  return state;
}

function saveState() {
  state.version = STATE_VERSION;
  state.updatedAt = new Date().toISOString();
  try {
    writeJsonAtomic(FILE(), state, { newline: false });
    return true;
  } catch {
    return false;
  }
}

function idsOf(platform) {
  const s = loadState();
  const ent = s[platform];
  return ent && Array.isArray(ent.ids) ? ent.ids : [];
}

function sourceOf(platform) {
  const s = loadState();
  const ent = s[platform];
  return ent && ent.source ? ent.source : null;
}

/** 写入某一侧的目录快照（幂等、原子；空集合不写）。 */
function recordCatalog(platform, ids, source = 'unknown') {
  const list = [...new Set((ids || []).map(normalizeId).filter(Boolean))].sort();
  if (!list.length) return { ok: false, reason: 'empty' };
  const s = loadState();
  const prev = s[platform];
  const same = prev && Array.isArray(prev.ids) && prev.ids.length === list.length
    && prev.ids.every((v, i) => v === list[i]);
  if (same && Date.now() - (prev.at || 0) < 6 * 3600 * 1000) {
    return { ok: true, unchanged: true, count: list.length };
  }
  s[platform] = { at: Date.now(), ids: list, source };
  saveState();
  return { ok: true, count: list.length };
}

const recordTraeModels = (ids, source) => recordCatalog('trae', ids, source);
const recordWorkBuddyModels = (ids, source) => recordCatalog('workbuddy', ids, source);

/**
 * 记录一次实测结论。
 * @param {string} id 模型 id（裸名或 wb/ 前缀均可，内部归一）
 * @param {boolean} ok 是否成功
 * @param {{platform?:'trae'|'workbuddy', note?:string}} [meta]
 */
function recordProbe(id, ok, meta = {}) {
  const key = normalizeId(id);
  if (!key) return { ok: false, reason: 'empty' };
  const platform = meta.platform === 'workbuddy' ? 'workbuddy' : 'trae';
  const s = loadState();
  s.probes[key] = {
    at: Date.now(),
    ok: !!ok,
    platform,
    ...(meta.note ? { note: String(meta.note).slice(0, 200) } : {}),
  };
  saveState();
  return { ok: true };
}

/** 取某 id 的最新实测结论（含是否过期）。 */
function probeOf(id) {
  const s = loadState();
  const p = s.probes[normalizeId(id)];
  if (!p) return null;
  return { ...p, ageMs: Date.now() - (p.at || 0), stale: Date.now() - (p.at || 0) > PROBE_MAX_AGE_MS };
}

/** Trae 侧实测明确失败（未过期）——「这个模型 Trae 确实没有」的强证据。
 * 不参与 isWorkBuddyExclusive 的判定（那里只看正向证据的缺失），
 * 但用于诊断视图与脚本输出，说明「为什么判成 WB 独有」。 */
function traeConfirmedAbsent(id) {
  const p = probeOf(id);
  return !!p && !p.ok && p.platform === 'trae' && !p.stale;
}

/** Trae 侧静态事实源（model-config 登记表）。只作**弱证据**：它含上游已不服务的
 * 历史条目（如 deepseek-v4-pro 实测「model is unknown」），故不用于「Trae 不服务」
 * 的判定，仅用于「Trae 也许服务」的方向。 */
let _traeStaticCache = null;
let _traeStaticCacheAt = 0;
let _traeStaticSource = null;
function traeStaticIds() {
  const src = config.modelConfig;
  if (_traeStaticCache && _traeStaticSource === src && Date.now() - _traeStaticCacheAt < 30_000) {
    return _traeStaticCache;
  }
  const mc = (src && src.models) || {};
  const out = [];
  for (const [key, val] of Object.entries(mc)) {
    out.push(key);
    if (val && val.config_name) out.push(String(val.config_name));
  }
  _traeStaticCache = out.map(normalizeId);
  _traeStaticCacheAt = Date.now();
  _traeStaticSource = src;
  return _traeStaticCache;
}

/** WorkBuddy 侧的静态事实源（2026-09 实测目录，动态目录不可用时的兜底）。 */
let _wbStaticCache = null;
function wbStaticIds() {
  if (_wbStaticCache) return _wbStaticCache;
  try {
    _wbStaticCache = require('../workbuddy/model-ids').WB_MODELS.map(normalizeId);
  } catch {
    _wbStaticCache = [];
  }
  return _wbStaticCache;
}

/** 可用性表里「裸 id = usable」的条目（调度探活写在裸 id 上的就是 Trae 侧结论）。 */
let _availabilityCache = null;
let _availabilityCacheAt = 0;
function traeUsableIds() {
  const now = Date.now();
  if (_availabilityCache && now - _availabilityCacheAt < 30_000) return _availabilityCache;
  const out = [];
  try {
    const availability = require('./availability');
    for (const e of availability.snapshot()) {
      if (!e || e.status !== 'usable') continue;
      const id = normalizeId(e.id);
      // 裸 id（不带 wb/ 前缀）的可用记录 = Trae 侧结论
      if (!id.startsWith('wb/') && !String(e.id || '').toLowerCase().startsWith('wb/')) out.push(id);
    }
  } catch { /* 可用性表不可读时按无证据处理 */ }
  _availabilityCache = out;
  _availabilityCacheAt = now;
  return out;
}

/**
 * Trae 是否服务该模型名（正向证据）。
 *
 * 证据按**强度**排序，强的覆盖弱的：
 *   1. 实测结论（最强）：跑过一次真实调用，成功=服务、失败=不服务。
 *      它能推翻其它任何来源——本地登记表里的 deepseek-v4-pro 就是这类：
 *      登记表说它归 Trae，实测却是 "the model is unknown"。
 *   2. 上游目录快照（含 hidden 项）：上游自己声明的可用模型。
 *   3. 本地 model-config 登记表（弱）：网关把该名绑定到 Trae 上游，
 *      但可能已过期（上游下架后条目仍在）。
 *   4. 可用性表里「裸 id = usable」：调度探活写在裸 id 上的就是 Trae 侧结论。
 */
function traeServes(model) {
  const id = normalizeId(model);
  if (!id) return false;
  if (id === 'auto') return true; // 网关本地语义（inline_chat 通道）
  // 1) 实测结论优先：它是最新的事实，且能推翻过期登记表
  const p = probeOf(id);
  if (p && !p.stale && p.platform === 'trae') return !!p.ok;
  // 2) 上游目录快照
  if (idsOf('trae').includes(id)) return true;
  // 3) 本地登记表
  if (traeStaticIds().includes(id)) return true;
  // 4) 可用性表
  return traeUsableIds().includes(id);
}

/** WorkBuddy 是否服务该模型名（正向证据；实测结论同样优先于目录）。 */
function workBuddyServes(model) {
  const id = normalizeId(model);
  if (!id) return false;
  const p = probeOf(id);
  if (p && !p.stale && p.platform === 'workbuddy') return !!p.ok;
  if (idsOf('workbuddy').includes(id)) return true;
  if (wbStaticIds().includes(id)) return true;
  return false;
}

/**
 * 是否为 WorkBuddy **独占**模型（WB 服务、且没有任何**未过期**的证据表明
 * Trae 也服务）。
 *
 * 修复方向是单调的：Trae 侧任何一条有效正向证据（实测成功 / 上游目录含
 * hidden 项 / 本地登记表 / 可用性表裸 id = usable）都会让它**不再**被判独占。
 * 这正是 2026-11-07 事故的修复——Trae 目录不完整（kimi-k2.6 / minimax-m2.5
 * 实测能调却不在目录里）时，不能因为「目录没列」就把可用模型整片拒成 403。
 *
 * 过期实测（stale）不再当证据：一次「model is unknown」只是那天那批账号的结论，
 * 上游可能改配置，7 天后要让目录/登记表重新接管判定，而不是永久拉黑。
 */
function isWorkBuddyExclusive(model) {
  const id = normalizeId(model);
  if (!id || id === 'auto' || id === 'default') return false;
  if (!workBuddyServes(id)) return false;
  return !traeServes(id);
}

/**
 * 归属平台（供通用密钥分派）。
 *
 * 口径：
 * - `wb/` 前缀恒归 WorkBuddy（显式请求，不猜）
 * - Trae 有正向证据 → Trae（Trae 目录/实测/可用性表任一命中）
 * - 否则 WB 有正向证据 → WorkBuddy
 * - 两侧都无证据 → Trae（网关默认通道；失败时上游会回明确的模型不存在错误）
 */
function ownerPlatformOf(model) {
  const id = normalizeId(model);
  if (!id) return 'trae';
  if (String(model || '').trim().toLowerCase().startsWith('wb/')) return 'workbuddy';
  if (traeServes(id)) return 'trae';
  if (workBuddyServes(id)) return 'workbuddy';
  return 'trae';
}

/** 诊断视图：一个名字在两平台的证据与归属。 */
function explain(model) {
  const id = normalizeId(model);
  const p = probeOf(id);
  return {
    model: id,
    trae: traeServes(id),
    workbuddy: workBuddyServes(id),
    traeConfirmedAbsent: traeConfirmedAbsent(id),
    wbExclusive: isWorkBuddyExclusive(id),
    owner: ownerPlatformOf(id),
    probe: p ? { ok: p.ok, platform: p.platform, ageMs: p.ageMs, stale: p.stale, note: p.note || null } : null,
    catalog: {
      trae: idsOf('trae').includes(id),
      workbuddy: idsOf('workbuddy').includes(id),
      traeSource: sourceOf('trae'),
      workbuddySource: sourceOf('workbuddy'),
    },
  };
}

/** 快照与实测统计（面板/启动体检用，不触发网络）。 */
function stats() {
  const s = loadState();
  const probes = Object.entries(s.probes || {});
  return {
    file: FILE(),
    version: s.version || 0,
    updatedAt: s.updatedAt || null,
    trae: {
      count: idsOf('trae').length,
      at: s.trae ? s.trae.at : null,
      source: sourceOf('trae'),
      stale: s.trae ? Date.now() - s.trae.at > SNAPSHOT_MAX_AGE_MS : true,
    },
    workbuddy: {
      count: idsOf('workbuddy').length,
      at: s.workbuddy ? s.workbuddy.at : null,
      source: sourceOf('workbuddy'),
      stale: s.workbuddy ? Date.now() - s.workbuddy.at > SNAPSHOT_MAX_AGE_MS : true,
    },
    probes: {
      total: probes.length,
      ok: probes.filter(([, p]) => p.ok).length,
      failed: probes.filter(([, p]) => !p.ok).length,
    },
    staticTrae: traeStaticIds().length,
    staticWb: wbStaticIds().length,
  };
}

/** 仅供测试：重置内存状态，让下一次读取重新走文件。 */
function _resetForTest() {
  state = null;
  stateLoaded = false;
  _traeStaticCache = null;
  _wbStaticCache = null;
  _availabilityCache = null;
  _availabilityCacheAt = 0;
}

module.exports = {
  normalizeId,
  recordTraeModels,
  recordWorkBuddyModels,
  recordProbe,
  probeOf,
  traeServes,
  workBuddyServes,
  traeConfirmedAbsent,
  isWorkBuddyExclusive,
  ownerPlatformOf,
  explain,
  stats,
  PROBE_MAX_AGE_MS,
  SNAPSHOT_MAX_AGE_MS,
  _resetForTest,
};
