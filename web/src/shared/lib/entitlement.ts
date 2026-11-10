/**
 * 权益归一：把四个平台的四套额度口径映射成同一个视图模型。
 *
 * 为什么必须集中在一处：后端刻意用四个**隔离键**存额度，因为它们不可相加——
 *   Trae / WorkBuddy  → entitlement_snapshot.packs（积分，量级 1e3）
 *   ZCode             → tokenBuckets / tokenRemaining（token，量级 1e8）
 *   Qoder             → quota{base, addOn}（配额，两段独立）
 *   Raccoon           → raccoonPoints{available, packages}（积分，分池，日清）
 * 代码里原本只有一个读取点 `accountPacks.tsx#packsOf`，它只读 `packs`，
 * 于是 ZCode / Qoder / Raccoon 三个平台在「权益包」「权益到期」两列恒为「—」。
 * 这不是展示漏了，是数据通道只有一条。
 *
 * 本模块的输出是**严格可区分口径**的：每个视图都带 `unit`，任何跨账号汇总
 * 只按 unit 分组累加。绝不把 token 与 credit 相加（那是 ZCode 那一亿 token
 * 曾被算成积分、把今日消耗抬高 4 个数量级的同一个坑）。
 *
 * 依赖方向：本文件只依赖 types 与 format，不依赖 features——它要被多个
 * 页面订阅（凭据池列表、权益总览、详情弹窗）。
 */
import type { Account, PackDigest } from '../api/types';
import { formatNumber, platformOf, type Platform } from '../lib/format';

/** 额度计量单位。不同单位之间不可相加，界面上必须各自标注。 */
export type EntitlementUnit = 'credit' | 'token' | 'quota' | 'points';

/** 到期呈现形态。 */
export type ExpiryTone = 'expired' | 'critical' | 'warning' | 'normal' | 'none';

export interface EntitlementSummary {
  platform: Platform;
  unit: EntitlementUnit;
  /** 主读数：该平台口径下的剩余额度（可能为 null = 未查询到） */
  amount: number | null;
  /** 主读数的可读文案，已含单位后缀的分工由调用方决定 */
  amountText: string;
  /** 副读数：说明这个数是什么（如「赠送额度」「0 Token」「12 个可用包」） */
  detailText: string;
  /** 到期：剩余自然日；null 表示无到期概念或未查询到 */
  days: number | null;
  /** 到期文案：「21 天后」「已到期」「长期」「未查询」 */
  expiryText: string;
  tone: ExpiryTone;
  /** 7 个自然日内到期的额度（积分口径才有意义；其余为 null） */
  expiring7d: number | null;
  /** 权益条目数（包 / 桶 / 额度段 / 分池）；0 表示未查询到 */
  items: number;
  /** 快照写入时刻；null 表示从未查询 */
  snapshotAt: string | null;
  /** 快照是否陈旧（> 24 小时） */
  stale: boolean;
  /** 该账号是否有任何可展示的权益数据 */
  known: boolean;
}

/**
 * 快照陈旧的判定窗口。
 *
 * 24 小时：余额轮询是 60 秒一轮，正常情况下快照不会超过几分钟。
 * 超过一天意味着「这个平台从未刷新成功」或「该账号长期未参与轮询」，
 * 两种情况用户都需要知道，否则会把 20 天前的数字当成实时值
 * （实测 Raccoon 一个账号的快照停在 2026-10-20）。
 */
const STALE_MS = 24 * 3600_000;

/** 天数 → 到期色调。阈值与后端 summarizeExpiry 的 3 / 7 日对齐。 */
export function toneOfDays(days: number | null): ExpiryTone {
  if (days == null) return 'none';
  if (days <= 0) return 'expired';
  if (days <= 3) return 'critical';
  if (days <= 7) return 'warning';
  return 'normal';
}

/** 天数 → 到期文案。 */
export function expiryTextOf(days: number | null, fallback = '长期'): string {
  if (days == null) return fallback;
  if (days <= 0) return '已到期';
  return `${days} 天后`;
}

/** 快照陈旧判定（entitlementSnapshotUpdatedAt 距今 > 24h）。 */
export function isStale(snapshotAt: string | null | undefined, now = Date.now()): boolean {
  if (!snapshotAt) return false; // 从未查询过 → 由 known=false 表达，不算「陈旧」
  const t = new Date(snapshotAt).getTime();
  if (!Number.isFinite(t)) return false;
  return now - t > STALE_MS;
}

/* ---------- 各平台投影 ---------- */

