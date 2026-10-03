import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface RowMenuItem {
  label: string;
  danger?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

/** 行内「更多」溢出菜单。fixed 定位以避免被表格 overflow 裁剪。 */
export default function RowMenu({ items, ariaLabel = '更多操作' }: { items: RowMenuItem[]; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  const place = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const menuH = items.length * 34 + 10;
    const below = window.innerHeight - r.bottom;
    const top = below < menuH + 8 ? r.top - menuH - 6 : r.bottom + 6;
    const menuW = 160;
    const left = Math.max(8, Math.min(r.right - menuW, window.innerWidth - menuW - 8));
    setPos({ top, left });
  }, [items.length]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useLayoutEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onScroll = () => close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, close]);

  return (
    <div className="relative" ref={anchorRef}>
      <button
        type="button"
        aria-label={ariaLabel}
        title={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-line bg-surf text-ink-soft cursor-pointer transition-colors hover:bg-surf-soft hover:text-ink"
      >
        <svg viewBox="0 0 24 24" className="w-4 h-4" aria-hidden="true">
          <circle cx="12" cy="5" r="1.7" fill="currentColor" />
          <circle cx="12" cy="12" r="1.7" fill="currentColor" />
          <circle cx="12" cy="19" r="1.7" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 min-w-[152px] card rounded-md py-1 shadow-pop"
          style={{ top: pos.top, left: pos.left }}
        >
          {items.map((it, i) => (
            <div key={i}>
              {it.separatorBefore && <div className="my-1 h-px bg-line" />}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  it.onSelect();
                }}
                className={`w-full text-left px-3.5 py-2 text-[13px] transition-colors hover:bg-surf-soft ${
                  it.danger ? 'text-danger' : 'text-ink'
                }`}
              >
                {it.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}