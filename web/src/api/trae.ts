import { api } from '../lib/api';
import type { Account, CheckinResult, BalanceResult, Summary } from './types';

/** Trae 凭据管理（/v1/credentials） */

export const listAccounts = (key: string) =>
  api<{ object: string; data: Account[] }>('/v1/credentials', {}, key).then((r) => r.data ?? []);

export const getSummary = (key: string) => api<Summary>('/v1/credentials/summary', {}, key);

export function importTrae(body: { label?: string; storageJsonText?: string; refreshToken?: string }, key: string) {
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

export const checkinAll = (key: string) => api<Record<string, unknown>>('/v1/credentials/checkin', { method: 'POST' }, key);
export const checkinOne = (id: string, key: string) =>
  api<CheckinResult & { status?: number }>(`/v1/credentials/${encodeURIComponent(id)}/checkin`, { method: 'POST' }, key);

export const refreshAllBalance = (key: string) =>
  api<{ ok: { accountId: string }[]; failed: { accountId: string; reason: string }[] }>(
    '/v1/credentials/balance',
    { method: 'POST' },
    key,
  );
export const refreshOneBalance = (id: string, key: string) =>
  api<BalanceResult>(`/v1/credentials/${encodeURIComponent(id)}/balance`, { method: 'POST' }, key);

export const resetDevice = (id: string, key: string) =>
  api<{ deviceGen: number; machineId: string }>(`/v1/credentials/${encodeURIComponent(id)}/device/reset`, { method: 'POST' }, key);

export const resetAllDevices = (key: string) =>
  api<{ ok: { accountId: string }[]; failed: { accountId: string; reason: string }[] }>(
    '/v1/credentials/device/reset-all',
    { method: 'POST' },
    key,
  );

// OAuth（Trae）
export function oauthUrl(group?: string, key = '') {
  const q = group ? `?group=${encodeURIComponent(group)}` : '';
  return api<{ url: string; state: string; redirectUri: string; expiresAt: string }>(
    `/v1/credentials/oauth/url${q}`,
    {},
    key,
  );
}
export function oauthStatus(key = '') {
  return api<{ result?: { state: string; label?: string; message?: string } }>('/v1/credentials/oauth/status', {}, key);
}