/**
 * 积分口径（Trae / WorkBuddy）：读 packDigest（slim）或 packs（完整）。
 *
 * 两条来源的判定规则由后端保证一致：packDigest 来自
 * credentials/entitlement-view.js#digestOf，它调用与 summarizeExpiry/FEFO
 * 相同的 naturalDayDiff。前端不再自行算天数。
 */
function creditSummary(a: Account, now: number): EntitlementSummary {
  const platform = platformOf(a);
  /**
   * 摘要优先级：
   *   1. `packDigest` —— 列表端点（?slim=1）给的摘要，后端已按平台口径算好；
   *   2. `packCaliber === 'credit'` 的 `packs` —— 未带 slim 时的兜底。
   *
   * `packCaliber` 是后端明确告诉前端「这行的 packs 是否属于积分口径」的标记。
   * 它存在的理由：ZCode 的快照里可能残留 token 计量的 packs（`meter:'model_usage'`、
   * limit 1e8），那是 token 不是积分。没有这个标记时只能靠 edition 猜，
   * 而猜错一次就是 1 亿 token 被算成 1 亿积分。标记缺失时按平台判定兜底。
   */
  const creditCaliber = a.packCaliber
    ? a.packCaliber === 'credit'
    : platform === 'trae' || platform === 'workbuddy';
  const d: PackDigest | null = a.packDigest ?? (creditCaliber ? digestFromPacks(a) : null);
  const known = !!d && d.total > 0;
  const days = d?.soonestDays ?? null;

  if (!known) {
    return {
      platform, unit: 'credit', amount: null, amountText: '—',
      detailText: '未查询到权益包', days: null, expiryText: '未查询',
      tone: 'none', expiring7d: null, items: 0,
      snapshotAt: a.entitlementSnapshotUpdatedAt ?? null,
      stale: isStale(a.entitlementSnapshotUpdatedAt, now), known: false,
    };
  }

  const usable = d!.usable;
  const unlimited = d!.unlimited;
  // 主读数：可用积分合计；全是不限量包时没有金额可报，如实说「不限量」
  const amount = unlimited > 0 && usable === unlimited ? null : d!.usableAmount;
  const amountText = amount == null ? '不限量' : formatNumber(amount);
  const detailText = unlimited > 0 && amount != null
    ? `${usable} 个可用包 · 含 ${unlimited} 个不限量`
    : usable > 0
      ? `${usable} 个可用包`
      : `${d!.total} 个包均已失效`;

  return {
    platform, unit: 'credit', amount, amountText, detailText,
    days, expiryText: usable > 0 ? expiryTextOf(days) : '—',
    tone: usable > 0 ? toneOfDays(days) : 'none',
    expiring7d: d!.expiring7d, items: usable,
    snapshotAt: a.entitlementSnapshotUpdatedAt ?? null,
    stale: isStale(a.entitlementSnapshotUpdatedAt, now),
    known: true,
  };
}

/** 完整 packs → 摘要（列表未带 slim 参数时的兜底，与后端同口径）。 */
function digestFromPacks(a: Account): PackDigest | null {
  const packs = a.packs;
  if (!Array.isArray(packs) || !packs.length) return null;
  const now = Date.now();
  let total = 0;
  let usable = 0;
  let usableAmount = 0;
  let unlimited = 0;
  let expiring7d = 0;
  let soonestDays: number | null = null;
  let soonestAmount = 0;

  for (const p of packs) {
    total += 1;
    const isUnlimited = p.unlimited === true;
    const remaining = typeof p.remaining === 'number' && Number.isFinite(p.remaining) ? p.remaining : null;
    const expireMs = typeof p.expireTime === 'number' && p.expireTime > 0 ? p.expireTime * 1000 : null;
    if (expireMs != null && expireMs <= now) continue;
    if (!isUnlimited && remaining === 0) continue;
    usable += 1;
    if (isUnlimited) { unlimited += 1; continue; }
    if (remaining != null) usableAmount += remaining;
    if (expireMs == null) continue;
    // 自然日差，与后端 naturalDayDiff 同算法（按本地零点对齐取整）
    const days = naturalDays(expireMs, now);
    if (days == null) continue;
    if (days <= 7 && remaining != null) expiring7d += remaining;
    if (soonestDays == null || days < soonestDays) {
      soonestDays = days;
      soonestAmount = remaining ?? 0;
    }
  }
  return {
    total, usable, usableAmount, unlimited, expiring7d, soonestDays, soonestAmount,
  };
}

/** 自然日差（与后端 naturalDayDiff 一致：两地零点之差取整到天）。 */
function naturalDays(expireMs: number, nowMs: number): number | null {
  if (!Number.isFinite(expireMs) || expireMs <= 0) return null;
  const startOfDay = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  return Math.round((startOfDay(expireMs) - startOfDay(nowMs)) / 86_400_000);
}

