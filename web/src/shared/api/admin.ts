/**
 * 管理端领域接口（/v1/admin/*）。
 *
 * 全部 URL、请求方法与请求体字段与后端保持一致，未做任何改写。
 * 类型定义集中在 shared/api/types.ts，页面不再就地断言。
 */
import { api } from './http';

export { ApiError, isBusinessFailure, businessFailureReason } from './http';

/* ------------------------------------------------------------ 流量日志 */

export interface TrafficRow {
  seq?: number;
  ts?: string;
  endpoint?: string;
  model?: string;
  account?: string;
  durationMs?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  estimatedCost?: number;
  error?: string | null;
  status?: number;
  toolCalls?: number;
}

export interface TrafficResponse {
  total: number;
  totalScan: number;
  page: number;
  totalPages: number;
  summary?: {
    byModel?: Record<string, number>;
    byAccount?: Record<string, number>;
    byStatus?: Record<string, number>;
    tokens?: number;
  };
  data: TrafficRow[];
}

export function getTraffic(
  params: { page?: number; pageSize?: number; days?: number; model?: string; account?: string } = {},
  key: string,
  signal?: AbortSignal,
) {
  const q = new URLSearchParams();
  if (params.page) q.set('page', String(params.page));
  if (params.pageSize) q.set('page_size', String(params.pageSize));
  if (params.days) q.set('days', String(params.days));
  if (params.model) q.set('model', params.model);
  if (params.account) q.set('account', params.account);
  const qs = q.toString();
  return api<TrafficResponse>(`/v1/admin/traffic${qs ? `?${qs}` : ''}`, { signal }, key);
}

/* ---------------------------------------------------------------- SSE */

export interface SseDebugRow {
  ts?: string;
  seq?: number;
  requestId?: string | null;
  accountId?: string | null;
  model?: string | null;
  event?: { type?: string; chunk?: string };
}

export const getSseDebugStatus = (key: string, signal?: AbortSignal) =>
  api<{ object: string; enabled: boolean }>('/v1/admin/debug/sse/status', { signal }, key);

export function getSseDebug(
  params: { days?: number; requestId?: string; limit?: number },
  key: string,
  signal?: AbortSignal,
) {
  const q = new URLSearchParams();
  if (params.days) q.set('days', String(params.days));
  if (params.requestId) q.set('request_id', params.requestId);
  if (params.limit) q.set('limit', String(params.limit));
  return api<{ object: string; enabled: boolean; total: number; data: SseDebugRow[]; hint?: string }>(
    `/v1/admin/debug/sse?${q.toString()}`,
    { signal },
    key,
  );
}

/* ------------------------------------------------------------ 测试请求 */

export function testChat(
  body: { model: string; message: string; stream?: boolean; max_tokens?: number },
  key: string,
) {
  return api<{
    ok: boolean;
    model: string;
    accountId?: string;
    durationMs?: number;
    content?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    finishReason?: string;
    message?: string;
  }>('/v1/admin/test-chat', { method: 'POST', body }, key);
}

/* ------------------------------------------------------------ 运行状态 */

/** 账号池快照条目（对应 pool.snapshot().accounts[]）。 */
export interface PoolAccountSnapshot {
  id: string;
  label?: string | null;
  balance?: number | null;
  /** FEFO 排序信号，用于核对「先到期先用」是否生效 */
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
  /** 模型级冷却：modelId -> 剩余毫秒 */
  modelCooldowns?: Record<string, number> | null;
  priority?: number;
  inFlight?: number;
  /** 启用且不在冷却、余额达标、有余量 */
  usable?: boolean;
}

export interface PoolSnapshot {
  strategy?: string;
  maxInFlight?: number;
  waiters?: { count?: number };
  accounts?: PoolAccountSnapshot[];
}

export interface SchedulerSnapshot {
  enabled?: boolean;
  checkinHour?: number;
  checkinMinute?: number;
  keepaliveHour?: number;
  keepaliveMinute?: number;
  tokenSweepMinutes?: number;
  modelProbeIntervalHours?: number;
  modelProbeMaxPerRun?: number;
  rotateEnabled?: number;
  rotateHour?: number;
  rotateMinute?: number;
  growthPollEnabled?: number;
  nextCheckinAt?: string | null;
  lastCheckinAt?: string | null;
  nextRotateAutoAt?: string | null;
}

