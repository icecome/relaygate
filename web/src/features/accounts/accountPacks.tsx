/**
 * 权益包到期与可用性：由 /v1/credentials/summary 派生，无独立接口。
 *
 * 关键口径（对齐后端 src/credentials/credits.js 与 src/upstream/balance.js）：
 *   - expireTime 是**秒级**时间戳（后端 `Math.floor(expireMs / 1000)`），
 *     转毫秒需乘1000；直接当毫秒用会落在 1970 年；
 *   - remaining 为 0 表示已用尽；unlimited 为true 时 remaining 为 null；
 *   - limit 为 -1 表示不限量，后端归一化为 unlimited + remaining=null。
 *
 * 三个用途：
 *   1. ExpiryChip —— 账号表单元格内显示最紧迫项；
 *   2. PackDialog —— 点击后弹窗展示该账号全部权益包，可用者在上、失效者置底置灰；
 *   3. expirySummary —— 工具条汇总提示。
 */
import { useMemo } from 'react';
import type { Account } from '../../shared/api/types';
import { formatNumber, formatTime } from '../../shared/lib/format';
import { Chip } from '../../shared/ui';

type Urgency = 'expired' | 'critical' | 'warning';

/** 到期提醒窗口：只关心 7 日内。 */
const NOTICE_DAYS = 7;

const URGENCY_META: Record<Urgency, { label: string; tone: 'danger' | 'warn'; dot: string }> = {
  expired: { label: '已到期', tone: 'danger', dot: 'dot-error' },
  critical: { label: '3 日内', tone: 'danger', dot: 'dot-error' },
  warning: { label: '7 日内', tone: 'warn', dot: 'dot-cool' },
};

export interface PackView {
  key: string;
  name: string;
  unlimited: boolean;
  /** 后端 remaining 为 null 且非 unlimited 时视为未知 */
  remaining: number | null;
  used: number | null;
  limit: number | null;
  /** 已归一化为毫秒，便于比较 */
  expireMs: number | null;
  urgency: Urgency | null;
  days: number | null;
  /** 是否仍可使用：未用尽且未过期 */
  usable: boolean;
  /** 置灰原因，供列表说明 */
  unusableReason: '已用尽' | '已过期' | null;
}

/** 秒级时间戳转毫秒；null / 非正数返回 null（表示无到期时间）。 */
function toMs(expireSec: number | null | undefined): number | null {
  if (typeof expireSec !== 'number' || !Number.isFinite(expireSec) || expireSec <= 0) {
    return null;
  }
  return expireSec * 1000;
}

function urgencyOf(days: number): Urgency | null {
  if (days <= 0) return 'expired';
  if (days <= 3) return 'critical';
  if (days <= NOTICE_DAYS) return 'warning';
  return null;
}

/** 单个账号的全部权益包，排序后返回：可用项在前，失效项置底。 */
export function packsOf(account: Account, now = Date.now()): PackView[] {
  const list = (account.packs ?? []).map((p, i): PackView => {
    const unlimited = p.unlimited === true;
    const expireMs = toMs(p.expireTime);
    const remaining = typeof p.remaining === 'number' ? p.remaining : null;

    const days = expireMs == null ? null : Math.ceil((expireMs - now) / 86_400_000);
    const urgency = days == null ? null : urgencyOf(days);

    // 已用尽：remaining 为 0；已过期：days <= 0
    const exhausted = !unlimited && remaining === 0;
    const expired = days != null && days <= 0;
    const usable = !exhausted && !expired;

    return {
      key: `${account.id}-pack-${p.name ?? i}`,
      name: p.name || `权益包 ${i + 1}`,
      unlimited,
      remaining,
      used: typeof p.used === 'number' ? p.used : null,
      limit: typeof p.limit === 'number' ? p.limit : null,
      expireMs,
      urgency,
      days,
      usable,
      unusableReason: exhausted ? '已用尽' : expired ? '已过期' : null,
    };
  });

  // 可用的按到期时间升序（先到期先用，FEFO 语义），
  // 不可用的统一置底；组内再按到期时间升序
  return list.sort((a, b) => {
    if (a.usable !== b.usable) return a.usable ? -1 : 1;
    const av = a.expireMs ?? Number.POSITIVE_INFINITY;
    const bv = b.expireMs ?? Number.POSITIVE_INFINITY;
    return av - bv;
  });
}

