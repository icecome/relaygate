/**
 * 凭据领域接口（/v1/credentials）。
 *
 * URL、请求方法与请求体字段与后端完全一致，未做任何改写。
 * getSummary 支持 AbortSignal 以取消在途请求。
 */
import { api } from './http';
import type {
  Account,
  CheckinResult,
  BalanceResult,
  EntitlementRollup,
  Summary,
} from './types';

/**
 * 账号列表。
 *
 * `slim=true`（默认）：后端把每个账号的 packs 明细换成 `packDigest` 摘要，
 * 并去掉 devices / fingerprint。实测 23 个账号 743 条权益包时，
 * 完整响应 121 KB，摘要后 ≈18 KB——而列表页只用到六个聚合值。
 *
 * 列表页**必须**用 slim：它随余额轮询每 60 秒跑一次。完整明细走
 * `getAccount(id)` 按需拉取（只有点开权益详情时才发生）。
 */
export const listAccounts = (key: string, signal?: AbortSignal, slim = true) =>
  api<{ object: string; slim?: boolean; rollup?: EntitlementRollup; data: Account[] }>(
    `/v1/credentials${slim ? '?slim=1' : ''}`,
    { signal },
    key,
  ).then((r) => r.data ?? []);

/** 列表 + 汇总一起取（列表页首屏只需要一次请求即可渲染统计条与表格）。 */
export const listAccountsWithRollup = (key: string, signal?: AbortSignal) =>
  api<{ object: string; slim?: boolean; rollup?: EntitlementRollup; data: Account[] }>(
    '/v1/credentials?slim=1',
    { signal },
    key,
  ).then((r) => ({ accounts: r.data ?? [], rollup: r.rollup ?? null }));

/**
 * 单账号详情（含完整 packs 明细）。
 *
 * 详情弹窗专用：权益明细、设备参数等只在用户点开时才需要。
 * 这条路径**不带** slim，返回的是完整 packs 数组。
 */
export const getAccount = (id: string, key: string, signal?: AbortSignal) =>
  api<Account>(`/v1/credentials/${encodeURIComponent(id)}`, { signal }, key);

/**
 * 账号池摘要（侧栏可用数、总览页额度卡）。
 * 同样带 slim：它是全局单例，每 60 秒随余额轮询重拉，
 * 不瘦身的话同一批 743 条包会被下发两遍。
 */
export const getSummary = (signal: AbortSignal | undefined, key: string) =>
  api<Summary>('/v1/credentials/summary?slim=1', { signal }, key);

export function importTrae(
  body: { label?: string; storageJsonText?: string; refreshToken?: string },
  key: string,
) {
  return api<Account>('/v1/credentials', { method: 'POST', body }, key);
}

export function importMany(items: object[], key: string) {
  return api<{ imported: number; updated: string[]; failed: string[] }>(
    '/v1/credentials',
    { method: 'POST', body: { items } },
    key,
  );
}

export function patchAccount(id: string, patch: Record<string, unknown>, key: string) {
  return api<Account>(`/v1/credentials/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }, key);
}

export function deleteAccount(id: string, key: string) {
  return api<{ deleted: string }>(`/v1/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }, key);
}

/**
 * 跨平台「全部签到」（POST /v1/credentials/checkin-all）。
 * 覆盖所有启用且有 checkin 能力的账号（Trae + WorkBuddy），返回分平台明细。
 * 注意：不要改回 /v1/credentials/checkin —— 那是 Trae 专用端点，
 * WorkBuddy 账号会被静默跳过（m-39 回归）。
 */
export interface CheckinAllResult {
  object?: string;
  trigger?: string;
  total?: number;
  claimed?: number;
  already?: number;
  disabled?: number;
  failed?: number;
  message?: string;
  /**
   * true 表示后端因另一轮签到（定时链或另一次手动）正在进行而跳过本轮，
   * 此时未向上游发任何请求，claimed/already/failed 均为 0。
   * 必须与「今日均已签到」区分：后者是真的签完了，前者是这一轮压根没跑。
   */
  skipped?: boolean;
  /** 各平台今日覆盖度（跨批次口径）：signed=今日已履约号数，unsigned=未签的号名 */
  coverage?: Record<string, { total: number; signed: number; unsigned: string[] }>;
  platforms?: {
    platform: string;
    total: number;
    claimed: number;
    already: number;
    disabled: number;
    failed: number;
    error: string | null;
    accounts: { id?: string; label?: string; result: string; credit?: number | null; reason?: string | null }[];
  }[];
}