export interface RuntimeInfo {
  object?: string;
  status?: {
    scheduler?: { enabled?: boolean; nextCheckinAt?: string | null; lastCheckinAt?: string | null };
    sticky?: { entries?: number };
    models?: { unavailable?: number };
    node?: string;
    uptimeSec?: number;
    pool?: { strategy?: string };
    accounts?: { total?: number; enabled?: number; cooling?: number };
  };
  /** 粘性会话明细 */
  sticky?: {
    key?: string;
    accountId?: string;
    expiresAt?: string;
  }[];
  pool?: PoolSnapshot;
  scheduler?: SchedulerSnapshot;
  notify?: { enabled?: boolean };
  keys?: { adminSeparated?: boolean };
}

export const getRuntime = (key: string, signal?: AbortSignal) =>
  api<RuntimeInfo>('/v1/admin/runtime', { signal }, key);

export const getSticky = (key: string, signal?: AbortSignal) =>
  api<{ object: string; data: RuntimeInfo['sticky']; ttlMs: number }>(
    '/v1/admin/sticky',
    { signal },
    key,
  );

/** 调度预演：不发真实请求，解释当前会选哪个账号。 */
export interface RouteCheck {
  object: string;
  strategy?: string;
  maxInFlightPerAccount?: number;
  minBalanceToUse?: number;
  wouldPick?: {
    id: string;
    label?: string | null;
    balance?: number | null;
    priority?: number;
  } | null;
  usableCount?: number;
  generatedAt?: string;
}

export const getRouteCheck = (key: string, signal?: AbortSignal) =>
  api<RouteCheck>('/v1/admin/route-check', { signal }, key);

/**
 * 客户端接入配置。含 OpenAI / Anthropic / Codex 三种协议的环境变量与 curl 示例，
 * 以及部署注意事项；不含真实密钥明文。
 */
export interface ClientConfig {
  object: string;
  baseUrl: string;
  openai?: {
    OPENAI_BASE_URL?: string;
    OPENAI_API_KEY?: string;
    curl?: string;
  };
  anthropic?: {
    ANTHROPIC_BASE_URL?: string;
    ANTHROPIC_API_KEY?: string;
    curl?: string;
  };
  codex?: { base_url?: string; note?: string };
  notes?: string[];
}

export const getClientConfig = (key: string, signal?: AbortSignal) =>
  api<ClientConfig>('/v1/admin/client-config', { signal }, key);

/* ---------------------------------------------------------------- 配置 */

export interface RuntimeConfig {
  object: string;
  port: number;
  host: string;
  poolStrategy: string;
  maxInFlightPerAccount: number;
  minBalanceToUse: number;
  ratePaceMs: number;
  rateWindowMs: number;
  rateWindowMax: number;
  rateCooldownMs: number;
  schedulerEnabled: boolean;
  checkinHour: number;
  checkinMinute: number;
  keepaliveHour: number;
  tokenRefreshLeadHours: number;
  modelProbeIntervalHours: number;
  upstreamFunction: string | null;
  upstreamChatPath: string;
  toolProtocol: string;
  maxRetries: number;
  retryBaseDelay: number;
  requestTimeoutMs: number;
  statusPublic: boolean;
  adminSeparated: boolean;
}

export const getRuntimeConfig = (key: string, signal?: AbortSignal) =>
  api<RuntimeConfig>('/v1/admin/config', { signal }, key);

export const reloadConfig = (key: string) =>
  api<{
    ok: boolean;
    before: { modelCount: number; poolStrategy: string };
    after: { modelCount: number; poolStrategy: string };
    reloadedAt: string;
  }>('/v1/admin/config/reload', { method: 'POST' }, key);

/* ---------------------------------------------------------- 定时任务 */

/**
 * 调度设置。字段与后端 jobs/scheduler-settings.js 的 SPECS 完全一致。
 * 注意：这里没有 enabled 字段——调度器总开关的唯一来源是环境变量
 * SCHEDULER_ENABLED（config.schedulerEnabled），接口以 schedulerEnabled 回传。
 */