/** 数值四舍五入到 2 位，消除跨账号累加的浮点噪声（12974.150000000001）。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * ZCode：token 计量。
 *
 * ⚠️ 只读 tokenBuckets / tokenRemaining，**绝不读 packs**。
 * 实测该账号的 entitlement_snapshot 里残留一条历史遗留的 packs
 * （meter:'model_usage'、limit:1e8），那是 token 数被误写进积分口径的痕迹，
 * 也正是 src/test/unit.test.js:4435 明令禁止的状态。读它会把 1 亿 token
 * 当成 1 亿积分。
 */
function tokenSummary(a: Account, now: number): EntitlementSummary {
  const bucketList = Array.isArray(a.tokenBuckets) ? a.tokenBuckets : [];
  const total = typeof a.tokenRemaining === 'number' && Number.isFinite(a.tokenRemaining)
    ? a.tokenRemaining
    : bucketList.length
      ? bucketList.reduce((s, b) => s + (Number(b.remaining) || 0), 0)
      : null;

  // 最近到期的桶（expireTime 是秒级时间戳）
  let soonestDays: number | null = null;
  for (const b of bucketList) {
    const sec = typeof b.expireTime === 'number' && b.expireTime > 0 ? b.expireTime : null;
    if (sec == null) continue;
    const days = naturalDays(sec * 1000, now);
    if (days == null) continue;
    if (soonestDays == null || days < soonestDays) soonestDays = days;
  }

  const known = total != null;
  /**
   * 额度为 0 且没有分桶明细时，`amountText · expiryText` 会渲染成「0 Token · —」，
   * 这是可读性最差的一种组合：两个破折号并排，用户无法判断是「没有额度」
   * 还是「查不到」。
   *
   * 这里把它改成能自解释的单一短语：额度耗尽的账号直接说「额度已用尽」，
   * 前端 entitlementCellText 对 token 口径会原样使用 detailText（不再拼到期）。
   */
  const exhausted = known && total === 0;
  const detailText = !known
    ? '未查询到额度'
    : exhausted
      ? '额度已用尽'
      : bucketList.length === 0
        ? '未取到分桶明细'
        : `${bucketList.length} 个额度桶`;

  return {
    platform: 'zcode', unit: 'token',
    amount: known ? total : null,
    amountText: known ? formatNumber(total) : '—',
    detailText,
    days: soonestDays,
    // 额度耗尽时不报到期：一个已经空了的桶，说「30 天后到期」只会误导
    expiryText: !known
      ? '未查询'
      : exhausted
        ? '—'
        : soonestDays == null
          ? '未取到分桶'
          : expiryTextOf(soonestDays),
    tone: known ? toneOfDays(soonestDays) : 'none',
    expiring7d: null,
    items: bucketList.length,
    snapshotAt: a.entitlementSnapshotUpdatedAt ?? null,
    stale: isStale(a.entitlementSnapshotUpdatedAt, now),
    known,
  };
}

/**
 * Qoder：基础额度 + 赠送额度，两段独立、不互相包含。
 *
 * 主读数取**非零的那一段**：实测 4 个账号的 base 全是 0、addOn 才是真实额度，
 * 直接报 base 会让整列显示 0。两段都非零时求和仅作展示并用 detailText 说明构成。
 */
function quotaSummary(a: Account, now: number): EntitlementSummary {
  const q = a.quota;
  const base = typeof q?.base?.remaining === 'number' ? q.base.remaining : null;
  const addOn = typeof q?.addOn?.remaining === 'number' ? q.addOn.remaining : null;
  const known = base != null || addOn != null;
  const sum = (base ?? 0) + (addOn ?? 0);

  // 到期：两段各自有 expiresAt，取更早的那个
  let soonestDays: number | null = null;
  for (const iso of [q?.base?.expiresAt ?? null, q?.addOn?.expiresAt ?? null]) {
    if (!iso) continue;
    const days = naturalDays(new Date(iso).getTime(), now);
    if (days == null) continue;
    if (soonestDays == null || days < soonestDays) soonestDays = days;
  }

  const parts: string[] = [];
  if (base != null && base > 0) parts.push(`基础 ${formatNumber(base)}`);
  if (addOn != null && addOn > 0) parts.push(`赠送 ${formatNumber(addOn)}`);

  return {
    platform: 'qoder', unit: 'quota',
    amount: known ? sum : null,
    amountText: known ? formatNumber(sum) : '—',
    detailText: !known
      ? '未查询到配额'
      : parts.length > 1
        ? parts.join(' + ')
        : parts.length === 1
          ? `${parts[0]}`
          : '基础与赠送额度均为 0',
    days: soonestDays,
    expiryText: known ? expiryTextOf(soonestDays) : '未查询',
    tone: known ? toneOfDays(soonestDays) : 'none',
    expiring7d: null,
    items: (base != null ? 1 : 0) + (addOn != null ? 1 : 0),
    snapshotAt: a.entitlementSnapshotUpdatedAt ?? (q?.updatedAt ?? null),
    stale: isStale(a.entitlementSnapshotUpdatedAt ?? q?.updatedAt ?? null, now),
    known,
  };
}

