import { api } from '../lib/api';

export interface StickyEntry {
  keyTail?: string;
  accountId?: string;
  ttlSec?: number;
}

export interface TrafficRow {
  /** 写入时的单调序号，同一日志文件内唯一，可作列表 key */
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
  summary?: { byModel?: Record<string, number>; byAccount?: Record<string, number>; byStatus?: Record<string, number>; tokens?: number };
  data: TrafficRow[];
}

export interface RuntimeInfo {
  status?: { scheduler?: { enabled?: boolean; nextCheckinAt?: string | null; lastCheckinAt?: string | null }; sticky?: { entries?: number }; models?: { unavailable?: number }; node?: string; uptimeSec?: number; pool?: { strategy?: string }; accounts?: { total?: number; enabled?: number; cooling?: number } };
  sticky?: StickyEntry[];
  pool?: unknown;
  scheduler?: unknown;
  notify?: { enabled?: boolean };
  keys?: { adminSeparated?: boolean };
}

export interface CreditRow {
  label?: string;
  todayUsed?: number;
}

// ===== T1 用量统计多维看板 =====
// tokens 只累加已计量请求；metered / unmetered 给出 usage 覆盖情况。
// 部分上游（如 WorkBuddy 平台）不回传 usage，此时 requests 有值而 tokens 恒为 0，
// 必须结合 unmetered 判断，不能读作「消耗 0 token」。

export interface DailyStat {
  date: string;
  requests: number;
  errors: number;
  tokens: number;
  metered: number;
  unmetered: number;
  estimatedCost: number;
  byModel: Record<string, { requests: number; tokens: number; metered: number; unmetered: number; estimatedCost: number }>;
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

export const getStatsDaily = (days: number, key: string) =>
  api<{ object: string; days: number; totalRequests: number; data: DailyStat[] }>(`/v1/admin/stats/daily?days=${days}`, {}, key);

export const getStatsModels = (days: number, key: string) =>
  api<{ object: string; days: number; totalRequests: number; data: ModelStat[] }>(`/v1/admin/stats/models?days=${days}`, {}, key);

export const getStatsAccounts = (days: number, key: string) =>
  api<{ object: string; days: number; totalRequests: number; data: AccountStat[] }>(`/v1/admin/stats/accounts?days=${days}`, {}, key);

/** WorkBuddy 本机会话日志扫描结果（客户端消耗一侧，与网关转发并列展示）。 */
export interface ClientDayStat {
  date: string;
  requests: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  credit: number;
  byModel: Record<string, { requests: number; tokens: number; credit?: number }>;
}

export interface ClientModelStat {
  model: string;
  requests: number;
  tokens: number;
  credit: number;
}

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
  data: ClientDayStat[];
  models: ClientModelStat[];
}

export const getClientStats = (days: number, key: string) =>
  api<ClientStatsResponse>(`/v1/admin/stats/client?days=${days}`, {}, key);

export const clearClientStatsCache = (key: string) =>
  api<{ ok: boolean; dir: string }>(`/v1/admin/stats/client/cache/clear`, { method: 'POST' }, key);

/** 官方账单接口逐请求 credit（精确值，仅 WorkBuddy 账号有）。 */
export interface OfficialUsageDay {
  date: string;
  requests: number;
  credit: number;
}

export interface OfficialUsageModel {
  model: string;
  requests: number;
  credit: number;
}

export interface OfficialUsageAccount {
  accountId: string;
  label: string;
  days: number;
  available: boolean;
  error?: string | null;
  credit: number;
  requests: number;
  byDay: OfficialUsageDay[];
  byModel: OfficialUsageModel[];
}

export interface OfficialUsageResponse {
  object: string;
  days: number;
  accounts: OfficialUsageAccount[];
}

export const getOfficialUsage = (days: number, key: string) =>
  api<OfficialUsageResponse>(`/v1/admin/stats/official-usage?days=${days}`, {}, key);

// ===== T2 SSE 调试 =====

export interface SseDebugRow {
  ts?: string;
  seq?: number;
  requestId?: string | null;
  accountId?: string | null;
  model?: string | null;
  event?: { type?: string; chunk?: string };
}

export const getSseDebugStatus = (key: string) =>
  api<{ object: string; enabled: boolean }>(`/v1/admin/debug/sse/status`, {}, key);

export const getSseDebug = (params: { days?: number; requestId?: string; limit?: number }, key: string) => {
  const q = new URLSearchParams();
  if (params.days) q.set('days', String(params.days));
  if (params.requestId) q.set('request_id', params.requestId);
  if (params.limit) q.set('limit', String(params.limit));
  return api<{ object: string; enabled: boolean; total: number; data: SseDebugRow[]; hint?: string }>(`/v1/admin/debug/sse?${q.toString()}`, {}, key);
};