export interface SchedulerSettings {
  object?: string;
  /** 调度器总开关，来自 SCHEDULER_ENABLED，非配置文件可改 */
  schedulerEnabled?: boolean;
  checkinHour?: number;
  checkinMinute?: number;
  keepaliveHour?: number;
  keepaliveMinute?: number;
  /** 令牌扫描间隔（分钟） */
  tokenSweepMinutes?: number;
  modelProbeIntervalHours?: number;
  modelProbeMaxPerRun?: number;
  rotateHour?: number;
  rotateMinute?: number;
  /** 成长中心轮询开关（0/1） */
  growthPollEnabled?: number;
  growthPollIntervalHours?: number;
  /** 确定性错峰窗口（分钟） */
  checkinSpreadMinutes?: number;
  balanceSpreadMinutes?: number;
  /** 保存后回传的调度器快照 */
  scheduler?: SchedulerSnapshot;
}

export const getSchedulerSettings = (key: string, signal?: AbortSignal) =>
  api<SchedulerSettings>('/v1/admin/scheduler-settings', { signal }, key);

export const saveSchedulerSettings = (body: Partial<SchedulerSettings>, key: string) =>
  api<SchedulerSettings>('/v1/admin/scheduler-settings', { method: 'POST', body }, key);

/**
 * 任务日志。字段与后端 appendTaskLog 写入的一致：
 * 计数用 ok/failed/total（部分任务另有 acted），trigger 区分 scheduler/manual/timer。
 * 后端不记录 durationMs 与 message，故类型里不设这两个字段。
 */
export interface TaskLogRow {
  ts?: string;
  task?: string;
  trigger?: string;
  ok?: number;
  failed?: number;
  total?: number;
  /** growth-auto 等任务的实际动作数 */
  acted?: number;
  error?: string;
}

/**
 * 任务日志。后端一次返回全部（按时间倒序）并按 limit 截断，
 * 上限 500；不支持 offset，因此分页由前端切片实现。
 */
export const getTaskLog = (
  limit: number,
  key: string,
  task: string | undefined,
  signal?: AbortSignal,
) => {
  const q = new URLSearchParams();
  q.set('limit', String(limit));
  if (task) q.set('task', task);
  return api<{ object: string; data: TaskLogRow[] }>(
    `/v1/admin/task-log?${q.toString()}`,
    { signal },
    key,
  );
};

export const clearTaskLog = (key: string) =>
  api<{ ok: boolean }>('/v1/admin/task-log/clear', { method: 'POST' }, key);

/**
 * 余额自动刷新配置。字段与后端 jobs/balance-refresh.js 的 SPECS 一致：
 * 只有 enabled 与 intervalMinutes（分钟），没有 hour/minute。
 */
export interface BalanceRefreshSettings {
  enabled?: boolean;
  intervalMinutes?: number;
  /** 上次执行时间 */
  lastRunAt?: string | null;
  lastOk?: number | null;
  lastFailed?: number | null;
  lastSummary?: {
    ok: number;
    failed: number;
    total: number;
    ranAt: string;
    trigger: string;
    error?: string;
  } | null;
  running?: boolean;
  timer?: { intervalMinutes?: number; nextRunAt?: string } | null;
}

export const getBalanceRefresh = (key: string, signal?: AbortSignal) =>
  api<BalanceRefreshSettings & { object: string }>('/v1/admin/balance-refresh', { signal }, key);

/** 保存余额刷新配置；后端会重排定时器。 */
export const saveBalanceRefresh = (
  body: Partial<Pick<BalanceRefreshSettings, 'enabled' | 'intervalMinutes'>>,
  key: string,
) =>
  api<BalanceRefreshSettings & { object: string }>(
    '/v1/admin/balance-refresh',
    { method: 'POST', body },
    key,
  );

/* ------------------------------------------------------------ 账号轮换 */

/**
 * 轮换状态。字段与后端 routes/admin-jobs.js 的 /rotate/status 完全一致：
 *   - currentUid：当前 auth 文件对应的 uid（不是账号库 id）
 *   - accounts：本机 auth 目录里发现的账号备份
 *   - heatmap：各账号当日成长活跃度（仅 workbuddy 账号，逐个查上游）
 */
