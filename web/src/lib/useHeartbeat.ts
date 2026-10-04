import { useEffect, useRef } from 'react';

/**
 * 可见性感知的周期刷新（对齐 workbuddy-manager 的 useHeartbeat）：
 * - 页面可见时按 intervalMs 周期触发 callback；
 * - document.hidden 期间暂停，切回前台立即触发一次；
 * - callback 变化不重启定时器（用 ref 持有最新回调）。
 */
export default function useHeartbeat(callback: () => void, intervalMs: number | null) {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    if (intervalMs == null || intervalMs <= 0) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => cbRef.current(), intervalMs);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        cbRef.current(); // 切回立即刷一次，不等下一个周期
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs]);
}
