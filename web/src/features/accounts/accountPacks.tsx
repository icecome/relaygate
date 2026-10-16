/**
 * 权益包到期与可用性：由 /v1/credentials/summary 派生，无独立接口。
 * 关键口径（统一后端 src/credentials/credits.js 与 src/upstream/balance.js）：
 *   - expireTime 是秒级时间戳（后端 `Math.floor(expireMs / 1000)`），转毫秒需乘 1000，
 *     直接当毫秒用会落在 1970 年；
 *   - remaining 为 0 表示已用尽；unlimited 为 true 时 remaining 为 null；
 *   - limit 为 -1 表示不限量，后端归一化为 unlimited + remaining=null。
 *
 * 单位边界（务必遵守）：本模块的 packs / remaining / creditTotals 全部是积分口径
 * （单位 credit，量级 1e3）；ZCode 额度是 token 计量（量级 1e8），后端刻意把它存在
 * Account.tokenBuckets（非 packs），故本模块不会读到它。若将来要展示 ZCode 额度，
 * 必须走独立通道，绝不能并入 packs 或 creditTotals。
 *
 * 三个用途：ExpiryChip（账号表单元格内显示最紧迫项）、PackDialog（弹窗展示该账号全部
 * 权益包，可用者在上、失效者置底置灰）、expirySummary（工具条汇总提示）。
 */
import { useMemo } from 'react';
import type { Account } from '../../shared/api/types';
import {
  formatNumber,
  formatTime,
  platformOf,
  type Platform,
} from '../../shared/lib/format';
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

  // 展示排序：可用项在前、失效置底，组内按到期时间升序。
  // 这只是阅读顺序，不代表后端的消耗顺序——后端调度（pool.js）有自己的 FEFO 决策；
  // 此处不宣称「这些包会优先被消耗」，以免 UI 排序与后端算法漂移。
  return list.sort((a, b) => {
    if (a.usable !== b.usable) return a.usable ? -1 : 1;
    const av = a.expireMs ?? Number.POSITIVE_INFINITY;
    const bv = b.expireMs ?? Number.POSITIVE_INFINITY;
    return av - bv;
  });
}

/**
 * 账号表中「权益包」列用：仅仍可使用的包（未用尽、未过期）。
 *
 * 为什么不再取 packsOf()[0]：那只是「最早到期的一个包」，会让该列
 * 既不反映账号的真实额度（其余可用包被隐去），又与右侧「余额/额度」
 * （可用包 remaining 之和）和「权益到期」（最紧迫包的到期状态）重复。
 * 列内改为展示可用包数量，额度总量归「余额/额度」，明细在 PackDialog 内查看。
 */
export function usablePacksOf(account: Account, now = Date.now()): PackView[] {
  return packsOf(account, now).filter((p) => p.usable);
}

/**
 * 到期提醒是否值得计入：只有「作废仍会造成损失」的包才算。
 *
 * 已用尽（remaining === 0）的包过期不损失任何积分，不参与「权益到期」判定。
 * Trae 每日签到赠送按天拆包（每包 100 分），用尽后包体还要挂 1~3 天才到期——
 * 此前 worstExpiry / expirySummary 把这些死包读成「3 日内 / 7 日内到期」，
 * 整池明明没有任何额度临期却持续告警。后端的金额与调度口径
 * （credentials/credits.js summarizeFefo、pool.js poolSignals）都只统计
 * remaining > 0 的包，展示口径在此与之对齐。
 * unlimited 包（remaining=null）过期即失去不限量额度，属真实损失，保留提醒；
 * remaining 为 null 且非 unlimited（未知）与后端 summarizeExpiry 同口径跳过。
 */
function expiryWorthNoticing(p: PackView): boolean {
  if (p.unlimited) return true;
  return typeof p.remaining === 'number' && p.remaining > 0;
}