// ===== T3 一键测试请求 =====

export const testChat = (body: { model: string; message: string; stream?: boolean; max_tokens?: number }, key: string) =>
  api<{ ok: boolean; model: string; accountId?: string; durationMs?: number; content?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; finishReason?: string; message?: string }>('/v1/admin/test-chat', { method: 'POST', body }, key);

// ===== T4 配置热更新 =====

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

export const getRuntimeConfig = (key: string) => api<RuntimeConfig>('/v1/admin/config', {}, key);

export const reloadConfig = (key: string) =>
  api<{ object: string; ok: boolean; before: { modelCount: number; poolStrategy: string }; after: { modelCount: number; poolStrategy: string }; reloadedAt: string }>('/v1/admin/config/reload', { method: 'POST' }, key);

// ===== 运维扩展端点（/v1/admin）+ 状态（/status） =====

export function getStatus(key: string) {
  return api<Record<string, unknown>>('/status', {}, key);
}

export function getRuntime(key: string) {
  return api<RuntimeInfo>('/v1/admin/runtime', {}, key);
}

export function getTraffic(params: { page?: number; pageSize?: number; status?: string; days?: number; account?: string }, key: string) {
  const q = new URLSearchParams();
  if (params.page) q.set('page', String(params.page));
  if (params.pageSize) q.set('page_size', String(params.pageSize));
  if (params.status) q.set('status', params.status);
  if (params.days) q.set('days', String(params.days));
  if (params.account) q.set('account', params.account);
  return api<TrafficResponse>(`/v1/admin/traffic?${q.toString()}`, {}, key);
}

export const getCreditHistory = (days: number, key: string) =>
  api<{ days: number; totalUsed: number; data: CreditRow[] }>(`/v1/admin/credit-history?days=${days}`, {}, key);

export const exportBackup = (key: string) => api<unknown>('/v1/admin/credentials/export', {}, key);

export interface ClientConfig {
  baseUrl: string;
  openai?: { OPENAI_BASE_URL?: string };
  anthropic?: { ANTHROPIC_BASE_URL?: string };
  codex?: { base_url?: string };
  notes?: string[];
}

export const getClientConfig = (key: string) => api<ClientConfig>('/v1/admin/client-config', {}, key);

export interface NotifySettings {
  webhookUrl?: string;
  webhookMethod?: string;
  webhookHeaders?: string;
  webhookTitleKey?: string;
  webhookContentKey?: string;
  serverChanSendKey?: string;
  pushPlusToken?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  events?: NotifyEventPrefs;
}

export interface NotifyEventPrefs {
  checkin_ok?: boolean;
  checkin_fail?: boolean;
  credits_expiring?: boolean;
  balance_low?: boolean;
  refresh_fail?: boolean;
  pool_empty?: boolean;
  growth_claimed?: boolean;
  growth_departed?: boolean;
  backup_done?: boolean;
  backup_failed?: boolean;
  [key: string]: boolean | undefined;
}

export function getNotifySettings(key: string) {
  return api<NotifySettings & { object: string }>('/v1/admin/notify/settings', {}, key);
}
export function saveNotifySettings(body: NotifySettings, key: string) {
  return api<NotifySettings>('/v1/admin/notify/settings', { method: 'POST', body }, key);
}
export const testNotify = (key: string) =>
  api<{ ok: boolean; enabled: boolean; results?: { channel: string; ok: boolean; message?: string }[] }>(
    '/v1/admin/notify/test',
    { method: 'POST', body: {} },
    key,
  );

export interface SchedulerSettings {
  object?: string;
  checkinHour: number;
  checkinMinute: number;
  keepaliveHour: number;
  keepaliveMinute: number;
  tokenSweepMinutes: number;
  modelProbeIntervalHours: number;
  modelProbeMaxPerRun: number;
  rotateEnabled?: number;
  rotateHour?: number;
  rotateMinute?: number;
  growthPollEnabled?: number;
  growthPollIntervalHours?: number;
  schedulerEnabled?: boolean;
}

export function getSchedulerSettings(key: string) {
  return api<SchedulerSettings>('/v1/admin/scheduler-settings', {}, key);
}
export function saveSchedulerSettings(body: Partial<SchedulerSettings>, key: string) {
  return api<SchedulerSettings>('/v1/admin/scheduler-settings', { method: 'POST', body }, key);
}

// ===== 任务执行日志 =====

export interface TaskLogRow {
  ts?: string;
  task?: string;
  trigger?: string;
  ok?: number;
  failed?: number;
  total?: number;
  acted?: number;
  error?: string;
  file?: string;
  sizeBytes?: number;
  checksum?: string;
}

