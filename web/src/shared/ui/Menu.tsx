/**
 * 下拉菜单（portal 版）。
 *
 * 为什么必须挂到 body：菜单是绝对定位的浮层，而它所在的表格面板有
 * `overflow: hidden`（`.panel` 的圆角裁切需要）。实测症状是点「⋯」后
 * 菜单被父级裁掉 —— 只剩下一个被切掉的小方块，看起来像渲染错误。
 *
 * 同时表格里还有 `.table-wrap { overflow-x: auto }`，那是第二个裁剪祖先。
 * 任何「给祖先去掉 overflow」的修法都会让圆角失效或让表格无法横向滚动，
 * 所以正确解法是渲染到 body + 按触发按钮的屏幕坐标定位。
 *
 * 定位规则：
 *   - 默认向下展开；下方空间不足时翻转到上方
 *   - 右对齐：菜单右边缘贴按钮右边缘；左对齐反之
 *   - 视口边缘留 8px 余量
 *   - 滚动 / 缩放时重新计算（否则会出现菜单停在原地的错觉）
 *
 * 无障碍契约：
 *   - 触发按钮 aria-haspopup="menu" + aria-expanded + aria-controls
 *   - 菜单 role="menu"，项 role="menuitem"，禁用项 aria-disabled
 *   - ↑↓ 循环、Home/End 首尾、Esc 关闭并归还焦点、Tab 关闭
 *   - 点击外部关闭
 *   - 打开时焦点落在第一项（留在触发按钮上会让方向键失去落点）
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  key: string;
  label: string;
  /** 点击处理。菜单会先关闭再调用。 */
  onSelect?: () => void;
  /** 危险项：红色文字，用于删除这类不可撤销操作。 */
  danger?: boolean;
  disabled?: boolean;
  /** 悬停说明（不可用原因、口径备注等）。 */
  hint?: string;
  /** 与上一项之间渲染一条分隔线。 */
  groupStart?: boolean;
}

/** 菜单与视口边缘的最小间距。 */
const EDGE = 8;
/** 菜单与按钮之间的间距。 */
const GAP = 4;

interface Pos {
  top: number;
  left: number;
  maxHeight: number;
}

export function MenuButton({
  label,
  items,
  trigger,
  align = 'right',
  width = 190,
}: {
  /** 无障碍名与 title，例如「19075795328 的更多操作」 */
  label: string;
  items: MenuItem[];
  /** 自定义触发内容；缺省为「⋯」 */
  trigger?: ReactNode;
  align?: 'left' | 'right';
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const [activeIdx, setActiveIdx] = useState(-1);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  /** 可选中项在 items 里的下标（跳过 disabled）。 */
  const selectableIdx = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

  /** 取菜单内可聚焦的 menuitem 节点，顺序与 selectableIdx 一一对应。 */
  const focusables = useCallback((): HTMLElement[] => {
    if (!menuRef.current) return [];
    return [...menuRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')];
  }, []);

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    setPos(null);
    setActiveIdx(-1);
    if (returnFocus) btnRef.current?.focus();
  }, []);

  /**
   * 按触发按钮的屏幕坐标计算菜单位置。
   *
   * 用 getBoundingClientRect（视口坐标）+ position: fixed，
   * 这样页面滚动时菜单跟着按钮走，不需要监听祖先的滚动事件。
   */
  const place = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 预估高度：每项 32px + 分隔线，用于决定向上还是向下展开
    const estH = items.reduce((s, it) => s + 32 + (it.groupStart ? 9 : 0), 0) + 8;
    const below = vh - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const down = below >= Math.min(estH, 160) || below >= above;

    const top = down ? r.bottom + GAP : Math.max(EDGE, r.top - GAP - Math.min(estH, above));
    const availH = down ? below : above;

    let left = align === 'right' ? r.right - width : r.left;
    left = Math.max(EDGE, Math.min(left, vw - width - EDGE));

    setPos({ top, left, maxHeight: Math.max(120, Math.min(availH, vh - EDGE * 2)) });
  }, [align, width, items]);

  // 打开时定位 + 聚焦第一项
  useLayoutEffect(() => {
    if (!open) return;
    place();
    if (selectableIdx.length) {
      setActiveIdx(selectableIdx[0]);
      const raf = window.requestAnimationFrame(() => focusables()[0]?.focus());
      return () => window.cancelAnimationFrame(raf);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 滚动 / 缩放时跟随（capture 覆盖所有可滚动祖先）
  useEffect(() => {
    if (!open) return;
    const onScroll = () => place();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, place]);

  // 点击外部关闭：菜单现在在 body 里，判定要同时排除按钮与菜单本身
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  /** 按可选中项的顺序移动焦点（delta=±1 循环）。 */
  function move(delta: 1 | -1) {
    if (!selectableIdx.length) return;
    const at = selectableIdx.indexOf(activeIdx);
    const next = at < 0
      ? (delta > 0 ? 0 : selectableIdx.length - 1)
      : (at + delta + selectableIdx.length) % selectableIdx.length;
    setActiveIdx(selectableIdx[next]);
    focusables()[next]?.focus();
  }

  function focusEdge(edge: 'first' | 'last') {
    if (!selectableIdx.length) return;
    const at = edge === 'first' ? 0 : selectableIdx.length - 1;
    setActiveIdx(selectableIdx[at]);
    focusables()[at]?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'ArrowUp': e.preventDefault(); move(-1); break;
      case 'Home': e.preventDefault(); focusEdge('first'); break;
      case 'End': e.preventDefault(); focusEdge('last'); break;
      case 'Escape': e.preventDefault(); close(); break;
      case 'Tab': close(false); break;
      default: break;
    }
  }

  function choose(item: MenuItem) {
    if (item.disabled) return;
    close();
    item.onSelect?.();
  }

  const menu = open && pos
    ? createPortal(
      <div
        ref={menuRef}
        id={menuId}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        className="fixed z-[60] rounded-lg border py-1 shadow-lg animate-pop outline-none overflow-y-auto"
        style={{
          top: pos.top,
          left: pos.left,
          width,
          maxHeight: pos.maxHeight,
          borderColor: 'var(--rg-border-stronger)',
          background: 'var(--rg-bg-base)',
          boxShadow: '0 8px 24px rgba(23, 23, 23, 0.16)',
        }}
        onKeyDown={onKeyDown}
      >
        {items.map((item, i) => (
          <div key={item.key}>
            {item.groupStart && (
              <div className="my-1 h-px" style={{ background: 'var(--rg-border)' }} role="separator" />
            )}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-disabled={item.disabled || undefined}
              className={[
                'flex w-full items-center gap-2 px-3 py-[7px] text-left text-[13px] whitespace-nowrap border-0 transition-colors',
                item.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
              ].join(' ')}
              title={item.hint}
              style={{
                color: item.disabled
                  ? 'var(--rg-text-tertiary)'
                  : item.danger
                    ? 'var(--rg-state-error)'
                    : 'var(--rg-text-primary)',
                background: i === activeIdx ? 'var(--rg-bg-secondary)' : 'transparent',
              }}
              onMouseEnter={() => {
                if (!item.disabled) setActiveIdx(i);
              }}
              onClick={() => choose(item)}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>,
      document.body,
    )
    : null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="btn btn-sm btn-ghost px-1.5"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          // 未展开时 ↓ / Enter / 空格 直接打开并落焦
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {trigger ?? '⋯'}
      </button>
      {menu}
    </>
  );
}