/** 账号表单元格用：最紧迫的一项（已到期优先，其次 3 日内、7 日内；已用尽的包不计）。 */
export function worstExpiry(account: Account, now = Date.now()): PackView | null {
  const notice = packsOf(account, now).filter((p) => p.urgency != null && expiryWorthNoticing(p));
  if (notice.length === 0) return null;
  const order: Record<Urgency, number> = { expired: 0, critical: 1, warning: 2 };
  return notice.sort(
    (a, b) => order[a.urgency as Urgency] - order[b.urgency as Urgency] || (a.days ?? 0) - (b.days ?? 0),
  )[0];
}

/**
 * 全库汇总（按账号数口径），供凭据池工具条提示。
 * 命名注意：后端 /summary 的 expiring3d/7d 是积分额度（amount），本函数返回的是账号数
 * （count）—— 同名不同义。调用方文案必须写明「N 个账号」，不得与 summary.expiring3d 直接对比。
 */
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
 * 全库积分额度汇总，口径与 packsOf 一致（已用尽与已过期都不计入）：
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

/* 保活状态 */

/**
 * 账号凭据保活状态（登录 token 的有效期与刷新流程）。
 * 口径说明（避免与「到期」列混淆——那是权益包积分的到期）：
 *   - expiredAt 是登录 token（JWT）的过期时间，由上游 ExchangeToken / WorkBuddy refresh
 *     写回；保活定时任务（scheduler 的 keepalive）在到期前用 refreshToken 换新。
 *     ZCode 账号的 JWT 无 exp，恒为 null —— 属「长期有效」，不是异常；
 *   - refreshExpiredAt 是 refreshToken 本身的有效期，一旦过期就无法再换新，
 *     账号只能重新导入或 OAuth 登录，是保活流程的最终期限。
 */
export interface KeepaliveView {
  /** 登录 token 到期毫秒；null 表示无记录或长期有效（ZCode） */
  expiresMs: number | null;
  /** refreshToken 到期毫秒；null 表示无记录 */
  refreshExpiresMs: number | null;
  /** token 相对 now 的剩余天数（向上取整）；expiresMs 为 null 时为 null */
  days: number | null;
  /** 保活流程状态文案 */
  label: string;
  tone: 'neutral' | 'ok' | 'warn' | 'danger';
}

/** 保活告警窗口：7 日内到期提示，已过期告警。 */
const KEEPALIVE_NOTICE_DAYS = 7;

export function keepaliveOf(account: Account, now = Date.now()): KeepaliveView {
  const toMs = (iso: string | null | undefined): number | null => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? null : t;
  };
  const expiresMs = toMs(account.expiredAt);
  const refreshExpiresMs = toMs(account.refreshExpiredAt);

  // refreshToken 已过期：无法再换新，保活流程终止
  if (refreshExpiresMs != null && refreshExpiresMs <= now) {
    return { expiresMs, refreshExpiresMs, days: null, label: '需重新登录', tone: 'danger' };
  }
  // token 已过期：下一次请求会触发换票，可自愈
  if (expiresMs != null && expiresMs <= now) {
    return { expiresMs, refreshExpiresMs, days: null, label: '已过期 · 待刷新', tone: 'warn' };
  }
  if (expiresMs == null) {
    // ZCode 的 JWT 无 exp 字段，属长期有效而非数据缺失
    return { expiresMs, refreshExpiresMs, days: null, label: '长期有效', tone: 'neutral' };
  }
  const days = Math.ceil((expiresMs - now) / 86_400_000);
  if (days <= KEEPALIVE_NOTICE_DAYS) {
    return { expiresMs, refreshExpiresMs, days, label: `${days} 天`, tone: 'warn' };
  }
  return { expiresMs, refreshExpiresMs, days, label: `${days} 天`, tone: 'ok' };
}

/**
 * 分平台保活汇总：每个账号池各自一份，供面板逐池展示。
 *
 * 为什么要按池拆开：此前「最近操作与保活」表取 `rows.slice(0, 8)`，
 * 而行序来自后端 store.list() 的插入顺序 —— Trae 与 WorkBuddy 账号在库里
 * 交错排列，前 8 行必然混着两个池、并静默丢掉后面的账号。表现就是
 * 「选全部来源时看不到完整保活情况，切到某个池才看到那几行」。
 * 本函数只读账号字段；「该平台是否纳入定时保活」属渠道能力位，
 * 由调用方从 /v1/admin/channels 取，不在这里越界。
 */
