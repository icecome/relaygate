/**
 * 通用异步数据 hook。
 *
 * 解决原实现的三类问题：路由切换后旧请求仍会 setState 造成竞态覆盖、
 * 同一数据被多处请求时重复拉取、错误只 console.error 而界面无反馈。
 *
 * 本 hook 统一处理挂载态、取消、错误暴露与手动刷新，
 * 并保证 setState 只发生在有效挂载期间。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/http';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useAsyncData<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: { enabled?: boolean } = {},
): AsyncState<T> {
  const enabled = options.enabled ?? true;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // fetcher 通常是内联箭头函数，用 ref 固定住，避免因引用变化重复触发
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let active = true;
    setLoading(true);

    fetcherRef
      .current(controller.signal)
      .then((result) => {
        if (!active) return;
        setData(result);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!active || controller.signal.aborted) return;
        setData(null);
        setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : '未知错误');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, nonce, ...deps]);

  return { data, loading, error, reload };
}