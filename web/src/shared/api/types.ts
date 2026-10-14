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

/** ZCode 的额度桶（token 计量；与 Pack 的积分口径是两套，勿合并汇总） */
export interface TokenBucket {
  name?: string;
  bucketId?: string | null;
  planId?: string | null;
  meter?: string;
  /** 计量单位，固定 'token' */
  unit?: string;
  limit?: number;
  used?: number;
  remaining?: number;
  /** 秒级时间戳，转毫秒需乘 1000 */
  expireTime?: number | null;
}

export interface Account {
  id: string;
  label: string | null;
  edition?: string | null;
  source?: string | null;
  region?: string | null;
  /**
   * 登录 token 的到期时间（ISO）。由 ExchangeToken / WorkBuddy refresh 写回，
   * 保活定时任务在到期前换新。ZCode 的 JWT 无 exp，恒为 null（长期有效）。
   */
  expiredAt?: string | null;
  /** refreshToken 的到期时间（ISO）；过期即无法再换新，需重新登录/导入。 */
  refreshExpiredAt?: string | null;
  /** 积分口径余额（Trae/WorkBuddy）。ZCode 无积分概念，恒为 null。 */
  balance?: number | null;
  errorCount?: number;
  enabled: boolean;
  coolUntil?: string | null;
  lastPickedAt?: string | null;
  lastCheckinAt?: string | null;
  lastCheckinResult?: string | null;
  /** 最近一次保活（token 刷新）的时刻与结果；保活任务逐账号写入 */
  lastKeepaliveAt?: string | null;
  lastKeepaliveResult?: string | null;
  priority?: number;
  group?: string | null;
  expiring3d?: number;
  expiring7d?: number;
  /** 积分口径权益包。ZCode 为空（其额度走 tokenBuckets） */
  packs?: Pack[];
  /**
   * ZCode 专用：token 计量剩余额度（非积分，量级 1e8）。
   * 与 packs/balance 分属两套口径，任何积分汇总都必须排除它。
   */
  tokenRemaining?: number;
  tokenBuckets?: TokenBucket[];
  /**
   * Qoder 专用：两段额度快照（src/upstream/balance.js 的 refreshQoderBalance）。
   * userQuota（基础）与 addOnQuota（赠送/签到）是**两段独立**额度，
   * 单位都是 credit，但语义不同（addOn 由每日活动产生）。
   * 与 packs/balance 分属两套口径，任何积分汇总都必须排除它，
   * totalRemaining 仅供展示。
   */
  quota?: QoderQuota;
}

/** Qoder 账号的两段额度（口径隔离，见 Account.quota）。 */
export interface QoderQuota {
  updatedAt?: string | null;
  userType?: string | null;
  usageType?: string | null;
  base?: { total: number; remaining: number; used: number; expiresAt?: string | null } | null;
  addOn?: { total: number; remaining: number; used: number; expiresAt?: string | null } | null;
  totalRemaining: number;
  isQuotaExceeded?: boolean;
}

export interface Summary {
  total: number;
  enabled: number;
  disabled: number;
  cooling: number;
  /** 3 日内到期的积分额度，非账号数（后端 summarizeExpiry 的 d3） */
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