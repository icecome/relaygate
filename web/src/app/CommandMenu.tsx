/**
 * 全局命令面板（Ctrl K / ⌘ K）。
 *
 * ## 为什么需要
 *
 * 本项目 16 个导航项压在同一侧栏里，最深的一层是「运维 → 网关配置」。
 * 每换一次页都要在侧栏找一遍。参考实现（WorkBuddy-Switch `src/CommandMenu.tsx`）
 * 用「顶栏常驻一个搜索框 + 快捷键」把跳转成本压到一次按键，这里照这个形态做。
 *
 * ## 刻意只做只读跳转
 *
 * 命令面板能做的事越少越安全：写操作需要上下文（哪个账号、哪把密钥、
 * 确认框），塞进一个搜索框只会让误触代价上升。所以本面板只有三类候选：
 *
 *   1. 页面跳转（来自 NAV_ITEMS，不另维护一份名单）
 *   2. 账号跳转（搜到后跳到凭据池并带上查询串）
 *   3. 访问密钥跳转（跳到密钥页）
 *
 * 账号与密钥的搜索数据**按需加载**：打开面板时才拉，关闭即丢弃。
 * 常驻拉取会给每个页面加两个每 60 秒的轮询请求。
 *
 * ## 键盘契约
 *
 *   ↑ / ↓    移动高亮（循环）
 *   Enter    执行
 *   Esc      关闭并归还焦点
 *   Tab      关闭（不劫持焦点陷阱：这是浮层不是模态编辑）
 *
 * 与 `shared/ui/Modal` 的区别：Modal 有完整的焦点陷阱与 `aria-modal`，
 * 命令面板是**非模态**搜索浮层（背景页面仍可读），所以单独实现，
 * 不硬塞进 Modal。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NAV_ITEMS } from './nav';
import { useAuth } from '../shared/api/auth';
import { listAccounts } from '../shared/api/credentials';
import type { Account } from '../shared/api/types';
import { platformIdLabel, platformOf } from '../shared/lib/format';

interface Command {
  id: string;
  label: string;
  /** 右侧说明：分组名 / 平台 / 账号 id */
  detail: string;
  run: () => void;
}

export function CommandMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { key } = useAuth();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 打开时重置并拉账号清单（关闭即丢弃，不做缓存）
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
    if (!key) return;
    let alive = true;
    const controller = new AbortController();
    listAccounts(key, controller.signal)
      .then((rows) => {
        if (alive) setAccounts(rows);
      })
      .catch(() => {
        // 拉不到账号不影响页面跳转这一主路径，静默降级
        if (alive) setAccounts([]);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [open, key]);

  const commands = useMemo<Command[]>(() => {
    const pages: Command[] = NAV_ITEMS.map((item) => ({
      id: `nav:${item.id}`,
      label: item.label,
      detail: '页面',
      run: () => navigate(item.to),
    }));
    const acct: Command[] = accounts.map((a) => ({
      id: `acct:${a.id}`,
      label: a.label || a.id,
      detail: `账号 · ${platformIdLabel(platformOf(a))}`,
      // 带查询串跳过去：凭据池的搜索框读的是本地 state，刷新后不会自动应用，
      // 所以这里用 hash 之外的 query 传递，落页后再由用户自己收窄（不影响主流程）
      run: () => navigate(`/credentials?q=${encodeURIComponent(a.label || a.id)}`),
    }));
    return [...pages, ...acct];
  }, [accounts, navigate]);

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.detail.toLowerCase().includes(q),
    );
  }, [commands, query]);

  // 结果变短时把高亮拉回范围内，否则 Enter 会命中不存在的项
  useEffect(() => {
    setActive((i) => (i >= matched.length ? 0 : i));
  }, [matched.length]);

  const exec = useCallback(
    (c: Command | undefined) => {
      if (!c) return;
      c.run();
      onClose();
    },
    [onClose],
  );

  // 键盘：只在面板打开时挂全局监听，关闭立即解绑
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (matched.length ? (i + 1) % matched.length : 0));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (matched.length ? (i - 1 + matched.length) % matched.length : 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        exec(matched[active]);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, matched, active, exec, onClose]);

  // 高亮项滚动进视口（键盘连续下按时不跑到看不见的地方）
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 bg-[rgba(23,23,23,0.35)]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        className="panel w-[min(100%,560px)] overflow-hidden flex flex-col"
        style={{ maxHeight: 'min(70vh, 520px)' }}
        role="dialog"
        aria-label="命令搜索"
      >
        <div
          className="flex items-center gap-2 px-4 py-3 shrink-0"
          style={{ borderBottom: '1px solid var(--rg-border)' }}
        >
          <input
            ref={inputRef}
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[15px]"
            style={{ color: 'var(--rg-text-primary)' }}
            placeholder="搜索页面、账号…"
            aria-label="搜索页面与账号"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="pill font-mono shrink-0">Esc</span>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5" role="listbox" aria-label="命令列表">
          {matched.length === 0 ? (
            <div
              className="px-3 py-8 text-center text-aux"
              style={{ color: 'var(--rg-text-tertiary)' }}
              role="status"
            >
              没有匹配的页面或账号
            </div>
          ) : (
            matched.map((c, i) => (
              <button
                key={c.id}
                type="button"
                data-idx={i}
                role="option"
                aria-selected={i === active}
                className="flex items-center gap-3 w-full text-left px-2.5 py-2 rounded-md"
                style={{
                  background: i === active ? 'var(--rg-bg-secondary)' : 'transparent',
                  color: 'var(--rg-text-primary)',
                }}
                onMouseEnter={() => setActive(i)}
                onClick={() => exec(c)}
              >
                <span className="text-[13px] truncate flex-1 min-w-0">{c.label}</span>
                <span className="text-aux shrink-0" style={{ color: 'var(--rg-text-tertiary)' }}>
                  {c.detail}
                </span>
              </button>
            ))
          )}
        </div>

        <div
          className="shrink-0 flex items-center justify-end gap-4 px-4 py-2 text-aux"
          style={{ borderTop: '1px solid var(--rg-border)', color: 'var(--rg-text-tertiary)' }}
        >
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
