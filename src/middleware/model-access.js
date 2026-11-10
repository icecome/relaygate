'use strict';
/**
 * middleware/model-access.js — 访问密钥对模型的调用权限。
 * 权限口径：
 * - platform 密钥（trae|workbuddy）：只能调本平台模型
 * - 通用密钥（platform=all）：可调虚拟模型 + 全部平台 + 通用 Provider
 */
const apiKeys = require('../credentials/api-keys');
const mrStore = require('../model-router/store');
const ownership = require('../models/platform-ownership');

/**
 * 是否为虚拟模型。
 *
 * 直接查 model-router/store 而非 model-router/index：后者在加载期 require
 * 本模块的 providerAllowedForKey，经 index 取会形成 model-router 与 model-access
 * 的循环依赖。store 是无依赖的叶子模块，依赖方向单向。
 */
function isVirtualModel(model) {
  const id = String(model == null ? '' : model);
  try {
    return !!mrStore.getVirtual(id);
  } catch {
    return false;
  }
}

/**
 * 是否为 WorkBuddy **独有**模型。
 *
 * 2026-11-07 根因修复：此前只对照 workbuddy/chat.js 的静态 WB_MODELS 名单，
 * 而 glm-5.3 / glm-5.3-flash / minimax-m3 / deepseek-v4.1-flash 等名字 Trae
 * 上游目录同样服务——只看 WB 名单会把「Trae 密钥调 glm-5.3」误判成
 * platform_mismatch 拒成 403（平台密钥调单个物理模型全灭、只剩聚合虚拟模型
 * 可用的直接根因）。
 *
 * 现在的判据是 models/platform-ownership 的双平台归属表：
 * WB 独有 = WB 名单（静态 + 动态目录快照）里有、且 Trae 侧（本地登记表 +
 * 上游目录快照）没有。归属快照由 catalog.js / workbuddy/chat.js 在目录同步
 * 成功时落盘，冷启动读上一次运行的快照，判定不随重启退化。
 */
function isWorkBuddyOnlyModel(model) {
  try {
    return ownership.isWorkBuddyExclusive(model);
  } catch {
    return false;
  }
}

/**
 * 是否为 Qoder 国际版对话面的模型。
 *
 * 依据 src/qoder/chat.js 的 CALLABLE_INTL_MODELS（实测可调用集合）。
 * 用 require 懒加载而非顶层导入：chat.js → transform/* → 无环，
 * 但本模块被 routes/openai 等在启动早期加载，懒加载可避免无谓的启动依赖。
 */
function isQoderOnlyModel(model) {
  try {
    const qoderChat = require('../qoder/chat');
    const lower = String(model || '').toLowerCase().trim();
    return qoderChat.CALLABLE_INTL_MODELS.includes(lower);
  } catch {
    return false;
  }
}

/**
 * 是否为 Raccoon 对话面的模型。
 *
 * 判据是**模型 id 的命名空间前缀 `sn-`**（该 provider 的全部远端模型都是
 * `sn-` 开头：`sn-sensenova-6-8-flash` / `sn-glm-5-3` / `sn-kimi-k3` /
 * `sn-deepseek-v4-1-flash` …）。这里刻意**不复用** Qoder 那种硬编码清单：
 * Raccoon 的模型目录是远端动态下发的（含限免与倍率），写死清单必然随上游
 * 上新而漏判，而漏判的后果是「平台密钥越界消耗别家积分」。
 */
function isRaccoonOnlyModel(model) {
  return /^sn-[\w.-]+$/i.test(String(model || '').trim());
}

/**
 * 平台密钥的资源 ACL 关卡（M-S5 根因修复）。
 *
 * 此前 resources 校验只散布在虚拟模型分支与 all 分支，trae/workbuddy
 * 分支直接放行——按分支散布的 if 式校验，新增分支必然遗漏。现收口为统一关卡：
 * 平台过滤通过后一律经 canInvokeModel 校验 authKey.resources。
 * - authKey 为空（内部调用或旧路径）：保持原有放行语义，避免回归；
 * - resources 为空数组：与既有分支口径一致，跳过校验（normalizeResources
 *   实际不会产出空数组，此处仅为防御）。
 * meta 原样传给下游 scope.modelResourcePath：workbuddy 平台密钥调裸模型 ID 时必须
 * 传 { platform: 'workbuddy' }，否则会被映射成 model:trae/<id> 造成误拒。
 */
