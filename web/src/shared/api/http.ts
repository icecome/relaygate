/**
 * HTTP 请求内核。
 *
 * 在 fetch 封装上补齐三项能力：AbortSignal 取消（路由切换时中止在途请求，避免竞态覆盖）、
 * 默认 30s 超时、同一 GET 在飞行中的并发请求复用同一个 Promise。
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
    super(0, `请求超时（${Math.round(ms / 1000)} 秒）`);
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

/**
 * GET 去重。
 *
 * ⚠️ 这里有一条必须遵守的约束：**不能把同一个可中止的 Promise 共享给
 * 不同调用方**。
 *
 * 原实现按 `${key}|${path}` 缓存飞行中的 Promise，但那个 Promise 绑定的是
 * 第一个调用方的 AbortSignal。于是出现这个可复现的症状：
 *   从总览切到凭据池 → 前一个页面的 useAsyncData 卸载时 abort →
 *   后一个订阅者拿到的是**已被中止**的那个 Promise → 页面显示「请求已取消」，
 *   刷新一次才正常。
 *
 * 修复：只在没有外部 AbortSignal 时才共享；带了 signal 的请求各自独立发。
 * 代价是并发同路径请求可能发两次（罕见），收益是「取消」绝不会串到别的组件。
 */
const inflight = new Map<string, Promise<unknown>>();

/** 该请求是否允许被去重复用。带 AbortSignal 的一律不共享。 */
function dedupeKey(path: string, key: string, opts: RequestOptions): string | null {
  if (opts.signal) return null;
  if (opts.dedupe === false) return null;
  // 超时时间不同的两次请求语义不同，不共享
  return `${key}|${path}|${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}`;
}

/**
 * 管理面鉴权失效的全局处置：清掉本地密钥并回到首登引导。
 * 由 http 层在收到 401 时触发，页面无需各自处理。
 * 统一走 auth.clearKey()：同时清 AUTH_STORE 与 sessionStorage，
 * 否则 store 里残留的 key 会继续被拼进 Authorization 头反复触发 401。
 *
 * 只在响应确实是「登录密钥无效」时才退出登录。
 * 转发面用的是另一类密钥（access key），管理面路由未命中时会落到转发面
 * 鉴权并返回 `Invalid access key. 请使用管理面创建的访问密钥……`——
 * 那是路由或凭据类型问题，不是登录过期。若一律退出登录，用户会被反复踢出，
 * 且真实原因（路径写错、用转发密钥访问管理面）会被掩盖成「登录失效」。
 */
function isLoginKeyRejection(status: number, type?: string, message?: string): boolean {
  if (status !== 401) return false;
  if (type === 'auth_error' && /invalid login key|missing login key/i.test(message || '')) return true;
  // 其余 401（转发面 access key 报错等）一律不退出登录
  return false;
}

function handleAuthLost(requestKey: string): void {
  // 会话密钥已前进时（如面板重置登录密钥后 setKey 到新明文），
  // 用旧密钥发出的在途请求必然收到 401。那是过期凭据的余波，不是登录失效；
  // 若照样清密钥并广播 auth-lost，刚生成的新明文会随组件卸载一起消失，
  // 用户被锁在面板外，只能回服务器重跑 CLI。
  if (requestKey && getKey() !== requestKey) return;
  const had = !!getKey();
  clearKey();
  if (had) {
    // App 层监听该事件后重开首登引导
    window.dispatchEvent(new CustomEvent('relaygate:auth-lost'));
  }
}

function buildSignal(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; done: () => void; getReason: () => unknown } {
  const controller = new AbortController();
  // 原因按请求局部持有：旧实现用模块级 lastAbortReason，并发请求 A 超时写入后，
  // 请求 B 的 catch 会读到 A 的原因，把「用户取消」误报成「请求超时」。
  let abortReason: unknown = null;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          const reason = new TimeoutError(timeoutMs);
          abortReason = reason;
          controller.abort(reason);
        }, timeoutMs)
      : null;
  const onExternalAbort = () => {
    abortReason = external?.reason ?? new ApiError(0, '请求已取消');
    controller.abort(abortReason);
  };
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  return {
    signal: controller.signal,
    getReason: () => abortReason,
    done: () => {
      if (timer) clearTimeout(timer);
      if (external) external.removeEventListener('abort', onExternalAbort);
    },
  };
}

/**
 * AbortController.abort(reason) 在部分环境抛出的仍是裸 AbortError，
 * 这里依据 buildSignal 局部记录的原因还原成 TimeoutError /取消错误，
 * 使上层能区分二者。
 */
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
  const { signal, done, getReason } = buildSignal(timeoutMs, opts.signal);

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
      if (isLoginKeyRejection(r.status, type, msg)) handleAuthLost(key);
      throw new ApiError(r.status, msg, type, details);
    }

    if (r.status === 204) return undefined as T;
    return (await r.json()) as T;
  } catch (e) {
      // 超时 abort 会带上 TimeoutError 原因，外部取消则是裸 AbortError
      if ((e as { name?: string } | null)?.name === 'AbortError') {
        throw reasonToError(getReason(), timeoutMs);
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

  // 仅对幂等 GET 去重；带外部 AbortSignal 的请求不参与共享（见 dedupeKey 说明）
  if (method !== 'GET') {
    return rawRequest<T>(path, opts, key);
  }

  const cacheKey = dedupeKey(path, key, opts);
  if (cacheKey == null) {
    return rawRequest<T>(path, opts, key);
  }

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