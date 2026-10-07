'use strict';
/**
 * credentials/pool.js — 账号池：积分优先调度 + 分级冷却 + 在途租约 + 签到解冻。
 *
 * pick()
 *   - 过滤 enabled / coolUntil / 模型级冷却 / 余额低于阈值
 *   - least_balance：余额高优先（对照 trae2api-web / Sliverkiss）
 *   - round_robin：errorCount → lastPickedAt
 *   - 排除 maxInFlight 满员账号与 100ms 防撞
 *
 * record()
 *   - ok：清 errorCount；若余额>阈值可解冻
 *   - auth：短冷却
 *   - quota(402)：硬冷却到次日 04:00
 *   - rate_limit：优先用上游恢复时刻，否则指数退避；带 model 时只冷 (账号,模型)
 *   - model：模型级冷却（6004 类），不冷却整号
 *   - 5xx：计数熔断
 *
 * run()
 *   - 租约 acquire/release；auth/quota 换号
 */
const store = require('./store');
const { classifyError, parseRateLimitReset } = require('../upstream/errors');
const { summarizeExpiry, summarizeFefo } = require('./credits');
const config = require('../config');
const { notify } = require('../notify');
const variant = require('../platform/variant');

const COOL_AUTH_MS = 10 * 60 * 1000;
const COOL_5XX_MS = 5 * 60 * 1000;
const COOL_THRESHOLD = 5;
const MAX_ERROR_COUNT = 50;
const WAIT_TIMEOUT_MS = 30_000; // 等号最长等待，超过则放弃
const WAIT_CAPACITY_PROBE_MS = 200; // 在途满时的探测步长（无法精确预测完成时刻）

/** 模型级冷却的指数退避基数与封顶（6004 类：上游未给恢复时刻时用）。 */
const MODEL_COOL_BASE_MS = 60 * 1000;
const MODEL_COOL_MAX_MS = 6 * 60 * 60 * 1000;

/** 进程内在途计数（不持久化）。 */
const inFlight = new Map();

/** 每账号近窗内的请求起点时间戳（内存，用于滚动窗口槽位上限）。 */
const recentStart = new Map();

/**
 * FIFO 等待队列：账号满载/节流时请求在此排队，由 release() 事件驱动唤醒。
 * 队列长度即并发连接堆积量，受 maxWaiters() 限制，超出直接拒绝（429），
 * 避免子代理高并发下连接无限堆积压垮进程。
 */
const waiters = [];
let waitSeq = 0;

let _enabledCount = 1;
let _enabledCountAt = 0;

/** 排队上限：默认取「账号并发上限 × 倍数」，保证有界且随池规模伸缩。 */
function maxWaiters() {
  const n = Number(process.env.POOL_MAX_WAITERS);
  if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
  // 缓存账号数：避免每次入队都触发全表扫描（list() 含逐行解密）
  const now = Date.now();
  if (now - _enabledCountAt > 5000) {
    _enabledCount = store.list().filter((a) => a.enabled).length || 1;
    _enabledCountAt = now;
  }
  return Math.max(8, _enabledCount * maxInFlight() * 4);
}

/** 当前排队长度（调度状态观测用）。 */
function waiterCount() {
  return waiters.length;
}

/**
 * 入队等待。返回 Promise：
 * - 被唤醒 → resolve('ready')，调用方需自行重新 pick
 * - 超时   → resolve('timeout')
 * - 队满   → reject(QueueFullError)
 */
function enqueueWaiter(opts) {
  if (waiters.length >= maxWaiters()) {
    const e = new Error(`pool wait queue full (${waiters.length}/${maxWaiters()})`);
    e.code = 'POOL_QUEUE_FULL';
    e.status = 429;
    return Promise.reject(e);
  }
  return new Promise((resolve) => {
    const id = ++waitSeq;
    // 不 unref：超时是排队者的兜底放行路径，被 unref 会在进程空闲时永久悬挂
    const timer = setTimeout(() => {
      removeWaiter(id);
      resolve({ reason: 'timeout' });
    }, WAIT_TIMEOUT_MS);
    waiters.push({ id, opts, resolve, timer, enqueuedAt: Date.now() });
  });
}

