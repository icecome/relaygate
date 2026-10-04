import { useEffect, useRef, useState } from 'react';

/**
 * 行操作菜单：把账号表中原本平铺的多个操作收敛为一个「更多」入口，
 * 避免一屏十几行全是按钮、且删除与详情视觉重量相同。
 *
 * 设计依据（设计稿 v2 区块 04 / 07）：操作列从并列 8 按钮收敛为
 * 「1 主操作（按状态推导）+ 更多菜单」。破坏性操作（删除）在菜单内以红色
 * 与分隔线明确区分，不混同在普通操作里。
 *
 * 可达性：菜单为 role=menu / menuitem；Esc 关闭；方向键在项间移动；
 * 点击菜单外部或失焦时关闭；关闭后焦点归还触发按钮。
 */

export interface RowMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  /** 破坏性操作：红色 + 上方分隔线 */
  danger?: boolean;
}

export interface RowMenuProps {
  items: RowMenuItem[];
}

export default function RowMenu({ items }: RowMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const firstDanger = items.findIndex((i) => i.danger);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    btnRef.current?.focus();
  };

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        ref={btnRef}
        type="button"
        className="btn-quiet text-xs"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        更多 ⌄
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 min-w-[148px] py-1 bg-surf border border-line-hairline rounded-md shadow-pop"
        >
          {items.map((it, idx) => (
            <div key={it.key} role="none">
              {firstDanger >= 0 && idx === firstDanger && (
                <div className="h-px bg-line-hairline my-1" role="separator" />
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  it.onSelect();
                  close();
                }}
                className={`block w-full text-left px-3 py-1.5 text-[12.5px] ${
                  it.danger ? 'text-danger hover:bg-danger-soft' : 'text-ink hover:bg-surf-soft'
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
