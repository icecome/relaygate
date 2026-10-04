import { useEffect, useId, useRef, type ReactNode } from 'react';

/** md 用于短表单，lg 用于详情/表格，xl 用于多分区编辑器 */
export type ModalSize = 'md' | 'lg' | 'xl';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  desc?: ReactNode;
  size?: ModalSize;
  children: ReactNode;
  footer?: ReactNode;
  labelledBy?: string;
}

const WIDTH: Record<ModalSize, string> = {
  md: 'w-[min(100%,520px)]',
  lg: 'w-[min(100%,720px)]',
  xl: 'w-[min(100%,920px)]',
};

/** 可聚焦元素选择器；与 offsetParent 判可见性配合使用。 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    // offsetParent 为 null 表示 display:none 或不在布局中，不可聚焦
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * 初始焦点落点：输入控件 > 主操作按钮 > 首个可聚焦元素。
 * 直接取首个元素会把焦点落在「关闭」或危险按钮上，回车即误触。
 */
function initialFocusTarget(root: HTMLElement | null): HTMLElement | null {
  const list = focusableIn(root);
  if (!list.length) return null;
  const input = list.find((el) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName));
  if (input) return input;
  const primary = list.find((el) => el.classList.contains('btn-primary'));
  return primary || list[0];
}

export default function Modal({ open, onClose, title, desc, size = 'md', children, footer, labelledBy }: ModalProps) {
  const autoId = useId();
  // 始终给出可访问名：调用方未传时用内部生成 id，避免 aria-labelledby="undefined"
  const titleId = labelledBy || autoId;
  const panelRef = useRef<HTMLDivElement | null>(null);
  // 记录打开前的焦点，关闭时归还，避免键盘用户被丢回页面顶部
  const openerRef = useRef<HTMLElement | null>(null);
  // onClose 多为行内箭头函数，每次渲染都换身份；用 ref 取最新值，
  // 使下方副作用只随 open 变化执行，否则父组件每渲染一次就会重置初始焦点
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;

    openerRef.current = document.activeElement as HTMLElement | null;

    // 初始焦点：优先输入控件/主按钮，否则落到面板本身（面板有 tabIndex=-1）
    const panel = panelRef.current;
    const first = initialFocusTarget(panel);
    (first || panel)?.focus();

    // 面板内最近一次获得焦点的元素：Tab 逃逸兜底时据此归还，而非一律拉回首个元素
    let lastInPanel: HTMLElement | null = first || panel;
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && panel?.contains(target)) lastInPanel = target;
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      // 焦点陷阱：在首尾元素之间循环，防止 Tab 穿透到遮罩后的页面
      const list = focusableIn(panelRef.current);
      if (!list.length) {
        e.preventDefault();
        panelRef.current?.focus();
        return;
      }
      const head = list[0];
      const tail = list[list.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // 焦点已逃出面板（如被脚本移走）：归还到面板内最近一次聚焦处，
      // 无条件拉回首个元素会让正在编辑的输入框突然被顶部输入框顶替
      if (!active || !panelRef.current?.contains(active)) {
        e.preventDefault();
        (lastInPanel && lastInPanel.isConnected ? lastInPanel : head).focus();
        return;
      }
      if (e.shiftKey && active === head) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && active === tail) {
        e.preventDefault();
        head.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      // 关闭时归还焦点；元素可能已卸载，需判 isConnected
      const opener = openerRef.current;
      if (opener && opener.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto p-4 sm:p-6 bg-[rgba(16,24,40,0.5)]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`card shadow-pop my-auto animate-pop overflow-hidden flex flex-col max-h-[calc(100vh-3rem)] outline-none ${WIDTH[size]}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="shrink-0 px-5 pt-4 pb-3 border-b border-line">
          <h2 className="text-sm font-semibold text-ink" id={titleId}>
            {title}
          </h2>
          {desc && <div className="text-xs text-ink-soft mt-1 leading-[1.6]">{desc}</div>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="shrink-0 flex justify-end gap-2 px-5 py-3.5 border-t border-line bg-surf-soft">{footer}</div>
        )}
      </div>
    </div>
  );
}