function platformResourceGate(authKey, model, meta = {}) {
  if (!authKey) return { ok: true };
  if (!Array.isArray(authKey.resources) || !authKey.resources.length) return { ok: true };
  const { canInvokeModel } = require('../auth/scope');
  const chk = canInvokeModel(authKey, model, meta);
  if (!chk.ok) {
    return { ok: false, message: `access denied: ${chk.reason || 'resource_denied'}`, reason: chk.reason };
  }
  return { ok: true };
}

/**
 * 模型名 → 归属平台（供资源路径映射与通用密钥分派）。
 *
 * 裸名不再一律归 trae：`hy3` / `hunyuan-chat` 这类只有 WorkBuddy 服务的名字，
 * 归到 model:trae/* 会让「resources 收窄过的工作密钥」被误拒，也和
 * routes/openai 的实际分派（走 WB 池）不一致。归属判据与分派判据必须同源，
 * 否则 ACL 与实际路由会漂移——这里统一取 platform-ownership。
 */
function platformOfModel(model) {
  const raw = String(model == null ? '' : model);
  if (isQoderOnlyModel(raw)) return 'qoder';
  if (isRaccoonOnlyModel(raw)) return 'raccoon';
  if (raw.startsWith('wb/')) return 'workbuddy';
  try {
    return ownership.ownerPlatformOf(raw);
  } catch {
    return 'trae';
  }
}

/**
 * 判断密钥能否调用该模型（平台规则 + scope/资源 ACL）。
 *
 * 虚拟模型不在这里整单拒绝：平台密钥只调度本平台候选，通用密钥走全部候选
 * （与「平台密钥调本平台模型、通用密钥调所有模型」一致）。
 */