function removeWaiter(id) {
  const i = waiters.findIndex((w) => w.id === id);
  if (i === -1) return null;
  const [w] = waiters.splice(i, 1);
  clearTimeout(w.timer);
  return w;
}

/**
 * 唤醒队首等待者（FIFO，避免饥饿）。
 * 只唤醒「当前确实可能拿到号」的请求；若队首条件不满足则停止，
 * 保持顺序语义，防止后到者插队。
 * 取不到号时按「下一个最早可用时刻」安排精确定时唤醒，避免空转。
 */
function wakeWaiters() {
  let woken = 0;
  while (waiters.length) {
    const head = waiters[0];
    if (!couldPick(head.opts)) break;
    removeWaiter(head.id);
    head.resolve({ reason: 'ready' });
    woken++;
  }
  if (waiters.length && woken === 0) scheduleWake();
  return woken;
}

/**
 * 判断该请求此刻是否可能取到号（pick 的完整过滤条件）。
 * 与 pick() 保持一致，避免「唤醒了却拿不到号」的空转。
 */
function couldPick(opts = {}) {
  return pickCandidate(opts) !== null;
}

/**
 * 返回最早可能取到号的账号（不产生副作用），语义对齐 pick() 的过滤条件。
 */
function pickCandidate(opts = {}) {
  const now = Date.now();
  const exclude = new Set(opts.exclude || []);
  return store.list().find((a) =>
    a.enabled
    && !inCooldown(a)
    && !modelCooling(a, opts.model)
    && balanceOk(a)
    && groupOk(a)
    && editionOk(a, opts.edition)
    && hasCapacity(a)
    && !exclude.has(a.id)
    && now - (a.lastPickedAt || 0) >= minPickGapMs()
    && recentCount(a.id) < rateWindowMax()) || null;
}

/**
 * 计算「距离最早可能有号还有多少毫秒」。
 * 遍历所有账号，对容量/节流/窗口/冷却约束取各自解除时刻的最小值。
 */
function nextAvailableIn(opts = {}) {
  const now = Date.now();
  const exclude = new Set(opts.exclude || []);
  let best = Infinity;
  for (const a of store.list()) {
    if (!a.enabled || balanceOk(a) === false || !groupOk(a) || !editionOk(a, opts.edition) || exclude.has(a.id)) continue;
    if (modelCooling(a, opts.model)) {
      // 模型级冷却可精确计算解除时刻
      const until = modelCooldownMap(a)[String(opts.model)];
      const t = until ? new Date(until).getTime() - now : 0;
      if (t > 0) best = Math.min(best, Math.max(0, t));
      continue;
    }
    let wait = 0;
    // 冷却
    if (a.coolUntil) wait = Math.max(wait, new Date(a.coolUntil).getTime() - now);
    // 容量：在途满则需等待任一请求完成，无法精确预测，用一个探测步长
    if (!hasCapacity(a)) wait = Math.max(wait, WAIT_CAPACITY_PROBE_MS);
    // 出站节流
    wait = Math.max(wait, minPickGapMs() - (now - (a.lastPickedAt || 0)));
    // 滚动窗口
    const starts = recentStart.get(a.id) || [];
    const w = rateWindowMs();
    const inWindow = starts.filter((t) => now - t < w);
    if (inWindow.length >= rateWindowMax()) {
      const oldest = Math.min(...inWindow);
      wait = Math.max(wait, w - (now - oldest));
    }
    if (wait < best) best = wait;
  }
  if (!Number.isFinite(best)) return null; // 无账号可救
  return Math.max(0, best);
}

let _wakeTimer = null;