export const checkinAll = (key: string) =>
  api<CheckinAllResult>('/v1/credentials/checkin-all', { method: 'POST' }, key);

export const checkinOne = (id: string, key: string) =>
  api<CheckinResult & { status?: number }>(
    `/v1/credentials/${encodeURIComponent(id)}/checkin`,
    { method: 'POST' },
    key,
  );

/**
 * 批量刷新全部启用账号的剩余积分。
 * 供页面自动轮询使用；后端受互斥锁保护，被占用时返回 202（解析为 skipped）。
 */
export const refreshAllBalance = (key: string) =>
  api<{
    object: string;
    ok?: { accountId: string }[];
    failed?: { id: string; label: string; reason: string }[];
    total?: number;
    /** true 表示后端因另一轮刷新进行中而跳过本轮 */
    skipped?: boolean;
  }>('/v1/credentials/balance', { method: 'POST' }, key);

export const refreshOneBalance = (id: string, key: string) =>
  api<BalanceResult>(`/v1/credentials/${encodeURIComponent(id)}/balance`, { method: 'POST' }, key);

export const resetAllDevices = (key: string) =>
  api<{ ok: { accountId: string }[]; failed: { accountId: string; reason: string }[] }>(
    '/v1/credentials/device/reset-all',
    { method: 'POST' },
    key,
  );

/**
 * 重置单账号设备标识（POST /v1/credentials/:id/device/reset）。
 *
 * 后端从 2026-10 起就有这条端点（credentials.js 的 `/:id/device/reset`），
 * 但面板只接了「全部重置」——想重置一个账号必须动全池。行内入口补上这条。
 */
export const resetOneDevice = (id: string, key: string) =>
  api<{ accountId: string; deviceGen?: number }>(
    `/v1/credentials/${encodeURIComponent(id)}/device/reset`,
    { method: 'POST' },
    key,
  );

/** 分组汇总（分组名 → 账号数；name=null 表示未分组）。供筛选器与统计展示。 */
export interface CredentialGroup {
  name: string | null;
  count: number;
}

export const listGroups = (key: string, signal?: AbortSignal) =>
  api<{ object: string; data: CredentialGroup[] }>('/v1/credentials/groups', { signal }, key);

/* Trae OAuth */

/**
 * OAuth 登录：先取授权地址并打开，用户完成授权后前端轮询 status。
 * state 一次性有效且与本次登录绑定，未先发起流程直接提交回调会被拒绝。
 */
export const oauthUrl = (group: string | undefined, key: string) => {
  const q = group ? `?group=${encodeURIComponent(group)}` : '';
  return api<{
    url: string;
    state: string;
    redirectUri: string;
    expiresAt: string;
    statusUrl: string;
  }>(`/v1/credentials/oauth/url${q}`, {}, key);
};

export interface OauthStatus {
  state?: 'idle' | 'pending' | 'success' | 'error';
  label?: string;
  message?: string;
  result?: { accountId?: string; label?: string };
}

export const oauthStatus = (key: string, signal?: AbortSignal) =>
  api<{ result?: OauthStatus }>('/v1/credentials/oauth/status', { signal }, key);

/** 手动最后手段：粘贴完整回调 URL，仅解析参数，不向该地址发起请求。 */
export const oauthCallback = (url: string, key: string) =>
  api<{ ok: boolean; account?: Account; detail?: OauthStatus }>(
    '/v1/credentials/oauth/callback',
    { method: 'POST', body: { url } },
    key,
  );

/* 账号加密导出 / 导入（跨机迁移，对标 WorkDaddy accounts export/import） */

export interface TransferExportResult {
  object: string;
  filename: string;
  /** 加密信封 JSON 全文（前端保存为 .json 文件下载） */
  content: string;
  count: number;
}

export const transferExport = (password: string, key: string, accountIds?: string[]) =>
  api<TransferExportResult>('/v1/credentials/transfer/export', { method: 'POST', body: { password, accountIds } }, key);

export interface TransferImportResult {
  object: string;
  ok: boolean;
  /** 新建的账号 id 列表 */
  imported: string[];
  /** 按 userId 去重后更新的既有账号 id 列表 */
  updated: string[];
  /** 形态校验未通过被跳过的行数 */
  skipped: number;
  total: number;
}

export const transferImport = (content: string, password: string, key: string) =>
  api<TransferImportResult>('/v1/credentials/transfer/import', { method: 'POST', body: { content, password } }, key);
