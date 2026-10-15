/**
 * 应用布局：左侧两级分组导航 + 顶栏 + 内容区。
 * 固定桌面布局，不做响应式断点。
 */
import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { NAV_GROUPS, navItemOf } from './nav';
import { useSummaryStore } from '../shared/api/SummaryProvider';

function Clock() {
  // 顶栏时钟独立组件：每秒定时更新，秒级刷新不会带动整页重渲染
  const [now, setNow] = useState<Date>(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    <span className="pill font-mono">
      {p(now.getHours())}:{p(now.getMinutes())}:{p(now.getSeconds())}
    </span>
  );
}

export default function AppLayout() {
  const location = useLocation();
  const current = navItemOf(location.pathname);
  const { data } = useSummaryStore();

  const cooling = data?.cooling ?? 0;
  const enabled = data?.enabled ?? 0;

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      <aside className="w-[216px] shrink-0 flex flex-col" style={{ background: 'var(--rg-bg-secondary)', borderRight: '1px solid var(--rg-border)' }}>
        <div className="px-4 py-4" style={{ borderBottom: '1px solid var(--rg-border)' }}>
          <span className="font-mono text-[13px] font-semibold tracking-wide">RELAYGATE</span>
        </div>

        <nav className="flex-1 overflow-y-auto py-2" aria-label="主导航">
          {NAV_GROUPS.map((group) => (
            <div key={group.id} className="px-2 pb-1">
              {group.items.length > 1 && (
                <div
                  className="px-2 pt-2.5 pb-1 text-[11px] font-semibold leading-4"
                  style={{ color: 'var(--rg-text-tertiary)' }}
                >
                  {group.label}
                </div>
              )}
              {group.items.map((item) => (
                <NavLink
                  key={item.id}
                  to={item.to}
                  end={item.to === '/' || item.to === '/ops'}
                  className="flex items-center h-8 px-2 rounded-md text-[13px] no-underline transition-colors"
                  style={({ isActive }) => ({
                    color: isActive ? 'var(--rg-brand-700)' : 'var(--rg-text-secondary)',
                    background: isActive ? 'var(--rg-brand-50)' : 'transparent',
                    fontWeight: isActive ? 600 : 400,
                  })}
                  onMouseEnter={(e) => {
                    if (!e.currentTarget.getAttribute('aria-current')) {
                      e.currentTarget.style.background = 'var(--rg-bg-tertiary)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!e.currentTarget.getAttribute('aria-current')) {
                      e.currentTarget.style.background = 'transparent';
                    }
                  }}
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="px-4 py-3" style={{ borderTop: '1px solid var(--rg-border)' }}>
          <span className="pill pill-ok">
            <i className="dot dot-ok" aria-hidden="true" />
            可用 {enabled}
            {cooling > 0 && <span style={{ color: 'var(--rg-state-warning)' }}>· 冷却 {cooling}</span>}
          </span>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header
          className="flex items-center justify-between gap-4 h-14 px-6 shrink-0 bg-white"
          style={{ borderBottom: '1px solid var(--rg-border)' }}
        >
          <span className="text-block">{current.label}</span>
          <Clock />
        </header>

        <main className="flex-1 overflow-y-auto bg-white">
          <div className="max-w-[1400px] mx-auto p-6 pb-14">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}