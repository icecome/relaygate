/**
 * WorkBuddy 成长中心接口（/v1/workbuddy/growth/*）。
 *
 * 真实语义（对照 src/routes/cat-trip.js）：
 *   - 全部端点为 POST，单账号端点必须带 accountId；
 *   - 只读端点：status / config / buddy / streak / redeem / chances / tasks；
 *   - 写端点：depart / claim / redeem-tier / draw / buddy-open；
 *   - status-all 与 overview 缺省作用于全部启用的 WorkBuddy 账号；
 *   - auto 为后台任务，立即返回 taskId，需轮询 progress 获取进度。
 */
import { api } from './http';

/* ------------------------------------------------------------ 汇总视图 */

export interface GrowthStatusRow {
  accountId: string;
  label: string;
  ok: boolean;
  state?: string;
  location?: string;
  departAt?: string;
  arriveAt?: string;
  serverNow?: string;
  rewardCredit?: number;
  dailyLimitReached?: boolean;
  reason?: string;
}

export interface GrowthOverviewRow {
  accountId: string;
  label: string;
  ok: boolean;
  buddyName?: string | null;
  rarity?: string | null;
  energy?: number | null;
  affordable?: boolean | null;
  streakDays?: number | null;
  makeupCards?: number | null;
  lotteryChances?: number | null;
  reason?: string;
}

export const growthStatusAll = (key: string, signal?: AbortSignal) =>
  api<{ object: string; total: number; data: GrowthStatusRow[] }>(
    '/v1/workbuddy/growth/status-all',
    { method: 'POST', signal, body: {} },
    key,
  );

export const growthOverview = (key: string, signal?: AbortSignal) =>
  api<{ object: string; total: number; data: GrowthOverviewRow[] }>(
    '/v1/workbuddy/growth/overview',
    { method: 'POST', signal, body: {} },
    key,
  );

/* -------------------------------------------------------------- 单账号 */

export interface GrowthStatus {
  ok?: boolean;
  state?: string;
  location?: string;
  departAt?: string;
  arriveAt?: string;
  rewardCredit?: number;
  dailyLimitReached?: boolean;
  reason?: string;
}

export interface GrowthStreak {
  ok?: boolean;
  days?: number;
  makeupCards?: number;
  reason?: string;
}

export interface GrowthLotteryChances {
  ok?: boolean;
  balance?: number;
}

const single = <T>(name: string) => (accountId: string, key: string, signal?: AbortSignal) =>
  api<T & { object: string; accountId: string }>(
    `/v1/workbuddy/growth/${name}`,
    { method: 'POST', signal, body: { accountId } },
    key,
  );

export const growthStatus = single<GrowthStatus>('status');
export const growthStreak = single<GrowthStreak>('streak');
export const growthChances = single<GrowthLotteryChances>('chances');

/** 领取旅行奖励。返回 rewardCredit 表示到账额度。 */
export const growthClaim = (accountId: string, key: string) =>
  api<{ ok?: boolean; rewardCredit?: number; reason?: string }>(
    '/v1/workbuddy/growth/claim',
    { method: 'POST', body: { accountId } },
    key,
  );

/** 出发（开始旅行）。 */
export const growthDepart = (
  accountId: string,
  body: { location?: string },
  key: string,
) =>
  api<{ ok?: boolean; reason?: string }>(
    '/v1/workbuddy/growth/depart',
    { method: 'POST', body: { accountId, ...body } },
    key,
  );

/** 连登兑换。 */
export const growthRedeemTier = (accountId: string, tier: string, key: string) =>
  api<{ ok?: boolean; credit?: number; reason?: string }>(
    '/v1/workbuddy/growth/redeem-tier',
    { method: 'POST', body: { accountId, tier } },
    key,
  );

/** 抽奖。 */
export const growthDraw = (accountId: string, key: string) =>
  api<{ ok?: boolean; prize?: string; reason?: string }>(
    '/v1/workbuddy/growth/draw',
    { method: 'POST', body: { accountId } },
    key,
  );

/* -------------------------------------------------------------- 后台任务 */

export interface GrowthProgress {
  taskId?: string;
  status?: string;
  done?: number;
  total?: number;
  current?: string;
  errors?: string[];
  finishedAt?: string;
}

export const growthAuto = (body: { accountId?: string }, key: string) =>
  api<{ object: string; taskId: string; startedAt: string; progressUrl: string }>(
    '/v1/workbuddy/growth/auto',
    { method: 'POST', body },
    key,
  );

export const growthProgress = (taskId: string, key: string, signal?: AbortSignal) =>
  api<GrowthProgress & { object: string }>(
    `/v1/workbuddy/growth/progress?taskId=${encodeURIComponent(taskId)}`,
    { method: 'POST', signal, body: {} },
    key,
  );

export interface GrowthLastRun {
  ranAt?: string | null;
  ok?: number;
  failed?: number;
  durationMs?: number;
}

export const growthLastRun = (key: string, signal?: AbortSignal) =>
  api<GrowthLastRun & { object: string }>(
    '/v1/workbuddy/growth/last-run',
    { method: 'POST', signal, body: {} },
    key,
  );