/** 账号表单元格用：最紧迫的一项（已到期优先，其次 3 日内、7 日内）。 */
export function worstExpiry(account: Account, now = Date.now()): PackView | null {
  const notice = packsOf(account, now).filter((p) => p.urgency != null);
  if (notice.length === 0) return null;
  const order: Record<Urgency, number> = { expired: 0, critical: 1, warning: 2 };
  return notice.sort(
    (a, b) => order[a.urgency as Urgency] - order[b.urgency as Urgency] || (a.days ?? 0) - (b.days ?? 0),
  )[0];
}

/** 全库汇总，供工具条提示。 */
export function expirySummary(
  accounts: Account[],
  now = Date.now(),
): { expiring: number; expired: number } {
  let expiring = 0;
  let expired = 0;
  for (const a of accounts) {
    const worst = worstExpiry(a, now);
    if (!worst) continue;
    expiring += 1;
    if (worst.urgency === 'expired') expired += 1;
  }
  return { expiring, expired };
}

/**
 * 全库积分额度汇总，口径与 packsOf 一致（已用尽/ 已过期都不计入）：
 *   - total：所有可用包的 remaining 之和；unlimited 包不计入金额，只计数量
 *   - expiring：7 日内到期的可用额度
 *   - unlimited：带不限量包的账号数
 *   - packs：可用计量包总数
 */
export interface CreditTotals {
  total: number;
  expiring: number;
  unlimited: number;
  packs: number;
  /** 至少有可用权益包的账号数 */
  accounts: number;
}

export function creditTotals(accounts: Account[], now = Date.now()): CreditTotals {
  let total = 0;
  let expiring = 0;
  let unlimited = 0;
  let packs = 0;
  let withCredit = 0;

  for (const a of accounts) {
    let accountHasCredit = false;
    for (const p of packsOf(a, now)) {
      if (p.unlimited) {
        if (p.usable) {
          unlimited += 1;
          accountHasCredit = true;
        }
        continue;
      }
      if (!p.usable || p.remaining == null) continue;
      packs += 1;
      accountHasCredit = true;
      total += p.remaining;
      if (p.days != null && p.days <= NOTICE_DAYS) expiring += p.remaining;
    }
    if (accountHasCredit) withCredit += 1;
  }

  return {
    total: Math.round(total * 100) / 100,
    expiring: Math.round(expiring * 100) / 100,
    unlimited,
    packs,
    accounts: withCredit,
  };
}

export function ExpiryChip({ item }: { item: PackView | null }) {
  if (!item) return <span style={{ color: 'var(--rg-text-disabled)' }}>—</span>;
  const meta = URGENCY_META[item.urgency as Urgency];
  return (
    <Chip tone={meta.tone} dot={meta.dot}>
      {meta.label}
    </Chip>
  );
}

/** 弹窗内的到期明细表：失效项置底并置灰。 */
export function PackTable({ account }: { account: Account }) {
  const packs = useMemo(() => packsOf(account), [account]);

  if (packs.length === 0) {
    return (
      <div className="py-3 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
        该账号没有权益包记录。
      </div>
    );
  }

  return (
    <>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className="th">权益包</th>
            <th className="th cell-num">剩余 / 总量</th>
            <th className="th">到期时间</th>
            <th className="th cell-num">剩余天数</th>
            <th className="th">状态</th>
          </tr>
        </thead>
        <tbody>
          {packs.map((p) => {
            const meta = p.urgency ? URGENCY_META[p.urgency] : null;
            return (
              <tr
                key={p.key}
                style={p.usable ? undefined : { color: 'var(--rg-text-disabled)' }}
              >
                <td className="td">
                  <span style={p.usable ? undefined : { color: 'var(--rg-text-disabled)' }}>
                    {p.name}
                  </span>
                </td>
                <td className="td cell-num">
                  {p.unlimited
                    ? '不限量'
                    : `${formatNumber(p.remaining)}${
                        p.limit != null ? ` / ${formatNumber(p.limit)}` : ''
                      }`}
                </td>
                <td className="td font-mono text-[12px]">
                  {p.expireMs == null ? '无到期时间' : formatTime(new Date(p.expireMs).toISOString())}
                </td>
                <td className="td cell-num">
                  {p.expireMs == null ? '—' : p.days != null && p.days <= 0 ? '已过' : `${p.days} 天`}
                </td>
                <td className="td">
                  {p.usable ? (
                    meta ? (
                      <Chip tone={meta.tone} dot={meta.dot}>
                        {meta.label}
                      </Chip>
                    ) : (
                      <Chip tone="ok" dot="dot-ok">
                        可用
                      </Chip>
                    )
                  ) : (
                    <Chip tone="neutral">{p.unusableReason}</Chip>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
        已用尽或已过期的权益包不参与调度，置底显示；带「N 日内」标记的包会优先被消耗。
      </p>
    </>
  );
}