/** 安排一次精确定时唤醒（去重，多个等待者共用一个定时器）。 */
function scheduleWake() {
  if (_wakeTimer || !waiters.length) return;
  const delay = nextAvailableIn(waiters[0].opts);
  if (delay === null) return; // 无账号可救，交由等待者超时处理
  // 不 unref：唤醒定时器是排队者的唯一放行路径，被 unref 会在进程空闲时丢失
  _wakeTimer = setTimeout(() => {
    _wakeTimer = null;
    if (waiters.length) wakeWaiters();
  }, Math.min(Math.max(delay, 0) + 5, WAIT_TIMEOUT_MS));
}

/** 队列快照（诊断 / 压测观测用）。 */
function waiterSnapshot() {
  const now = Date.now();
  return {
    count: waiters.length,
    limit: maxWaiters(),
    // 队首等待时长（ms），用于判断背压是否成为瓶颈
    headWaitMs: waiters.length ? now - waiters[0].enqueuedAt : 0,
    oldestWaitMs: waiters.length ? now - Math.min(...waiters.map((w) => w.enqueuedAt)) : 0,
  };
}

function maxInFlight() {
  const n = Number(config.maxInFlightPerAccount);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 2;
}

/** 同账号两次请求开始的最小间隔（出站节流，防 3004）。 */
function minPickGapMs() {
  const n = Number(config.ratePaceMs);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

/** rate_limit 后账号冷却基数。 */
function rateCooldownMs() {
  const n = Number(config.rateCooldownMs);
  return Number.isFinite(n) && n > 0 ? n : 20000;
}

/** rate_limit 指数退避封顶（连续 429 时按次数翻倍，到此为止）。 */
function rateCooldownMaxMs() {
  const n = Number(config.rateCooldownMaxMs);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000;
}

/**
 * 连续 rate_limit 的退避时长：基数 × 2^(连续次数-1)，封顶 maxMs。
 * @param {number} streak 当前账号连续 rate_limit 次数（≥1）
 */
function backoffMs(streak) {
  const s = Math.max(1, Math.trunc(streak) || 1);
  const capped = Math.min(s, 16); // 2^16 已远超封顶，防溢出与无意义计算
  return Math.min(rateCooldownMs() * Math.pow(2, capped - 1), rateCooldownMaxMs());
}

/** 滚动窗口长度。 */
function rateWindowMs() {
  const n = Number(config.rateWindowMs);
  return Number.isFinite(n) && n > 0 ? n : 30000;
}

/** 滚动窗口内单账号最大承载请求数。 */
function rateWindowMax() {
  const n = Number(config.rateWindowMax);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

function pruneRecent() {
  const now = Date.now();
  const w = rateWindowMs();
  for (const [id, arr] of recentStart) {
    const kept = arr.filter((t) => now - t < w);
    if (kept.length) recentStart.set(id, kept);
    else recentStart.delete(id);
  }
}

/** 账号在滚动窗口内的当前请求数。 */
function recentCount(id) {
  pruneRecent();
  return (recentStart.get(id) || []).length;
}

/** 记录一次请求起点。 */
function markStart(id) {
  pruneRecent();
  const arr = recentStart.get(id) || [];
  arr.push(Date.now());
  recentStart.set(id, arr);
}

function strategy() {
  return config.poolStrategy === 'round_robin' ? 'round_robin' : 'least_balance';
}

function inCooldown(a) {
  if (!a.coolUntil) return false;
  return new Date(a.coolUntil).getTime() > Date.now();
}

/** 模型级冷却表（账号字段 modelCooldowns: { [model]: ISO }）。 */
function modelCooldownMap(a) {
  return a && a.modelCooldowns && typeof a.modelCooldowns === 'object' && !Array.isArray(a.modelCooldowns)
    ? a.modelCooldowns
    : {};
}

/** 该账号对指定模型是否处于冷却中。model 为空时只看整号冷却（此处只负责模型维度）。 */
function modelCooling(a, model) {
  if (!a || !model) return false;
  const until = modelCooldownMap(a)[String(model)];
  if (!until) return false;
  const t = new Date(until).getTime();
  if (!Number.isFinite(t)) return false;
  if (t <= Date.now()) return false; // 过期条目惰性清理（写入时顺带删除）
  return true;
}

/** 清理已过期的模型冷却条目（返回 null 表示无可清理）。 */
function pruneModelCooldowns(a) {
  const map = modelCooldownMap(a);
  const now = Date.now();
  const kept = {};
  let changed = false;
  for (const [m, until] of Object.entries(map)) {
    const t = new Date(until).getTime();
    if (Number.isFinite(t) && t > now) kept[m] = until;
    else changed = true;
  }
  return changed ? kept : null;
}

/** 写一条模型级冷却（durationMs 或精确 ISO 时刻二选一）。 */
function coolModel(a, model, { durationMs, untilIso } = {}) {
  if (!a || !model) return;
  const map = { ...modelCooldownMap(a) };
  const prev = map[model] ? new Date(map[model]).getTime() : 0;
  const until = untilIso ? new Date(untilIso).getTime() : Date.now() + (durationMs || 0);
  // 只延长不缩短：短时间内多次命中时保留最严格的约束
  if (until <= prev) return;
  map[String(model)] = new Date(until).toISOString();
  store.update(a.id, { modelCooldowns: map });
}

function getInFlight(id) {
  return inFlight.get(id) || 0;
}

function acquire(id) {
  const n = getInFlight(id) + 1;
  inFlight.set(id, n);
  return n;
}

function release(id) {
  const n = Math.max(0, getInFlight(id) - 1);
  if (n === 0) inFlight.delete(id);
  else inFlight.set(id, n);
  // 腾出容量即唤醒排队者（事件驱动，替代空转轮询）
  wakeWaiters();
  return n;
}

function balanceOf(a) {
  return typeof a.balance === 'number' && Number.isFinite(a.balance) ? a.balance : null;
}

/** 账号快照里的权益包列表（两平台结构一致：{ packs: [...] }）。 */
function packsOf(a) {
  return a && a.entitlementSnapshot && Array.isArray(a.entitlementSnapshot.packs)
    ? a.entitlementSnapshot.packs
    : [];
}

function balanceOk(a) {
  const min = Number(config.minBalanceToUse) || 0;
  const b = balanceOf(a);
  // 未知余额（null）视为可用，避免从未刷过余额的号全被拒
  if (b == null) return true;
  return b >= min;
}

function hasCapacity(a) {
  return getInFlight(a.id) < maxInFlight();
}

/** 分组过滤（POOL_GROUPS env，逗号分隔；空 = 不限分组）。 */
function groupOk(a) {
  const raw = String(process.env.POOL_GROUPS || '').trim();
  if (!raw) return true;
  const allowed = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  if (!allowed.size) return true;
  return !!a.group && allowed.has(a.group);
}

/**
 * 平台过滤：workbuddy 账号（edition='workbuddy'）与 trae 账号分池调度，
 * 由 opts.edition 指定目标平台；未指定时仅取 trae 系账号（保持既有行为）。
 *
 * 平台判定走 variant.canChat（单一事实源）：新增平台（如 zcode）的
 * capability.chat=false，未声明 chat 能力前不可能被误选进转发池。
 * 未知 edition 显式排除——绝不能兜底进任何池。
 *
 * 平台归属一律走 variant.isEdition —— 它内部用 isTrae（白名单 cn/sg/us/manual）
 * 归一化 Trae 系历史值。此前这里用 editionOf(a.edition) === editionOf(wanted)
 * 直接字符串比较，而 editionOf 只做 toLowerCase 不做归一，导致库里 edition='cn'
 * 的 Trae 账号永远不等于 wanted='trae'，全部 Trae 账号被静默排除出池
 * （表现为整池 429 "No account available in pool"）。
 */
function editionOk(a, wanted) {
  const edition = variant.editionOf(a.edition);
  if (wanted) return variant.isEdition(edition, wanted) && variant.canChat(edition);
  // 未指定目标平台时：保持既有行为——canChat 为真且非 workbuddy
  // （空 edition 的历史账号视为 Trae 系；显式平台过滤由上面的 wanted 分支负责）
  return variant.canChat(edition) && edition !== variant.WORKBUDDY;
}

/**
 * 从启用账号中选一个可用账号。
 * @param {string} excludeId
 * @param {{exclude?: string[], edition?: 'trae'|'workbuddy'}} opts
 */
function pick(excludeId, opts = {}) {
  const now = Date.now();
  const exclude = new Set(opts.exclude || []);
  if (excludeId) exclude.add(excludeId);

  const all = store.list().filter((a) =>
    a.enabled
    && !inCooldown(a)
    && !modelCooling(a, opts.model)
    && balanceOk(a)
    && groupOk(a)
    && editionOk(a, opts.edition)
    && hasCapacity(a)
    && !exclude.has(a.id)
    && now - (a.lastPickedAt || 0) >= minPickGapMs()
    && recentCount(a.id) < rateWindowMax()
  );

  if (!all.length) return null;

  const prioOf = (a) => Number(a.priority) || 0;
  // 成本分层：costTier 越小越优先（0=免费额度包，1=未知/默认，2=收费）；对齐 Sliverkiss 成本优先选号
  const costTierOf = (a) => (Number.isFinite(a.costTier) ? Number(a.costTier) : 1);
  // FEFO（先到期先用）：临期积分作废是硬损失，优先于余额。
  // 账号携带的权益包（entitlementSnapshot.packs）里取「最近一个未用尽包的到期时刻」，
  // 到期越近的账号越先被调度，从根上避免按余额排序把临期积分拖过期。
  // packsOf 见模块级定义（snapshot / explain 亦需复用）
  // 兜底排序信号：d3/d7 金额分档（仅在到期时刻相同时用于打破平局）
  const expiringOf = (a) => summarizeExpiry(packsOf(a)) || { d3: 0, d7: 0 };
  // 主排序信号：最近到期时刻；无任何可计量到期包的账号排最后（不抢占临期额度）
  const fefoOf = (a) => summarizeFefo(packsOf(a)) || { soonestMs: null, soonestDays: null, soonestAmount: 0 };
  if (strategy() === 'least_balance') {
    all.sort((x, y) => {
      const px = prioOf(x);
      const py = prioOf(y);
      if (px !== py) return py - px; // 置顶优先级高的先
      // 1) FEFO：到期时刻升序（先到期先用）。无到期包的账号沉底，不与临期账号抢。
      const fx = fefoOf(x);
      const fy = fefoOf(y);
      const hx = fx.soonestMs == null;
      const hy = fy.soonestMs == null;
      if (hx !== hy) return hx ? 1 : -1;
      if (!hx && !hy) {
        if (fx.soonestMs !== fy.soonestMs) return fx.soonestMs - fy.soonestMs;
        // 同一到期时刻：临期金额多的先消耗
        if (fx.soonestAmount !== fy.soonestAmount) return fy.soonestAmount - fx.soonestAmount;
      }
      // 2) 同到期档位再按 d3/d7 金额分档
      const ex = expiringOf(x);
      const ey = expiringOf(y);
      if (ex.d3 !== ey.d3) return ey.d3 - ex.d3; // 3 天内到期积分多者优先
      if (ex.d7 !== ey.d7) return ey.d7 - ex.d7; // 7 天内到期积分多者次之
      const cx = costTierOf(x);
      const cy = costTierOf(y);
      if (cx !== cy) return cx - cy; // 免费层优先
      const bx = balanceOf(x);
      const by = balanceOf(y);
      // 未知余额放后面；余额大优先；再按闲置时间
      const sx = bx == null ? -1 : bx;
      const sy = by == null ? -1 : by;
      if (sx !== sy) return sy - sx;
      return (x.lastPickedAt || 0) - (y.lastPickedAt || 0);
    });
  } else {
    all.sort((x, y) => prioOf(y) - prioOf(x)
      || (x.errorCount || 0) - (y.errorCount || 0)
      || (x.lastPickedAt || 0) - (y.lastPickedAt || 0));
  }

  const chosen = all[0];
  store.update(chosen.id, { lastPickedAt: now });
  markStart(chosen.id);
  return chosen;
}

/** 池内可用账号为 0 时告警（去重由 notify 模块处理）。 */
function alertIfPoolEmpty() {
  try {
    const all = store.list().filter((a) =>
      a.enabled
      && !inCooldown(a)
      && balanceOk(a)
      && hasCapacity(a));
    if (!all.length) {
      notify('pool_empty', { message: 'no usable account in pool' }).catch(() => {});
    }
  } catch { /* best-effort */ }
}

/** 硬冷却：次日本地时区 04:00。 */
function nextDayFourAmIso() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(4, 0, 0, 0);
  return d.toISOString();
}

/**
 * 记录一次调用结果。
 * @param {string} id
 * @param {'ok'|'auth'|'network'|'5xx'|'rate_limit'|'quota'|'model'|'other'} kind
 * @param {{model?:string, message?:string}} [info] model=触发限流的模型；message=上游错误文案（用于解析精确恢复时刻）
 */
function record(id, kind, info = {}) {
  if (!id) return;
  const a = store.get(id);
  if (!a) return;

  if (kind === 'ok') {
    const pruned = pruneModelCooldowns(a);
    // 成功即重置连续限流计数：否则再次限流时退避会从上次残留次数继续翻倍
    store.update(id, {
      errorCount: 0,
      coolUntil: null,
      rateStreak: 0,
      modelCoolStreak: 0,
      ...(pruned ? { modelCooldowns: pruned } : {}),
    });
    // 该账号解冻后重新可用，唤醒排队者
    wakeWaiters();
    return;
  }

  if (kind === 'network') return;

  // 模型级限流（6004 类）：只冷 (账号, 模型) 组合，不冷却整号。
  // 此前完全放行会让同一账号对同一模型被反复撞限；有恢复时刻用精确值，否则指数退避。
  if (kind === 'model') {
    const model = info.model ? String(info.model) : null;
    if (!model) return;
    const untilIso = parseRateLimitReset(info.message || '')
      || new Date(Date.now() + Math.min(
        MODEL_COOL_BASE_MS * Math.pow(2, Math.min(a.modelCoolStreak || 0, 10)),
        MODEL_COOL_MAX_MS,
      )).toISOString();
    coolModel(a, model, { untilIso });
    store.update(id, { modelCoolStreak: Math.min((a.modelCoolStreak || 0) + 1, 16) });
    return;
  }

  if (kind === 'quota') {
    store.update(id, {
      errorCount: Math.min((a.errorCount || 0) + 1, MAX_ERROR_COUNT),
      coolUntil: nextDayFourAmIso(),
    });
    return;
  }

  if (kind === 'rate_limit') {
    const model = info.model ? String(info.model) : null;
    // 上游给出精确恢复时刻（"将在 … 重置" / "usage will reset at …"）则直接采用
    const untilIso = parseRateLimitReset(info.message || '');
    if (model) {
      // 模型维度记录：只冷该模型，账号其余模型继续服务
      coolModel(a, model, untilIso ? { untilIso } : { durationMs: backoffMs((a.rateStreak || 0) + 1) });
    }
    if (!model || !untilIso) {
      // 账号级兜底：无 model 或无精确时刻时，按连续限流次数指数退避（替代此前固定 20s）
      const streak = Math.min((a.rateStreak || 0) + 1, 16);
      store.update(id, {
        coolUntil: untilIso || new Date(Date.now() + backoffMs(streak)).toISOString(),
        rateStreak: streak,
      });
    } else {
      store.update(id, { rateStreak: Math.min((a.rateStreak || 0) + 1, 16) });
    }
    return;
  }

  const next = Math.min((a.errorCount || 0) + 1, MAX_ERROR_COUNT);
  const patch = { errorCount: next, rateStreak: 0, modelCoolStreak: 0 };

  if (kind === 'auth') {
    patch.coolUntil = new Date(Date.now() + COOL_AUTH_MS).toISOString();
  } else if (kind === '5xx' && next >= COOL_THRESHOLD) {
    patch.coolUntil = new Date(Date.now() + COOL_5XX_MS).toISOString();
  }

  store.update(id, patch);
}

/** 签到/刷余额后：余额恢复则清冷却（解冻）。 */
function unfreezeIfHealthy(id) {
  const a = store.get(id);
  if (!a || !a.enabled) return false;
  if (balanceOf(a) != null && balanceOf(a) < (Number(config.minBalanceToUse) || 0)) return false;
  if (a.coolUntil) {
    store.update(id, { coolUntil: null, errorCount: 0 });
    wakeWaiters();
    return true;
  }
  return false;
}

/**
 * 包装一次上游调用：选号 → 租约 → 调用 → 释放。
 * @param {Function} fn async (accountId) => result
 * @param {{maxSwitches?:number, stickyKey?:string, stickyAccountId?:string, edition?:'trae'|'workbuddy'}} opts
 */
async function run(fn, opts = {}) {
  const maxSwitches = opts.maxSwitches ?? 3;
  const attempted = new Set();
  let lastErr = null;

  // 粘性：优先复用绑定账号（同样受出站节流/窗口约束，避免短期连打同一账号触发 3004）
  if (opts.stickyAccountId) {
    const sticky = store.get(opts.stickyAccountId);
    const now = Date.now();
    if (sticky && sticky.enabled && !inCooldown(sticky) && !modelCooling(sticky, opts.model)
        && balanceOk(sticky) && hasCapacity(sticky)
        && editionOk(sticky, opts.edition)
        && now - (sticky.lastPickedAt || 0) >= minPickGapMs()
        && recentCount(sticky.id) < rateWindowMax()) {
      attempted.add(sticky.id);
      store.update(sticky.id, { lastPickedAt: Date.now() });
      markStart(sticky.id);
      acquire(sticky.id);
      try {
        const result = await fn(sticky.id);
        record(sticky.id, 'ok');
        return { result, accountId: sticky.id };
      } catch (err) {
        const kind = classifyError(err);
        record(sticky.id, kind, { model: opts.model, message: err.message });
        lastErr = err;
        // rate_limit 同样切换：账号已进入短冷却，继续重试只会重复 3004
        if (kind !== 'auth' && kind !== 'quota' && kind !== 'rate_limit') throw err;
        console.log(`[pool] sticky ${kind} on ${sticky.id}, switching`);
      } finally {
        release(sticky.id);
      }
    }
  }

  // 池满载/节流时进入 FIFO 等待队列，由 release() 事件或精确定时唤醒；
  // 队列有上限，超出直接 429，避免连接无限堆积。
  let switches = 0;
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const acct = pick(null, { exclude: Array.from(attempted), edition: opts.edition, model: opts.model });
    if (!acct) {
      // 无任何账号可救（禁用/冷却/余额不足）才判池空；仅节流则继续排队
      const hasHope = nextAvailableIn({ exclude: Array.from(attempted), edition: opts.edition, model: opts.model });
      if (hasHope === null) {
        alertIfPoolEmpty();
        break;
      }
      const wait = await enqueueWaiter({ exclude: Array.from(attempted), edition: opts.edition, model: opts.model });
      if (wait.reason === 'timeout') break;
      continue;
    }

    const accountId = acct.id;
    attempted.add(accountId);
    acquire(accountId);

    try {
      const result = await fn(accountId);
      record(accountId, 'ok');
      return { result, accountId };
    } catch (err) {
      const kind = classifyError(err);
      record(accountId, kind, { model: opts.model, message: err.message });
      lastErr = err;
      // rate_limit 同样切换：账号已进入短冷却，继续重试只会重复 3004
      if (kind !== 'auth' && kind !== 'quota' && kind !== 'rate_limit') throw err;
      switches++;
      console.log(`[pool] ${kind} on ${accountId}, switching (${switches}/${maxSwitches})`);
      if (switches >= maxSwitches) break;
    } finally {
      release(accountId);
    }
  }

  // 池耗尽属于「暂时无可用账号」，对客户端是可重试语义（429），
  // 而非服务内部错误（500）；避免客户端把背压误判为故障。
  if (lastErr) throw lastErr;
  const e = new Error('No account available in pool (all accounts throttled or cooling)');
  e.code = 'POOL_UNAVAILABLE';
  e.status = 429;
  throw e;
}

