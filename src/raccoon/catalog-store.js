'use strict';
/**
 * raccoon/catalog-store.js —— Raccoon 模型目录的**持久化快照** + 漂移对账。
 *
 * ## 这个文件为什么必须存在（2026-11-25 事故的直接产物）
 *
 * 事故现象：上游把 `sn-deepseek-v4-1-flash` 改名成 `…-1017`、`sn-kimi-k3`
 * 改成 `…-1-pro`，而网关稳定地把请求发到**旧名**上，每个请求都吃
 * `400 {"code":100004,"message":"param model unsupport"}`，再被重试逻辑
 * 放大成无效调用风暴，最终触发账号级风控（`200108`，3 小时不可用）。
 *
 * 复盘时发现的问题不是「忘了改名」，而是**架构上缺了一条链路**：
 *
 * | 链路 | 数据源 | 新鲜度 | 谁读它 |
 * |---|---|---|---|
 * | A. 模型列表 | 每次实时拉远端 | **永远新鲜** | `GET /v1/models`、`available-models` |
 * | B. 派发用的候选池 | `model-router.json`（静态） | **可能是几个月前的** | `model-router` 真实派发 |
 *
 * A 和 B 之间**没有任何同步机制**：
 *   - `POST /v1/models/refresh` 只刷 Trae 的 `models/catalog.js`，函数体里
 *     连 `raccoon` 这个词都没有；
 *   - `autotier.syncAutoTiers` 只拉 `trae` + `workbuddy` 两个平台，且只写
 *     `auto=true` 的分层虚拟模型 —— `raccoon` / `vm/raccoon` 是 `auto=false`，
 *     它根本不碰；
 *   - `explainCandidates` 的不可用理由只有「候选被禁用 / provider 缺失 /
 *     provider 被禁用 / 平台不允许 / 冷却中」，**没有「这个模型上游已不存在」**。
 *
 * 于是「刷新按钮能拉到新名字」和「派发还在用旧名字」可以同时为真，
 * 而面板上一片绿色（`usable: true`）。这就是本次事故的结构性成因。
 *
 * ## 本模块做三件事
 *
 * 1. **持久化远端目录**（`.trae-api/raccoon-catalog.json`）：让「上次见到的
 *    上游目录」成为一个可查、可 diff 的事实，而不是每次拉完就丢。
 *    冷启动或远端暂时不可达时，回退顺序是 快照 → 硬编码兜底表。
 * 2. **漂移对账**（{@link reconcile}）：把快照/远端目录与虚拟模型的候选池比对，
 *    产出「哪些候选的模型上游已不存在 / 有哪些上游新模型没进池子」。
 * 3. **候选重写**（{@link reconcileCandidates}）：把**可迁移**的旧 id 换成现行 id
 *    （只认 `product.LEGACY_MODEL_ALIASES` 这张显式迁移表），并把无法迁移的
 *    候选**禁用而不是删除** —— 删掉会丢用户的权重/置顶/优先级，禁用可回滚。
 *
 * ## 为什么「自动改名」要受限
 *
 * 上游对旧名有一种更危险的行为：带 `X-Client-Name: Raccoon` 头时，旧名
 * **不报错**，而是被静默改写成默认模型 `raccoon-090dd3` 返回 200 ——
 * 你以为在跑 DeepSeek-V4.1-Flash（x0.25），实际在跑默认模型（x1）。
 * 计费与能力全变，而日志里看起来一切正常。
 *
 * 所以本模块**只按显式迁移表改名**（那是「同一个模型的改名」，语义等价），
 * 对**没有迁移记录**的失联模型只做「禁用 + 上报」，绝不猜。
 *
 * @module src/raccoon/catalog-store
 */

const fs = require('fs');
const { writeJsonAtomic } = require('../lib/atomic-write');
const { stateFile, resolveStateFileForRead } = require('../lib/paths');
const product = require('./product');

/** 快照文件名（相对 .trae-api）。 */
const SNAPSHOT_NAME = 'raccoon-catalog.json';