export const getTaskLog = (limit: number, task: string | null, key: string) => {
  const q = new URLSearchParams();
  q.set('limit', String(limit));
  if (task) q.set('task', task);
  return api<{ object: string; data: TaskLogRow[] }>(`/v1/admin/task-log?${q.toString()}`, {}, key);
};
export const clearTaskLog = (key: string) =>
  api<{ ok: boolean }>('/v1/admin/task-log/clear', { method: 'POST' }, key);

// ===== 余额自动刷新 =====

export interface BalanceRefreshSettings {
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt?: string | null;
  lastOk?: number | null;
  lastFailed?: number | null;
  running?: boolean;
  lastError?: string | null;
}
export const getBalanceRefresh = (key: string) =>
  api<BalanceRefreshSettings>('/v1/admin/balance-refresh', {}, key);
export const saveBalanceRefresh = (body: Partial<BalanceRefreshSettings>, key: string) =>
  api<BalanceRefreshSettings>('/v1/admin/balance-refresh', { method: 'POST', body }, key);
export const runBalanceRefresh = (key: string) =>
  api<{ ok: number; failed: number; total: number; running?: boolean }>('/v1/admin/balance-refresh/run', { method: 'POST' }, key);

// ===== 全量备份 =====

export interface BackupSettings {
  enabled: boolean;
  dir: string;
  keep: number;
  intervalHours: number;
  lastBackupAt?: string | null;
  lastBackupFile?: string | null;
  lastBackupOk?: boolean | null;
  lastError?: string | null;
  running?: boolean;
  list?: BackupRow[];
}
export interface BackupRow {
  file: string;
  path: string;
  sizeBytes?: number;
  checksum?: string;
  createdAt?: string;
}
export const getBackup = (key: string) => api<BackupSettings>('/v1/admin/backup', {}, key);
export const saveBackup = (body: Partial<BackupSettings>, key: string) =>
  api<BackupSettings>('/v1/admin/backup', { method: 'POST', body }, key);
export const runBackup = (key: string) =>
  api<{ ok: boolean; file?: string; error?: string; running?: boolean; sizeBytes?: number; list?: BackupRow[] }>('/v1/admin/backup/run', { method: 'POST' }, key);
export const verifyBackup = (path: string, key: string) =>
  api<{ ok: boolean; reason?: string }>('/v1/admin/backup/verify', { method: 'POST', body: { path } }, key);

// ===== 通知事件自定义 =====

export interface NotifyEventRow {
  id: string;
  enabled: boolean;
  builtin?: boolean;
}
export const getNotifyEvents = (key: string) =>
  api<{ object: string; builtin: string[]; data: NotifyEventRow[] }>('/v1/admin/notify/events', {}, key);
export const addNotifyEvent = (event: string, key: string) =>
  api<{ ok: boolean; event: NotifyEventRow }>('/v1/admin/notify/events', { method: 'POST', body: { event } }, key);
export const removeNotifyEvent = (event: string, key: string) =>
  api<{ ok: boolean; removed: boolean }>('/v1/admin/notify/events/remove', { method: 'POST', body: { event } }, key);

export type SchedulerAction = 'checkin' | 'keepalive' | 'balance';
export const runScheduler = (action: SchedulerAction, key: string) =>
  api<Record<string, unknown>>(`/v1/admin/scheduler/${action}`, { method: 'POST' }, key);

export const getRouteCheck = (key: string) => api<Record<string, unknown>>('/v1/admin/route-check', {}, key);
export const probeModel = (model: string, key: string) =>
  api<{ ok: boolean; message?: string }>(`/v1/admin/models/probe`, { method: 'POST', body: { model } }, key);
export const getSticky = (key: string) => api<{ data: StickyEntry[]; ttlMs: number }>('/v1/admin/sticky', {}, key);

// ===== 账号自动切换（轮换）=====

export interface RotateSettings {
  object?: string;
  enabled: boolean;
  intervalMinutes: number;
  stayMs: number;
  authDir: string;
  excludeUids: string;
  switchBack: boolean;
}

export interface RotateHeatmapRow {
  accountId: string;
  label: string;
  uid?: string;
  score?: number;
  isActive?: boolean;
  level?: string;
  statusText?: string;
  error?: string;
}

export interface RotateStatus {
  object: string;
  currentUid: string | null;
  authDir: string;
  accounts: { uid: string; label: string; backup: string }[];
  heatmap: RotateHeatmapRow[];
  lastRotateAt?: string | null;
  lastRotateOk?: number | null;
  lastRotateFailed?: number | null;
  settings: RotateSettings;
  scheduler: {
    enabled?: boolean;
    nextRotateAt?: string | null;
    rotateSettings?: RotateSettings;
    rotateEnabled?: number;
    rotateHour?: number;
    rotateMinute?: number;
  };
}