function canUseModel(keyPlatform, model, authKey = null) {
  const raw = String(model == null ? '' : model);
  const platform = keyPlatform || 'trae';

  if (isVirtualModel(raw)) {
    /*
     * 虚拟模型的权限判定，与 /v1/models 的可见性判据同源（2026-11-10 修复）。
     *
     * ## 为什么是「显式授予才收紧」而不是「没有就拒绝」
     *
     * 平台密钥的默认 scopes 是 `['models:read','models:invoke']`
     * （credentials/api-keys.js 的 DEFAULT_SCOPES），**不含 router:invoke**。
     * 若在此硬性要求 router:invoke，所有存量的 trae/workbuddy 密钥调虚拟模型
     * 会立刻 403 —— 那是行为回归，不是修复。
     *
     * 所以按「显式意图」判：
     *   - scopes 里**出现** router:read 或 router:invoke 任一 → 说明用户在有意识地
     *     管理路由权限，此时要求 router:invoke 才放行调用（只有 router:read 是只读密钥）。
     *   - 两个都没出现 → 沿用旧行为放行，交由 platform / resource 判定。
     *
     * 这样：
     *   - 默认平台密钥：行为不变；
     *   - 只想读虚拟模型列表的密钥：给 router:read（可见，不可调）；
     *   - 要调的：router:read + router:invoke（可见且可调）。
     * 与 /v1/models 的 `hasRouterRead` 判据合用，形成一致的「读/调」两级。
     */
    if (authKey) {
      const scopes = Array.isArray(authKey.scopes) ? authKey.scopes : [];
      const wantsRouter = scopes.includes('router:read') || scopes.includes('router:invoke');
      if (wantsRouter && !scopes.includes('router:invoke')) {
        return {
          ok: false,
          message:
            'access denied: scope_missing:router:invoke. 该密钥已声明 router 权限但只有 router:read（只读）。' +
            '调用虚拟模型需要同时授予 router:invoke。',
          reason: 'scope_missing:router:invoke',
        };
      }
      if (Array.isArray(authKey.resources) && authKey.resources.length) {
        const { canInvokeModel } = require('../auth/scope');
        const chk = canInvokeModel(authKey, raw, { virtual: true });
        // 通用密钥（resources=*）放行；平台密钥默认 resources 为 model:trae/* 等，
        // 对虚拟模型允许进入路由层做候选过滤，不在此返回 403
        if (!chk.ok && platform === 'all') {
          return { ok: false, message: `access denied: ${chk.reason || 'resource_denied'}`, reason: chk.reason };
        }
      }
    }
    return { ok: true };
  }

  if (platform === 'all' || platform === 'universal') {
    if (authKey && Array.isArray(authKey.resources) && authKey.resources.length) {
      const { canInvokeModel } = require('../auth/scope');
      // Qoder / Raccoon 模型走各自独立的资源前缀，不能归到 trae/workbuddy 前缀下
      const meta = { platform: platformOfModel(raw) };
      const chk = canInvokeModel(authKey, raw, meta);
      if (!chk.ok) {
        return { ok: false, message: `access denied: ${chk.reason || 'resource_denied'}`, reason: chk.reason };
      }
    }
    return { ok: true };
  }

  // Qoder 模型：只有通用密钥可调。平台密钥（trae|workbuddy）一律拒绝。
  //
  // 必须放在 platform==='workbuddy' 分支**之前**：那个分支直接 return，
  // 会把 Qoder 模型当成 WB 模型放行（等于让 wb 密钥越界消耗 Qoder 积分）。
  //
  // 也不能复用下面的「trae 平台密钥」分支：那里的口径是「非 WorkBuddy 独有
  // 模型就放行」，而 Qoder 的模型名（qmodel / kmodel / gmodel…）不在
  // WorkBuddy 独有清单里，会被当成 Trae 模型放行。
  // Qoder 是独立账号池，密钥边界必须按平台显式收口。
  if (isQoderOnlyModel(raw)) {
    return {
      ok: false,
      message: `model "${raw}" is a Qoder model. Use the Qoder endpoint (/v1/qoder/chat/completions) with a universal key (platform=all).`,
      reason: 'platform_mismatch',
    };
  }

  // Raccoon 模型：同样只有通用密钥可调。理由与 Qoder 完全一致 ——
  // 它是独立账号池，模型 id 前缀（sn-）不在 Trae/WorkBuddy 的命名空间里，
  // 复用下面的 trae 分支会被当成 Trae 模型放行，等于让平台密钥越界消耗 Raccoon 积分。
  if (isRaccoonOnlyModel(raw)) {
    return {
      ok: false,
      message: `model "${raw}" is a Raccoon model. Use the Raccoon endpoint (/v1/raccoon/chat/completions) with a universal key (platform=all).`,
      reason: 'platform_mismatch',
    };
  }

  if (platform === 'workbuddy') {
    // WB 平台密钥调 Trae 也在服务的同名模型（如 glm-5.2）时，上游仍走 WB 通道：
    // 密钥平台决定账号池，同名模型按 WB 目录的倍率计费，语义自洽，不做拦截。
    return platformResourceGate(authKey, raw, { platform: 'workbuddy' });
  }

  // trae 平台密钥
  if (raw.startsWith('wb/')) {
    return {
      ok: false,
      message: `model "${raw}" is WorkBuddy-only. 请使用 workbuddy 访问密钥或通用密钥（platform=all）。`,
      reason: 'platform_mismatch',
    };
  }
  if (isWorkBuddyOnlyModel(raw)) {
    return {
      ok: false,
      message: `model "${raw}" is a WorkBuddy-only model. 请使用 workbuddy 访问密钥或通用密钥（platform=all）。`,
      reason: 'platform_mismatch',
    };
  }
  return platformResourceGate(authKey, raw);
}

/** Provider 是否允许在该密钥平台下被虚拟路由选中。 */
function providerAllowedForKey(provider, keyPlatform) {
  const platform = keyPlatform || 'trae';
  if (platform === 'all' || platform === 'universal') return true;
  if (!provider) return false;
  if (provider.type === 'openai') return false; // 通用 OpenAI 端点仅允许通用密钥
  return provider.builtin === platform;
}

module.exports = {
  canUseModel,
  isVirtualModel,
  isWorkBuddyOnlyModel,
  isQoderOnlyModel,
  isRaccoonOnlyModel,
  /**
   * 别名：逻辑上就是 `isRaccoonOnlyModel`，没有任何附加语义。
   *
   * 存在理由只有一个 —— **判据同源**。`routes/openai.js` 的分派分支与
   * `raccoon/dispatch.js` 的判定必须是同一个函数；若两边各写一份
   * `/^sn-[\w.-]+$/i`，将来放宽命名空间时必然漂移成「ACL 放行但分派不认」。
   * 这里用别名而不是让它们各自 require `isRaccoonOnlyModel`，是因为分派层
   * 需要表达「这个模型归 Raccoon 对话面」这个语义，而 ACL 层需要表达
   * 「这个模型只有通用密钥能调」。语义不同的两件事共用一个实现。
   */
  isRaccoonModel: isRaccoonOnlyModel,
  platformOfModel,
  providerAllowedForKey,
  PLATFORM_LABELS: apiKeys.PLATFORM_LABELS,
};
