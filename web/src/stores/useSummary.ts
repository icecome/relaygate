import { useEffect, useMemo, useState, useCallback } from 'react';
import { useAuth } from './useAuth';
import { getSummary } from '../api/trae';
import type { Account, Summary } from '../api/types';

export interface SummaryStore {
  data: Summary | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** 按 edition 过滤账号（trae 系 / workbuddy） */
  accountsOf: (edition: 'trae' | 'workbuddy' | 'all') => Account[];
}

export function useSummary(): SummaryStore {
  const { key } = useAuth();
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!key) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    getSummary(key)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => {
        if (!alive) return;
        setData(null);
        setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [key, tick]);

  const accountsOf = useCallback(
    (edition: 'trae' | 'workbuddy' | 'all') => {
      if (!data?.accounts) return [];
      if (edition === 'all') return data.accounts;
      const target = edition === 'workbuddy' ? 'workbuddy' : 'trae';
      return data.accounts.filter((a) => {
        const e = String(a.edition || a.source || '');
        if (target === 'workbuddy') return e === 'workbuddy' || e.startsWith('wb');
        return e !== 'workbuddy' && !e.startsWith('wb');
      });
    },
    [data],
  );

  return useMemo(
    () => ({ data, loading, error, refresh, accountsOf }),
    [data, loading, error, refresh, accountsOf],
  );
}