export const getRotateStatus = (key: string) => api<RotateStatus>('/v1/admin/rotate/status', {}, key);
export const runRotateNow = (key: string) =>
  api<{ ok: number; failed: number; skipped?: number; reason?: string; busy?: boolean; results?: { label?: string; ok?: boolean; msg?: string }[]; seeded?: { ok?: { uid?: string; file?: string; label?: string }[]; skipped?: unknown[]; failed?: unknown[]; total?: number } }>('/v1/admin/rotate/run', { method: 'POST' }, key);
export const seedRotateBackups = (key: string) =>
  api<{ object: string; ok?: { uid?: string; file?: string; label?: string }[]; skipped?: { accountId?: string; reason?: string }[]; failed?: { accountId?: string; reason?: string }[]; total?: number }>('/v1/admin/rotate/seed', { method: 'POST' }, key);
export const switchRotateAccount = (uid: string, key: string) =>
  api<{ ok: boolean; uid: string; label: string; msg?: string }>('/v1/admin/rotate/switch', { method: 'POST', body: { uid } }, key);export const getRotateSettings = (key: string) => api<RotateSettings>('/v1/admin/rotate/settings', {}, key);
export const saveRotateSettings = (body: Partial<RotateSettings>, key: string) =>
  api<RotateSettings>('/v1/admin/rotate/settings', { method: 'POST', body }, key);

export interface ModelInfo {
  id: string;
  display_name?: string;
  status?: string;
  source_name?: string;
  owned_by?: string;
  capability?: string;
  rateText?: string;
  reason?: string;
  custom?: boolean;
  multimodal?: boolean;
  reasoning?: boolean;
  scene?: string | null;
}
export function getModelsStatus(params: { refresh?: boolean }, key: string) {
  const q = params.refresh ? '?refresh=1' : '';
  return api<{ strategy?: string; upstreamFunction?: string; source?: string; syncedAt?: string; data?: ModelInfo[]; hostNote?: string; upstreamChatPath?: string }>(`/v1/models/status${q}`, {}, key);
}

// ===== 密钥体系：登录密钥 setup + 访问密钥管理 =====

export interface SetupStatus {
  object: string;
  hasLoginKey: boolean;
  hasAccessKey: boolean;
}

export interface ApiKeyRow {
  id: string;
  label: string | null;
  kind: 'login' | 'access';
  platform: string | null;
  keyType?: string;
  scopes?: string[];
  resources?: string[];
  expiresAt?: string | null;
  revokedAt?: string | null;
  rpmLimit?: number | null;
  status?: string;
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  hint?: string | null;
}

export interface CreatedKey extends ApiKeyRow {
  /** 明文仅创建/重置响应中出现一次 */
  key: string;
}

export const getSetupStatus = () => api<SetupStatus>('/v1/api-keys/setup/status', {}, '');

export const createFirstLoginKey = (label = 'login') =>
  api<CreatedKey>('/v1/api-keys/setup/login-key', { method: 'POST', body: { label } }, '');

export const listAccessKeys = (key: string) =>
  api<{ object: string; kind: string; data: ApiKeyRow[] }>('/v1/api-keys?kind=access', {}, key);

export const createAccessKey = (
  body: {
    platform: 'trae' | 'workbuddy' | 'all';
    label?: string;
    scopes?: string[];
    resources?: string[];
    expiresAt?: string | null;
    rpmLimit?: number | null;
    keyType?: 'universal' | 'dedicated';
  },
  key: string,
) => api<CreatedKey>('/v1/api-keys', { method: 'POST', body }, key);

export const rotateAccessKey = (id: string, key: string, graceMs?: number) =>
  api<CreatedKey>(`/v1/api-keys/${id}/rotate`, { method: 'POST', body: { graceMs } }, key);

export const revokeAccessKey = (id: string, key: string) =>
  api<{ revoked: boolean }>(`/v1/api-keys/${id}/revoke`, { method: 'POST', body: {} }, key);

export const resetAccessKey = (id: string, key: string) =>
  api<CreatedKey>(`/v1/api-keys/${id}/reset`, { method: 'POST', body: {} }, key);

export const deleteAccessKey = (id: string, key: string) =>
  api<{ deleted: boolean }>(`/v1/api-keys/${id}`, { method: 'DELETE' }, key);

/** 取回明文供剪贴板复制；界面不展示。历史密钥无密文备份时 404。 */
export const revealAccessKey = (id: string, key: string) =>
  api<{ object: string; id: string; key: string }>(`/v1/api-keys/${id}/reveal`, {}, key);

export const resetLoginKey = (key: string) =>
  api<CreatedKey>('/v1/api-keys/login-key/reset', { method: 'POST', body: {} }, key);