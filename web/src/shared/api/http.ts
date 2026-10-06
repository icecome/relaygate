/**
 * HTTP 请求内核。
 *
 * 在原有 fetch 封装上补齐三件此前缺失的能力：
 *   1. 取消：调用方可传 AbortSignal，路由切换时中止在途请求，避免竞态覆盖；
 *   2. 超时：默认 30s，避免慢响应挂死页面；
 *   3. 去重：同一 GET 在飞行中的并发请求复用同一个 Promise。
 *
 * 错误模型保留后端返回的 code / type / message / details，
 * 使调用方能区分「请求异常」与「业务层失败」两类问题。
 */

import { clearKey, getKey } from './auth';

export class ApiError extends Error {
  readonly status: number;
  readonly type?: string;
  readonly details?: unknown;

  constructor(status: number, message: string, type?: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
    this.details = details;
  }

  /** 请求根本没拿到业务响应（网络中断、超时、被取消）。 */
  get isTransport(): boolean {
    return this.status === 0;
  }
}

export class TimeoutError extends ApiError {
  constructor(ms: number) {
    super(0, `请求超时（${Math.round(ms / 1000)}s）`);
    this.name = 'TimeoutError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** 外部取消信号，与内部超时信号合并 */
  signal?: AbortSignal;
  /** 覆盖默认超时（毫秒），0 表示不超时 */
  timeoutMs?: number;
  /** 关闭同请求去重，用于确实需要并发多次的写操作 */
  dedupe?: boolean;
}

export interface ApiEnvelope {
  error?: { message?: string; type?: string; code?: string; details?: unknown };
  message?: string;
  code?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** key -> 飞行中的 Promise，用于 GET 去重。 */
const inflight = new Map<string, Promise<unknown>>();

/**
 * 管理面鉴权失效的全局处置：清掉本地密钥并回到首登引导。
 * 由 http 层在收到 401 时触发，页面无需各自处理。
 * 统一走 auth.clearKey()：同时清 AUTH_STORE 与 sessionStorage，
 * 否则 store 里残留的 key 会继续被拼进 Authorization 头反复触发 401。
 */
function handleAuthLost(): void {
  const had = !!getKey();
  clearKey();
  if (had) {
    // App 层监听该事件后重开首登引导
    window.dispatchEvent(new CustomEvent('relaygate:auth-lost'));
  }
}

function buildSignal(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          const reason = new TimeoutError(timeoutMs);
          lastAbortReason = reason;
          controller.abort(reason);
        }, timeoutMs)
      : null;
  const onExternalAbort = () => {
    lastAbortReason = external?.reason ?? new ApiError(0, '请求已取消');
    controller.abort(lastAbortReason);
  };
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      if (timer) clearTimeout(timer);
      if (external) external.removeEventListener('abort', onExternalAbort);
    },
  };
}

/**
 * AbortController.abort(reason) 在部分环境抛出的仍是裸 AbortError，
 * 这里依据记录的原因还原成 TimeoutError /取消错误，使上层能区分二者。
 */
let lastAbortReason: unknown = null;

function reasonToError(reason: unknown, timeoutMs: number): ApiError {
  if (reason instanceof ApiError) return reason;
  if (reason instanceof Error && reason.name === 'TimeoutError') {
    return new TimeoutError(timeoutMs);
  }
  return new ApiError(0, '请求已取消');
}

/** 把 DOM 异常统一转成 ApiError。 */
function toTransportError(reason: unknown): ApiError {
  if (reason instanceof ApiError) return reason;
  const name = (reason as { name?: string } | null)?.name;
  if (name === 'AbortError') return new ApiError(0, '请求已取消');
  return new ApiError(0, reason instanceof Error ? reason.message : '网络异常');
}

async function rawRequest<T>(path: string, opts: RequestOptions, key: string): Promise<T> {
  const { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  lastAbortReason = null;
  const { signal, done } = buildSignal(timeoutMs, opts.signal);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;

  try {
    const r = await fetch(path, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal,
    });

    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      let type: string | undefined;
      let details: unknown;
      try {
        const payload = (await r.json()) as ApiEnvelope;
        const err = payload?.error;
        if (err?.message) msg = err.message;
        type = err?.type ?? payload?.code;
        details = err?.details;
      } catch {
        // 响应体非 JSON，保留 HTTP 状态码作为信息
      }
      if (r.status === 401) handleAuthLost();
      throw new ApiError(r.status, msg, type, details);
    }

    if (r.status === 204) return undefined as T;
    return (await r.json()) as T;
  } catch (e) {
      // 超时 abort 会带上 TimeoutError 原因，外部取消则是裸 AbortError
      if ((e as { name?: string } | null)?.name === 'AbortError') {
        throw reasonToError(lastAbortReason, timeoutMs);
      }
      if (e instanceof ApiError) throw e;
      throw toTransportError(e);
    } finally {
      done();
    }
}

export async function api<T = unknown>(
  path: string,
  opts: RequestOptions = {},
  key: string,
): Promise<T> {
  const method = opts.method || 'GET';

  // 仅对幂等 GET 去重：同一时刻的相同请求复用结果
  if (method !== 'GET' || opts.dedupe === false) {
    return rawRequest<T>(path, opts, key);
  }

  const cacheKey = `${key}|${path}`;
  const existing = inflight.get(cacheKey);
  if (existing) return existing as Promise<T>;

  const p = rawRequest<T>(path, opts, key).finally(() => {
    inflight.delete(cacheKey);
  });
  inflight.set(cacheKey, p);
  return p;
}

/**
 * 业务层失败判定：HTTP 成功，但响应体 ok 为 false。
 * 后端轮换、模型保存等接口会这样返回，不能一律当异常处理。
 */
export function isBusinessFailure(payload: unknown): payload is { ok: false; reason?: string } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { ok?: unknown }).ok === false
  );
}

/** 取出业务层失败的原因文案，无原因时回退到通用提示。 */
export function businessFailureReason(payload: unknown, fallback = '操作未成功'): string {
  if (typeof payload !== 'object' || payload === null) return fallback;
  const p = payload as { reason?: unknown; message?: unknown; msg?: unknown };
  const candidate = p.reason ?? p.message ?? p.msg;
  return typeof candidate === 'string' && candidate ? candidate : fallback;
}