export interface RotateAccount {
  uid: string;
  label?: string;
  backup?: string;
}

/** 单账号活跃度条目；上游查询失败时只有 error。 */
export interface RotateHeatmapRow {
  accountId: string;
  label?: string | null;
  uid?: string | null;
  score?: number;
  isActive?: boolean;
  /** 活跃度档位文案（后端按分数分档） */
  level?: string;
  statusText?: string;
  error?: string;
}

export interface RotateStatus {
  object: string;
  currentUid?: string | null;
  authDir?: string;
  accounts?: RotateAccount[];
  heatmap?: RotateHeatmapRow[];
  lastRotateAt?: string | null;
  lastRotateOk?: boolean | null;
  lastRotateFailed?: number | null;
  scheduler?: SchedulerSnapshot;
  settings?: RotateSettings;
}

/**
 * 轮换配置。字段与后端 jobs/rotate-settings.js 的 SPECS 完全一致。
 * 注意：没有 intervalHours / keepCount —— 间隔轮换链已移除，
 * 时刻由 scheduler-settings 的 rotateHour:rotateMinute 决定。
 */
export interface RotateSettings {
  object?: string;
  /** 自动轮换总开关（每日 rotateHour:rotateMinute 定时执行） */
  enabled?: boolean;
  /** 每个账号停留时长（毫秒），默认 60000 */
  stayMs?: number;
  /** 不参与轮换的 uid 列表，逗号分隔 */
  excludeUids?: string;
  /** 轮换结束后是否切回起始账号 */
  switchBack?: boolean;
  /** 客户端 auth 目录，空= 默认探测 */
  authDir?: string;
  /** 已废弃，保留仅为兼容旧配置文件 */
  intervalMinutes?: number;
  /** 保存后回传的调度器快照 */
  scheduler?: SchedulerSnapshot;
}

export const getRotateStatus = (key: string, signal?: AbortSignal) =>
  api<RotateStatus>('/v1/admin/rotate/status', { signal }, key);

export const getRotateSettings = (key: string, signal?: AbortSignal) =>
  api<RotateSettings>('/v1/admin/rotate/settings', { signal }, key);

/** 保存轮换配置；后端会重启轮换定时器使新配置生效。 */
export const saveRotateSettings = (body: Partial<RotateSettings>, key: string) =>
  api<RotateSettings>('/v1/admin/rotate/settings', { method: 'POST', body }, key);

/**
 * 轮换执行。注意：接口可能返回业务层失败（HTTP 200 但 ok 计数偏低或带 reason），
 * 调用方需用 isBusinessFailure 区分「请求异常」与「业务未成功」。
 */
export const runRotate = (key: string) =>
  api<{
    ok: number;
    failed: number;
    skipped?: number;
    reason?: string;
    busy?: boolean;
    results?: { label?: string; ok?: boolean; msg?: string }[];
  }>('/v1/admin/rotate/run', { method: 'POST' }, key);

export const seedRotate = (key: string) =>
  api<{
    ok?: { uid?: string; file?: string; label?: string }[];
    skipped?: { accountId?: string; reason?: string }[];
    failed?: { accountId?: string; reason?: string }[];
    total?: number;
  }>('/v1/admin/rotate/seed', { method: 'POST' }, key);

export const switchRotate = (uid: string, key: string) =>
  api<{ ok: boolean; uid: string; label: string; msg?: string }>(
    '/v1/admin/rotate/switch',
    { method: 'POST', body: { uid } },
    key,
  );

/* ---------------------------------------------------------- 通知与备份 */

/** 通知事件 id → 中文标签（与后端 notify/settings.js 的 EVENTS 一一对应）。 */
export const NOTIFY_EVENT_LABELS: Record<string, string> = {
  checkin_ok: '签到成功',
  checkin_fail: '签到失败',
  credits_expiring: '权益即将到期',
  balance_low: '余额不足',
  refresh_fail: '令牌刷新失败',
  pool_empty: '账号池为空',
  growth_claimed: '成长奖励已领取',
  growth_departed: '成长奖励已消耗',
  backup_done: '备份完成',
  backup_failed: '备份失败',
};

