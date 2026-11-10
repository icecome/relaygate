/**
 * 总览页的展开明细数据。
 *
 * 三个数字各自能展开成什么，取决于后端到底有没有对应的口径——这是本模块
 * 存在的唯一理由：**无法拆分的数字就不要假装能拆**。
 *
 * | 指标 | 可拆到什么粒度 | 依据 |
 * |---|---|---|
 * | 可用额度 | 按平台 → 按账号 | `packDigest`（积分）/ `tokenBuckets` / `quota` / `raccoonPoints` 四套隔离键，全部在手 |
 * | 今日消耗 | 按平台 → 按账号 | `credit_history` 逐账号差分，**但只有积分口径会写这张表** |
 * | 即将到期 | 按账号（含平台） | `packs` / `tokenBuckets` 的 `expireTime`，需完整 packs，故走详情端点 |
 *
 * 关键约束（不要为了「看起来完整」而破坏）：
 *   - 今日消耗**不得**给 ZCode / Qoder / Raccoon 编数字。后端从 2026-10 起刻意
 *     不写它们的 credit_history（token 混进积分曾把今日消耗抬高 4 个数量级）。
 *     这三类平台如实标「未纳入统计」，而不是显示 0。
 *   - 跨平台额度不可相加：积分 / Token / 配额 / 分池积分是四种计量。
 */
import type { Account } from '../api/types';
import type { CreditHistoryRow } from '../api/stats';
import { entitlementOf, rollupByPlatform, type PlatformRollup } from './entitlement';
import { platformIdLabel, formatNumber, type Platform } from './format';

/* ---------- ① 可用额度：按平台 ---------- */

export interface PlatformAmountRow {
  platform: Platform;
  label: string;
  unit: string;
  /** 该平台额度合计（同 unit 内累加） */
  amount: number | null;
  accounts: number;
  known: number;
  /** 平台内补充说明（Qoder 两段 / Raccoon 分池 / ZCode 计量） */
  detail: string;
  /** 该平台是否有账号快照过期 */
  stale: boolean;
}

const UNIT_LABEL: Record<string, string> = {
  credit: '积分',
  token: 'Token',
  quota: '配额',
  points: '积分',
};

/** 可用额度的按平台拆分。直接复用权益总览的汇总口径，不另算一套。 */
export function amountByPlatform(accounts: Account[]): PlatformAmountRow[] {
  return rollupByPlatform(accounts).map((r: PlatformRollup) => ({
    platform: r.platform,
    label: platformIdLabel(r.platform),
    unit: UNIT_LABEL[r.unit] ?? r.unit,
    amount: r.known > 0 ? r.amount : null,
    accounts: r.accounts,
    known: r.known,
    detail: r.detail,
    stale: r.stale,
  }));
}

/**
 * 积分口径的「按平台占比」序列，供卡面混合条使用。
 *
 * 只统计 `unit === 'credit'` 且平台不是 raccoon 的行——那是唯一可相加的口径
 * （Trae + WorkBuddy）。Token / 配额 / 分池积分不进来：它们的量级差 4~5 个
 * 数量级，混进同一条百分比条会变成「WorkBuddy 占 99.9%」这种没有信息的图。
 *
 * `unknown` 是「有账号但一次都没查过余额」的平台数。它必须能被单独说出来：
 * 把这些平台当作 0 参与分母，会让已有数据的平台占比虚高。
 */
export interface CreditShareRow {
  platform: Platform;
  label: string;
  amount: number;
  /** 占积分口径合计的比例 0~1 */
  share: number;
}

