'use strict';
/**
 * raccoon/index.js —— Raccoon 渠道的**聚合入口**（供不关心实现分层的调用方使用）。
 *
 * ## 为什么要有这一层
 *
 * `raccoon/` 下分了 product（纯函数）/ client（HTTP）/ auth（登录续期）/
 * credits（积分）/ chat（对话）/ dispatch（池调度）/ stream（流式出口）/
 * limiter（闸门）八个模块，各自职责清晰。但**目录类**调用方（`routes/models`、
 * `routes/model-router`）只需要回答一个问题：「这个渠道现在有哪些模型」——
 * 它不该知道要先 pickAccount、再 fetchModelCatalog、再解析远端形状。
 *
 * 所以这里提供两个稳定的入口：
 *   - {@link catalog}        —— 当前可用模型列表（远端优先，失败回退兜底表）
 *   - {@link fallbackCatalog} —— 兜底表（不触网，纯本地）
 *
 * ⚠️ 这层**不做权限判断**（不判有没有账号、该不该显示）。调用方各自判：
 * 转发面按密钥平台过滤，面板按有无启用账号过滤。理由：这两个判断的判据
 * 本就不同（一个是 key 的 platform，一个是库里的账号），合并到这里会让
 * 调用方失去区分能力。
 *
 * @module src/raccoon
 */

const product = require('./product');
const catalogStore = require('./catalog-store');
const store = require('../credentials/store');
const variant = require('../platform/variant');

/**
 * 取一个可用的 Raccoon 账号（用于拉目录这类只读操作）。
 * @returns {object|null} 完整账号记录（含明文 token）
 */
function pickCatalogAccount() {
  const cand = store.list()
    .filter((a) => a.enabled && variant.isEdition(a.edition, variant.RACCOON))
    .sort((x, y) => (x.lastPickedAt || 0) - (y.lastPickedAt || 0))[0];
  return cand ? store.get(cand.id) : null;
}

/** 该渠道是否有已启用的账号。 */
function hasAccount() {
  return store.list().some((a) => a.enabled && variant.isEdition(a.edition, variant.RACCOON));
}

/**
 * 当前模型目录：远端优先 → 持久化快照 → 兜底表。
 *
 * ## 2026-11-25：加持久化快照（改这段之前必读）
 *
 * 此前本函数「每次调用都真拉远端、拉完就丢」。这让**列表**永远新鲜，
 * 但也意味着「上次见到的上游目录」这个事实**在进程里活不过一次请求**——
 * 而真正决定请求发到哪里的，是 `model-router.json` 里那份静态候选池。
 * 两者之间没有任何同步，于是上游改名后可以出现「列表显示新名字、
 * 派发还在用旧名字、面板一片绿色」的状态（本次事故即此）。
 *
 * 现在每次成功拉取都会落一份快照（`.trae-api/raccoon-catalog.json`），
 * 于是：
 *   - 冷启动/远端暂时不可达时，回退顺序是 **快照 → 兜底表**（快照比硬编码新）；
 *   - 快照本身成为「漂移对账」的事实源（见 {@link refreshCatalog}）。
 *
 * `force:true` 一律穿透 TTL 直连远端（「用户点了刷新就要真的刷新」）。
 *
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<Array<{id:string,name:string,contextWindow:number,maxTokens:number,supportsImage:boolean}>>}
 */
async function catalog(opts = {}) {
  const force = opts.force === true;
  const snap = catalogStore.readSnapshot();
  // TTL 内的快照直接复用：列表渲染不该每次都打上游（面板一次刷新会并发好几个请求）
  if (!force && catalogStore.isFresh(snap)) return snap.models;

  const acct = pickCatalogAccount();
  if (!acct) {
    // 没有账号时远端拉不了：快照比硬编码兜底表更接近事实
    return (snap && snap.models.length) ? snap.models : product.fallbackCatalog();
  }
  const auth = require('./auth');
  const r = await auth.fetchModelCatalog(acct);
  if (r.models && r.models.length) {
    if (r.source === 'remote') catalogStore.writeSnapshot({ models: r.models, source: 'remote', drift: r.drift || null });
    return r.models;
  }
  return (snap && snap.models.length) ? snap.models : product.fallbackCatalog();
}

/** 兜底表（纯本地，不触网）。 */
function fallbackCatalog() {
  return product.fallbackCatalog();
}

