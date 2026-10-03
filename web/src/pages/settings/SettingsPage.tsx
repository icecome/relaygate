import { Navigate, useParams } from 'react-router-dom';
import StatusPage from '../StatusPage';
import SettingsConfig from './SettingsConfig';
import SettingsNotify from './SettingsNotify';
import SettingsTasks from './SettingsTasks';

const TABS = ['run', 'tasks', 'notify', 'config'] as const;
type Tab = (typeof TABS)[number];

/** 设置页视图（运行状态由 StatusPage 承担，不在本组件内渲染）。 */
export type SettingsView = Exclude<Tab, 'run'>;

export default function SettingsPage() {
  const { tab } = useParams<{ tab: string }>();
  if (!tab || !TABS.includes(tab as Tab)) return <Navigate to="/settings/run" replace />;

  if (tab === 'run') return <StatusPage />;
  if (tab === 'tasks') return <SettingsTasks />;
  if (tab === 'notify') return <SettingsNotify />;
  return <SettingsConfig />;
}