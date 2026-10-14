/**
 * 统计接口（/v1/admin/stats/*、/v1/admin/credit-history）。
 *
 * 关键语义：metered / unmetered 是真实字段。
 * 部分上游（如 WorkBuddy）不回传 usage，此时 requests 有值而 tokens 恒为 0，
 * 不能读作「消耗 0 token」，必须结合 unmetered 判断。
 * estimatedCost 是估算值，不是账单精确值。
 */
import { api } from './http';

export interface DailyStat {
  date: string;
  requests: number;
  errors: number;
  tokens: number;
  metered: number;
  unmetered: number;
  /** token 来源三分类：exact=上游真值；estimated=tiktoken 补算；none=完全没有 token。 */
  exact?: number;
  estimated?: number;
  none?: number;
  /** token 字段被历史脱敏缺陷写成 '***' 而无法还原的行数（该日 token 总量是下界）。 */
  tokensLost?: number;
  /** 能算出估算积分的行数；远小于请求数时说明该日估算总量是下界。 */
  priced?: number;
  /** 缺缓存读信息、按「全未缓存」上界计价的行数；多时估算整体偏高。 */
  costUpper?: number;
  /** 缓存读 token 合计（已含在 tokens 内，单列用于解释积分单价）。 */
  cacheReadTokens?: number;
  estimatedCost: number;
  /** 官方账单该日积分合计（Trae 会话 + WB 逐请求），与 estimatedCost 同窗口可直接对照。 */
  officialCredit?: number;
  officialTraeCredit?: number;
  officialWbCredit?: number;
  /** 官方账单该日 token 合计（仅 Trae 账单带 token）。 */
  officialTokens?: number;
  officialSessions?: number;
  officialRequests?: number;
  /** 该日是否存在账单缓存文件（不代表有消耗——Trae 入账有 1~2 天滞后）。 */
  officialCovered?: boolean;
  /** 该日按模型拆分（后端 stats.js:196-199 已返回）。tokens 为该模型已计量合计。 */
  byModel?: Record<string, {
    requests: number;
    tokens: number;
    metered: number;
    unmetered: number;
    estimatedCost: number;
  }>;
  /**
   * 逻辑回合口径：一次客户端请求 = 一个回合。降级换候选会给同一回合写多行
   * traffic（每候选一行），故只按行数算成功率会把「降级后成功」记成失败。
   * turns 为该日回合数；turnsFailed 为全部尝试都失败的回合数；
   * recoveredTurns 为至少失败过一次、最终成功的回合数。
   */
  turns?: number;
  turnsFailed?: number;
  recoveredTurns?: number;
}

export interface ModelStat {
  model: string;
  requests: number;
  errors: number;
  tokens: number;
  metered: number;
  unmetered: number;
  /** 其中由 tiktoken 补算的请求数（token 值非账单口径）。 */
  estimated?: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  estimatedCost: number;
  avgDurationMs: number | null;
  toolCalls: number;
}

export interface AccountStat {
  accountId: string;
  requests: number;
  errors: number;
  tokens: number;
  metered: number;
  unmetered: number;
  estimatedCost: number;
  errorRate: number;
  tokenShare: number;
}

export const getStatsDaily = (days: number, key: string, signal?: AbortSignal) =>
  api<{
    days: number;
    totalRequests: number;
    /** 窗口内逻辑回合汇总（与 totalRequests 不同口径：后者按上游请求行计）。 */
    turns?: { turns: number; turnsFailed: number; recoveredTurns: number };
    data: DailyStat[];
  }>(`/v1/admin/stats/daily?days=${days}`, { signal }, key);

export const getStatsModels = (days: number, key: string, signal?: AbortSignal) =>
  api<{ days: number; totalRequests: number; data: ModelStat[] }>(
    `/v1/admin/stats/models?days=${days}`,
    { signal },
    key,
  );

export const getStatsAccounts = (days: number, key: string, signal?: AbortSignal) =>
  api<{ days: number; totalRequests: number; data: AccountStat[] }>(
    `/v1/admin/stats/accounts?days=${days}`,
    { signal },
    key,
  );