/** 渠道 id → 中文标签（对应 notify/index.js 的 activeChannels）。 */
export const NOTIFY_CHANNEL_LABELS: Record<string, string> = {
  webhook: 'Webhook',
  serverchan: 'Server 酱',
  pushplus: 'PushPlus',
  telegram: 'Telegram',
};

/**
 * 通知设置。字段与后端 notify/settings.js 的 FIELDS 完全一致：
 * 总开关 enabled + 四类渠道凭据；密钥类字段为明文存储，前端不回显时留空即可。
 */
export interface NotifySettings {
  enabled?: boolean;
  webhookUrl?: string;
  webhookMethod?: string;
  webhookHeaders?: string;
  webhookTitleKey?: string;
  webhookContentKey?: string;
  serverChanSendKey?: string;
  pushPlusToken?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  events?: Record<string, boolean>;
}

export interface NotifySettingsResponse extends NotifySettings {
  object: string;
  /** 总开关打开且凭据齐备的渠道 */
  activeChannels?: string[];
  /** 已配置但被总开关关掉的渠道 */
  configuredChannels?: string[];
  /** 是否真的会发送（activeChannels 非空） */
  running?: boolean;
}

export const getNotifySettings = (key: string, signal?: AbortSignal) =>
  api<NotifySettingsResponse>('/v1/admin/notify/settings', { signal }, key);

export const saveNotifySettings = (body: Partial<NotifySettings>, key: string) =>
  api<NotifySettingsResponse>('/v1/admin/notify/settings', { method: 'POST', body }, key);

/** 逐渠道发送测试，绕过去重可反复点。 */
export const testNotify = (key: string) =>
  api<{
    ok: boolean;
    enabled?: boolean;
    results?: { channel: string; ok: boolean; error?: string }[];
  }>('/v1/admin/notify/test', { method: 'POST' }, key);

/** 事件开关。builtin 为后端内置事件 id，data 为当前开关状态。 */
export const getNotifyEvents = (key: string, signal?: AbortSignal) =>
  api<{ object: string; builtin: string[]; data: { id: string; enabled: boolean }[] }>(
    '/v1/admin/notify/events',
    { signal },
    key,
  );

/** 事件开关随通知设置一并落盘，返回同 saveNotifySettings。 */
export const saveNotifyEvents = (events: Record<string, boolean>, key: string) =>
  saveNotifySettings({ events }, key);

/** 备份条目。path 用于后续校验 / 预览 / 恢复。 */
export interface BackupRow {
  file: string;
  path?: string;
  sizeBytes?: number;
  createdAt?: string;
  checksum?: string;
}

/** 备份任务配置。dir 为服务端路径，仅回显不接受前端写入。 */
export interface BackupSettings {
  enabled?: boolean;
  dir?: string;
  keep?: number;
  intervalHours?: number;
  lastBackupAt?: string | null;
  lastBackupFile?: string | null;
  lastBackupOk?: boolean | null;
  lastError?: string | null;
  running?: boolean;
  timer?: { intervalHours?: number; nextRunAt?: string } | null;
}

export interface BackupResponse extends BackupSettings {
  object: string;
  list?: BackupRow[];
}

export const getBackup = (key: string, signal?: AbortSignal) =>
  api<BackupResponse>('/v1/admin/backup', { signal }, key);

export const saveBackup = (body: Partial<BackupSettings>, key: string) =>
  api<BackupResponse>('/v1/admin/backup', { method: 'POST', body }, key);

export const runBackup = (key: string) =>
  api<{
    ok: boolean;
    file?: string;
    error?: string;
    skipped?: boolean;
    running?: boolean;
    sizeBytes?: number;
    accounts?: number;
    list?: BackupRow[];
  }>('/v1/admin/backup/run', { method: 'POST' }, key);

export const verifyBackup = (path: string, key: string) =>
  api<{ ok: boolean; reason?: string }>('/v1/admin/backup/verify', { method: 'POST', body: { path } }, key);

/** 备份内容预览：只回计数摘要，不回明文凭据。 */
export interface BackupInspect {
  object: string;
  file: string;
  path: string;
  createdAt?: string | null;
  checksumOk: boolean;
  checksumReason?: string;
  summary: {
    accounts: number;
    apiKeys: number;
    creditHistory: number;
    configKeys: number;
    hasNotifySettings: boolean;
    hasBalanceRefresh: boolean;
  };
}

