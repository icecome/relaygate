import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import { ToastProvider } from './components/Toast';
import { PromptProvider } from './components/Prompt';
import SetupGate from './components/SetupGate';
import Overview from './pages/Overview';
import AccountsPage from './pages/AccountsPage';
import StatsPage from './pages/StatsPage';
import SettingsPage from './pages/settings/SettingsPage';

export default function App() {
  const [setupDone, setSetupDone] = useState(false);

  // 管理面任意请求收到 401（密钥失效/被删）时回到首登引导；
  // 事件由 lib/api.ts 的全局分支发出，页面无需各自处理。
  useEffect(() => {
    const onAuthLost = () => setSetupDone(false);
    window.addEventListener('relaygate:auth-lost', onAuthLost);
    return () => window.removeEventListener('relaygate:auth-lost', onAuthLost);
  }, []);

  return (
    <ToastProvider>
      <PromptProvider>
        {!setupDone && <SetupGate onReady={() => setSetupDone(true)} />}
        {setupDone && (
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<Overview />} />
              {/* 子栏为真实 URL：可分享、可前进后退、刷新保持 */}
              <Route path="/accounts" element={<Navigate to="/accounts/all" replace />} />
              <Route path="/accounts/:tab" element={<AccountsPage />} />
              <Route path="/stats" element={<Navigate to="/stats/token" replace />} />
              <Route path="/stats/:tab" element={<StatsPage />} />
              <Route path="/settings" element={<Navigate to="/settings/run" replace />} />
              <Route path="/settings/:tab" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        )}
      </PromptProvider>
    </ToastProvider>
  );
}
