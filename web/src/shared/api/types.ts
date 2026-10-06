export type AccountState = 'ok' | 'cool' | 'off';

export interface Pack {
  name?: string;
  packId?: string | null;
  /** 秒级时间戳（后端 Math.floor(expireMs / 1000)），转毫秒需乘 1000 */
  expireTime?: number | null;
  /** 已用额度 */
  used?: number;
  /** 总额度；-1 表示不限量，后端归一化为 unlimited + remaining=null */
  limit?: number | null;
  /** 不限量时为 null */
  remaining?: number | null;
  unlimited?: boolean;
}

export interface Account {
  id: string;
  label: string | null;
  edition?: string | null;
  source?: string | null;
  userRegion?: unknown;
  region?: string | null;
  balance?: number | null;
  errorCount?: number;
  enabled: boolean;
  coolUntil?: string | null;
  lastPickedAt?: string | null;
  lastCheckinAt?: string | null;
  lastCheckinResult?: string | null;
  priority?: number;
  group?: string | null;
  expiring3d?: number;
  expiring7d?: number;
  packs?: Pack[];
  verified?: boolean;
  action?: string;
  verifiedBalance?: number | null;
}

export interface Summary {
  total: number;
  enabled: number;
  disabled: number;
  cooling: number;
  /** 3 日内到期的**积分额度**，非账号数（后端 summarizeExpiry 的 d3） */
  expiring3d: number;
  /** 7 日内到期的积分额度 */
  expiring7d: number;
  accounts: Account[];
}

/** 账号池运行时快照（/status 的 pool.accounts），含凭据接口未提供的在途数 */
export interface PoolAccount {
  id: string;
  label?: string | null;
  balance?: number | null;
  /** FEFO 排序信号：最近一个未用尽权益包的到期信息 */
  fefo?: {
    soonest?: number | null;
    soonestDays?: number | null;
    soonestAmount?: number;
    expiringAmount?: number;
    hasExpiry?: boolean;
    never?: boolean;
  };
  errorCount?: number;
  coolUntil?: string | null;
  inFlight?: number;
  usable?: boolean;
}

export interface CheckinResult {
  claimed?: boolean;
  checkinCredits?: number | null;
  result?: string;
  lastCheckinResult?: string;
  note?: string;
}

export interface BalanceResult {
  balance?: number | null;
  used?: number | null;
  expiring?: { d3?: number; d7?: number };
}

export function accountState(a: Account): AccountState {
  if (!a.enabled) return 'off';
  if (a.coolUntil && new Date(a.coolUntil).getTime() > Date.now()) return 'cool';
  return 'ok';
}