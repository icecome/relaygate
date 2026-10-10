/**
 * 应用布局：左侧两级分组导航 + 顶栏 + 内容区。
 * 固定桌面布局，移动端断点见 global.css 的 @media 块。
 */
import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { NAV_GROUPS, navItemOf } from './nav';
import { useSummaryStore } from '../shared/api/SummaryProvider';
import { useOnboarding } from '../features/setup/onboarding';
import { Button } from '../shared/ui';

function Clock() {
  // 顶栏时钟独立组件：秒级刷新不会带动整页重渲染；
  // 窄屏下降为分钟粒度，避免在低端手机上每秒触发一次 React 提交。
  const [now, setNow] = useState<Date>(new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const fine = window.matchMedia('(min-width: 768px)').matches;
    const timer = setInterval(tick, fine ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, []);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    <span className="pill font-mono">
      {p(now.getHours())}:{p(now.getMinutes())}
      {window.matchMedia('(min-width: 768px)').matches ? `:${p(now.getSeconds())}` : ''}
    </span>
  );
}

/** 首登引导进度条：仅在还有未完成步骤时出现，完成后自动消失。 */
function OnboardingBar() {
  const navigate = useNavigate();
  const { steps, remaining, next } = useOnboarding();
  if (remaining === 0 || !next) return null;
  const done = steps.filter((s) => s.done).length;
  return (
    <div
      className="flex items-center justify-between gap-3 flex-wrap mb-4"
      style={{ background: 'var(--rg-brand-50)', border: '1px solid var(--rg-brand-200)' }}
    >
      <span className="text-[13px]" style={{ color: 'var(--rg-brand-900)' }}>
        首次使用还差 {remaining} 步，下一步：{next.label}
        <span className="ml-2 text-[12px]" style={{ color: 'var(--rg-brand-700)' }}>
          （已完成 {done}/{steps.length}）
        </span>
      </span>
      <Button size="sm" variant="primary" onClick={() => navigate(next.path)}>
        去完成
      </Button>
    </div>
  );
}

export default function AppLayout() {
  const location = useLocation();
  const current = navItemOf(location.pathname);
  const { data } = useSummaryStore();
  const [navOpen, setNavOpen] = useState(false);

  // 窄屏下侧栏默认收起：点击汉堡唤起，点遮罩或切页后关闭
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  const cooling = data?.cooling ?? 0;
  const enabled = data?.enabled ?? 0;

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      {/* 移动端汉堡按钮：仅窄屏显示（见 global.css @media） */}
      <button
        type="button"
        className="layout-menu-btn"
        aria-label={navOpen ? '关闭导航' : '打开导航'}
        aria-expanded={navOpen}
        onClick={() => setNavOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>

      {navOpen && (
        <div
          className="layout-nav-scrim"
          role="presentation"
          onClick={() => setNavOpen(false)}
        />
      )}

      <aside
        className={`layout-aside ${navOpen ? 'layout-aside-open' : ''}`}
        style={{ background: 'var(--rg-bg-secondary)', borderRight: '1px solid var(--rg-border)' }}
      >
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
                  end={item.to === '/' || item.to === '/ops' || item.to === '/audit'}
                  className="nav-item flex items-center h-8 px-2 rounded-md text-[13px] no-underline transition-colors"
                  style={({ isActive }) => ({
                    color: isActive ? 'var(--rg-brand-700)' : 'var(--rg-text-secondary)',
                    background: isActive ? 'var(--rg-brand-50)' : 'transparent',
                    fontWeight: isActive ? 600 : 400,
                  })}
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
            已启用 {enabled}
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
            <OnboardingBar />
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}