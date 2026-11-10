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

/* 汇总视图 */

/**
 * 上游 travel/status 的 location 是结构化对象
 * （见 src/workbuddy/cat-trip.js normalizeStatus），idle 时为 null。
 * 键名保持上游蛇形（duration_hours）：后端归一化时不做大小写转换，
 * 前端类型必须与真实返回一致，否则读到 undefined。
 */
export interface GrowthLocation {
  id?: number | null;
  code?: string | null;
  name?: string | null;
  duration_hours?: number | null;
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
  /** 今日是否活跃（成长中心热力墙 today.is_active）；null=未取到（不是未活跃） */
  todayActive?: boolean | null;
  todayScore?: number | null;
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

/* 成长每日汇总（与 WorkDaddy 账号页同形态；本机挂载在 /v1/workbuddy/growth/daily-progress） */

/**
 * 成长任务明细。state 五态：claimed / completed / in_progress / not_accepted / unknown。
 * automatable=true 表示该任务码在自动化名单内（可被后台任务推进）；
 * false 表示需要用户在客户端真实操作。
 */
export interface GrowthTaskDetail {
  taskCode: string;
  title: string;
  guide: string;
  tag: string;
  deadline: string | null;
  reward: { credits: number; energy: number; buddy: boolean };
  current: number;
  target: number;
  state: string;
  automatable: boolean;
}

export interface GrowthDailyRow {
  accountId: string;
  label: string;
  /** ready=取到；unavailable=该账号查询失败（不是「什么都没有」） */
  status: 'ready' | 'unavailable';
  reason?: string;
  fetchedAt?: number;
  growth?: {
    completed: number;
    total: number;
    ratio: number;
    tasks: GrowthTaskDetail[];
  };
  rewards?: { claimed: number; total: number; pending: number; ratio: number };
  cat?: {
    state: string;
    progress: number;
    arriveAt: number | null;
    dailyLimitReached: boolean;
    available: boolean;
    activeBuddy: boolean;
    buddies: { instanceId: number; name: string }[];
    reward: { credits: number; energy: number };
  };
  actions?: {
    gacha: { available: boolean; count: number | null; energy: number | null; cost: number | null };
    lottery: { available: boolean; count: number | null };
  };
  manualTasks?: string[];
  checkin?: { checkedIn: boolean; source: string | null };
  active?: { todayActive: boolean | null; todayScore: number | null; streakDays: number | null };
  /**
   * 任务数据来源：'v2' = 完整进度与奖励；'v1' = 旧端点回退（上游不提供
   * progress/reward 字段，计数如实为 0）；null = 未取到。界面据此说明
   * 「零进度」是数据缺失还是真的没做。
   */
  taskSource?: 'v2' | 'v1' | null;
  /** v2 失败的原因（仅在回退到 v1 时有值） */
  taskV2Error?: string | null;
}

/** 全池成长每日汇总（只读）。force=true 时跳过 TTL 缓存重新查询上游。 */
export const growthDailyProgress = (key: string, force = false, signal?: AbortSignal) =>
  api<{ object: string; total: number; data: GrowthDailyRow[] }>(
    '/v1/workbuddy/growth/daily-progress',
    { method: 'POST', signal, body: { force } },
    key,
  );

/* 单账号 */
/*
 * 说明：单账号只读端点（status / config / buddy / streak / redeem / chances / tasks）
 * 与单账号写操作（claim / draw / redeem-tier / depart 等）由后端 handle() 生成，
 * 但管理面板不做单账号操作入口：只读由全池视图（status-all / overview /
 * daily-progress）覆盖，写操作归后台定时任务（jobs/growth-auto.js）。
 * 需要逐账号排查时走 CLI（node scripts/growth-*.js）。
 * 后端端点仍然保留，供 jobs 与 CLI 使用。
 */

/* 后台任务 */

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

/**
 * 一键执行成长自动化（旅行 + 任务 + 补登 + 兑换 + 抽奖 + 盲盒）。
 * 立即返回 taskId，进度轮询 /growth/progress?taskId=…。
 * 已有任务在跑时后端回 409。
 */
export const growthAuto = (key: string, body: { accountId?: string } = {}) =>
  api<{ object: string; taskId: string; startedAt: string; progressUrl: string }>(
    '/v1/workbuddy/growth/auto',
    { method: 'POST', body },
    key,
  );

/** 后台任务进度（轮询）。任务不存在或已过期时后端回 404。 */
export interface GrowthAutoProgress {
  object: string;
  taskId: string;
  startedAt: number;
  finishedAt: number | null;
  running: boolean;
  stage: string;
  error: string | null;
  currentAccount: string | null;
  total: number;
  doneCount: number;
  okCount: number;
  failCount: number;
  results: unknown[];
}

export const growthProgress = (taskId: string, key: string, signal?: AbortSignal) =>
  api<GrowthAutoProgress>(
    `/v1/workbuddy/growth/progress?taskId=${encodeURIComponent(taskId)}`,
    { method: 'POST', signal, body: {} },
    key,
  );

/** 最近自动化任务列表（新→旧）。 */
export const growthProgressList = (key: string, signal?: AbortSignal) =>
  api<{ object: string; data: GrowthAutoProgress[] }>(
    '/v1/workbuddy/growth/progress-list',
    { method: 'POST', signal, body: {} },
    key,
  );