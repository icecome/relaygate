/**
 * 权益包（积分口径）的纯计算 + 保活状态。
 *
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
 * 跨平台的权益视图（Token / 配额 / Raccoon 分池）在 shared/lib/entitlement.ts，
 * 本模块只负责积分口径与保活判定这两件事。
 */
import type { Account } from '../../shared/api/types';
import { platformOf, type Platform } from '../../shared/lib/format';

type Urgency = 'expired' | 'critical' | 'warning';

/** 到期提醒窗口：只关心 7 日内。 */
const NOTICE_DAYS = 7;

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

/**
 * 秒级时间戳转毫秒；null / 非正数返回 null（表示无到期时间）。
 *
 * 导出是必要的：权益详情弹窗要渲染 ZCode 的额度桶，而桶的 expireTime 与
 * 权益包的 expireTime 是同一种「秒级时间戳」——直接当毫秒用会落到 1970 年。
 * 让两处各自实现一遍这个换算，就是在等一处漏乘 1000。
 */
export function toMs(expireSec: number | null | undefined): number | null {
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
 * 全库积分额度汇总，口径与 packsOf 一致（已用尽与已过期都不计入）：
 *   - total：所有可用包的 remaining 之和；unlimited 包不计入金额，只计数量
 *   - expiring：7 日内到期的可用额度
 *   - unlimited：带不限量包的账号数
 *   - packs：可用计量包总数
 *
 * 双形态支持：列表端点带 `?slim=1` 时 `packs` 被换成 `packDigest` 摘要
 * （后端 credentials/entitlement-view.js#digestOf，与 summarizeExpiry / FEFO
 * 共用同一套日历日判定）。两形态必须在同一函数里处理，否则总览页会在
 * 没人注意的时候静默变成 0 —— 那正是这次给列表加 slim 时最容易踩的坑。
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
    // 摘要形态：直接采信后端的聚合，不再重算（重算就会与调度差一天）
    if (a.packDigest) {
      const d = a.packDigest;
      if (d.usable === 0) continue;
      withCredit += 1;
      packs += d.usable - d.unlimited;
      unlimited += d.unlimited;
      total += d.usableAmount;
      expiring += d.expiring7d;
      continue;
    }
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
 * 直接走 platformOf：此前这里特判 Raccoon 是因为 platformOf 不返回
 * 'raccoon'（账号落进 Trae 分支），2026-11-06 起 platformOf 已显式识别
 * Raccoon，特判不再必要。保持一行调用，避免两处口径漂移。
 */
function keepalivePoolOf(a: Account): Platform {
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