/**
 * Raccoon：分池积分。
 *
 * 单位单列为 `points` 而不是 `credit`：虽然上游也叫「积分」，但它是**分池 + 日清**
 * 语义（每日积分次日整额清零），与 Trae / WorkBuddy 的可累积积分不是同一个东西。
 * 归到同一个 unit 会让「按 unit 分组累加」把两套语义加在一起。
 *
 * 「每日积分」按官方规则次日整额清零（src/raccoon/credits.js:23 已实证），
 * 所以这个平台**没有**可报的到期天数，只能标「日清」。硬给它算一个到期日
 * 是编数据；如实说「日清」才是正确表达。
 */
function raccoonSummary(a: Account, now: number): EntitlementSummary {
  const p = a.raccoonPoints;
  const pkgs = Array.isArray(p?.packages) ? p.packages : [];
  const available = typeof p?.available === 'number'
    ? p.available
    : typeof a.balance === 'number'
      ? a.balance
      : null;
  const known = available != null;

  // 主读数：总额。副读数给占比最大的分池，避免把 4 个池全铺进单元格
  const top = [...pkgs]
    .filter((x) => typeof x.remaining === 'number' && x.remaining > 0)
    .sort((x, y) => y.remaining - x.remaining)[0];
  const daily = pkgs.find((x) => /每日/.test(x.name));

  const detailParts: string[] = [];
  if (top) detailParts.push(`${top.name} ${formatNumber(top.remaining)}`);
  if (daily && daily.remaining > 0 && top && daily.name !== top.name) {
    detailParts.push(`${daily.name} ${formatNumber(daily.remaining)}`);
  }

  return {
    platform: 'raccoon', unit: 'points',
    amount: available,
    amountText: known ? formatNumber(available) : '—',
    detailText: !known
      ? '未查询到积分'
      : detailParts.length
        ? detailParts.join(' + ')
        : `${pkgs.length} 个积分池`,
    days: null,
    // 每日积分次日清零，没有「N 天后到期」这回事
    expiryText: known ? '日清' : '未查询',
    tone: known ? 'none' : 'none',
    expiring7d: null, items: pkgs.length,
    snapshotAt: p?.updatedAt ?? a.entitlementSnapshotUpdatedAt ?? null,
    stale: isStale(p?.updatedAt ?? a.entitlementSnapshotUpdatedAt ?? null, now),
    known,
  };
}

/**
 * 单账号权益视图。按平台分派，未知平台按积分口径处理（宁可少一个字段，
 * 也不要因为后端新增平台就把整行渲染成空白）。
 */
export function entitlementOf(a: Account, now = Date.now()): EntitlementSummary {
  switch (platformOf(a)) {
    case 'zcode': return tokenSummary(a, now);
    case 'qoder': return quotaSummary(a, now);
    case 'raccoon': return raccoonSummary(a, now);
    default: return creditSummary(a, now);
  }
}

/**
 * 「权益」列的单行文案。
 *
 * 各口径的表达方式不同，不能一律 `detail · 到期`：
 *   - 积分：`12 个可用包 · 21 天后`（数量 + 到期，两个维度都有意义）
 *   - Token：有桶时 `N 个额度桶 · 30 天后`；耗尽时只留「额度已用尽」
 *     （`0 Token · —` 这种破折号并排读不出信息）
 *   - 配额：`赠送 2,026 · 长期`（两段构成比段数重要）
 *   - Raccoon：`奖励积分 1,524 + 每日积分 600 · 日清`
 */
export function entitlementCellText(e: EntitlementSummary): string {
  if (!e.known) return '未查询';
  if (e.unit === 'token') {
    // 耗尽 / 未取到分桶：detailText 本身已经是完整句子，不再拼到期
    if (e.amount === 0 || e.items === 0) return e.detailText;
    return `${e.detailText} · ${e.expiryText}`;
  }
  return `${e.detailText} · ${e.expiryText}`;
}

