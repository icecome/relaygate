import { api } from '../lib/api';
import type { Account } from './types';

/** 旅行地点（travel/config 返回）。 */
export interface TravelLocation {
  id: number;
  code: string | null;
  name: string | null;
  durationHoursMin: number | null;
  durationHoursMax: number | null;
  rewardCreditMin: number | null;
  rewardCreditMax: number | null;
}

/** 旅行状态（travel/status 返回，归一化后）。 */
export interface TravelStatus {
  ok: boolean;
  state: 'idle' | 'traveling' | string;
  buddyId?: number | null;
  recordId?: number | null;
  location?: { id: number | null; code: string | null; name: string | null; duration_hours: number | null } | null;
  departAt?: number | null;
  arriveAt?: number | null;
  serverNow?: number | null;
  dailyLimitReached?: boolean;
  durationHours?: number | null;
  rewardCredit?: number | null;
  reason?: string;
}

export interface StatusAllRow {
  accountId: string;
  label: string;
  ok: boolean;
  state?: string;
  location?: TravelStatus['location'];
  departAt?: number | null;
  arriveAt?: number | null;
  serverNow?: number | null;
  rewardCredit?: number | null;
  dailyLimitReached?: boolean;
  reason?: string;
}

export interface DepartResult {
  object: string;
  accountId: string;
  ok: boolean;
  state?: string;
  location?: TravelStatus['location'];
  arriveAt?: number | null;
  rewardCredit?: number | null;
  result?: string;
  reason?: string;
}

export interface ClaimResult {
  object: string;
  accountId: string;
  ok: boolean;
  recordId?: number | null;
  rewardCredit?: number | null;
  result?: string;
  reason?: string;
}

export interface AutoResult {
  object: string;
  total: number;
  ranAt?: string;
  okCount?: number;
  failCount?: number;
  results?: AccountRun[];
  departed?: { accountId: string; label: string; location?: string | null; rewardCredit?: number | null; arriveAt?: number | null }[];
  claimed?: { accountId: string; label: string; recordId?: number | null; rewardCredit?: number | null }[];
  skipped?: { accountId: string; label: string; state?: string; dailyLimitReached?: boolean; arriveAt?: number | null }[];
  failed?: { accountId: string; label: string; reason: string }[];
}

/** 单账号一次自动化运行的动作明细。 */
export interface AccountRun {
  accountId: string;
  label: string;
  ok: boolean;
  actions: { seg: string; ok: boolean; skip?: boolean; msg: string }[];
}

/** 上次运行结果（last_run 展示）。 */
export interface LastRun {
  object?: string;
  ranAt: string | null;
  total?: number;
  okCount?: number;
  failCount?: number;
  actions?: string[];
}

/** 成长中心总览（buddy/能量/连登/抽奖）。 */
export interface GrowthOverviewRow {
  accountId: string;
  label: string;
  ok: boolean;
  buddyName?: string | null;
  rarity?: string | null;
  energy?: number | null;
  affordable?: number | null;
  streakDays?: number | null;
  makeupCards?: number | null;
  lotteryChances?: number | null;
  reason?: string;
}

/** 后台自动化任务进度（progress 轮询返回）。 */
export interface GrowthProgress {
  taskId: string;
  startedAt: number;
  finishedAt?: number | null;
  running: boolean;
  stage: string;
  error?: string | null;
  currentAccount?: string | null;
  total: number;
  doneCount: number;
  okCount: number;
  failCount: number;
  results: AccountRun[];
}

/** WorkBuddy 成长旅行端点（/v1/workbuddy/growth） */

export const growthStatus = (accountId: string, key: string) =>
  api<TravelStatus & { object: string; accountId: string }>('/v1/workbuddy/growth/status', { method: 'POST', body: { accountId } }, key);

export const growthStatusAll = (key: string) =>
  api<{ object: string; total: number; data: StatusAllRow[] }>('/v1/workbuddy/growth/status-all', { method: 'POST' }, key);

export const growthConfig = (accountId: string, key: string) =>
  api<{ object: string; accountId: string; ok: boolean; locations: TravelLocation[]; reason?: string }>('/v1/workbuddy/growth/config', { method: 'POST', body: { accountId } }, key);

export const growthDepart = (body: { accountId: string; location_id: number; duration_hours: number }, key: string) =>
  api<DepartResult>('/v1/workbuddy/growth/depart', { method: 'POST', body }, key);

export const growthClaim = (accountId: string, key: string) =>
  api<ClaimResult>('/v1/workbuddy/growth/claim', { method: 'POST', body: { accountId } }, key);

export const growthAuto = (body: { location_id?: number; duration_hours?: number; accountId?: string }, key: string) =>
  api<{ object: string; taskId: string; startedAt: string; progressUrl: string }>('/v1/workbuddy/growth/auto', { method: 'POST', body }, key);

export const growthProgress = (taskId: string, key: string) =>
  api<GrowthProgress & { object: string }>(`/v1/workbuddy/growth/progress?taskId=${encodeURIComponent(taskId)}`, { method: 'POST', body: {} }, key);

export const growthProgressList = (key: string) =>
  api<{ object: string; data: Pick<GrowthProgress, 'taskId' | 'startedAt' | 'finishedAt' | 'running' | 'stage' | 'total' | 'doneCount' | 'okCount' | 'failCount'>[] }>('/v1/workbuddy/growth/progress-list', { method: 'POST', body: {} }, key);

export const growthLastRun = (key: string) =>
  api<LastRun>('/v1/workbuddy/growth/last-run', { method: 'POST', body: {} }, key);

export const growthOverview = (key: string) =>
  api<{ object: string; total: number; data: GrowthOverviewRow[] }>('/v1/workbuddy/growth/overview', { method: 'POST', body: {} }, key);

/** 单账号成长操作（只读/写通用）。 */
export const growthCall = <T>(name: string, body: Record<string, unknown>, key: string) =>
  api<T & { object: string; accountId: string }>('/v1/workbuddy/growth/' + name, { method: 'POST', body }, key);

/** 仅 WorkBuddy 启用账号作为成长活动候选。 */
export function growthCandidates(accounts: Account[]): Account[] {
  return accounts.filter((a) => {
    const e = String(a.edition ?? a.source ?? '');
    return (e === 'workbuddy' || e.startsWith('wb')) && a.enabled === true;
  });
}