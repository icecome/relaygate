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
 * 当前模型目录：远端优先，失败/空结果回退兜底表。
 *
 * ⚠️ 每次调用都会发一次上游请求（`model_catalog`），**不要放进热路径**。
 * 面板打开时拉一次、虚拟模型对话框打开时拉一次，这样的频率可以接受。
 * 需要缓存时由调用方自己缓存（本模块刻意不做隐式缓存 —— 与 catalog.js
 * 不同，Raccoon 的目录变化很慢，但「用户点了刷新就要真的刷新」更重要）。
 *
 * @returns {Promise<Array<{id:string,name:string,contextWindow:number,maxTokens:number,supportsImage:boolean}>>}
 */
async function catalog() {
  const acct = pickCatalogAccount();
  if (!acct) return product.fallbackCatalog();
  const auth = require('./auth');
  const r = await auth.fetchModelCatalog(acct);
  return r.models && r.models.length ? r.models : product.fallbackCatalog();
}

/** 兜底表（纯本地，不触网）。 */
function fallbackCatalog() {
  return product.fallbackCatalog();
}

module.exports = {
  catalog,
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