export function creditShare(rows: PlatformAmountRow[]): {
  total: number;
  parts: CreditShareRow[];
  unknownPlatforms: string[];
} {
  const credit = rows.filter((r) => r.unit === '积分' && r.platform !== 'raccoon');
  const total = credit.reduce((s, r) => s + (r.amount ?? 0), 0);
  const parts = credit
    .filter((r) => (r.amount ?? 0) > 0)
    .map((r) => ({
      platform: r.platform,
      label: r.label,
      amount: r.amount ?? 0,
      // total 为 0 时给 0，不给 NaN —— 除零在图上表现为宽度 0%，但 NaN 会让
      // style 里出现 `width: NaN%`，浏览器静默丢弃整条规则
      share: total > 0 ? (r.amount ?? 0) / total : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
  const unknownPlatforms = credit.filter((r) => r.known === 0 || r.amount == null).map((r) => r.label);
  return { total, parts, unknownPlatforms };
}

/* ---------- ② 今日消耗：按平台 / 按账号 ---------- */

export interface UsageByPlatformRow {
  platform: Platform;
  label: string;
  amount: number;
  /** 该平台参与统计的账号数 */
  accounts: number;
  /** 有可差分快照的账号数（< accounts 说明部分账号本轮没刷新过） */
  covered: number;
  /** 该平台是否根本不写 credit_history（token / 配额 / 分池口径） */
  notTracked: boolean;
  /** 按账号明细，金额降序 */
  members: { accountId: string; label: string; amount: number; covered: boolean }[];
}

/**
 * 今日消耗按平台拆分。
 *
 * `accounts` 是当前账号清单（用来给 credit_history 的行补平台归属——
 * 后端的 summary() 只回 accountId，不重复存 edition）。
 *
 * `notTracked` 的判定：该平台既没有任何已被统计的账号，又不是积分口径。
 * 这样 ZCode / Qoder / Raccoon 会明确显示「未纳入统计」，而不是 0。
 */
export function usageByPlatform(
  accounts: Account[],
  usage: CreditHistoryRow[],
): UsageByPlatformRow[] {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const byPlatform = new Map<string, UsageByPlatformRow>();
  const seenPlatforms = new Set<Platform>();

  // 先按账号清单铺出全部平台，保证「0 消耗但有账号」的平台也会出现一行
  for (const a of accounts) {
    const e = entitlementOf(a);
    seenPlatforms.add(e.platform);
    if (!byPlatform.has(e.platform)) {
      byPlatform.set(e.platform, {
        platform: e.platform,
        label: platformIdLabel(e.platform),
        amount: 0,
        accounts: 0,
        covered: 0,
        notTracked: false,
        members: [],
      });
    }
  }

  for (const row of usage) {
    const acct = accountById.get(row.accountId);
    if (!acct) continue;
    const e = entitlementOf(acct);
    const bucket = byPlatform.get(e.platform);
    if (!bucket) continue;
    bucket.accounts += 1;
    bucket.amount += row.usedTotal;
    if (row.covered) bucket.covered += 1;
    if (row.usedTotal > 0 || row.covered) {
      bucket.members.push({
        accountId: row.accountId,
        label: row.label,
        amount: row.usedTotal,
        covered: row.covered,
      });
    }
  }

  for (const [platform, bucket] of byPlatform) {
    const first = accounts.find((a) => entitlementOf(a).platform === platform);
    const unit = first ? entitlementOf(first).unit : 'credit';
    // 非积分口径（token / quota / points）不写 credit_history —— 如实标注
    bucket.notTracked = unit !== 'credit';
    bucket.amount = Math.round(bucket.amount * 100) / 100;
    bucket.members.sort((x, y) => y.amount - x.amount);
    void seenPlatforms;
  }

  const ORDER: Platform[] = ['trae', 'workbuddy', 'zcode', 'qoder', 'raccoon'];
  return ORDER.map((p) => byPlatform.get(p)).filter((r): r is UsageByPlatformRow => !!r);
}

/* ---------- ③ 即将到期：按账号 ---------- */

export interface ExpiringAccountRow {
  accountId: string;
  label: string;
  platform: Platform;
  platformLabel: string;
  unit: string;
  /** 该账号在窗口内到期的积分总额 */
  amount: number;
  /** 最近一项的剩余自然日（0 = 今天到期） */
  days: number;
  /** 到期项数 */
  items: number;
  /** 到期的包 / 桶名称（1 个代表名，便于识别类型） */
  names: string[];
  /** 包名去重后的变体数（>1 说明同族多个变体，明细在 title 里看项数即可） */
  nameVariants: number;
}

/** 到期提醒窗口（自然日）。 */
export const EXPIRY_WINDOWS = [3, 7, 30] as const;
export type ExpiryWindow = (typeof EXPIRY_WINDOWS)[number];

/**
 * 按账号拆出「N 日内将要到期多少额度」。
 *
 * 需要**完整**的 packs / tokenBuckets，因此只在用户展开「即将到期」时
 * 拿到明细数据后调用（列表端点是 slim，只有聚合值）。
 *
 * 统计口径与后端 `summarizeExpiry` 一致：
 *   - 只算未用尽（remaining > 0）且未过期的条目；
 *   - 用自然日差（本地零点对齐），不是毫秒除法；
 *   - unlimited（remaining 为 null）不计入金额。
 */
export function expiringAccounts(
  accounts: Account[],
  windowDays: ExpiryWindow,
  now = Date.now(),
): ExpiringAccountRow[] {
  const out: ExpiringAccountRow[] = [];

  for (const a of accounts) {
    const e = entitlementOf(a);
    // 到期只在有明确到期时间的口径里有意义：Raccoon 是日清，没有到期日
    if (e.unit === 'points') continue;

    const items: { amount: number; days: number; name: string }[] = [];

    if (e.unit === 'token') {
      for (const b of a.tokenBuckets ?? []) {
        const sec = typeof b.expireTime === 'number' && b.expireTime > 0 ? b.expireTime : null;
        if (sec == null) continue;
        const days = naturalDays(sec * 1000, now);
        if (days == null || days < 0 || days > windowDays) continue;
        const remaining = Number(b.remaining) || 0;
        if (remaining <= 0) continue;
        items.push({ amount: remaining, days, name: b.name || '额度桶' });
      }
    } else if (e.unit === 'quota') {
      const segs = [
        { name: '基础额度', seg: a.quota?.base },
        { name: '赠送额度', seg: a.quota?.addOn },
      ];
      for (const { name, seg } of segs) {
        if (!seg?.expiresAt) continue;
        const days = naturalDays(new Date(seg.expiresAt).getTime(), now);
        if (days == null || days < 0 || days > windowDays) continue;
        const remaining = Number(seg.remaining) || 0;
        if (remaining <= 0) continue;
        items.push({ amount: remaining, days, name });
      }
    } else {
      // 积分口径：逐包
      for (const p of a.packs ?? []) {
        const sec = typeof p.expireTime === 'number' && p.expireTime > 0 ? p.expireTime : null;
        if (sec == null) continue;
        const days = naturalDays(sec * 1000, now);
        if (days == null || days < 0 || days > windowDays) continue;
        if (p.unlimited === true) continue; // 不限量不计金额
        const remaining = typeof p.remaining === 'number' ? p.remaining : 0;
        if (remaining <= 0) continue;
        items.push({ amount: remaining, days, name: p.name || '权益包' });
      }
    }

    if (!items.length) continue;
    items.sort((x, y) => x.days - y.days || y.amount - x.amount);
    /**
     * 名称只保留 1 个代表名。
     *
     * 实测一个 WorkBuddy 账号在 30 天窗口内会命中 60 项，而包名高度重复且带
     * 细微变体（「CodeBuddy个人版国内运营裂变包」同族）。铺 2 个名字会得到
     * 两个几乎一样的字符串，占满一行却不增加信息。真正有用的是
     * 「几项、总共多少、最早几天后」——名字只用于识别包的类型。
     * 变体数写进 nameVariants，需要时可在 title 里展开。
     */
    const uniqNames = [...new Set(items.map((x) => x.name))];
    out.push({
      accountId: a.id,
      label: a.label || a.id,
      platform: e.platform,
      platformLabel: platformIdLabel(e.platform),
      unit: UNIT_LABEL[e.unit] ?? e.unit,
      amount: Math.round(items.reduce((s, x) => s + x.amount, 0) * 100) / 100,
      days: items[0].days,
      items: items.length,
      names: uniqNames.slice(0, 1),
      nameVariants: uniqNames.length,
    });
  }

  return out.sort((x, y) => x.days - y.days || y.amount - x.amount);
}

/** 自然日差（与后端 credits.js#naturalDayDiff 同算法：两地零点之差取整）。 */
function naturalDays(expireMs: number, nowMs: number): number | null {
  if (!Number.isFinite(expireMs) || expireMs <= 0) return null;
  const startOfDay = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  return Math.round((startOfDay(expireMs) - startOfDay(nowMs)) / 86_400_000);
}

/** 到期行的合计文案（按单位分组，绝不跨单位相加）。 */
export function expiringTotals(rows: ExpiringAccountRow[]): { unit: string; amount: number }[] {
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.unit, (map.get(r.unit) ?? 0) + r.amount);
  }
  return [...map.entries()]
    .map(([unit, amount]) => ({ unit, amount: Math.round(amount * 100) / 100 }))
    .sort((x, y) => y.amount - x.amount);
}

/** 金额 + 单位的统一格式（用于展开表里的小计）。 */
export function amountText(amount: number | null, unit: string): string {
  if (amount == null) return '—';
  return `${formatNumber(amount)} ${unit}`;
}
