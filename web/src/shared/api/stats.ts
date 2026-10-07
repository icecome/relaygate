/**
 * 统计接口（/v1/admin/stats/*、/v1/admin/credit-history）。
 *
 * 关键语义：metered / unmetered 是真实字段。
 * 部分上游（如 WorkBuddy）不回传usage，此时 requests 有值而 tokens 恒为 0，
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
  estimatedCost: number;
}

export interface ModelStat {
  model: string;
  requests: number;
  errors: number;
  tokens: number;
  metered: number;
  unmetered: number;
  promptTokens: number;
  completionTokens: number;
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
  api<{ days: number; totalRequests: number; data: DailyStat[] }>(
    `/v1/admin/stats/daily?days=${days}`,
    { signal },
    key,
  );

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