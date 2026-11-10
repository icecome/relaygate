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

/**
 * 权益摘要（后端 credentials/entitlement-view.js 的 digestOf）。
 *
 * 列表端点带 `?slim=1` 时，每个账号的 `packs` 明细被替换成本结构。
 * 口径与后端的 summarizeExpiry / FEFO 完全一致（同一套日历日判定），
 * 不要在前端重新推导天数——那会让面板与调度算出差一天的两个值。
 */
export interface PackDigest {
  /** 该账号权益包总条数（含已用尽、已过期） */
  total: number;
  /** 仍可用的包数（未用尽、未过期） */
  usable: number;
  /** 可用包的剩余积分之和（unlimited 不计入金额） */
  usableAmount: number;
  /** 其中不限量包的个数 */
  unlimited: number;
  /** 7 个自然日内到期的可用额度 */
  expiring7d: number;
  /** 可用包里最近一项的剩余自然日（0 = 今天到期）；无到期时间时为 null */
  soonestDays: number | null;
  /** 上述最近一项的剩余额度 */
  soonestAmount: number;
}

/** Raccoon 的分池积分（隔离键 raccoonPoints，不属于积分口径的 packs）。 */
export interface RaccoonPoints {
  available: number | null;
  packages: { name: string; remaining: number }[];
  updatedAt: string | null;
}

export interface Account {
  id: string;
  label: string | null;
  edition?: string | null;
  source?: string | null;
  /**
   * 账号的区域标记（后端列 user_region，camelCase 为 userRegion）。
   * 历史上这里曾误声明为 `region` —— 后端从不返回该字段（region 只存在于
   * WorkBuddy 登录态探测 /v1/workbuddy/local 的响应里），前端也从未消费。
   */
  userRegion?: string | null;
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
  /**
   * 连续签到天数（连登）—— 账号维度上的历史值，**当前面板不消费**。
   *
   * 位置说明（2026-11-10 修正）：连登属于「成长计划」维度，界面落点是
   * 运维 → 账号轮换页的成长计划面板，读的是 `GET /v1/admin/rotate/status`
   * 的 `heatmap[].streakDays`（每轮由 checkStatus 直读上游 /activity/growth/streak）。
   * 凭据池列表**不再**展示它 —— 那张表回答的是「这个号还能不能调」。
   *
   * 字段保留：后端仍在签到链写入该列（审计用：某次签到当时上游报的连登是多少）。
   * 前端若将来需要在账号维度展示历史值，可以读它，但必须同时带上
   * `lastCheckinAt`（两者同源同刻，隔天即过期）。
   */
  checkinStreakDays?: number | null;
  /** 最近一次保活（token 刷新）的时刻与结果；保活任务逐账号写入 */
  lastKeepaliveAt?: string | null;
  lastKeepaliveResult?: string | null;
  priority?: number;
  group?: string | null;
  /** 成本分层（0=免费额度包，1=未知/默认，2=收费），越小越优先消耗；见 pool.js。 */
  costTier?: number;
  /** 自由标签（字符串数组） */
  tags?: string[] | null;
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
  /**
   * Raccoon 专用：分池积分明细（奖励 / 每日 / 充值）。
   * 与 `balance` 的总额是两回事，也与 packs 的积分口径隔离
   * （Raccoon 的余额接口不提供每个包的到期时间，故不写 packs）。
   */
  raccoonPoints?: RaccoonPoints;
  /** 列表端点 `?slim=1` 时返回的权益摘要；未带该参数时为 undefined。 */
  packDigest?: PackDigest;
  /**
   * 该行的 `packs` 属于哪种计量口径（后端 entitlement-view.js 下发）。
   * `'credit'` = 积分（Trae / WorkBuddy）；其余值是平台 id，表示该平台
   * 虽有 packs 字段但不按积分读（ZCode 的快照里可能残留 token 桶）。
   * 缺失时前端按 edition 兜底判定。
   */
  packCaliber?: string;
  /** 权益快照的写入时刻（ISO）；null 表示从未查询过上游。 */
  entitlementSnapshotUpdatedAt?: string | null;
}

/** 列表端点 `?slim=1` 附带的全库积分汇总（只覆盖 packs 口径）。 */
export interface EntitlementRollup {
  /** 可用积分合计（unlimited 不计入金额） */
  usableAmount: number;
  /** 可用权益包总数 */
  usable: number;
  /** 至少有可用包的账号数 */
  accounts: number;
  /** 不限量包个数 */
  unlimited: number;
  /** 7 日内到期额度 */
  expiring7d: number;
  /** 权益包总条数（含失效） */
  total: number;
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