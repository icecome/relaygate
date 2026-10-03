import { NavLink, useLocation } from 'react-router-dom';
import { NAV, groupOf } from '../lib/nav';

/** 内嵌品牌图标：简洁正形勾选（不使用渐变底） */
function BrandLogo() {
  return (
    <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" fill="none" aria-hidden="true">
      <rect x="4.6" y="5.2" width="14.8" height="15.6" rx="2.5" stroke="#fff" strokeWidth="1.6" />
      <path d="m8.5 13.4 2.4 2.4 4.6-4.8" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Sidebar() {
  const { pathname } = useLocation();
  const current = groupOf(pathname);

  return (
    <aside className="w-52 shrink-0 bg-surf border-r border-line flex flex-col">
      {/* 品牌区：克制，仅一个深绿方块 logo */}
      <div className="flex items-center gap-2.5 px-3 pt-5 pb-4">
        <div className="w-7 h-7 shrink-0 rounded-md bg-acc flex items-center justify-center">
          <BrandLogo />
        </div>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold tracking-tight text-ink leading-none">RelayGate</div>
          <div className="text-[11px] text-ink-faint mt-0.5">多平台账号池</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        <div className="flex flex-col gap-0.5">
          {NAV.map((g) => (
            <NavLink
              key={g.id}
              to={g.path}
              className={`px-3 py-1.5 rounded-md text-[13px] transition-colors ${
                current.id === g.id
                  ? 'bg-acc-soft text-[#065F46] font-medium'
                  : 'text-ink-soft hover:bg-surf-soft hover:text-ink'
              }`}
            >
              {g.label}
            </NavLink>
          ))}
        </div>
      </nav>

      <div className="px-5 py-3 border-t border-line text-[11px] text-ink-faint">v3.0</div>
    </aside>
  );
}