export const inspectBackup = (path: string, key: string) =>
  api<BackupInspect>(`/v1/admin/backup/inspect?path=${encodeURIComponent(path)}`, {}, key);

/** 从备份恢复。safetyBackup 默认 true：恢复前先快照当前状态。 */
export const restoreBackup = (path: string, key: string, safetyBackup = true) =>
  api<{
    object: string;
    ok: boolean;
    file: string;
    createdAt?: string | null;
    accounts: number;
    apiKeys: number;
    creditHistory: number;
    configs: number;
    safetyBackupFile?: string | null;
    list?: BackupRow[];
  }>('/v1/admin/backup/restore', { method: 'POST', body: { path, safetyBackup } }, key);

/* ------------------------------------------------------------ 模型池 */

/**
 * 模型池条目（GET /v1/models/status）。
 * 字段与后端 routes/models.js 的 listModels 完全一致：
 *   - status: usable | unavailable | unknown（后端 availability 模块判定）；
 *   - rate/rateText：积分倍率，x 开头；两平台接口均未提供峰谷价格，故peak 恒为 null；
 *   - contextWindow 仅虚拟模型有值，上游模型目录不提供窗口；
 *   - candidates/usableCandidates 仅虚拟模型有值。
 */
export interface ModelInfo {
  id: string;
  display_name?: string;
  /**
   * 可用性，取值与 models/availability.js 的三态一致：
   * usable（探测成功）| unavailable（探测失败，带 TTL）| unknown（尚无探测记录）。
   */
  status?: 'usable' | 'unavailable' | 'unknown';
  /** 不可用原因，如「已禁用」「全部候选不可用」「无可用 WorkBuddy 账号」 */
  reason?: string | null;
  capability?: string | null;
  multimodal?: boolean;
  custom?: boolean;
  virtual?: boolean;
  source?: string;
  source_name?: string;
  rate?: number | null;
  rateText?: string | null;
  feeLevel?: number | null;
  scene?: string | null;
  /** 峰谷价格：后端固定返回 null */
  peak?: number | null;
  /** WorkBuddy 侧的最大输入 token */
  maxInputTokens?: number | null;
  /** 虚拟模型候选数 / 可用候选数 */
  candidates?: number;
  usableCandidates?: number;
  /** 虚拟模型对外声明的上下文窗口 */
  contextWindow?: number | null;
}

export const getModelsStatus = (key: string, signal?: AbortSignal) =>
  api<{
    object: string;
    strategy?: string;
    upstreamFunction?: string | null;
    upstreamChatPath?: string;
    source?: string;
    syncedAt?: string;
    endpoint?: string | null;
    hostNote?: string;
    data?: ModelInfo[];
  }>('/v1/models/status', { signal }, key);

export const refreshModels = (key: string) =>
  api<{ ok: boolean; source?: string; syncedAt?: string; count?: number; error?: string | null }>(
    '/v1/models/refresh',
    { method: 'POST' },
    key,
  );

/** 清除可用性标记。缺省model 时清全部。 */
export const clearModelsStatus = (model: string | undefined, key: string) =>
  api<{ cleared: string }>(
    `/v1/models/status${model ? `?model=${encodeURIComponent(model)}` : ''}`,
    { method: 'DELETE' },
    key,
  );

export const probeModel = (model: string, key: string) =>
  api<{ ok: boolean; message?: string }>('/v1/admin/models/probe', { method: 'POST', body: { model } }, key);

export const getCatalogStatus = (key: string, signal?: AbortSignal) =>
  api<{ object: string; syncedAt?: string; count?: number }>('/v1/admin/catalog/status', { signal }, key);

/** 模型画像：由 traffic 日志聚合，补充请求数与错误数。 */
export interface ModelUsageStat {
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

/** days 范围 1-30（后端 clamp）。 */
export const getModelUsageStats = (days: number, key: string, signal?: AbortSignal) =>
  api<{ object: string; days: number; generatedAt: string; data: ModelUsageStat[] }>(
    `/v1/admin/models/stats?days=${days}`,
    { signal },
    key,
  );