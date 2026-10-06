/**
 * 访问密钥接口（/v1/api-keys）。
 *
 * 真实契约（对照 src/credentials/api-keys.js 的 rowToKey）：
 *   - 列表返回 { object, kind, data }，字段为 id / label / kind / platform /
 *     keyType / scopes / resources / expiresAt / revokedAt / rotatedFrom /
 *     rpmLimit / enabled / createdAt / lastUsedAt / hint / status；
 *   - hint 是不可逆推的掩码提示，形如 `sk-…abcd`；
 *   - 启用态字段是 enabled，吊销时间是 revokedAt（不是 revoked 布尔）；
 *   - 明文 key 仅在创建、轮换、重置、reveal 时返回一次。
 *
 * 注意：GET /login-key 返回的是 { object, data: [...] } 列表，
 * 不是 { hasLoginKey } 形状，据此判断登录密钥是否已配置。
 */
import { api } from './http';

export type KeyStatus = 'active' | 'revoked' | 'disabled' | 'expired';

export interface ApiKeyRow {
  id: string;
  label?: string | null;
  kind?: string;
  platform?: string | null;
  keyType?: string;
  scopes?: string[];
  resources?: string[];
  expiresAt?: string | null;
  revokedAt?: string | null;
  rotatedFrom?: string | null;
  rpmLimit?: number | null;
  enabled?: boolean;
  createdAt?: string;
  lastUsedAt?: string | null;
  /** 不可逆推的掩码提示，如 `sk-…abcd` */
  hint?: string | null;
  status?: KeyStatus;
}

export interface CreatedKey {
  id?: string;
  key: string;
  label?: string;
}

/** 有效：未吊销、未停用、未过期。 */
export function isKeyUsable(k: ApiKeyRow): boolean {
  return k.enabled === true && !k.revokedAt && k.status !== 'revoked' && k.status !== 'expired';
}

export function listAccessKeys(key: string, signal?: AbortSignal) {
  return api<{ object: string; kind: string; data: ApiKeyRow[] }>(
    '/v1/api-keys?kind=access',
    { signal },
    key,
  );
}

export const createAccessKey = (body: { label?: string; platform?: string }, key: string) =>
  api<CreatedKey>('/v1/api-keys', { method: 'POST', body }, key);

export const rotateAccessKey = (id: string, graceMs: number, key: string) =>
  api<CreatedKey>(`/v1/api-keys/${encodeURIComponent(id)}/rotate`, { method: 'POST', body: { graceMs } }, key);

export const revokeAccessKey = (id: string, key: string) =>
  api<{ revoked: boolean }>(`/v1/api-keys/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: {} }, key);

export const resetAccessKey = (id: string, key: string) =>
  api<CreatedKey>(`/v1/api-keys/${encodeURIComponent(id)}/reset`, { method: 'POST', body: {} }, key);

export const deleteAccessKey = (id: string, key: string) =>
  api<{ deleted: boolean }>(`/v1/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }, key);

export const revealAccessKey = (id: string, key: string) =>
  api<{ object: string; id: string; key: string }>(`/v1/api-keys/${encodeURIComponent(id)}/reveal`, {}, key);

/* ------------------------------------------------------------ 登录密钥 */

/**
 * 登录密钥列表。返回形状是 { object, data }，
 * 因此是否已配置要由 data 长度判断，而不是读 hasLoginKey。
 */
export const listLoginKeys = (key: string, signal?: AbortSignal) =>
  api<{ object: string; data: ApiKeyRow[] }>('/v1/api-keys/login-key', { signal }, key);

export const resetLoginKey = (label: string, key: string) =>
  api<CreatedKey>('/v1/api-keys/login-key/reset', { method: 'POST', body: { label } }, key);

/** 展示用掩码：优先用后端 hint，其次由明文派生。 */
export function maskKey(raw: string | null | undefined): string {
  if (!raw) return '—';
  if (raw.length <= 8) return '••••';
  return `sk-…${raw.slice(-4)}`;
}

/* ------------------------------------------------------------ 首登引导 */

export interface SetupStatus {
  /** 后端权威字段：是否已存在登录密钥 */
  hasLoginKey: boolean;
  hasAccessKey: boolean;
}

export const getSetupStatus = () => api<SetupStatus>('/v1/api-keys/setup/status', {}, '');

export const createFirstLoginKey = (label: string) =>
  api<CreatedKey>('/v1/api-keys/setup/login-key', { method: 'POST', body: { label } }, '');