'use strict';
/**
 * routes/models.js —— 模型列表端点。
 * 主数据源：上游 get_detail_param 动态目录（catalog）；失败回退本地 model-config。
 * 默认过滤 unavailable；?availability=all|usable|unknown|unavailable 过滤视图。
 */
const { Router } = require('express');
const config = require('../config');
const { getModelDetailParam } = require('../upstream/client');
const availability = require('../models/availability');
const catalog = require('../models/catalog');
const wbChat = require('../workbuddy/chat');
const raccoonProduct = require('../raccoon/product');
const { authenticateAdmin } = require('../middleware/auth');

const router = Router();
// 运维类子路由（缓存清理 / 强制刷新上游目录 / 直读上游详情）仅管理密钥可用。
// GET /v1/models 保持双面：转发密钥按绑定平台过滤，登录密钥看全部。
const admin = (req, res, next) => authenticateAdmin(req, res, next);

function wantCustom(req) {
  const v = String(req.query.include_custom || req.query.custom || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

async function listModels(req, res) {
  const view = String(req.query.availability || 'default');
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  // 平台过滤：转发 Key 按绑定平台；管理 Key 可用 ?platform=；缺省管理面返回全部。
  //
  // 显式 ?platform= 优先于 Key 绑定平台：通用密钥（platform=all）带
  // ?platform=workbuddy 时，此前 req.platform='all' 会让查询参数被静默忽略，
  // 结果返回「全部」而非请求的那个平台。qoder 也走同一条路。
  const queryPlatform = String(req.query.platform || '').toLowerCase();
  const platformFilter = queryPlatform || req.platform || null;
  try {
    const cat = await catalog.listWithStatus({ force: refresh, includeCustom: wantCustom(req) });
    let rows = cat.models;
    if (view === 'default' || view === 'usable') {
      rows = rows.filter((m) => !availability.isHidden(m.id));
    } else if (view === 'unavailable') {
      rows = rows.filter((m) => availability.isHidden(m.id));
    } else if (view === 'unknown') {
      rows = rows.filter((m) => m.status === 'unknown');
    }

    const list = rows.map((m) => {
      const base = {
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: m.custom ? 'user' : 'trae',
        display_name: m.display_name || m.id,
        custom: !!m.custom,
      };
      if (view !== 'default') base.availability = m.status;
      return base;
    });

    // WorkBuddy 目录：以**动态目录**为准（失败回退静态名单）。
    //
    // 2026-11-08 修正：此前这里只映射静态 WB_MODELS，导致转发面（本端点）与
    // 管理面（/v1/models/status，用动态目录）口径分叉——客户端拿到的清单里
    // 有 7 个上游已下架的 id（hy4-preview / glm-5v-turbo / glm-5.1 / minimax-m3 /
    // kimi-k2.7 / kimi-k2.6 / hunyuan-image-v3.0），却少了 14 个上游新增的
    // （hy4free / hy4std / fast-model / space-bunny / step-5-preview / mimo-v2.6-pro …）。
    // 只列 chat 模型：目录里的图片/视频生成模型没有 chat 端点，列出去只会让
    // 客户端选到一个必然 11103 的 id。
    let wbCatalog = [];
    try { wbCatalog = await wbChat.modelCatalog(refresh); } catch { /* 回退静态 */ }
    if (!wbCatalog.length) wbCatalog = wbChat.WB_MODELS.map((id) => ({ id, name: id, chat: undefined }));
    const wbList = wbCatalog
      .filter((m) => (typeof m.chat === 'boolean' ? m.chat : wbChat.isChatModel(m)))
      // 与 Trae 行同口径：已判定不可用的模型从默认视图隐藏（客户端不应选到它）。
      // view=all / unavailable 时照常返回，便于排查。
      .filter((m) => view !== 'default' && view !== 'usable' ? true : !availability.isHidden('wb/' + m.id))
      .map((m) => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'workbuddy',
        display_name: m.name || m.id,
        custom: false,
        virtual: false,
      }));

    // Qoder 国际版目录：可调用集合来自 src/qoder/chat.js 的实测清单
    // （is_free 不等于可调用，qfmodel 实测 invalid_model_error，故不列）。
    // 只有真有启用的国际版账号时才列出——否则客户端会拿到一组必然失败的 id。
    const qoderChat = require('../qoder/chat');
    const variant = require('../platform/variant');
    const qoderHasAccount = require('../credentials/store').list().some((a) => a.enabled
      && variant.isEdition(a.edition, variant.QODER)
      && variant.qoderChatRealms().includes(variant.qoderRealmOfAccount(a)));
    const qoderList = qoderHasAccount ? qoderChat.CALLABLE_INTL_MODELS.map((id) => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'qoder',
      display_name: id,
      custom: false,
      virtual: false,
    })) : [];

    // Raccoon 模型目录：远端动态下发（含倍率）；失败回退兜底表（6 个模型）
    // 只有真有启用的账号时才列出 —— 没有账号时客户端选到它们会直接 503。
    const raccoonStore = require('../credentials/store');
    const raccoonHasAccount = raccoonStore.list().some((a) => a.enabled && variant.isEdition(a.edition, variant.RACCOON));
    let raccoonList = [];
    if (raccoonHasAccount) {
      try {
        const raccoon = require('../raccoon');
        const models = await raccoon.catalog();
        raccoonList = models.map((m) => ({
          id: m.id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'raccoon',
          display_name: m.name,
          custom: false,
          virtual: false,
        }));
      } catch {
        raccoonList = raccoonProduct.fallbackCatalog().map((m) => ({
          id: m.id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'raccoon',
          display_name: m.name,
          custom: false,
          virtual: false,
        }));
      }
    }

    let data;
    if (platformFilter === 'workbuddy') {
      data = wbList;
    } else if (platformFilter === 'trae') {
      data = list;
    } else if (platformFilter === 'qoder') {
      // Qoder 无前缀：端点本身就是 /v1/qoder/chat/completions
      data = qoderList;
    } else {
      data = list
        .concat(wbList.map((m) => ({ ...m, id: 'wb/' + m.id, display_name: 'wb/' + m.id })))
        .concat(qoderList)
        .concat(raccoonList);
    }
    /*
     * 虚拟模型 ID（model-router）可见性。
     *
     * ⚠️ 判据必须是「platform 或 scope」的**或**关系，不能只看 platform。
     *
     * 此前只有 `!platform || platform === 'all' || keyKind === 'login'`，
     * 于是 `router:read` / `router:invoke` 这两个 scope 在整个仓库里
     * **只存在于定义处**（credentials/api-keys.js 的 SCOPES 与 DEFAULT_SCOPES），
     * 没有任何一处消费它——用户在面板给 trae 密钥补上 router:read，
     * 数据库存了、面板显示了，/v1/models 里依旧一个虚拟模型都看不到。
     * 实测（隔离实例）：
     *   platform=all               → 49 个模型，其中虚拟 2 个
     *   platform=trae + router:read → 18 个模型，其中虚拟 0 个
     *
     * 修复后语义：
     *   - 管理密钥（login）：全可见（面板要能看全量）
     *   - 通用密钥（platform=all）：全可见
     *   - 平台密钥（trae/workbuddy）+ `router:read`：可见虚拟模型，但**只能看到
     *     该密钥平台能调度的候选**所构成的虚拟模型（见下方 provider 过滤）。
     *     这与 canUseModel 的语义一致：平台密钥调虚拟模型时只在候选层过滤平台，
     *     不整单拒绝。
     *   - 平台密钥无 router:read：不可见（保持原行为，避免默认放大权限）
     *
     * `req.authKey` 缺失（env 引导密钥等无库记录的路径）时按「无 scope 记录」处理，
     * 与 requireKeyScope 的既有约定一致（rec 为空则放行），不做额外收窄。
     */
    try {
      const scopes = Array.isArray(req.authKey && req.authKey.scopes) ? req.authKey.scopes : [];
      // 与 middleware/model-access.js 的 wantsRouter 同源：两个 router scope
      // 任一出现即说明用户在管理路由权限。只认 router:read 会让「仅授予
      // router:invoke」的密钥可调虚拟模型却在列表里一个都看不到。
      const hasRouterScope = scopes.includes('router:read') || scopes.includes('router:invoke');
      const isAdminView = req.keyKind === 'login';
      const isUniversal = !req.platform || req.platform === 'all';
      // 平台密钥未显式授予任一 router scope 时保持不可见
      const allowVirtual = isAdminView || isUniversal || hasRouterScope;
      if (allowVirtual) {
        // 候选层判据必须与调度同源：调度按 getProvider(id).builtin 判定
        // （model-router/index.js:156-158），而 c.provider 只是字符串 id。
        // store.normalizeProvider 允许 id 与 builtin 不同，按字符串相等会漂移。
        // 两处都放在函数内延迟 require，避免启动期循环依赖。
        const { store: mrStore } = require('../model-router');
        const { providerAllowedForKey } = require('../middleware/model-access');
        const virt = mrStore.listVirtual()
          .filter((vm) => vm.enabled)
          /*
           * 平台密钥额外做候选层过滤：一个虚拟模型的候选全在别的平台上时，
           * 这个密钥即使有 router:read 也调不动它（invoke 会在候选层过滤成空）。
           * 列出来只会让客户端选到一个必然失败的模型，所以按「至少有一个
           * 本平台候选」过滤。通用密钥不筛。
           */
          .filter((vm) => {
            if (isAdminView || isUniversal) return true;
            const keyPlatform = String(req.platform || '');
            if (!keyPlatform) return true;
            const cands = Array.isArray(vm.candidates) ? vm.candidates : [];
            return cands.some((c) => c && c.enabled !== false
              && providerAllowedForKey(mrStore.getProvider(c.provider), keyPlatform));
          })
          .map((vm) => ({
            id: vm.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'model-router',
            display_name: vm.description || vm.id,
            custom: true,
            virtual: true,
            ...(vm.contextWindow ? { context_length: vm.contextWindow } : {}),
          }));
        data = virt.concat(data);
      }
    } catch { /* model-router 未就绪时忽略 */ }

    res.json({
      object: 'list',
      source: cat.source,
      syncedAt: cat.syncedAt,
      endpoint: cat.endpoint || null,
      platform: platformFilter || 'all',
      data,
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
}

router.get('/v1/models', listModels);

router.get('/v1/models/status', admin, async (req, res) => {
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  try {
    const cat = await catalog.listWithStatus({ force: refresh, includeCustom: wantCustom(req) });
    const availability = require('../models/availability');
    // 预热动态目录（含倍率）；失败或未就绪时回退静态目录（倍率列显示 —）
    let wbModels = [];
    try { wbModels = await wbChat.modelCatalog(refresh); } catch (e) { /* 回退静态 */ }
    if (!wbModels.length) wbModels = wbChat.WB_MODELS.map((id) => ({ id, name: id, rateText: null, rate: null }));
    // 目录始终展示，但无启用账号时状态为 unavailable（实际无法调用）
    const wbEnabled = require('../credentials/store').list().some((a) => a.enabled && a.edition === 'workbuddy');
    const wbReason = wbEnabled ? null : '无可用 WorkBuddy 账号';
    const wbRows = wbModels.map((m) => {
      const id = 'wb/' + m.id;
      // 有启用账号时以真实探测记录为准（探测按传入的原始 id 写入，此处用同一 id 查询）；
      // 无探测记录则回退 unknown —— 不能仅凭「有可用账号」就断言模型可用。
      const ent = wbEnabled ? availability.entryOf(id) : null;
      // 「目录里有」与「chat 能调」是两件事（2026-11-08 核实）：
      // WB 目录是售卖清单，图片/视频生成模型也在里面，但它们的推理后端不是 chat。
      // 这类模型我们**从探活目标里剔除**（否则必然 11103 被写成 unavailable），
      // 面板上标记为 media，不再显示成「不可用」的红点。
      const isChat = typeof m.chat === 'boolean' ? m.chat : wbChat.isChatModel(m);
      return {
        id,
        display_name: m.name || id,
        status: !wbEnabled ? 'unavailable' : (isChat ? (ent ? ent.status : 'unknown') : 'media'),
        chat: isChat,
        mediaKind: isChat ? null : (m.mediaKind || wbChat.mediaKindOf(m)),
        capability: isChat ? (m.supportsReasoning ? 'reasoning_model' : 'chat_model') : 'media_model',
        multimodal: !!m.multimodal,
        custom: false,
        virtual: false,
        reason: !wbEnabled ? wbReason : (isChat ? (ent ? ent.reason : null) : '图片/视频生成模型，无 chat 端点，不参与转发'),
        source: 'workbuddy-cn',
        source_name: 'WorkBuddy CN',
        rateText: m.rateText || null,
        rate: m.rate != null ? m.rate : null,
        feeLevel: null,
        scene: null,
        peak: null,
        maxInputTokens: m.maxInputTokens || null,
      };
    });
    const traeRows = cat.models.map((m) => ({
      id: m.id,
      display_name: m.display_name || m.id,
      status: m.status,
      capability: m.capability || null,
      multimodal: !!m.multimodal,
      custom: !!m.custom,
      virtual: false,
      reason: m.reason || null,
      source: 'trae-cn',
      source_name: 'Trae CN',
      rateText: m.rate != null ? 'x' + m.rate : null,
      rate: m.rate != null ? m.rate : null,
      feeLevel: m.feeLevel != null ? m.feeLevel : null,
      scene: m.scene || null,
      peak: null,
    }));
    // Raccoon 状态行：有启用账号才显示，目录来自远端（或兜底表）
    const raccoonEnabled = require('../credentials/store').list().some((a) => a.enabled && variant.isEdition(a.edition, variant.RACCOON));
    let raccoonRows = [];
    if (raccoonEnabled) {
      // 目录是只读操作，用专用选号器；没有账号时直接走兜底表，不再让
      // firstRaccoon.id 抛 TypeError 被 catch 吞成「远端失败」。
      const firstRaccoon = require('../raccoon').pickCatalogAccount();
      let catalogModels = null;
      if (firstRaccoon) {
        try {
          catalogModels = (await require('../raccoon/auth').fetchModelCatalog(firstRaccoon)).models;
        } catch (e) {
          console.error('[models] Raccoon 远端目录拉取失败，回退兜底表:', e && e.message);
        }
      }
      const rows = catalogModels || raccoonProduct.fallbackCatalog();
      raccoonRows = rows.map((m) => ({
        id: m.id,
        display_name: m.name,
        status: 'unknown', // Raccoon 暂不接入探活，统一 unknown
        capability: 'chat_model',
        multimodal: m.supportsImage,
        custom: false,
        virtual: false,
        reason: null,
        source: 'raccoon',
        source_name: 'Raccoon (商汤)',
        rateText: m.multiplier ? `x${m.multiplier}` : null,
        rate: m.multiplier || null,
        feeLevel: null,
        scene: null,
        peak: null,
      }));
    }
    let data = wbRows.concat(traeRows).concat(raccoonRows);
    try {
      const virt = require('../model-router').store.listVirtual().map((vm) => {
        const cands = require('../model-router').explainCandidates(vm.id);
        const usable = cands.filter((c) => c.usable).length;
        return {
          id: vm.id,
          display_name: vm.description || vm.id,
          status: vm.enabled && usable > 0 ? 'usable' : (vm.enabled ? 'unknown' : 'unavailable'),
          capability: 'virtual_router',
          multimodal: false,
          custom: true,
          virtual: true,
          reason: vm.enabled ? (usable ? null : '全部候选不可用') : '已禁用',
          source: 'model-router',
          source_name: '虚拟模型',
          rateText: null,
          rate: null,
          peak: null,
          candidates: cands.length,
          usableCandidates: usable,
          contextWindow: vm.contextWindow || null,
        };
      });
      data = virt.concat(data);
    } catch { /* ignore */ }
    const hostNote = [
      '模型来源：Trae CN（官方模型配置接口，与客户端同源）',
      wbEnabled ? ' 与 WorkBuddy CN（官方模型目录）' : ' 与 WorkBuddy CN（目录可见；无可用账号）',
      raccoonEnabled ? ' 与 Raccoon (商汤小浣熊)' : '',
      '；倍率（x）为真实积分消耗率；两平台接口均未提供峰谷价格',
    ].filter(Boolean).join('');
    res.json({
      object: 'list',
      strategy: config.poolStrategy,
      upstreamFunction: config.upstreamFunction || null,
      upstreamChatPath: config.upstreamChatPath,
      source: cat.source,
      syncedAt: cat.syncedAt,
      endpoint: cat.endpoint || null,
      hostNote,
      data,
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

router.delete('/v1/models/status', admin, (req, res) => {
  const m = req.query.model;
  availability.reset(m ? String(m) : null);
  res.json({ cleared: m || 'all' });
});

router.get('/v1/models/detail', admin, async (req, res) => {
  try {
    const data = await getModelDetailParam(req.query.function || 'chat_v3');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

/** 强制刷新上游目录（运维/面板按钮用）。 */
router.post('/v1/models/refresh', admin, async (req, res) => {
  try {
    const cat = await catalog.listWithStatus({ force: true });
    res.json({
      ok: true,
      source: cat.source,
      syncedAt: cat.syncedAt,
      count: cat.models.length,
      error: cat.error || null,
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
  }
});

module.exports = router;
