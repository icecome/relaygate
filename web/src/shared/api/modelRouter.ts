/**
 * 模型路由接口（/v1/admin/model-router/*）。
 *
 * 字段与后端类型保持一致，未做改写。
 * 关键语义：auto=true 的虚拟模型候选由网关自动生成，
 * 面板只读候选、仅可禁用；健康度用于判断是否需要解冻。
 */
import { api } from './http';

export interface RouterProvider {
  id: string;
  type: 'builtin' | 'openai';
  builtin?: 'trae' | 'workbuddy' | null;
  label: string;
  enabled: boolean;
  baseUrl?: string | null;
  apiKeyEnv?: string | null;
  hasApiKey?: boolean;
  models?: string[] | null;
  timeoutMs?: number;
}

export interface RouterCandidate {
  id: string;
  provider: string;
  model: string;
  priority: number;
  weight: number;
  maxRpm?: number | null;
  enabled: boolean;
  /** 置顶：无视成本排名强制进入轮转池。 */
  pinned?: boolean;
  contextWindow?: number | null;
  promptMaxTokens?: number | null;
  maxOutputTokens?: number | null;
  rate?: number | null;
  providerType?: string | null;
  providerLabel?: string | null;
  usable?: boolean;
  reasons?: string[];
  cooldownRemainingMs?: number;
}

export interface VirtualModel {
  id: string;
  enabled: boolean;
  description: string;
  strategy: 'priority' | 'weighted';
  auto?: boolean;
  sort?: 'rate' | 'window' | null;
  /** 轮转池大小：取成本序前 N 个候选做加权轮转；0 表示关闭轮转，固定取首选。 */
  rotateTopN?: number;
  contextWindow?: number | null;
  candidates: RouterCandidate[];
  failover: { maxAttempts: number; switchOn: string[]; cooldownMs: number };
}

export interface HealthRow {
  virtualId: string;
  candidateId: string;
  ok: number;
  fail: number;
  successRate: number | null;
  avgLatencyMs: number | null;
  lastError: string | null;
  cooling: boolean;
  cooldownRemainingMs: number;
}

export interface RouterOverview {
  providers: RouterProvider[];
  virtualModels: VirtualModel[];
  health: HealthRow[];
}

export interface AutoTierSyncResult {
  ok: boolean;
  tiers: { id: string; candidates: number; declaredWindow: number; skipped?: string; error?: string }[];
  errors: string[];
}

export const getRouterOverview = (key: string, signal?: AbortSignal) =>
  api<RouterOverview>('/v1/admin/model-router/overview', { signal }, key);

export const upsertProvider = (id: string, body: Partial<RouterProvider>, key: string) =>
  api<{ data: RouterProvider }>(
    `/v1/admin/model-router/providers/${encodeURIComponent(id)}`,
    { method: 'PUT', body },
    key,
  );

export const deleteProvider = (id: string, key: string) =>
  api<unknown>(`/v1/admin/model-router/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }, key);

export const upsertVirtual = (id: string, body: Partial<VirtualModel>, key: string) =>
  api<{ data: VirtualModel }>(
    `/v1/admin/model-router/virtual/${encodeURIComponent(id)}`,
    { method: 'PUT', body },
    key,
  );

export const deleteVirtual = (id: string, key: string) =>
  api<unknown>(`/v1/admin/model-router/virtual/${encodeURIComponent(id)}`, { method: 'DELETE' }, key);

/**
 * 定点修改单个候选的开关，不整体回写候选列表。
 * 面板上的候选表是展开时的快照，整体 PUT 会用旧值覆盖并发改动。
 *
 * candidateId 走查询参数：候选 id 形如 `workbuddy/wb/hy3` 含斜杠，
 * 放进路径段即便 encodeURIComponent 也会被 Express 解码后重新切分，
 * 导致路由落到转发面鉴权、返回 401 并把面板误判为登录失效。
 */
export const patchCandidate = (
  virtualId: string,
  candidateId: string,
  body: { enabled?: boolean; pinned?: boolean },
  key: string,
) =>
  api<{ data: RouterCandidate }>(
    `/v1/admin/model-router/virtual/${encodeURIComponent(virtualId)}/candidate?candidateId=${encodeURIComponent(candidateId)}`,
    { method: 'PATCH', body },
    key,
  );

export const unfreezeVirtual = (id: string, key: string) =>
  api<unknown>(
    `/v1/admin/model-router/virtual/${encodeURIComponent(id)}/unfreeze`,
    { method: 'POST', body: {} },
    key,
  );

export const resyncAutoTiers = (key: string) =>
  api<AutoTierSyncResult>('/v1/admin/model-router/virtual/resync-auto', { method: 'POST', body: {} }, key);

export const reloadRouter = (key: string) =>
  api<{ ok: boolean; message?: string }>('/v1/admin/model-router/reload', { method: 'POST' }, key);

export const getRouteCheck = (id: string, key: string, signal?: AbortSignal) =>
  api<{ ok: boolean; message?: string; checkedAt?: string }>(
    `/v1/admin/model-router/route-check/${encodeURIComponent(id)}`,
    { signal },
    key,
  );

export const getAvailableModels = (key: string, signal?: AbortSignal) =>
  api<{ data: Record<string, { id: string; label: string }[]> }>(
    '/v1/admin/model-router/available-models',
    { signal },
    key,
  );