/**
 * 逐账号解释「为何能/不能被 pick」，不产生副作用（Route Check 用）。
 *
 * 与 pickCandidate 同源：过滤条件在此只写一份，避免解释口径与实际调度
 * 分叉（此前该函数放在 upstream/errors.js，导致 pool ⇄ errors 循环依赖，
 * 且与 pick 的条件各写一遍）。
 *
 * @param {string[]} excludeIds 视为已被本次请求尝试过的账号
 * @returns {{id:string,label:string,balance:number|null,priority:number,errorCount:number,coolUntil:string|null,inFlight:number,usable:boolean,reasons:string[]}[]}
 */
function explainCandidates(excludeIds = []) {
  const exclude = new Set(excludeIds);
  const now = Date.now();
  const min = Number(config.minBalanceToUse) || 0;
  const maxIn = maxInFlight();

  return store.list().map((a) => {
    const reasons = [];
    if (!a.enabled) reasons.push('disabled');
    if (a.coolUntil && new Date(a.coolUntil).getTime() > now) reasons.push('cooling');
    if (modelCooling(a, a._explainModel)) reasons.push('model_cooling');
    if (typeof a.balance === 'number' && a.balance < min) reasons.push('low_balance');
    if (getInFlight(a.id) >= maxIn) reasons.push('full_inflight');
    if (exclude.has(a.id)) reasons.push('excluded');
    const pruned = pruneModelCooldowns(a);
    if (pruned) store.update(a.id, { modelCooldowns: pruned });
    const modelCooldowns = pruned || modelCooldownMap(a);
    return {
      id: a.id,
      label: a.label,
      balance: a.balance,
      priority: a.priority || 0,
      errorCount: a.errorCount || 0,
      coolUntil: a.coolUntil || null,
      modelCooldowns: Object.keys(modelCooldowns).length ? modelCooldowns : null,
      inFlight: getInFlight(a.id),
      usable: reasons.length === 0,
      reasons,
    };
  });
}

