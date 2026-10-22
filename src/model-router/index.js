'use strict';
/**
 * model-router/index.js — 虚拟模型请求管理入口。
 *
 * 能力范围：
 * 1. 自定义模型 ID（virtualModels）
 * 2. 远端模型集成（providers：builtin 与 openai 兼容端点）
 * 3. 请求分发（按虚拟 ID 选候选）
 * 4. 启用控制（enabled 开关，配置与管理端双入口）
 * 5. 限流自动切换（健康度冷却与 failover.switchOn）
 * 6. 故障恢复重试（maxAttempts 与候选轮换）
 * 7. 状态监控（health.snapshot 与 traffic 日志）
 * 8. 优先级、权重、最大频率（priority / weight / maxRpm）
 * 9. 上下文窗口守门（contextWindow：粗估输入超窗口 75% 时显式返回 400，
 *    防止客户端按虚高窗口堆积历史后被上游静默截断，进而出现记忆错乱与幻觉）
 */
const store = require('./store');
const health = require('./health');
const dispatch = require('./dispatch');
const { createStreamGate } = require('./stream-gate');
const { compressMessages } = require('../lib/rtk');
const { classifyError } = require('../upstream/errors');
const { logRequest, usageToLogFields, rtkLogFields } = require('../log/traffic');
const { estimateCost } = require('../models/rates');
const { estimateTokensOfText } = require('../lib/token-precise');
const config = require('../config');
const { providerAllowedForKey } = require('../middleware/model-access');
const { estimateRequestTokens } = require('../lib/token-estimate');
const autotier = require('./autotier');
const windowCalib = require('./window-calibration');
// 账号池只在这里被引用（惰性）以取「池级账号权益信号」：候选排序需要知道
// trae 池与 workbuddy 池各自的临期/余额状态。require 放函数体内，
// 避免 model-router ← pool 的静态循环依赖（pool 的 dispatch 反向引用 model-router）。

const VIRTUAL_PREFIX = 'vm/';

function hasVirtualModel(model) {
  const id = String(model == null ? '' : model);
  return !!store.getVirtual(id);
}

function isVirtualId(id) {
  return String(id || '').startsWith(VIRTUAL_PREFIX) || !!store.getVirtual(id);
}

/**
 * 加权随机抽序：按 weight 抽签决定先后，抽样过程用累减而非每次重算总和，
 * 保证「抽到的排在前面」这一分布与 pool 顺序无关（避免首个候选天然占优）。
 */
function weightedShuffle(list) {
  const pool = list.map((c) => ({ c, w: Math.max(1, Number(c.weight) || 1) }));
  const ordered = [];
  while (pool.length) {
    const total = pool.reduce((s, x) => s + x.w, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].w;
      if (r <= 0) { idx = i; break; }
    }
    ordered.push(pool[idx].c);
    pool.splice(idx, 1);
  }
  return ordered;
}

/** 候选倍率：未知或非法倍率排到成本序末尾（Infinity）。 */
function candRate(c) {
  return (Number.isFinite(Number(c.rate)) && Number(c.rate) >= 0 ? Number(c.rate) : Infinity);
}

/** 候选上下文窗口：未声明按 0 计（sort=window 时排在后面）。 */
function candWindow(c) {
  return (Number.isFinite(Number(c.contextWindow)) ? Number(c.contextWindow) : 0);
}

/**
 * 跨平台账号级调度（POOL_ACCOUNT_PRIORITY，默认开）。
 *
 * 背景：账号池 FEFO（先到期先用）只在单个平台池内生效——同一候选模型被路由到
 * trae 池还是 workbuddy 池，此前只由模型倍率决定，账号权益（临期/余额）完全
 * 不参与跨池比较。结果是临期积分可能整池闲置，而余额低、到期远的池反而被
 * 优先消耗。
 *
 * 分档规则（与 pool.poolSignals 的 tier 语义对齐）：
 *   tier 1 = 池内存在 WINDOW_DAYS 内到期的未用尽包（临期/到期，作废是硬损失）
 *            → 按最早到期时刻升序抢占；
 *   tier 2 = 无临期包 → 按池内余额合计降序（余额多的池优先使用）；
 *   信号缺失（null，如池空）→ 记为 tier 3 沉底，回落到纯成本序。
 * 分档平局才回落到原有成本键（倍率/窗口 → priority）。
 */
