import { api } from '../lib/api';
import type { Account } from './types';

export interface WbLocalInfo {
  found: boolean;
  hint?: string;
  file?: string;
  uid?: string;
  nickname?: string;
  phoneNumber?: string;
  region?: string;
  expiresAt?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
}

export interface WbVerifyResult {
  valid: boolean;
  reason?: string;
  balance?: number | null;
}

/** WorkBuddy 平台端点（/v1/workbuddy） */

export const wbLocal = (key: string) => api<WbLocalInfo>('/v1/workbuddy/local', {}, key);

export function wbImport(body: { label?: string; infoJsonText?: string; force?: boolean }, key: string) {
  return api<Account & { verified?: boolean; verifiedBalance?: number | null }>(
    '/v1/workbuddy/import',
    { method: 'POST', body },
    key,
  );
}

export function wbVerify(body: { accountId?: string }, key: string) {
  return api<WbVerifyResult>('/v1/workbuddy/verify', { method: 'POST', body }, key);
}

export function wbRefresh(body: { accountId: string }, key: string) {
  return api<{ ok: boolean; expiredAt?: string; accessToken?: string | null }>(
    '/v1/workbuddy/refresh',
    { method: 'POST', body },
    key,
  );
}

export interface WbCheckinOne {
  accountId?: string;
  label?: string;
  claimed?: boolean;
  checkedIn?: boolean;
  result?: string;
  note?: string;
  checkinCredits?: number | null;
  streakDays?: number | null;
  totalCredits?: number | null;
  alreadyCheckedIn?: boolean;
}

export interface WbCheckinBatch {
  object?: string;
  claimed: WbCheckinOne[];
  already: WbCheckinOne[];
  disabled: WbCheckinOne[];
  failed: { id?: string; label?: string; reason?: string }[];
  total: number;
  summary?: Record<string, number> | null;
}

export const wbCheckin = (accountId: string, key: string) =>
  api<WbCheckinOne>('/v1/workbuddy/checkin', { method: 'POST', body: { accountId } }, key);

export const wbCheckinAll = (key: string) =>
  api<WbCheckinBatch>('/v1/workbuddy/checkin-all', { method: 'POST' }, key);

export const wbCheckinStatus = (accountId: string | undefined, key: string) =>
  api<{ ok: boolean; checkedIn?: boolean; streakDays?: number | null; reason?: string }>(
    '/v1/workbuddy/checkin-status',
    { method: 'POST', body: accountId ? { accountId } : {} },
    key,
  );