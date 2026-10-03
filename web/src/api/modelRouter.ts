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

export interface ModelOption {
  id: string;
  label: string;
}

export const getAvailableModels = (key: string) =>
  api<{ data: Record<string, ModelOption[]> }>(`/v1/admin/model-router/available-models`, {}, key);
