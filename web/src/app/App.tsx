/**
 * 应用入口：全局 Provider、首登引导、路由表。
 *
 * 路由级代码分割：各功能页按需加载，首屏只下载总览所需代码。
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './AppLayout';
import { SummaryProvider } from '../shared/api/SummaryProvider';
import { useAuth } from '../shared/api/auth';
import { ToastProvider } from '../shared/ui/Toast';
import { PromptProvider } from '../shared/ui/Prompt';
import SetupGate from '../features/setup/SetupGate';
import { LoadingBlock } from '../shared/ui';

const Overview = lazy(() => import('../features/overview/OverviewPage'));
const Credentials = lazy(() => import('../features/accounts/CredentialsPage'));
const AccessKeys = lazy(() => import('../features/accounts/AccessKeysPage'));
const ModelRouter = lazy(() => import('../features/models/ModelRouterPage'));
const ModelPool = lazy(() => import('../features/models/ModelPoolPage'));
const TokenStats = lazy(() => import('../features/stats/TokenStatsPage'));
const Traffic = lazy(() => import('../features/stats/TrafficPage'));
const Ops = lazy(() => import('../features/ops/OpsPage'));

function RouteFallback() {
  return <LoadingBlock label="加载模块" />;
}

export default function App() {
  const { key } = useAuth();
  // 有本地会话即视为已登录，避免首屏闪现引导页；
  // 401 事件会把 key 清空，届时自动回落到引导页。
  const [authLost, setAuthLost] = useState(false);
  const setupDone = !!key && !authLost;

  // 管理面任意请求收到 401（密钥失效/被删）时回到首登引导；
  // 事件由 shared/api/http.ts 全局分支发出，页面无需各自处理。
  useEffect(() => {
    if (key) setAuthLost(false);
  }, [key]);

  useEffect(() => {
    const onAuthLost = () => setAuthLost(true);
    window.addEventListener('relaygate:auth-lost', onAuthLost);
    return () => window.removeEventListener('relaygate:auth-lost', onAuthLost);
  }, []);

  return (
    <ToastProvider>
      <PromptProvider>
        <SummaryProvider>
          {!setupDone && (
            <SetupGate
              onReady={() => {
                // setKey 已写入 sessionStorage，auth store 会同步更新 key，
                // setupDone 随之派生为 true，无需整页刷新
                setAuthLost(false);
              }}
            />
          )}
          {setupDone && (
            <Routes>
              <Route element={<AppLayout />}>
                <Route
                  path="/"
                  element={
                    <Suspense fallback={<RouteFallback />}>
                      <Overview />
                    </Suspense>
                  }
                />
                <Route
                  path="/credentials"
                  element={
                    <Suspense fallback={<RouteFallback />}>
                      <Credentials />
                    </Suspense>
                  }
                />
                <Route
                  path="/access-keys"
                  element={
                    <Suspense fallback={<RouteFallback />}>
                      <AccessKeys />
                    </Suspense>
                  }
                />
                <Route
                  path="/model-router"
                  element={
                    <Suspense fallback={<RouteFallback />}>
                      <ModelRouter />
                    </Suspense>
                  }
                />
                <Route
                  path="/model-pool"
                  element={
                    <Suspense fallback={<RouteFallback />}>
                      <ModelPool />
                    </Suspense>
                  }
                />
                <Route
                  path="/token-stats"
                  element={
                    <Suspense fallback={<RouteFallback />}>
                      <TokenStats />
                    </Suspense>
                  }
                />
                <Route
                  path="/traffic"
                  element={
                    <Suspense fallback={<RouteFallback />}>
                      <Traffic />
                    </Suspense>
                  }
                />
                <Route
                  path="/ops/*"
                  element={
                    <Suspense fallback={<RouteFallback />}>
                      <Ops />
                    </Suspense>
                  }
                />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          )}
        </SummaryProvider>
      </PromptProvider>
    </ToastProvider>
  );
}