/**
 * 快照的默认 TTL。
 *
 * 取 10 分钟与 Trae 的 `MODEL_CATALOG_TTL_MS` 同口径：Raccoon 目录变化很慢
 * （实测两次改名的间隔以月计），但「用户点了刷新就要真的刷新」更重要 ——
 * 所以 TTL 只用于**自动**路径（列表渲染），`force:true` 一律穿透。
 */
const SNAPSHOT_TTL_MS = Number(process.env.RACCOON_CATALOG_TTL_MS || 10 * 60 * 1000);

/** 进程内缓存（避免每次列表渲染都读盘 + 解析 JSON）。 */
let cache = null;

/** 快照文件路径（写固定新位置）。 */
function snapshotPath() {
  return stateFile(SNAPSHOT_NAME);
}

/**
 * 读路径：新位置优先，其次旧位置（升级用户不丢快照）。
 *
 * ⚠️ 必须把 `fs.existsSync` 传进去：`resolveStateFileForRead` 不传 exists 时
 * 只是返回候选列表的**第一个**（不做存在性探测），那样旧位置的回退形同虚设。
 */
function readPath() {
  try {
    return resolveStateFileForRead(SNAPSHOT_NAME, fs.existsSync) || snapshotPath();
  } catch {
    return snapshotPath();
  }
}

/**
 * 读快照。文件不存在 / 解析失败 / 结构非法都返回 null（**不抛错**）。
 *
 * 为什么容错到这个程度：快照是**可重建**的派生数据，它坏掉的正确处置是
 * 「当作没有，重新拉一次」，而不是让整个模型列表端点 500。
 *
 * @returns {{syncedAt:string, at:number, source:string, models:Array, drift:object|null}|null}
 */
function readSnapshot() {
  if (cache) return cache;
  const file = readPath();
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.models) || !raw.models.length) return null;
    // 只保留结构合法的条目：远端字段偶有缺失，坏一条不该让整份快照作废
    const models = raw.models.filter((m) => m && typeof m.id === 'string' && m.id.length > 0);
    if (!models.length) return null;
    cache = {
      syncedAt: typeof raw.syncedAt === 'string' ? raw.syncedAt : new Date(raw.at || 0).toISOString(),
      at: Number(raw.at) || 0,
      source: typeof raw.source === 'string' ? raw.source : 'remote',
      models,
      drift: raw.drift && typeof raw.drift === 'object' ? raw.drift : null,
    };
    return cache;
  } catch {
    return null;
  }
}

/**
 * 写快照（原子写；失败只告警，不影响调用方）。
 *
 * @param {{models:Array, source?:string, drift?:object|null}} payload
 * @returns {object|null} 写入后的快照；失败返回 null
 */
function writeSnapshot(payload) {
  const models = Array.isArray(payload && payload.models) ? payload.models : [];
  if (!models.length) return null;
  const snap = {
    syncedAt: new Date().toISOString(),
    at: Date.now(),
    source: payload.source || 'remote',
    models,
    drift: payload.drift || null,
  };
  const ok = writeJsonAtomic(snapshotPath(), snap, { newline: false });
  if (!ok) {
    console.warn('[raccoon] 模型目录快照写入失败（不影响本次请求，下次会重试）');
    return null;
  }
  cache = snap;
  return snap;
}

/** 清进程内缓存（测试与「强制刷新」用）。 */
function clearCache() {
  cache = null;
}

/**
 * 快照是否仍在 TTL 内。
 * @param {number} [now]
 */
function isFresh(snap, now = Date.now()) {
  if (!snap || !snap.at) return false;
  return now - snap.at < SNAPSHOT_TTL_MS;
}

/* ---------- 对账 ---------- */

/**
 * 把「上游现行目录」与「某个虚拟模型的候选列表」对账。
 *
 * 三条产出，语义互不重叠：
 *   - `renamed`：旧 id 在显式迁移表里 → 应改写成现行 id（**语义等价**）；
 *   - `missing`：上游已没有、且无迁移记录 → 应**禁用**（不能猜它变成了谁）；
 *   - `available`：上游有、但候选池里没有 → 只是信息，供用户决定要不要加。
 *
 * @param {Array<{id:string}>} remoteModels 上游现行目录
 * @param {Array<{id?:string, provider?:string, model?:string, enabled?:boolean}>} candidates
 * @param {{provider?:string}} [opts] 只对账该 provider 的候选（默认 raccoon）
 * @returns {{renamed:Array, missing:Array, available:Array, ok:boolean}}
 */