/** 额度列的数值文案（不含单位）；单位由调用方用 .text-unit 渲染。 */
export function amountUnitOf(e: EntitlementSummary): string {
  if (e.unit === 'token') return 'Token';
  if (e.unit === 'quota') return '配额';
  if (e.unit === 'points') return '积分';
  return '积分';
}

export interface PlatformRollup {
  platform: Platform;
  unit: EntitlementUnit;
  /** 该平台所有账号的额度合计（同 unit 内累加） */
  amount: number | null;
  /** 账号数 */
  accounts: number;
  /** 有数据的账号数 */
  known: number;
  /** 可用权益条目数合计 */
  items: number;
  /** 7 日内到期额度合计（仅积分口径） */
  expiring7d: number | null;
  /** 最早到期天数 */
  soonestDays: number | null;
  /** 最旧的快照时刻（用于整体陈旧提示） */
  oldestSnapshotAt: string | null;
  /** 是否有账号快照陈旧 */
  stale: boolean;
  /** 平台内的补充说明（Qoder 的两段、Raccoon 的分池） */
  detail: string;
}

/**
 * 按平台汇总（权益总览面板用）。
 *
 * 严格按 platform 分组：每个平台一个 unit，绝不跨 unit 相加。
 * Trae / WorkBuddy 同为 credit（可累积积分）；ZCode 是 token；Qoder 是 quota；
 * Raccoon 是 points（分池 + 日清，与可累积积分语义不同，故单列一个 unit）。
 * 跨 unit 相加是明确的错误（见文件头说明），故本函数不提供总额。
 */
export function rollupByPlatform(accounts: Account[], now = Date.now()): PlatformRollup[] {
  const ORDER: Platform[] = ['trae', 'workbuddy', 'zcode', 'qoder', 'raccoon'];
  const map = new Map<Platform, PlatformRollup & { _base: number; _addOn: number; _pools: string[] }>();

  for (const a of accounts) {
    const e = entitlementOf(a, now);
    let r = map.get(e.platform);
    if (!r) {
      r = {
        platform: e.platform, unit: e.unit, amount: 0, accounts: 0, known: 0, items: 0,
        expiring7d: e.unit === 'credit' ? 0 : null,
        soonestDays: null, oldestSnapshotAt: null, stale: false, detail: '',
        _base: 0, _addOn: 0, _pools: [],
      };
      map.set(e.platform, r);
    }
    r.accounts += 1;
    if (e.known) {
      r.known += 1;
      // 累加后统一 round2 收口：逐项累加会产生 12974.150000000001 这类尾巴
      r.amount = round2((r.amount ?? 0) + (e.amount ?? 0));
    }
    r.items += e.items;
    if (e.expiring7d != null && r.expiring7d != null) {
      r.expiring7d = round2(r.expiring7d + e.expiring7d);
    }
    if (e.days != null && (r.soonestDays == null || e.days < r.soonestDays)) r.soonestDays = e.days;
    if (e.snapshotAt) {
      const t = new Date(e.snapshotAt).getTime();
      const cur = r.oldestSnapshotAt ? new Date(r.oldestSnapshotAt).getTime() : null;
      if (cur == null || (Number.isFinite(t) && t < cur)) r.oldestSnapshotAt = e.snapshotAt;
    }
    if (e.stale) r.stale = true;

    // 平台内补充说明
    if (e.platform === 'qoder') {
      r._base += a.quota?.base?.remaining ?? 0;
      r._addOn += a.quota?.addOn?.remaining ?? 0;
    }
    if (e.platform === 'raccoon') {
      for (const p of a.raccoonPoints?.packages ?? []) {
        if (!(p.remaining > 0)) continue;
        r._pools.push(p.name);
      }
    }
  }

  const out: PlatformRollup[] = [];
  for (const platform of ORDER) {
    const r = map.get(platform);
    if (!r) continue;
    const { _base, _addOn, _pools, ...rest } = r;
    if (platform === 'qoder') {
      const parts: string[] = [];
      if (_base > 0) parts.push(`基础 ${formatNumber(_base)}`);
      if (_addOn > 0) parts.push(`赠送 ${formatNumber(_addOn)}`);
      rest.detail = parts.length ? parts.join(' + ') : '基础与赠送额度均为 0';
    } else if (platform === 'raccoon') {
      const uniq = [...new Set(_pools)];
      rest.detail = uniq.length ? uniq.join(' / ') : '无可用积分池';
    } else if (platform === 'zcode') {
      rest.detail = rest.known > 0 ? 'Token 计量，不计入积分' : '未查询到额度';
    }
    out.push(rest);
  }
  return out;
}
