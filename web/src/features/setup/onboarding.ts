/**
 * 首登引导状态机。
 *
 * 面板只有一个用户（机器主人），但「接入账号 → 创建访问密钥 → 验证链路」
 * 这三步是有先后顺序的一次性流程。原实现里创建完登录密钥就直接落进空总览，
 * 用户不知道下一步做什么，这三步也各自散落在不同页面。
 *
 * 这里把三步收敛成一个可订阅的状态：AppLayout 在顶部显示一条进度提示，
 * 全部完成后自动消失，不打扰日常使用。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { listAccessKeys } from '../../shared/api/apiKeys';
import { useAuth } from '../../shared/api/auth';
import { useSummaryStore } from '../../shared/api/SummaryProvider';
import { useAsyncData } from '../../shared/hooks/useAsyncData';

export interface OnboardingStep {
  id: 'account' | 'key' | 'verify';
  label: string;
  done: boolean;
  /** 完成这一步要去的路由 */
  path: string;
}

/** 连通性验证成功的标记位（TrafficPage 测试通过后写入）。 */
export const VERIFIED_FLAG = 'rg_verified';

export function markLinkVerified() {
  try {
    localStorage.setItem(VERIFIED_FLAG, '1');
  } catch {
    // 隐私模式下 localStorage 可能不可写：验证标记丢失不影响任何功能
  }
}

export function useOnboarding() {
  const { key } = useAuth();
  const { data: summary } = useSummaryStore();

  // 只在引导尚未完成时才拉访问密钥列表，完成后不再发这个请求
  const [needKeys, setNeedKeys] = useState(true);
  const keys = useAsyncData(
    (signal) => listAccessKeys(key, signal),
    [key],
    { enabled: !!key && needKeys },
  );

  const steps = useMemo<OnboardingStep[]>(() => {
    const hasAccount = (summary?.accounts?.length ?? 0) > 0;
    const hasKey = (keys.data?.data?.length ?? 0) > 0;
    let verified = false;
    try {
      verified = localStorage.getItem(VERIFIED_FLAG) === '1';
    } catch {
      verified = false;
    }
    return [
      { id: 'account', label: '接入第一个账号', done: hasAccount, path: '/credentials' },
      { id: 'key', label: '创建访问密钥', done: hasKey, path: '/access-keys' },
      { id: 'verify', label: '验证链路连通', done: verified, path: '/traffic' },
    ];
  }, [summary, keys.data]);

  const remaining = steps.filter((s) => !s.done).length;
  const next = steps.find((s) => !s.done) ?? null;

  // 全部完成后停止拉密钥列表，避免每次进面板都多一个请求
  const refresh = useCallback(() => {
    setNeedKeys(true);
    keys.reload();
  }, [keys]);

  useEffect(() => {
    if (remaining === 0) setNeedKeys(false);
  }, [remaining]);

  return { steps, remaining, next, refresh, loading: keys.loading };
}