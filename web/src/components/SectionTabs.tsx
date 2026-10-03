import { NavLink, useLocation } from 'react-router-dom';
import { groupOf, childOf, tabPath } from '../lib/nav';

/**
 * 顶部分段标签：一级栏目内的子栏切换。
 * 用 tablist 语义，方向键 / Home / End 在标签间移动焦点。
 */
export default function SectionTabs() {
  const { pathname } = useLocation();
  const group = groupOf(pathname);
  const active = childOf(pathname, group);

  if (!group.children.length) return null;

  const tabs = group.children.map((c) => ({ ...c, to: tabPath(group, c.seg) }));

  /** 焦点移动到相邻标签（不改变激活项，符合 tablist 键盘惯例） */
  const move = (e: React.KeyboardEvent, i: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const el = e.currentTarget.parentElement?.children[next] as HTMLElement | undefined;
    el?.focus();
  };

  return (
    <div className="sticky top-0 z-20 shrink-0 bg-surf border-b border-line">
      <div className="max-w-[1200px] mx-auto px-6 py-2.5">
        <div className="seg-track" role="tablist" aria-label={`${group.label}子栏目`}>
          {tabs.map((t, i) => (
            <NavLink
              key={t.seg}
              to={t.to}
              role="tab"
              aria-selected={active === t.seg}
              tabIndex={active === t.seg ? 0 : -1}
              onKeyDown={(e) => move(e, i)}
              className="seg-tab"
            >
              {t.label}
            </NavLink>
          ))}
        </div>
      </div>
    </div>
  );
}
