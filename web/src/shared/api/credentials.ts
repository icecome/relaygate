/**
 * 凭据领域接口（/v1/credentials）。
 *
 * URL、请求方法与请求体字段与后端完全一致，未做任何改写。
 * 相比原实现，getSummary 增加了 AbortSignal 支持以便取消在途请求。
 */
import { api } from './http';
import type { Account, CheckinResult, BalanceResult, Summary } from './types';

export const listAccounts = (key: string, signal?: AbortSignal) =>
  api<{ object: string; data: Account[] }>('/v1/credentials', { signal }, key).then((r) => r.data ?? []);

export const getSummary = (signal: AbortSignal | undefined, key: string) =>
  api<Summary>('/v1/credentials/summary', { signal }, key);

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

export const checkinAll = (key: string) =>
  api<Record<string, unknown>>('/v1/credentials/checkin', { method: 'POST' }, key);

export const checkinOne = (id: string, key: string) =>
  api<CheckinResult & { status?: number }>(
    `/v1/credentials/${encodeURIComponent(id)}/checkin`,
    { method: 'POST' },
    key,
  );

export const refreshAllBalance = (key: string) =>
  api<{ ok: { accountId: string }[]; failed: { accountId: string; reason: string }[] }>(
    '/v1/credentials/balance',
    { method: 'POST' },
    key,
  );

export const refreshOneBalance = (id: string, key: string) =>
  api<BalanceResult>(`/v1/credentials/${encodeURIComponent(id)}/balance`, { method: 'POST' }, key);

export const resetDevice = (id: string, key: string) =>
  api<{ deviceGen: number; machineId: string }>(
    `/v1/credentials/${encodeURIComponent(id)}/device/reset`,
    { method: 'POST' },
    key,
  );

export const resetAllDevices = (key: string) =>
  api<{ ok: { accountId: string }[]; failed: { accountId: string; reason: string }[] }>(
    '/v1/credentials/device/reset-all',
    { method: 'POST' },
    key,
  );

/* ------------------------------------------------------------ Trae OAuth */

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

/** 提交 OAuth 回调结果。token 或 refreshToken 至少给一个。 */
export const oauthComplete = (
  body: { token?: string; refreshToken?: string; name?: string },
  key: string,
) =>
  api<{ ok: boolean; account?: Account; detail?: OauthStatus }>(
    '/v1/credentials/oauth/complete',
    { method: 'POST', body },
    key,
  );

/** 手动兜底：粘贴完整回调 URL，仅解析参数，不向该地址发起请求。 */
export const oauthCallback = (url: string, key: string) =>
  api<{ ok: boolean; account?: Account; detail?: OauthStatus }>(
    '/v1/credentials/oauth/callback',
    { method: 'POST', body: { url } },
    key,
  );
