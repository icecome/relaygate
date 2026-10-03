export type AccountState = 'ok' | 'cool' | 'off';

export interface Pack {
  name?: string;
  remaining?: number;
  used?: number;
  expireTime?: number;
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
  expiring3d: number;
  expiring7d: number;
  accounts: Account[];
}

/** 账号池运行时快照（/status 的 pool.accounts），含凭据接口未提供的在途数 */
export interface PoolAccount {
  id: string;
  label?: string | null;
  balance?: number | null;
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