function reconcile(remoteModels, candidates, opts = {}) {
  const provider = opts.provider || 'raccoon';
  const remote = new Set(
    (Array.isArray(remoteModels) ? remoteModels : [])
      .map((m) => (m && typeof m.id === 'string' ? m.id : ''))
      .filter(Boolean),
  );
  const inPool = new Set();
  const renamed = [];
  const missing = [];
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!c || c.provider !== provider) continue;
    const model = typeof c.model === 'string' ? c.model : '';
    if (!model) continue;
    inPool.add(model);
    if (remote.has(model)) continue;
    const target = product.LEGACY_MODEL_ALIASES[model];
    if (target && remote.has(target)) {
      renamed.push({ id: c.id, from: model, to: target });
    } else {
      missing.push({ id: c.id, model, enabled: c.enabled !== false });
    }
  }
  // `available`（上游有、池子里没有）只在**该虚拟模型本来就用了 raccoon 候选**
  // 时才有意义。对没有任何 raccoon 候选的虚拟模型（如纯 Trae 的 vm/unified-chat）
  // 把全部远端模型都列成「可新增」，是纯噪声 —— 用户没打算在这个入口用 Raccoon。
  //
  // 另外要排除**改名目标**：`sn-deepseek-v4-1-flash-1017` 对旧名池子来说确实
  // 「池里没有」，但它马上会由 rename 补进来，再报成「上游新增」是重复信息。
  const renameTargets = new Set(renamed.map((r) => r.to));
  const available = [];
  if (inPool.size > 0) {
    for (const id of remote) {
      if (inPool.has(id) || renameTargets.has(id)) continue;
      available.push({ model: id });
    }
  }
  return { renamed, missing, available, ok: renamed.length === 0 && missing.length === 0 };
}

/**
 * 按对账结果**重写候选列表**（纯函数，不改外部状态）。
 *
 * 处置原则：
 *   - 可迁移 → 改写 `model` 与 `id`（`id` 是候选的稳定标识，不跟着改会与
 *     其他候选撞键；`provider:model` 是 `store.normalizeVirtual` 的默认 id 规则）；
 *   - 不可迁移 → `enabled: false`（**保留**权重/置顶/优先级，用户可回滚）；
 *   - 已在上游目录里的候选 → 保持原样（用户手工禁用过的不复活）。
 *
 * @param {Array} candidates 原始候选
 * @param {{renamed:Array, missing:Array}} plan reconcile() 的产出
 * @param {{provider?:string}} [opts]
 * @returns {{candidates:Array, changed:boolean, renamedCount:number, disabledCount:number}}
 */
function applyReconcile(candidates, plan, opts = {}) {
  const provider = opts.provider || 'raccoon';
  const renameOf = new Map((plan && plan.renamed || []).map((r) => [r.from, r.to]));
  const missingSet = new Set((plan && plan.missing || []).map((m) => m.model));
  let renamedCount = 0;
  let disabledCount = 0;
  const out = (Array.isArray(candidates) ? candidates : []).map((c) => {
    if (!c || c.provider !== provider) return c;
    const model = typeof c.model === 'string' ? c.model : '';
    const to = renameOf.get(model);
    if (to) {
      renamedCount += 1;
      return {
        ...c,
        model: to,
        // id 只在「它仍是默认派生值」时跟着改，避免覆盖用户自定义的 id。
        id: c.id === `${provider}:${model}` || c.id === model ? `${provider}:${to}` : c.id,
      };
    }
    if (missingSet.has(model) && c.enabled !== false) {
      disabledCount += 1;
      return { ...c, enabled: false };
    }
    return c;
  });
  return {
    candidates: out,
    changed: renamedCount > 0 || disabledCount > 0,
    renamedCount,
    disabledCount,
  };
}

module.exports = {
  SNAPSHOT_NAME,
  SNAPSHOT_TTL_MS,
  snapshotPath,
  readSnapshot,
  writeSnapshot,
  clearCache,
  isFresh,
  reconcile,
  applyReconcile,
};
