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
 * GET /login-key 返回 { object, data: [...] } 列表，不是 { hasLoginKey } 形状，
 * 据此判断登录密钥是否已配置。
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

/**
 * 修改访问密钥的属性（PATCH /v1/api-keys/:id）。
 *
 * 后端的可改字段白名单（src/routes/api-keys.js 的 patch 分支）：
 *   label / enabled / scopes / resources / expiresAt / rpmLimit
 *
 * 注意 **platform 不在白名单里**：一把 sk- 建出来属于哪个平台是身份的一部分，
 * 改它等于把已发给 IDE 的密钥偷偷扩大适用范围 —— 需要换平台请新建一把。
 *
 * 三个字段的取值语义（照抄后端，不要在前端另立一套）：
 *   - scopes：六个枚举值，见 KEY_SCOPES；传空数组会被 normalizeScopes 回落到
 *     平台默认值（所以「取消全部权限」不是传 []，而是停用这把密钥）；
 *   - resources：形如 `*` / `model:trae/*` / `model:virtual:vm/x` / `provider/<id>/*`，
 *     前缀通配；传空数组同样回落默认值；
 *   - expiresAt：ISO 字符串或 null（null = 永不过期）。
 */
export const updateAccessKey = (
  id: string,
  patch: Partial<Pick<ApiKeyRow, 'label' | 'enabled' | 'scopes' | 'resources' | 'expiresAt' | 'rpmLimit'>>,
  key: string,
) =>
  api<{ object: string; id: string }>(
    `/v1/api-keys/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: patch },
    key,
  );

/**
 * scopes 枚举。**必须与后端 `credentials/api-keys.js#SCOPES` 逐字一致**：
 * 多一个会被 normalizeScopes 静默过滤（保存成功但权限没给），
 * 少一个则用户无法授予该权限。
 */
export const KEY_SCOPES = [
  { value: 'models:read', label: '读取模型列表', hint: '/v1/models；缺它客户端连模型列表都拿不到' },
  { value: 'models:invoke', label: '调用模型', hint: 'chat / messages / responses 三个转发端点' },
  { value: 'router:read', label: '读取路由信息', hint: '查询虚拟模型的候选与健康度' },
  { value: 'router:invoke', label: '调用虚拟模型', hint: '以 vm/ 开头的聚合模型名' },
  { value: 'admin:keys', label: '管理密钥（高危）', hint: '仅管理面使用，不要发给 IDE' },
  { value: 'admin:catalog', label: '管理模型目录（高危）', hint: '仅管理面使用' },
] as const;

/** 与后端 SCOPES 集合一致的取值集，用于把后端返回值过滤成已知项。 */
export const KNOWN_SCOPES = new Set<string>(KEY_SCOPES.map((s) => s.value));

/** 剩余有效期（自然日，向上取整）；无过期时间返回 null。 */
export function keyDaysLeft(expiresAt: string | null | undefined, now = Date.now()): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - now) / 86_400_000);
}

/* 登录密钥 */

/**
 * 登录密钥列表。返回形状是 { object, data }，
 * 是否已配置由 data 长度判断，而不是读 hasLoginKey。
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

/* 首登引导 */

export interface SetupStatus {
  /** 后端权威字段：是否已存在登录密钥 */
  hasLoginKey: boolean;
  hasAccessKey: boolean;
}

export const getSetupStatus = () => api<SetupStatus>('/v1/api-keys/setup/status', {}, '');

export const createFirstLoginKey = (label: string) =>
  api<CreatedKey>('/v1/api-keys/setup/login-key', { method: 'POST', body: { label } }, '');