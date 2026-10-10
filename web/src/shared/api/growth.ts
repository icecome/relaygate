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

/**
 * 上游 travel/status 的 location 是结构化对象
 * （见 src/workbuddy/cat-trip.js normalizeStatus），idle 时为 null。
 */
export interface GrowthLocation {
  id?: number | null;
  code?: string | null;
  name?: string | null;
  durationHours?: number | null;
}

export interface GrowthStatusRow {
  accountId: string;
  label: string;
  ok: boolean;
  state?: string;
  location?: GrowthLocation | null;
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
/*
 * 说明：单账号写操作（claim / draw / redeem-tier / depart 等）只在后台定时任务里
 * 使用，管理面板不再暴露 —— 面板只做只读展示。因此这里不导出对应的前端封装，
 * 避免出现「有函数但没人调用」的死代码（此前有 4 个零引用导出）。
 * 后端端点仍然保留，供 jobs/growth-auto.js 与 CLI 使用。
 */

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

export interface GrowthLastRun {
  ranAt?: string | null;
  total?: number;
  okCount?: number;
  failCount?: number;
  /** 成功动作摘要，形如 "acct-1: 领取旅行奖励 +200" */
  actions?: string[];
  durationMs?: number;
}

export const growthLastRun = (key: string, signal?: AbortSignal) =>
  api<GrowthLastRun & { object: string }>(
    '/v1/workbuddy/growth/last-run',
    { method: 'POST', signal, body: {} },
    key,
  );