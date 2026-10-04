export class ApiError extends Error {
  status: number;
  type?: string;
  constructor(status: number, message: string, type?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
}

/**
 * 管理面鉴权失效的全局处置：清掉本地密钥并回到首登引导。
 * 由 api() 在收到 401（密钥无效/被删）时触发；各页面无需各自处理，
 * 未捕获的后续请求会因 key 为空而停止（见 useAuth 消费方）。
 */
function handleAuthLost(): void {
  const had = typeof sessionStorage !== 'undefined' && !!sessionStorage.getItem('trae_key');
  if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('trae_key');
  if (had) {
    // 触发应用级回退：App.tsx 监听该事件后重开 SetupGate
    window.dispatchEvent(new CustomEvent('relaygate:auth-lost'));
  }
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}, key: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const r = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const j = (await r.json()) as { error?: { message?: string; type?: string } };
      if (j?.error?.message) msg = j.error.message;
    } catch {
      /* body 非 JSON */
    }
    if (r.status === 401) handleAuthLost();
    throw new ApiError(r.status, msg);
  }
  return (await r.json()) as T;
}
