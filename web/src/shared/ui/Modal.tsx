import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

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
  /** 描述文本的可访问名 id；不传则内部生成，并挂到 aria-describedby */
  describedBy?: string;
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

/*
 * ---------------------------------------------------------------------------
 * 打开栈：解决「一次 Esc 关掉所有层」
 * ---------------------------------------------------------------------------
 *
 * 原先每个 Modal 实例各自在 document 上挂一个 keydown，两层弹窗同时打开时
 * 一次 Esc 会触发两个监听器，两层一起关。真实场景：导入弹窗里点「查看详情」
 * 打开第二层，按 Esc 期望只退回导入弹窗，实际两层全没。
 *
 * 这里维护一个模块级栈：只有栈顶实例响应 Esc。
 * 用模块级而不是 context，是因为 Modal 在各处被直接 import 使用，
 * 引入 Provider 会要求改全部 21 个调用点；而栈是纯粹的运行时状态，
 * 与 React 树无关。
 */
const OPEN_STACK: symbol[] = [];

/**
 * 为每层弹窗分配稳定的栈槽。
 * useId 给出跨实例唯一的字符串，转成 symbol 后用于栈内比较。
 */
let tokenSeq = 0;
function nextToken(): symbol {
  tokenSeq += 1;
  return Symbol.for(`rg-modal-${tokenSeq}`);
}

/*
 * 背景滚动锁：引用计数，避免嵌套弹窗时先关的那层把锁提前解开。
 */
let scrollLockCount = 0;
let savedOverflow = '';
let savedPaddingRight = '';

function lockBodyScroll() {
  if (scrollLockCount === 0) {
    const body = document.body;
    savedOverflow = body.style.overflow;
    savedPaddingRight = body.style.paddingRight;
    /*
     * 滚动条宽度补偿：直接把 overflow 设成 hidden 会让页面内容右移一个
     * 滚动条宽度，表现为「打开弹窗时背景横向跳一下」。
     */
    const gap = window.innerWidth - document.documentElement.clientWidth;
    if (gap > 0) body.style.paddingRight = `${gap}px`;
    body.style.overflow = 'hidden';
  }
  scrollLockCount += 1;
}

function unlockBodyScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) {
    document.body.style.overflow = savedOverflow;
    document.body.style.paddingRight = savedPaddingRight;
  }
}

export default function Modal({
  open,
  onClose,
  title,
  desc,
  size = 'md',
  children,
  footer,
  labelledBy,
  describedBy,
}: ModalProps) {
  const autoId = useId();
  // 始终给出可访问名：调用方未传时用内部生成 id，避免 aria-labelledby="undefined"
  const titleId = labelledBy || `${autoId}-title`;
  const descId = describedBy || `${autoId}-desc`;
  const panelRef = useRef<HTMLDivElement | null>(null);
  // 记录打开前的焦点，关闭时归还，避免键盘用户被丢回页面顶部
  const openerRef = useRef<HTMLElement | null>(null);
  // 本实例在打开栈里的槽位；每次 open 变化重新取，保证顺序与实际打开顺序一致
  const tokenRef = useRef<symbol | null>(null);
  // onClose 多为行内箭头函数，每次渲染都换身份；用 ref 取最新值，
  // 使下方副作用只随 open 变化执行
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;

    openerRef.current = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    const first = initialFocusTarget(panel);
    (first || panel)?.focus();

    // 面板内最近一次获得焦点的元素：Tab 逃逸到最后手段时据此归还
    let lastInPanel: HTMLElement | null = first || panel;
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && panel?.contains(target)) lastInPanel = target;
    };

    const onKey = (e: KeyboardEvent) => {
      /*
       * 只有栈顶响应 Esc。深层弹窗先关，浅层留在原地。
       */
      if (e.key === 'Escape') {
        const token = tokenRef.current;
        if (token && OPEN_STACK[OPEN_STACK.length - 1] !== token) return;
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

    /*
     * 入栈 + 锁滚动。两者都必须在同一个 effect 里配对出栈/解锁，
     * 否则 StrictMode 双调用会漏算。
     */
    const token = nextToken();
    tokenRef.current = token;
    OPEN_STACK.push(token);
    lockBodyScroll();

    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      // 出栈：按 token 精确移除，避免中间层先关导致顺序错乱
      const at = OPEN_STACK.lastIndexOf(token);
      if (at >= 0) OPEN_STACK.splice(at, 1);
      tokenRef.current = null;
      unlockBodyScroll();
      const opener = openerRef.current;
      if (opener && opener.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;

  /*
   * 渲染到 body：与 Menu 同源做法。
   *
   * 此前直接渲染在调用点，于是弹窗会被祖先的 overflow:hidden 裁切
   * （.panel 的圆角裁切、.table-wrap 的横向滚动都是裁剪祖先），
   * 也拿不到稳定的层叠上下文。挂到 body 后 z-index 才真正可预期。
   */
  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto p-4"
      style={{ background: 'var(--rg-scrim)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`panel my-auto animate-pop overflow-hidden flex flex-col max-h-[calc(100vh-3rem)] outline-none ${WIDTH[size]}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={desc ? descId : undefined}
      >
        <div className="shrink-0 px-5 py-3" style={{ borderBottom: '1px solid var(--rg-border)' }}>
          <h2 className="text-[14px] font-semibold" id={titleId}>
            {title}
          </h2>
          {desc && (
            <div
              className="text-aux mt-1 leading-[1.6]"
              id={descId}
              style={{ color: 'var(--rg-text-secondary)' }}
            >
              {desc}
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div
            className="shrink-0 flex justify-end gap-2 px-5 py-3"
            style={{ borderTop: '1px solid var(--rg-border)', background: 'var(--rg-bg-secondary)' }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