function snapshot() {
  const list = store.list();
  return {
    strategy: strategy(),
    maxInFlight: maxInFlight(),
    waiters: waiterSnapshot(),
    accounts: list.map((a) => {
      const pruned = pruneModelCooldowns(a);
      if (pruned) store.update(a.id, { modelCooldowns: pruned });
      const modelCooldowns = pruned || modelCooldownMap(a);
      return {
        id: a.id,
        label: a.label,
        balance: a.balance,
        // FEFO 排序信号：暴露给管理面，便于核对「先到期先用」是否按预期生效
        fefo: summarizeFefo(packsOf(a)),
        errorCount: a.errorCount,
        coolUntil: a.coolUntil,
        modelCooldowns: Object.keys(modelCooldowns).length ? modelCooldowns : null,
        priority: a.priority || 0,
        inFlight: getInFlight(a.id),
        usable: a.enabled && !inCooldown(a) && balanceOk(a) && hasCapacity(a),
      };
    }),
  };
}

module.exports = {
  pick,
  record,
  run,
  inCooldown,
  modelCooling,
  snapshot,
  unfreezeIfHealthy,
  getInFlight,
  maxInFlight,
  alertIfPoolEmpty,
  waiterCount,
  waiterSnapshot,
  explainCandidates,
  COOL_AUTH_MS,
};
