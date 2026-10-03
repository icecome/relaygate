import { Navigate, useParams } from 'react-router-dom';
import TokenStats from './stats/TokenStats';
import CreditStats from './stats/CreditStats';
import ModelsSection from './stats/ModelsSection';
import LogsSection from './stats/LogsSection';

const TABS = ['token', 'credit', 'models', 'logs'] as const;
type Tab = (typeof TABS)[number];

export default function StatsPage() {
  const { tab } = useParams<{ tab: string }>();
  if (!tab || !TABS.includes(tab as Tab)) return <Navigate to="/stats/token" replace />;

  switch (tab as Tab) {
    case 'token':
      return <TokenStats />;
    case 'credit':
      return <CreditStats />;
    case 'models':
      return <ModelsSection />;
    case 'logs':
      return <LogsSection />;
  }
}
