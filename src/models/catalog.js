'use strict';
/**
 * models/catalog.js — 从 Trae 上游 get_detail_param 动态同步模型目录。
 *
 * 上游：POST {host}/api/ide/v1/get_detail_param（与 Trae 客户端拉模型配置同源）
 * 字段含义（实测）：
 * - config_source=1：平台官方配置
 * - config_source=3 且 is_custom_model=true：账号内用户自定义模型
 *
 * 默认只暴露官方模型；includeCustom=true 时一并返回自定义。
 * 过滤 custom_model_* 占位、工具配置、invisible、关闭项。
 * 缓存 TTL 内复用；上游失败回退本地 model-config.json。
 */
const config = require('../config');
const { getModelDetailParam } = require('../upstream/client');
const availability = require('./availability');

const CACHE_TTL_MS = Number(process.env.MODEL_CATALOG_TTL_MS || 10 * 60 * 1000);

/** 工具/内部配置：不作为对外可调用模型暴露。 */
const TOOL_CONFIGS = new Set([
  'summary',
  'fast_apply',
  'fast_apply_new',
  'title_generation',
  'input_optimization',
]);

let cache = null;
let inflight = null;

function isHiddenConfigName(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return true;
  if (n.startsWith('custom_model')) return true;
  if (TOOL_CONFIGS.has(n)) return true;
  return false;
}

/** 是否为账号内用户自定义模型（非平台官方）。 */
function isUserCustom(item) {
  if (item.is_custom_model === true) return true;
  const src = item.config_source;
  if (src != null && Number(src) !== 1) return true;
  return false;
}

/** 解析 display_contact_config 中的真实积分消耗率。 */
function parseContactRate(raw) {
  if (!raw || typeof raw !== 'string') return { rate: null, afterRate: null, discounted: false };
  let contact;
  try { contact = JSON.parse(raw); } catch { return { rate: null, afterRate: null, discounted: false }; }
  const cr = contact && contact.consumption_rate;
  const rate = cr && cr.enable && cr.data && typeof cr.data.rate === 'number' ? cr.data.rate : null;
  const act = contact && contact.activity_discount;
  const d = act && act.enable && act.data;
  const limited = d && (d.limited || d.current);
  const afterRate = limited && typeof limited.after_consumption_rate === 'number'
    ? limited.after_consumption_rate
    : (d && d.current && typeof d.current.consumption_rate === 'number' ? d.current.consumption_rate : null);
  return {
    rate,
    afterRate: afterRate != null ? afterRate : null,
    discounted: !!(afterRate != null && rate != null && afterRate < rate),
  };
}

function normalizeItem(item) {
  if (!item || !item.config_name) return null;
  if (item.config_switch === false) return null;
  if (item.is_invisible_to_user === true) return null;
  if (isHiddenConfigName(item.config_name)) return null;

  const dc = item.display_config || {};
  const capability = dc.model_capability || '';
  if (capability && capability !== 'chat_model' && capability !== 'reasoning_model') {
    return null;
  }

  const rateInfo = parseContactRate(item.display_contact_config);
  return {
    id: item.config_name,
    display_name: dc.display_name || item.config_name,
    capability: capability || null,
    multimodal: !!dc.multimodal,
    reasoning: capability === 'reasoning_model',
    custom: isUserCustom(item),
    config_source: item.config_source != null ? Number(item.config_source) : null,
    feeLevel: dc.fee_model_level != null ? Number(dc.fee_model_level) : null,
    // 真实积分消耗倍率（display_contact_config.consumption_rate）；afterRate 为折扣后
    rate: rateInfo.rate,
    afterRate: rateInfo.afterRate,
    discounted: rateInfo.discounted,
  };
}

/**
 * 提取可见模型（含官方+自定义，带 custom 标记）。
 * 同名（忽略大小写）优先官方；官方内优先独立 display_name。
 */
function pickFromList(list) {
  const byKey = new Map();
  for (const raw of list || []) {
    const m = normalizeItem(raw);
    if (!m) continue;
    const key = m.id.toLowerCase();
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, m);
      continue;
    }
    const score = (x) => {
      let s = 0;
      if (!x.custom) s += 10;
      if (x.display_name && x.display_name !== x.id) s += 2;
      if (x.capability === 'chat_model') s += 1;
      if (x.reasoning) s += 0.5;
      return s;
    };
    if (score(m) > score(prev)) byKey.set(key, m);
  }
  return Array.from(byKey.values()).sort((a, b) => {
    if (!!a.custom !== !!b.custom) return a.custom ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
}

function fromLocalConfig() {
  const ids = Object.keys(config.modelConfig.models || {});
  if (!ids.length) {
    return [{
      id: 'auto',
      display_name: 'auto',
      capability: 'chat_model',
      multimodal: false,
      reasoning: false,
      custom: false,
      config_source: null,
    }];
  }
  return ids.map((id) => {
    const v = config.modelConfig.models[id] || {};
    return {
      id,
      display_name: v.display_name || id,
      capability: v.reasoning ? 'reasoning_model' : 'chat_model',
      multimodal: !!v.multimodal,
      reasoning: !!v.reasoning,
      custom: false,
      config_source: null,
      scene: v.scene || null,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

async function loadCatalog({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) {
    return cache;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const detail = await getModelDetailParam('chat_v3');
      const models = pickFromList(detail && detail.config_info_list);
      if (!models.length) throw new Error('upstream catalog empty');
      cache = {
        at: Date.now(),
        models,
        source: 'upstream',
        endpoint: 'get_detail_param',
        hostNote: 'Trae 官方模型配置接口（与客户端同源）',
      };
      return cache;
    } catch (err) {
      console.warn(`[models] catalog upstream failed: ${err.message}; fallback local`);
      cache = {
        at: Date.now(),
        models: fromLocalConfig(),
        source: 'local',
        error: err.message,
        endpoint: null,
        hostNote: '本地 model-config.json 回退',
      };
      return cache;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * 合并可用性状态。
 * @param {{force?:boolean, includeCustom?:boolean}} opts
 */
async function listWithStatus({ force = false, includeCustom = false } = {}) {
  const cat = await loadCatalog({ force });
  const models = cat.models.filter((m) => includeCustom || !m.custom);
  return {
    source: cat.source,
    syncedAt: new Date(cat.at).toISOString(),
    error: cat.error || null,
    endpoint: cat.endpoint || null,
    hostNote: cat.hostNote || null,
    models: models.map((m) => {
      const ent = availability.entryOf(m.id);
      return {
        ...m,
        status: ent ? ent.status : 'unknown',
        at: ent ? ent.at : null,
        reason: ent ? ent.reason : null,
      };
    }),
  };
}

module.exports = {
  loadCatalog,
  listWithStatus,
  pickFromList,
  isHiddenConfigName,
  isUserCustom,
  CACHE_TTL_MS,
};
