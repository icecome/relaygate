import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

export type ToastKind = 'ok' | 'err' | 'warn';

interface ToastItem {
  id: number;
  msg: string;
  kind: ToastKind;
}

const ToastCtx = createContext<(msg: string, kind?: ToastKind) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

const DOT_VAR: Record<ToastKind, string> = {
  ok: 'var(--rg-state-success)',
  err: 'var(--rg-state-error)',
  warn: 'var(--rg-state-warning)',
};

/** 色点之外的可读标签：颜色不能是唯一的状态载体（色盲用户不可辨）。 */
const KIND_LABEL: Record<ToastKind, string> = {
  ok: '成功',
  err: '错误',
  warn: '警告',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((msg: string, kind: ToastKind = 'ok') => {
    const id = nextId.current++;
    setItems((xs) => [...xs, { id, msg, kind }]);
    window.setTimeout(() => {
      setItems((xs) => xs.filter((x) => x.id !== id));
    }, 3200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      {/*
        全站操作结果都走 Toast。polite 而非 assertive：批量操作可能连发多条，
        不应打断读屏当前的朗读。
      */}
      <div
        className="fixed right-4 bottom-4 z-[60] flex flex-col gap-2 max-w-[360px]"
        role="status"
        aria-live="polite"
        aria-relevant="additions"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className="panel px-3.5 py-2.5 text-[13px] flex items-center gap-2.5"
          >
            <span
              className="w-[7px] h-[7px] rounded-sm shrink-0"
              style={{ background: DOT_VAR[t.kind] }}
              aria-hidden="true"
            />
            <span className="min-w-0">
              <span className="sr-only">{KIND_LABEL[t.kind]}：</span>
              {t.msg}
            </span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}