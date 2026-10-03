import { Navigate, useParams } from 'react-router-dom';
import Settings from '../Settings';
import StatusPage from '../StatusPage';

const TABS = ['run', 'tasks', 'notify', 'config'] as const;
type Tab = (typeof TABS)[number];

export default function SettingsPage() {
  const { tab } = useParams<{ tab: string }>();
  if (!tab || !TABS.includes(tab as Tab)) return <Navigate to="/settings/run" replace />;

  if (tab === 'run') return <StatusPage />;
  return <Settings view={tab as 'tasks' | 'notify' | 'config'} />;
}