export interface ClientStatsResponse {
  object: string;
  available: boolean;
  reason?: string | null;
  root?: string;
  days: number;
  files: number;
  cachedFiles: number;
  parsedFiles: number;
  scope: 'local-device';
  totals: {
    requests: number;
    tokens: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheHitRate: number;
    credit: number;
  };
  data: { date: string; requests: number; tokens: number }[];
  models: { model: string; requests: number; tokens: number; credit: number }[];
}

export const getClientStats = (days: number, key: string, signal?: AbortSignal) =>
  api<ClientStatsResponse>(`/v1/admin/stats/client?days=${days}`, { signal }, key);

export const clearClientStatsCache = (key: string) =>
  api<{ ok: boolean; dir: string }>('/v1/admin/stats/client/cache/clear', { method: 'POST' }, key);

export interface OfficialUsageAccount {
  accountId: string;
  label: string;
  days: number;
  available: boolean;
  error?: string | null;
  credit: number;
  requests: number;
  /** 会话/请求级 token 合计（Trae 有，WorkBuddy 账单接口不返回）。 */
  tokens?: number;
  /** 平台：trae | workbuddy */
  platform?: 'trae' | 'workbuddy';
  /** 明细粒度：request=逐请求（WB）；session=逐会话聚合（Trae） */
  granularity?: 'request' | 'session';
  byDay?: { date: string; requests: number; credit: number; tokens?: number }[];
  byModel?: { model: string; requests: number; credits: number }[];
}

export const getOfficialUsage = (days: number, key: string, signal?: AbortSignal) =>
  api<{ days: number; accounts: OfficialUsageAccount[] }>(
    `/v1/admin/stats/official-usage?days=${days}`,
    { signal },
    key,
  );

export interface CreditHistoryRow {
  accountId: string;
  label: string;
  group?: string | null;
  /** 上游 consumed_amount 增量（主口径，与官方账单基本吻合） */
  usedTotal: number;
  /** 剩余下降量（含权益包到期作废，仅作对照，可能远高于真实消耗） */
  remainingDelta: number;
  snapshots: number;
  latestRemaining: number | null;
  /** 窗口内是否存在可差分的快照对；false 表示「未覆盖」而非「消耗 0」 */
  covered: boolean;
}

export const getCreditHistory = (days: number, key: string, signal?: AbortSignal) =>
  api<{
    days: number;
    totalUsed: number;
    remainingDelta: number;
    data: CreditHistoryRow[];
  }>(`/v1/admin/credit-history?days=${days}`, { signal }, key);

/**
 * 积分/token 标定系数（官方账单最小二乘回归结果）。
 *
 * 每个模型给出三个「积分/token」系数：uncached（未命中缓存的输入）、
 * output（输出）、cacheRead（缓存读）。n 为样本数，r2 为拟合优度——
 * r2≈1 表示该模型的三系数能精确还原账单，estimatedCost 可视作账单口径；
 * r2 偏低（如 Trae 会话级 DeepSeek）说明上游账单本身有抹零噪声。
 */
export interface PricingCalibration {
  version: number;
  calibratedAt: string | null;
  models: Record<
    string,
    { n: number; r2: number; uncached: number; output: number; cacheRead: number }
  >;
  /**
   * 账单实测的积分 ↔ token 换算比（无账单数据时为 null）。
   * 精确换算必须按模型逐个用三系数算，这里只是概览均值。
   */
  ratio?: {
    /** 换算比所属账单日（上游入账有滞后，不是实时值） */
    asOf: string | null;
    credits: number;
    tokens: number;
    /** 积分 / 千 token */
    creditsPer1k: number;
    /** token / 积分 */
    tokensPerCredit: number;
    models: number;
  } | null;
}

export const getPricingCalibration = (key: string, refresh = false, signal?: AbortSignal) =>
  api<PricingCalibration>(
    `/v1/admin/stats/pricing-calibration${refresh ? '?refresh=1' : ''}`,
    { signal },
    key,
  );