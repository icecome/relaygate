/**
 * SummaryProvider：凭据池汇总的单一数据源。
 *
 * 原实现里 `/summary` 被多个组件各自 useSummary() 拉取，
 * 同一页面可能触发多次重复请求。这里改为 Context 单例：
 * 整棵树只发起一次请求，页面按需订阅。
 *
 * 同时提供按 edition 过滤的派生函数，派生值不落 state。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getSummary } from '../api/credentials';
import type { Account, Summary } from './types';
import { ApiError } from './http';
import { useAuth } from './auth';

export type EditionFilter = 'trae' | 'workbuddy' | 'all';

export interface SummaryContextValue {
  data: Summary | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  /** 按 edition 过滤账号，派生值不缓存进 state */
  accountsOf: (edition: EditionFilter) => Account[];
}

const SummaryContext = createContext<SummaryContextValue | null>(null);

/** 账号 edition 归类：workbuddy 系与 trae 系，其余归 trae。 */
function editionOf(account: Account): 'trae' | 'workbuddy' {
  const raw = String(account.edition || account.source || '');
  return raw === 'workbuddy' || raw.startsWith('wb') ? 'workbuddy' : 'trae';
}

export function SummaryProvider({ children }: { children: ReactNode }) {
  const { key } = useAuth();
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!key) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    // 新一轮请求先中止上一轮，避免慢响应覆盖新数据
    abortRef.current?.abort();
    abortRef.current = controller;

    setLoading(true);
    getSummary(controller.signal, key)
      .then((next) => {
        if (controller.signal.aborted) return;
        setData(next);
        setError(null);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setData(null);
        setError(e instanceof ApiError ? e.message : '汇总数据加载失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [key, nonce]);

  const accountsOf = useCallback(
    (edition: EditionFilter): Account[] => {
      const list = data?.accounts;
      if (!list) return [];
      if (edition === 'all') return list;
      return list.filter((a: Account) => editionOf(a) === edition);
    },
    [data],
  );

  const value = useMemo<SummaryContextValue>(
    () => ({ data, loading, error, reload, accountsOf }),
    [data, loading, error, reload, accountsOf],
  );

  return <SummaryContext.Provider value={value}>{children}</SummaryContext.Provider>;
}

export function useSummaryStore(): SummaryContextValue {
  const ctx = useContext(SummaryContext);
  if (!ctx) throw new Error('useSummaryStore 必须在 SummaryProvider 内使用');
  return ctx;
}
