export interface ApiError {
  status: number;
  message: string;
  type?: string;
}

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
    throw new ApiError(r.status, msg);
  }
  return (await r.json()) as T;
}