const ACCOUNT_PRIORITY_TIER_BOTTOM = 3;

/** 每候选的池级权益信号缓存：一次 orderCandidates 里候选排序会重复比较多次。 */
const _sigMemo = new Map(); // providerId -> {tier, soonestMs, balance} | null

function accountPriorityOf(candidate) {
  if (!config.poolAccountPriority) return null;
  const providerId = candidate.provider;
  if (_sigMemo.has(providerId)) return _sigMemo.get(providerId);
  let sig = null;
  try {
    const pool = require('../credentials/pool');
    const provider = store.getProvider(providerId);
    const edition = provider && provider.builtin;
    if (edition === 'trae' || edition === 'workbuddy') {
      const s = pool.poolSignals(edition);
      // 池空（信号为 null）：该池拿不到账号，排到最后但仍保留在序列中作 failover
      sig = s || { tier: ACCOUNT_PRIORITY_TIER_BOTTOM, soonestMs: null, balance: -1 };
    }
    // 非内置（openai 兼容）候选无账号池概念，不参与账号权益排序
  } catch {
    sig = null; // 信号不可得时不参与排序，保持纯成本序
  }
  _sigMemo.set(providerId, sig);
  return sig;
}

function compareAccountPriority(a, b) {
  const pa = accountPriorityOf(a);
  const pb = accountPriorityOf(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;  // 无信号的候选沉底
  if (!pb) return -1;
  if (pa.tier !== pb.tier) return pa.tier - pb.tier;
  if (pa.tier === 1) {
    // 临期档：到期越早越优先
    const sa = pa.soonestMs == null ? Infinity : pa.soonestMs;
    const sb = pb.soonestMs == null ? Infinity : pb.soonestMs;
    if (sa !== sb) return sa - sb;
  } else {
    // 非临期档：余额合计越多越优先
    if (pa.balance !== pb.balance) return pb.balance - pa.balance;
  }
  return 0;
}

/**
 * 候选排序：priority 策略按 priority 升序；weighted 按权重随机加权。
 * 过滤：Provider 启用、候选启用、密钥平台允许、非冷却、本地 maxRpm。
 *
 * 自动分层 VM（auto + sort）先按 sort 确定成本序，再取前 rotateTopN 个构成
 * 「轮转池」做加权轮转：既保留低成本优先的意图，又不会恒定命中同一个模型。
 * rotateTopN 未声明或池内只剩一个候选时退化为原有优先级语义。
 * 池外候选仍保留在序列尾部，失败重试（failover）时可继续向下切换。
 *
 * 跨池账号级调度：accountPriorityOf 在成本键之前先比较候选所属池的账号权益
 * 分档（临期池抢占 → 余额池优先 → 回落成本序）。同池候选分档必然相同，
 * 因此池内仍维持倍率/窗口成本序，不破坏既有轮转语义。
 *
 * @param {string} keyPlatform trae|workbuddy|all
 */
function orderCandidates(virtualId, vm, keyPlatform = 'all') {
  const list = (vm.candidates || []).filter((c) => {
    if (!c.enabled) return false;
    const p = store.getProvider(c.provider);
    if (!p || !p.enabled) return false;
    if (!providerAllowedForKey(p, keyPlatform)) return false;
    if (health.isCooling(virtualId, c.id)) return false;
    if (!health.allowRpm(virtualId, c.id, c.maxRpm)) return false;
    return true;
  });
  // 每次调用清空候选级权益信号缓存：池信号依赖快照（分钟级刷新）与
  // config.poolAccountPriority，跨请求复用会读到过期值。
  _sigMemo.clear();

  // 自动分层 VM：sort=rate 按倍率升序（未知倍率排后），sort=window 按窗口大优先；
  // 平局回退 priority。手动 VM（sort=null）维持 priority 排序不变。
  if (vm.auto && vm.sort) {
    // 成本序基于「当前可用」候选（已过滤禁用、停用、冷却、超频候选）：
    // rotateTopN 表示「从可用模型里轮转 N 个」，已禁用的模型不占名额，
    // 应由其后的候选递补。否则用户禁用几个低价模型后，轮转池会缩水甚至空转。
    //
    // 跨池账号级调度：compareAccountPriority 先比较候选所属池的账号权益分档，
    // 分档平局才回落到倍率/窗口成本键。同池候选分档必然相同，池内成本序不变。
    // 注意：权益档位会随快照刷新改变（如某账号领了新包），因此排出的
    // 「轮转池成员」也应随之变化——这正是本排序放在成本序之前的含义。
    const ranked = list.slice().sort((a, b) => {
      // 1) 跨池账号权益分档：临期池抢占、余额池次之、同档回落成本键
      const dp = compareAccountPriority(a, b);
      if (dp) return dp;
      if (vm.sort === 'window') {
        const dw = candWindow(b) - candWindow(a);
        if (dw) return dw;
      } else {
        const dr = candRate(a) - candRate(b);
        if (dr) return dr;
      }
      return (a.priority - b.priority) || String(a.id).localeCompare(String(b.id));
    });
    const topN = Number(vm.rotateTopN);
    const poolSize = Number.isFinite(topN) && topN > 0 ? Math.floor(topN) : 0;
    // 置顶候选额外强制入池，且不占用 rotateTopN 的名额——
    // 否则「置顶一个高性能模型」会把等量的低成本候选挤出池，
    // 反而抬高整体成本，与置顶意图相反。
    const pinned = ranked.filter((c) => c.pinned);
    const pinnedIds = new Set(pinned.map((c) => c.id));
    const byRank = ranked.filter((c) => !pinnedIds.has(c.id)).slice(0, poolSize);
    const pool = pinned.concat(byRank);
    // 不轮转（poolSize=0）且无置顶：退化为固定取成本序首选
    if (poolSize === 0 && pinned.length === 0) return ranked;
    const poolKeyed = new Set(pool.map((c) => c.id));
    const rest = ranked.filter((c) => !poolKeyed.has(c.id));
    // 池内 ≥2 个才需要轮转；仅 1 个时固定用它，池外仍作 failover 的最后手段
    if (pool.length >= 2) return weightedShuffle(pool).concat(rest);
    return pool.concat(rest);
  }

  if (vm.strategy === 'weighted') {
    return weightedShuffle(list);
  }

  return list.slice().sort((a, b) => (a.priority - b.priority) || String(a.id).localeCompare(String(b.id)));
}

/** 被冷却、禁用或平台不允许的候选说明（诊断用）。 */
function explainCandidates(virtualId, keyPlatform = 'all') {
  const vm = store.getVirtual(virtualId);
  if (!vm) return [];
  return (vm.candidates || []).map((c) => {
    const p = store.getProvider(c.provider);
    const reasons = [];
    if (!c.enabled) reasons.push('candidate_disabled');
    if (!p) reasons.push('provider_missing');
    else if (!p.enabled) reasons.push('provider_disabled');
    if (p && !providerAllowedForKey(p, keyPlatform)) reasons.push('platform_denied');
    if (health.isCooling(virtualId, c.id)) reasons.push('rate_limited');
    return {
      ...c,
      providerType: p ? p.type : null,
      providerLabel: p ? p.label : null,
      usable: reasons.length === 0,
      reasons,
      cooldownRemainingMs: health.cooldownRemaining(virtualId, c.id),
    };
  });
}

function shouldSwitch(kind, vm) {
  // 上下文超限属终端错误：换候选/冷却账号都解决不了窗口问题，绝不切换
  // （否则会把每个候选都撞一遍同一天花板，并错误冷却健康的低窗口模型）。
  if (kind === 'context_length') return false;
  // 账号受限（11140）：账号级处置，同平台换候选通常=换门牌撞同一面墙（同账号
  // 被多个候选引用时），但不禁止——同平台其他账号仍可用，故放行走通用 failover
  // 白名单逻辑；'account' 不在默认 switchOn 里时由这里的显式放行兜底。
  if (kind === 'account') return true;
  // 渠道校验：同平台换候选无效（请求形状相同），但**允许跨平台**降级。
  // 真正的平台级熔断在 handleChat 的 blockedProviders 里做，这里只放行。
  if (kind === 'channel') return true;
  const set = new Set((vm.failover && vm.failover.switchOn) || ['rate_limit', 'model', '5xx', 'network', 'channel', 'other']);
  return set.has(kind);
}

/** 输入超限（相对声明窗口）时预留的比例，保证留有回复空间。 */
const CONTEXT_INPUT_HEADROOM_RATIO = 0.75;

/**
 * 候选未声明 contextWindow 时的兜底窗口（平台级安全地板）。
 *
 * 背景：候选窗口为 null 时，候选级守门会整体失效（hasCandidateWindows=false），
 * 超长输入直接飞向上游，只在收到 11115 后才失败——用户看到的是「某些请求
 * 突然全 400」，而网关本可以提前把它路由给窗口更大的候选。
 *
 * 取值依据：WorkBuddy 侧 hy3 与 space-bunny 的真实硬上限实测均为 100000
 * （上游 11115 报文 "prompt is too long: 100001 tokens > 100000 maximum"），
 * 取实测最小天花板作地板；未知平台取更保守的 100000 之外的 128000 无益，
 * 一律 100000。声明了真实窗口的候选不受影响。
 */
const NULL_WINDOW_FLOOR = 100000;

/**
 * 候选参与窗口守门的有效窗口：实测校准值 > 配置声明值 > 平台安全地板。
 * 目的是杜绝「全部候选都没声明窗口 → 候选级守门整体关闭」这一漏放路径，
 * 同时让 hy3 这类「目录值虚高」的候选按真实上限守门（见 window-calibration.js）。
 */
function effectiveCandidateWindow(c) {
  const cal = windowCalib.calibratedWindow(c);
  if (cal != null) return cal;
  return NULL_WINDOW_FLOOR;
}

/**
 * 声明了 contextWindow 的虚拟模型：分发前粗估输入 token，
 * 超过窗口 75% 时显式返回 400，让客户端走自己的压缩逻辑。
 * 不拦截则上游会静默截断头部，system 与早期记忆丢失，导致幻觉。
 *
 * 估算口径含 tools 声明：上游把工具 JSON schema 一并计入输入（实测
 * 27 个工具的请求在 messages 远未到上限时被 11115 拒绝），只算 messages
 * 会让守门在边界失效。
 */
function checkContextLimit(vm, messages, tools) {
  if (!vm || !vm.contextWindow) return null;
  const estimated = estimateRequestTokens(messages, tools);
  const limit = Math.floor(vm.contextWindow * CONTEXT_INPUT_HEADROOM_RATIO);
  if (estimated <= limit) return null;
  const e = new Error(
    `context length exceeded: estimated ${estimated} tokens exceeds input limit ${limit} (contextWindow ${vm.contextWindow} of "${vm.description || 'virtual model'}"). Reduce conversation history before retrying.`,
  );
  e.status = 400;
  e.code = 'context_length_exceeded';
  return e;
}

/**
 * 处理虚拟模型 chat 请求（在 openai 路由最前调用）。
 * 成功则直接写响应；失败耗尽候选时抛出/写出最后错误。
 */
async function handleChat(req, res, ctx) {  const virtualId = ctx.model;
  const vm = store.getVirtual(virtualId);
  if (!vm) {
    const e = new Error(`unknown virtual model: ${virtualId}`);
    e.status = 404;
    throw e;
  }
  if (!vm.enabled) {
    const e = new Error(`virtual model disabled: ${virtualId}`);
    e.status = 403;
    throw e;
  }

  // 工具输出压缩（RTK）：整个 handleChat **只压一次**——循环里的降级换候选与
  // 账号重试共用这份结果，否则同一次客户端请求会被重复计数、节省量虚高。
  // 守门与模态判定都按**压缩后**的 messages 算：那才是真正上路的字节。
  // 记账口径见 log/stats.js（rtk 字段只在真跑过压缩时写入）。
  const rtk = compressMessages(ctx.messages, { enabled: config.rtkEnabled });
  const messages = rtk.messages;

  // 窗口守门：声明了 contextWindow 且输入超限时直接拒绝，不做候选切换
  // （换候选解决不了超限——超限是输入与窗口的关系，不是候选健康度问题）。
  // 日志不在此处记：handleChat 唯一调用点 openai.js 的 catch 统一写入 traffic 日志。
  const tooLong = checkContextLimit(vm, messages, ctx.tools);
  if (tooLong) throw tooLong;
  // 候选级窗口守门（autotier）：候选声明了 contextWindow 且输入超该候选 75% 时跳过该候选，
  // 让请求落到窗口更大的候选上；全部候选装不下时在循环内显式返回 400。
  // 未声明窗口的候选按平台安全地板（effectiveCandidateWindow）参与守门，
  // 不再整体豁免——否则超长输入会绕过本地守门直接撞上游 11115。
  // 估算口径含 tools：上游把工具 schema 计入输入（见 lib/token-estimate.js）。
  const { estimated: estTokens, list: fittingAll } = autotier.filterCandidatesByInput(vm, messages, ctx.tools);
  const hasCandidateWindows = (vm.candidates || []).some((c) => effectiveCandidateWindow(c) > 0);
  // 模态过滤：发图请求只保留「未明确声明不支持」的候选（未知一律放行）。
  // 与窗口过滤同构——请求时过滤，纯文本请求仍可用全部候选。
  const modality = autotier.filterCandidatesByModality(vm, messages);

  const startedAt = ctx.startedAt || Date.now();
  const keyPlatform = ctx.keyPlatform || 'all';
  const maxAttempts = Math.max(1, vm.failover.maxAttempts || 3);
  const tried = new Set();
  const attempts = [];
  let lastErr = null;

  /**
   * 流式出口的答案提交闸门。
   *
   * 它把「HTTP 响应可提交」与「答案可提交」拆开：完整帧立即下发（正常路径的
   * 字节流与时序与改动前一致），只扣住未成行的残片，因此换候选既不会把残片
   * 拼进下一个候选的流，也不会让客户端少收到完整帧。
   * 能不能换候选的判据由此从 `res.headersSent` 变为 `gate.answerCommitted`：
   * 上游只输出过思考（reasoning）就失败时，窗口仍然是开着的——这正是原实现
   * 因为「首个增量即 flushHeaders」而丢掉的那类场景。
   */
  const gate = ctx.stream !== false ? createStreamGate(res) : null;
  let switched = 0;
  /**
   * 渠道校验拒绝（11128）后**整平台**熔断本次请求的候选。
   *
   * 该错误是「请求身份不被上游认可」的确定性判定：同一个 provider 下换模型、
   * 换账号都会撞同一堵墙（失败现场 12 次 11128 横跨 6 个模型 3 次尝试即为证据）。
   * 因此只允许跨平台降级（workbuddy → trae），同平台不再重试。
   */
  const blockedProviders = new Set();
  /**
   * 账号受限（11140）后**同账号**熔断本次请求的候选。受限是账号级处置：
   * 同账号挂在多个候选（同一上游账号可被多个虚拟模型引用）时，换候选只是
   * 换个门牌撞同一面墙。平台不整体熔断——受限只落在单个账号上，同平台
   * 其他账号照常可用。
   */
  const restrictedCandidates = new Set();

  for (let i = 0; i < maxAttempts; i++) {
    let candidates = orderCandidates(virtualId, vm, keyPlatform).filter((c) => !tried.has(c.id));
    if (blockedProviders.size) candidates = candidates.filter((c) => !blockedProviders.has(c.provider));
    if (restrictedCandidates.size) candidates = candidates.filter((c) => !restrictedCandidates.has(c.id));
    // 候选级窗口守门：只把「装得下当前输入」的候选视为可用（有候选声明窗口时才启用）
    if (hasCandidateWindows) candidates = candidates.filter((c) => fittingAll.some((f) => f.id === c.id));
    // 候选级模态守门：发图请求排掉明确不支持多模态的候选
    if (modality.image) candidates = candidates.filter((c) => modality.list.some((m) => m.id === c.id));
    if (!candidates.length) {
      if (!lastErr) {
        const windowBlocked = hasCandidateWindows && estTokens > 0;
        // 模态阻塞优先于窗口阻塞报告：用户看到「这个入口没有能读图的候选」
        // 才能对症处理（换入口/补候选），而不是去清历史记录。
        const modalityBlocked = modality.blocked;
        const e = new Error(
          modalityBlocked
            ? `virtual model "${virtualId}": no candidate supports image input (all enabled candidates declare multimodal=false). Use a virtual model that includes a vision candidate, or remove the image.`
            : windowBlocked
              ? `virtual model "${virtualId}": no candidate can fit estimated input ${estTokens} tokens (all candidates below 75% of their context window, or disabled/cooling)`
              : `virtual model "${virtualId}": no available candidate (platform=${keyPlatform}; disabled/cooling/rate-limited or not in platform scope)`,
        );
        e.status = modalityBlocked ? 400 : (windowBlocked ? 400 : 429);
        e.code = modalityBlocked ? 'MODALITY_UNSUPPORTED' : (windowBlocked ? 'context_length_exceeded' : 'VIRTUAL_NO_CANDIDATE');
        lastErr = e;
      }
      break;
    }
    const cand = candidates[0];
    tried.add(cand.id);
    const provider = store.getProvider(cand.provider);
    const t0 = Date.now();
    attempts.push({ candidateId: cand.id, provider: cand.provider, model: cand.model });

    try {
      const body = {
        model: cand.model,
        messages,
        temperature: ctx.temperature,
        top_p: ctx.top_p,
        max_tokens: autotier.clampMaxTokens(cand, ctx.max_tokens),
        stop: ctx.stop,
        tools: ctx.tools || undefined,
        tool_choice: ctx.tool_choice || undefined,
      };
      let result;
      let rawUsageForLog = null; // 裁剪前的原始 usage（含缓存读细节），仅用于计费日志
      // 真实命中的池账号 ID：dispatch 在 pool.run 拿到租约后回调上报。
      // 旧实现只把候选模型 ID 写进日志（如 workbuddy/wb/space-bunny），
      // 账号级消耗无法从 traffic 日志对账，只能靠余额快照差分反推。
      let usedAccountId = null;
      const onAccount = (id) => { if (id) usedAccountId = id; };
      if (ctx.stream !== false) {
        result = await dispatch.dispatchStream(provider, cand.model, body, res, {
          startedAt: t0,
          stickyKey: ctx.stickyKey,
          stickyAccountId: ctx.stickyAccountId,
          echoModel: virtualId,
          onAccount,
          gate,
        });
      } else {
        result = await dispatch.dispatchNonStream(provider, cand.model, body, {
          stickyKey: ctx.stickyKey,
          stickyAccountId: ctx.stickyAccountId,
          onAccount,
        });
        // 计费日志用原始 usage（含缓存读细节）；回写客户端前再裁到官方三字段
        if (result && typeof result === 'object' && result.usage) rawUsageForLog = result.usage;
        if (result && typeof result === 'object') {
          // 回写请求中的虚拟模型 ID，便于客户端校验 model 字段
          result.model = virtualId;
          if (result.usage) result.usage = dispatch.sanitizeUsage(result.usage) || result.usage;
        }
        if (!res.writableEnded) res.json(result);
      }
      health.markOk(virtualId, cand.id, Date.now() - t0);
      // 结束原因可观测性：truncated=true 表示上游截断（客户端会走续写或提示超长）
      const fr = (result && result.finishReason)
        || (result && result.choices && result.choices[0] && result.choices[0].finish_reason)
        || null;
      // usage 提取：流式来自 dispatch 返回值（末帧合并前已捕获），
      // 非流式优先用裁剪前的原始 usage（保留缓存读细节，标定费率需要它）。
      // 无 usage 时不写字段，统计层据此区分「未计量」与「消耗为 0」。
      let usageFields = usageToLogFields(rawUsageForLog || (result && result.usage));
      // 上游未回传 usage 时用真实分词器补算（结果仍属估算，日志标 tokensEstimated）。
      // 补算口径见 lib/token-precise.js：分词器与上游不完全一致，只作趋势参考。
      let tokensEstimated = false;
      if (!usageFields.totalTokens && config.estimateMissingTokens) {
        const outText = (result && result.outputText)
          || (result && result.choices && result.choices[0]
            && result.choices[0].message && result.choices[0].message.content)
          || '';
        const est = estimateTokensOfText(ctx.messages, outText);
        if (est.totalTokens > 0) {
          usageFields = est;
          tokensEstimated = true;
        }
      }
      // 费率按真实命中的上游模型（cand.model）计，而不是虚拟 ID——
      // 虚拟 ID 在费率表里没有条目，曾导致估算恒为 null。
      // platform 一并传：标定系数按平台分表（同名模型跨平台费率不同）。
      const platformTag = provider.type === 'openai' ? `openai:${cand.provider}` : provider.builtin;
      const estCost = usageFields.totalTokens
        ? estimateCost(cand.model, usageFields.promptTokens, usageFields.completionTokens, {
          cacheRead: Number(usageFields.cacheReadTokens) || 0,
          platform: platformTag,
        })
        : null;
      logRequest({
        endpoint: '/v1/chat/completions',
        method: 'POST',
        model: virtualId,
        // 账号归属用真实池账号 ID（acct_…）；拿不到时回落到候选 ID（保持旧行为）。
        account: usedAccountId || cand.id,
        accountId: usedAccountId || null,
        status: 200,
        toolCalls: 0,
        toolsIn: ctx.tools ? ctx.tools.length : 0,
        ...rtkLogFields(rtk.stats),
        durationMs: Date.now() - startedAt,
        error: null,
        platform: platformTag,
        virtualModel: virtualId,
        routedTo: `${cand.provider}/${cand.model}`,
        // 逻辑回合：turnId 由请求上下文（AsyncLocalStorage）自动带上，同一客户端
        // 请求的所有尝试共享它；attempt 是本回合内的第几次上游尝试。
        attempt: attempts.length,
        // 本轮为拿到答案换过几个候选：可观测性用。长期为 0 说明提交闸门没起作用，
        // 长期偏高说明候选健康度或上游稳定性有问题。
        ...(switched > 0 ? { failoverSwitches: switched } : {}),
        ...usageFields,
        ...(tokensEstimated ? { tokensEstimated: true } : {}),
        // 守门估算 vs 上游真实 promptTokens：长期累积可看出启发式估算在哪些
        // 内容形态（代码/英文/工具 schema）上系统性偏低，据此调校估算系数与
        // 各候选 contextWindow，避免守门在窗口边界失效。
        ...(estTokens > 0 && usageFields.promptTokens
          ? { tokenEstimate: estTokens, tokenEstimateDelta: usageFields.promptTokens - estTokens }
          : {}),
        // 计费模型：统计层按它查费率与标定表；model 是虚拟 ID，查不到任何费率
        ...(cand.model ? { pricedModel: cand.model } : {}),
        ...(estCost != null ? { estimatedCost: estCost } : {}),
        ...(fr ? { finishReason: fr, truncated: dispatch.isTruncatedFinish(fr) } : {}),
      });
      return { ok: true, candidate: cand, attempts };
    } catch (err) {
      lastErr = err;
      const kind = classifyError(err);
      const cooled = health.markFail(virtualId, cand.id, kind, err, vm.failover.cooldownMs);
      // 渠道校验拒绝：整平台熔断本次请求（换模型/换号在同一平台上都是同一堵墙），
      // 但保留跨平台降级能力（workbuddy → trae）。账号本身健康，markFail 不冷却它。
      if (kind === 'channel') {
        blockedProviders.add(cand.provider);
        console.log(`[model-router] channel blocked on provider ${cand.provider} (code ${err.upstreamCode ?? '?'}), `
          + 'skipping its remaining candidates for this request');
      }
      // 账号受限（11140）：本请求内跳过该候选；跨请求靠 health 的 2h 冷却
      // （orderCandidates 会把冷却中的候选排掉）。受限账号续期无效，
      // 不改 'auth' 的续期路径——这里已提前分流，不会走到那里。
      if (kind === 'account') {
        restrictedCandidates.add(cand.id);
        console.log(`[model-router] account restricted on candidate ${cand.id} (code ${err.upstreamCode ?? '?'}), `
          + `cooling it for ${Math.round((health.cooldownRemaining(virtualId, cand.id) || 0) / 60000)}min; `
          + 'use another account or wait — refreshing the token will NOT lift this');
      }
      // 可切换判据：答案（content/tool_call 的完整帧）是否已交付客户端。
      // 不能用 res.headersSent：dispatchTraeStream 在上游第一个增量（可能只是
      // reasoning）就会 flushHeaders，用它当判据会让「只思考过、随后上游失败」
      // 的场景永远无法降级——而那正是最该降级的情形。
      // 非流式路径没有闸门，维持原行为（响应体还没写出去，随时可换）。
      const canSwitch = shouldSwitch(kind, vm) && i < maxAttempts - 1
        && (gate ? !gate.answerCommitted : !res.headersSent);
      logRequest({
        endpoint: '/v1/chat/completions',
        method: 'POST',
        model: virtualId,
        account: cand.id,
        status: err.status && err.status >= 400 ? err.status : 500,
        // 同一次客户端请求的第几次尝试（回合聚合用，见 log/stats.js#turnBuckets）
        attempt: attempts.length,
        toolCalls: 0,
        toolsIn: ctx.tools ? ctx.tools.length : 0,
        // RTK 节省只记在**代表本回合结局**的那一行：压缩是每次客户端请求做一次，
        // 若每个失败尝试都记一遍，日聚合按行相加会把节省量按尝试次数放大。
        ...(canSwitch ? {} : rtkLogFields(rtk.stats)),
        durationMs: Date.now() - t0,
        error: err.message,
        platform: provider.type === 'openai' ? `openai:${cand.provider}` : provider.builtin,
        virtualModel: virtualId,
        routedTo: `${cand.provider}/${cand.model}`,
      });
      if (!canSwitch) break;
      if (gate) {
        // 丢弃未成行的残片：绝不能让上一个候选的半行拼进下一个候选的流里。
        // 完整帧早已下发，这个操作不会让客户端少收到任何东西。
        const dropped = gate.discardHeld();
        if (dropped > 0) {
          console.log(`[model-router] 换候选前丢弃未成行残片 ${dropped}B（候选 ${cand.provider}/${cand.model}）`);
        }
      }
      switched += 1;
      console.log(`[model-router] ${kind} on ${cand.provider}/${cand.model}, switching (attempt ${i + 1}/${maxAttempts}, cool ${cooled.cooledForMs}ms)`);
    }
  }

  // 全部失败：统一错误出口（流已开始则尽量补错误帧，否则返回 JSON）
  const err = lastErr || new Error(`virtual model "${virtualId}": all candidates failed`);
  if (gate) gate.dispose();
  if (res.writableEnded) return { ok: false, error: err.message, attempts };
  // 渠道校验全灭时给可执行的提示：原始报文（Illegal API invocation…）对使用者
  // 没有任何指向性，而真正的动作是「更新客户端身份版本」或「改用其它平台」。
  const lastKind = classifyError(err);
  const channelBlocked = lastKind === 'channel';
  // 账号受限全灭：动作是「换账号/等冷却」，而不是重试或续期——受限不在
  // 调用方能解，继续打只会加重账号画像。
  const accountRestricted = lastKind === 'account';
  const errMessage = channelBlocked
    ? `${err.message}\n\n上游按渠道校验拒绝了本平台的请求形状（code 11128）。`
      + `这不是账号、模型或上下文问题：请核对 WorkBuddy 桌面端版本与 CLI 版本`
      + `（platform/variant.js#identity.appVersion / cliVersion，或 WB_APP_VERSION / WB_CLI_VERSION），`
      + `或在虚拟模型里保留至少一个非 workbuddy 候选以便跨平台降级。`
    : accountRestricted
      ? `${err.message}\n\n上游已限制本平台账号（code 11140，账号级风控处置）。`
        + `这不是请求形状或模型问题：换一个账号（面板导入新凭据），或等待冷却后探测是否解除；`
        + `续期 token 与重试都无效。若账号持续受限并伴随积分清零，该账号大概率已被处置。`
      : err.message;
  // 走同一个 sink：若闸门里还扣着未成行的残片，必须先丢弃，
  // 否则错误帧会被拼到半行后面，客户端解析整行失败、连错误都看不到。
  const sink = gate || res;
  if (sink.headersSent) {
    try {
      if (gate) gate.discardHeld();
      sink.write(`data: ${JSON.stringify({ error: { message: errMessage, type: 'upstream_error', code: err.upstreamCode ?? err.code ?? (err.status === 429 ? 429 : null) } })}\n\n`);
      sink.write('data: [DONE]\n\n');
    } catch { /* ignore */ }
    if (!res.writableEnded) res.end();
    return { ok: false, error: errMessage, attempts };
  }
  res.status(err.status && err.status >= 400 ? err.status : 500).json({
    // code 原样带出：客户端要能区分「窗口装不下」「没有能读图的候选」「池里没可用账号」，
    // 否则只能拿到一句 message，无法程序化处理（上游错误码走 upstreamCode）。
    error: {
      message: errMessage,
      type: 'upstream_error',
      ...(err.code ?? err.upstreamCode) != null ? { code: err.code ?? err.upstreamCode } : {},
    },
  });
  return { ok: false, error: errMessage, attempts };
}

module.exports = {
  hasVirtualModel,
  isVirtualId,
  autotier,
  orderCandidates,
  explainCandidates,
  handleChat,
  checkContextLimit,
  usageToLogFields,
  store,
  health,
  dispatch,
  clearCooldown: health.clearAllCooldowns,
  snapshot: () => ({
    providers: store.listProviders(),
    virtualModels: store.listVirtual().map((vm) => ({
      ...vm,
      candidates: explainCandidates(vm.id),
    })),
    health: health.snapshot(),
  }),
};
