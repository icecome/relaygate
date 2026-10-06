/**
 * 余额自动轮询。
 *
 * 为什么需要主动轮询：/summary 与 /credentials 都是读数据库，而余额与权益包
 * 只有真正调用上游（refreshBalance）时才写入。只重新拉取页面数据读到的仍是
 * 旧值，数字不会变；因此轮询必须触发一次真实上游查询。
 *
 * 约束：
 *   - 仅在标签页可见时运行，页面隐藏即暂停，回到前台立即补一次；
 *   - 默认 60 秒一轮，避免高频打上游；
 *   - 后端批量接口受互斥锁保护，被占用时返回 202 并跳过，不产生并发请求；
 *   - 单轮失败只记录不抛，避免轮询因偶发网络问题整体中断。
 */
import { useEffect, useRef } from 'react';
import { refreshAllBalance } from '../api/credentials';

/** 默认轮询间隔（毫秒）。 */
export const BALANCE_POLL_MS = 60_000;

export function useBalanceAutoRefresh(
  apiKey: string | undefined,
  onRefreshed: () => void,
  intervalMs: number = BALANCE_POLL_MS,
): void {
  // 用 ref 固定回调与密钥，避免调用方每次渲染都重建定时器
  const cbRef = useRef(onRefreshed);
  cbRef.current = onRefreshed;
  const keyRef = useRef(apiKey);
  keyRef.current = apiKey;
  const runningRef = useRef(false);

  useEffect(() => {
    if (!apiKey) return;

    let timer: number | null = null;
    let cancelled = false;

    async function tick() {
      const key = keyRef.current;
      if (!key || cancelled || runningRef.current) return;
      // 页面不可见时不打上游：切回来时会立刻补一次
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      runningRef.current = true;
      try {
        await refreshAllBalance(key);
        if (!cancelled) cbRef.current();
      } catch {
        // 轮询失败静默重试：手动刷新按钮与页面数据仍可用
      } finally {
        runningRef.current = false;
      }
    }

    function schedule() {
      if (timer != null) window.clearInterval(timer);
      timer = window.setInterval(tick, intervalMs);
    }

    function onVisibility() {
      if (document.visibilityState === 'visible') {
        tick();
        schedule();
      }
    }

    // 打开页面即查一次，之后按间隔轮询
    tick();
    schedule();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [apiKey, intervalMs]);
}