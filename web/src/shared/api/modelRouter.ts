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

/**
 * 删除 Provider（仅第三方 OpenAI 兼容端点；内置 trae/workbuddy 由后端拒绝）。
 * 后端会同时清掉引用该 Provider 的候选，避免留下悬空引用。
 */
export const deleteProvider = (id: string, key: string) =>
  api<{ object: string; id: string }>(
    `/v1/admin/model-router/providers/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    key,
  );

/**
 * 新增 / 编辑上游 Provider（后端 PUT /v1/admin/model-router/providers/:id）。
 *
 * ⚠️ 这个端点从 2026-10 起就在后端存在（routes/model-router.js:27），但面板一直
 * 没有写入口，只给「删除」——想接一个 OpenAI 兼容端点必须手改 model-router.json。
 *
 * ⚠️ 密钥不随这个请求入库：`store.normalizeProvider` 会强制剥离明文 `apiKey`
 * （M-S6 修复，见 store.js:100-110 的注释），运行时只从
 * `process.env[apiKeyEnv]` 取（dispatch.js#resolveApiKey）。
 * 所以这里提交的是**环境变量名**，值必须写进 .env 并重启进程。
 * 面板保存成功 ≠ 密钥可用；判定「密钥是否真的能解析」只能靠一次真实请求
 * （模型池页的「探测」，或 PUT 后看 dispatch 的 401）。
 *
 * @param id provider id（同 id 覆盖即编辑；内置 trae/workbuddy/raccoon 由后端保底）
 */
export const upsertProvider = (id: string, body: Partial<RouterProvider>, key: string) =>
  api<{ object: string; data: RouterProvider }>(
    `/v1/admin/model-router/providers/${encodeURIComponent(id)}`,
    { method: 'PUT', body },
    key,
  );

/**
 * 单虚拟模型的路由体检：不发送真实请求，只解释「此刻这一跳会落到谁」。
 *
 * 后端 GET /v1/admin/model-router/route-check/:id 返回 wouldPick / usableCount /
 * 逐候选 reasons / failover。这条接口是回答「路由为什么乱」的唯一正解，
 * 但面板此前零调用——用户只能自己展开候选表数 priority。
 *
 * 注意与 /v1/admin/route-check（账号池版本，无 :id）区分：那个解释的是
 * 「账号池会选哪个账号」，这个解释的是「虚拟模型会选哪个候选」。
 */
export interface VirtualRouteCheck {
  object: string;
  virtualModel: string;
  strategy: 'priority' | 'weighted';
  failover: { maxAttempts: number; switchOn: string[]; cooldownMs: number };
  wouldPick: RouterCandidate | null;
  usableCount: number;
  candidates: RouterCandidate[];
  generatedAt: string;
}

export const getVirtualRouteCheck = (id: string, key: string, signal?: AbortSignal) =>
  api<VirtualRouteCheck>(
    `/v1/admin/model-router/route-check/${encodeURIComponent(id)}`,
    { signal },
    key,
  );

export const upsertVirtual = (id: string, body: Partial<VirtualModel>, key: string) =>
  api<{ data: VirtualModel }>(
    `/v1/admin/model-router/virtual/${encodeURIComponent(id)}`,
    { method: 'PUT', body },
    key,
  );

export const deleteVirtual = (id: string, key: string) =>
  api<unknown>(`/v1/admin/model-router/virtual/${encodeURIComponent(id)}`, { method: 'DELETE' }, key);

/**
 * 定点修改单个候选的开关，不整体回写候选列表：面板上的候选表是展开时的快照，
 * 整体 PUT 会用旧值覆盖并发改动。
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

/**
 * 各 Provider 可选模型目录（新增/编辑虚拟模型时填充候选下拉）。
 * 返回 providerId -> 模型列表；openai 兼容 Provider 可能为空数组（允许手填）。
 */
export const getAvailableModels = (key: string, signal?: AbortSignal) =>
  api<{ data: Record<string, { id: string; label: string }[]> }>(
    '/v1/admin/model-router/available-models',
    { signal },
    key,
  );
