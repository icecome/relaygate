/**
 * 应用布局：左侧分组导航 + 顶栏（面包屑 / 命令框）+ 内容区。
 *
 * ## 相对上一版的变更（对齐参考实现的顶栏结构）
 *
 * | 位置 | 上一版 | 现在 | 理由 |
 * |---|---|---|---|
 * | 顶栏左 | 只有页面名（`text-block`） | `工作空间 › 页面名` 面包屑 | 页面名在侧栏已有高亮，顶栏重复一遍等于浪费 14px 高的主位 |
 * | 顶栏右 | 秒级时钟 | 命令框（`Ctrl K`）+ 时钟 | 16 个导航项，找页面比看时间频繁得多 |
 * | 侧栏底 | 只有「可用 N · 冷却 M」 | 可用/冷却 + 版本号 | 查 changelog 前先要知道自己跑的是哪一版；`__APP_VERSION__` 早就在 `vite.config.ts` 注入，全仓零引用 |
 *
 * 时钟保留但降级为次要：它在排障时有用（对日志时间戳），但没有资格占右上一整块。
 *
 * ## 为什么侧栏不做收起态
 *
 * 这是桌面常驻运维界面（`layout-aside` 固定 216px），表格按 1366 宽度调过列宽。
 * 加收起态会让表格宽度在两档之间跳，`table-fixed` 的列宽表要维护两套。
 * 参考实现也不做（它是 Electron 主窗口，宽度稳定）。真正拥挤时靠表格自身
 * 横向滚动兜底，见 `global.css` 的 `.table-wrap` 注释。
 */
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { NAV_GROUPS, navItemOf } from './nav';
import { useSummaryStore } from '../shared/api/SummaryProvider';
import { CommandMenu } from './CommandMenu';

/** 快捷键提示随平台变化：macOS 用 ⌘，其余用 Ctrl。 */
function shortcutLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl K';
  return /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
}

function Clock() {
  // 顶栏时钟独立组件：每秒定时更新，秒级刷新不会带动整页重渲染
  const [now, setNow] = useState<Date>(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    <span className="pill font-mono" title="本机时间；对日志时间戳用">
      {p(now.getHours())}:{p(now.getMinutes())}:{p(now.getSeconds())}
    </span>
  );
}

/** 当前页面所属分组名（面包屑的第一段）。 */
function groupLabelOf(pathname: string): string {
  const item = navItemOf(pathname);
  const group = NAV_GROUPS.find((g) => g.items.some((i) => i.id === item.id));
  return group?.label ?? '工作空间';
}

export default function AppLayout() {
  const location = useLocation();
  const current = navItemOf(location.pathname);
  const { data } = useSummaryStore();
  const [commandOpen, setCommandOpen] = useState(false);

  const cooling = data?.cooling ?? 0;
  const enabled = data?.enabled ?? 0;
  const total = data?.total ?? 0;
  const shortcut = shortcutLabel();

  /**
   * 全局快捷键：Ctrl/⌘ + K 打开命令面板。
   *
   * 用 `e.key.toLowerCase() === 'k'` 而不是 `e.code`：后者在小键盘/IME 下
   * 行为不一致；同时要求无其他修饰键，避免与浏览器自带的 Ctrl+Shift+K 冲突。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--rg-bg-base)]">
      <aside
        className="layout-aside"
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
                  className="px-2 pt-2.5 pb-1 text-aux font-semibold"
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
                  // 悬停交给 CSS：此前用 onMouseEnter/Leave 逐帧改 style.background，
                  // 会与 NavLink 的 style 回调互相覆盖，切页后残留高亮。
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

        <div
          className="px-4 py-3 flex flex-col gap-2"
          style={{ borderTop: '1px solid var(--rg-border)' }}
        >
          <span className="pill pill-ok">
            <i className="dot dot-ok" aria-hidden="true" />
            可用 {enabled}
            {cooling > 0 && <span style={{ color: 'var(--rg-state-warning)' }}>· 冷却 {cooling}</span>}
          </span>
          <div
            className="flex items-center justify-between text-aux font-mono"
            style={{ color: 'var(--rg-text-tertiary)' }}
          >
            <span>RelayGate</span>
            {/* 版本号来自 vite.config.ts 的 __APP_VERSION__（根 package.json） */}
            <span>v{__APP_VERSION__}</span>
          </div>
          {total > 0 && (
            <span className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
              共 {total} 个账号
            </span>
          )}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header
          className="flex items-center justify-between gap-4 h-14 px-6 shrink-0 bg-[var(--rg-bg-base)]"
          style={{ borderBottom: '1px solid var(--rg-border)' }}
        >
          {/* 面包屑：分组 → 当前页。分组名从 nav.ts 派生，不另维护一份 */}
          <div className="flex items-center gap-2 min-w-0 text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
            <span className="shrink-0">{groupLabelOf(location.pathname)}</span>
            <span aria-hidden="true">›</span>
            <strong className="text-[13px] font-semibold truncate" style={{ color: 'var(--rg-text-primary)' }}>
              {current.label}
            </strong>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              className="flex items-center gap-2 h-8 px-2.5 rounded-md border text-aux cursor-pointer"
              style={{
                borderColor: 'var(--rg-border-strong)',
                background: 'var(--rg-bg-base)',
                color: 'var(--rg-text-tertiary)',
                width: 220,
              }}
              onClick={() => setCommandOpen(true)}
              aria-label={`搜索页面与账号（${shortcut}）`}
            >
              <span className="truncate">搜索页面和账号…</span>
              <kbd className="ml-auto font-mono text-[11px] whitespace-nowrap">{shortcut}</kbd>
            </button>
            <Clock />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto bg-[var(--rg-bg-base)]">
          <div className="max-w-[1400px] mx-auto p-6 pb-14">
            <Outlet />
          </div>
        </main>
      </div>

      <CommandMenu open={commandOpen} onClose={() => setCommandOpen(false)} />
    </div>
  );
}