/**
 * **强制刷新上游目录 + 对账 + 按需重写候选池**（「刷新」按钮与运维脚本的入口）。
 *
 * 这是把「链路 A（列表）」与「链路 B（派发候选池）」接起来的那一步 ——
 * 此前不存在，是 2026-11-25 事故的结构性成因。
 *
 * 做四件事，顺序固定：
 *   1. 真拉远端（`force`），失败就用快照，都没有则直接报错（不猜）；
 *   2. 落快照（让下次冷启动/远端不可达时有事实可用）；
 *   3. 对账每个虚拟模型的 raccoon 候选：可迁移的改名、失联的禁用、新模型上报；
 *   4. `apply` 为真时把改动写回 `model-router.json`（默认**写**，因为调用方
 *      就是「刷新」按钮；脚本想只看不写可传 `apply:false`）。
 *
 * ## 为什么不自动把「上游新增模型」加进候选池
 *
 * 加进去意味着用户的路由**行为**会因上游上新而改变（可能选到更贵/更弱的模型），
 * 那是产品决策不是同步。所以新增模型只在返回值里上报，由面板提示用户手动加。
 * 反过来「改名」与「失联」必须自动处置：前者语义等价，后者继续派发只会 400。
 *
 * @param {{apply?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, source:string, syncedAt:string|null, count:number,
 *   error:string|null, applied:boolean,
 *   changes:Array<{virtualId:string, renamed:Array, missing:Array, available:Array}>,
 *   totals:{renamed:number, disabled:number, available:number}}>}
 */
async function refreshCatalog(opts = {}) {
  const apply = opts.apply !== false;
  const auth = require('./auth');
  const store2 = require('../model-router/store');

  let models = [];
  let source = 'none';
  let error = null;
  const acct = pickCatalogAccount();
  if (acct) {
    const r = await auth.fetchModelCatalog(acct);
    if (r.source === 'remote' && r.models && r.models.length) {
      models = r.models;
      source = 'remote';
      catalogStore.writeSnapshot({ models, source: 'remote', drift: r.drift || null });
    } else {
      error = '远端目录拉取失败（账号可能已被风控处置或网络不可达）';
    }
  } else {
    error = '没有已启用的 Raccoon 账号，无法拉取远端目录';
  }
  if (!models.length) {
    const snap = catalogStore.readSnapshot();
    if (snap && snap.models.length) {
      models = snap.models;
      source = 'snapshot';
    } else {
      return {
        ok: false, source, syncedAt: null, count: 0, error, applied: false,
        changes: [], totals: { renamed: 0, disabled: 0, available: 0 },
      };
    }
  }

  const changes = [];
  const totals = { renamed: 0, disabled: 0, available: 0 };
  for (const vm of store2.listVirtual()) {
    const plan = catalogStore.reconcile(models, vm.candidates || []);
    if (plan.ok && !plan.available.length) continue;
    totals.renamed += plan.renamed.length;
    totals.disabled += plan.missing.length;
    totals.available += plan.available.length;
    if (!plan.renamed.length && !plan.missing.length) {
      // 只有「上游新增」：不写盘，仅上报
      changes.push({ virtualId: vm.id, renamed: [], missing: [], available: plan.available, applied: false });
      continue;
    }
    const next = catalogStore.applyReconcile(vm.candidates || [], plan);
    if (apply && next.changed) {
      const r = store2.setVirtualCandidates(vm.id, next.candidates);
      if (!r.ok) {
        console.warn(`[raccoon] 候选池回写失败 ${vm.id}: ${r.message}`);
        changes.push({ virtualId: vm.id, renamed: plan.renamed, missing: plan.missing, available: plan.available, applied: false });
        continue;
      }
    }
    changes.push({ virtualId: vm.id, renamed: plan.renamed, missing: plan.missing, available: plan.available, applied: apply && next.changed });
  }

  return {
    ok: true,
    source,
    syncedAt: (catalogStore.readSnapshot() || {}).syncedAt || null,
    count: models.length,
    error,
    applied: apply,
    changes,
    totals,
  };
}

module.exports = {
  catalog,
  refreshCatalog,
  catalogStore,
  fallbackCatalog,
  hasAccount,
  pickCatalogAccount,
  // 透传常用子模块，让调用方不必记住路径（如 `raccoon.product` 直接可用）。
  //
  // ⚠️ 注释里不要写出指向本目录聚合入口的相对 require 语句。
  // src/test/unit.test.js 的「全库无双向依赖」扫描用正则匹配源码中所有
  // 相对路径 require（**注释也会被匹配**），写进去会让本文件与自己构成自环。
  // 需要表达「从这里可以取到 X」时，写模块名而不是 require 语句的字面形态。
  product,
  chat: require('./chat'),
  dispatch: require('./dispatch'),
  limiter: require('./limiter'),
  stream: require('./stream'),
};