export interface KeepalivePoolStat {
  platform: Platform;
  /** 启用账号数 */
  accounts: number;
  /** 有保活记录（lastKeepaliveAt 非空）的账号数 */
  withRecord: number;
  /** 该池全部启用账号都无保活记录 */
  never: boolean;
  /** 该池最近一次保活时刻（毫秒）；无记录为 null */
  lastAtMs: number | null;
  /** 最近一次保活结果以 fail 开头的账号数 */
  failing: number;
  /** 登录 token 7 日内到期（含已过期）的账号数 */
  expiringSoon: number;
  /**
   * 保活记录超过一个执行周期（26 小时）的账号数。
   * 定时保活每天一次（默认 22:00），超期意味着服务停机或调度未启动，
   * 面板据此把「没跑」与「跑了但失败」区分开。
   */
  stale: number;
}

/** 保活记录的新鲜度上限：每日一次，留 2 小时余量吸收排程抖动。 */
const KEEPALIVE_RECORD_FRESH_MS = 26 * 3600_000;

/**
 * 分池保活汇总的池归属。
 *
 * 比 platformOf 多认 Raccoon：platformOf 的返回值不含 'raccoon'（该平台的
 * 账号会落进 'trae' 分支），而 Raccoon 恰恰是定时保活口径与 Trae 不同的池
 * （它有独立的 refresh 端点），把它并进 Trae 池会让本面板的「纳入定时保活」
 * 与失败计数归错地方。其余判定仍与 platformOf 同源，不另起一套。
 */
function keepalivePoolOf(a: Account): Platform {
  const edition = String(a.edition || '').toLowerCase();
  const source = String(a.source || '').toLowerCase();
  if (edition === 'raccoon' || source === 'raccoon') return 'raccoon';
  return platformOf(a);
}

export { keepalivePoolOf };

export function keepalivePools(accounts: Account[], now = Date.now()): KeepalivePoolStat[] {
  const toMs = (iso: string | null | undefined): number | null => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? null : t;
  };
  const byPlatform = new Map<Platform, KeepalivePoolStat>();
  for (const a of accounts) {
    if (!a.enabled) continue;
    const p = keepalivePoolOf(a);
    let s = byPlatform.get(p);
    if (!s) {
      s = {
        platform: p,
        accounts: 0,
        withRecord: 0,
        never: false,
        lastAtMs: null,
        failing: 0,
        expiringSoon: 0,
        stale: 0,
      };
      byPlatform.set(p, s);
    }
    s.accounts += 1;
    const kaMs = toMs(a.lastKeepaliveAt);
    if (kaMs != null) {
      s.withRecord += 1;
      if (s.lastAtMs == null || kaMs > s.lastAtMs) s.lastAtMs = kaMs;
      if (/^fail/i.test(String(a.lastKeepaliveResult || ''))) s.failing += 1;
      if (now - kaMs > KEEPALIVE_RECORD_FRESH_MS) s.stale += 1;
    }
    const k = keepaliveOf(a, now);
    // 已过期与临期都计入 expiringSoon；「长期有效」（token 无到期）不计
    if (k.expiresMs != null && k.expiresMs - now <= KEEPALIVE_NOTICE_DAYS * 86_400_000) {
      s.expiringSoon += 1;
    }
  }
  const list = [...byPlatform.values()];
  for (const s of list) s.never = s.withRecord === 0;
  // 有风险的池排在前面：先看「7 日内到期」，再看「完全没跑过保活」
  return list.sort(
    (a, b) => b.expiringSoon - a.expiringSoon || Number(b.never) - Number(a.never)
      || b.stale - a.stale || a.platform.localeCompare(b.platform),
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
        已用尽或已过期的权益包不参与调度，置底显示；「N 日内」标记表示距到期时间，不代表消耗顺序。
      </p>
    </>
  );
}