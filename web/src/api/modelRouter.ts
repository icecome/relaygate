import { api } from '../lib/api';

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
  /** 候选侧真实上下文窗口（自动分层写入；null=未声明） */
  contextWindow?: number | null;
  promptMaxTokens?: number | null;
  maxOutputTokens?: number | null;
  /** 积分倍率（排序依据；null=未知） */
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
  /** 自动分层：候选由网关按目录窗口生成，面板只读候选、仅可禁用 */
  auto?: boolean;
  /** 候选自动排序：rate=倍率低优先 | window=窗口大优先 | null=按 priority */
  sort?: 'rate' | 'window' | null;
  /** 对外声明的上下文窗口（token）；取候选模型真实窗口的最小值，null=不设守门 */
  contextWindow?: number | null;
  candidates: RouterCandidate[];
  failover: {
    maxAttempts: number;
    switchOn: string[];
    cooldownMs: number;
  };
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

export const getRouterOverview = (key: string) =>
  api<RouterOverview>('/v1/admin/model-router/overview', {}, key);

export const upsertProvider = (id: string, body: Partial<RouterProvider>, key: string) =>
  api<{ data: RouterProvider }>(`/v1/admin/model-router/providers/${encodeURIComponent(id)}`, { method: 'PUT', body }, key);

export const deleteProvider = (id: string, key: string) =>
  api(`/v1/admin/model-router/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }, key);

export const upsertVirtual = (id: string, body: Partial<VirtualModel>, key: string) =>
  api<{ data: VirtualModel }>(`/v1/admin/model-router/virtual/${encodeURIComponent(id)}`, { method: 'PUT', body }, key);

export const deleteVirtual = (id: string, key: string) =>
  api(`/v1/admin/model-router/virtual/${encodeURIComponent(id)}`, { method: 'DELETE' }, key);

export const unfreezeVirtual = (id: string, key: string) =>
  api(`/v1/admin/model-router/virtual/${encodeURIComponent(id)}/unfreeze`, { method: 'POST', body: {} }, key);

export interface AutoTierSyncResult {
  ok: boolean;
  tiers: { id: string; candidates: number; declaredWindow: number; skipped?: string; error?: string }[];
  errors: string[];
}

export const resyncAutoTiers = (key: string) =>
  api<AutoTierSyncResult>('/v1/admin/model-router/virtual/resync-auto', { method: 'POST', body: {} }, key);

export interface ModelOption {
  id: string;
  label: string;
}

export const getAvailableModels = (key: string) =>
  api<{ data: Record<string, ModelOption[]> }>(`/v1/admin/model-router/available-models`, {}, key);
