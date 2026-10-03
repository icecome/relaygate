import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import Modal from './Modal';

export interface PromptOptions {
  title: string;
  message?: string;
  input?: { label: string; value?: string };
  danger?: boolean;
  okText?: string;
  cancelText?: string;
}

export type PromptFn = (opts: PromptOptions) => Promise<string | boolean | null>;

const PromptCtx = createContext<PromptFn>(() => Promise.resolve(null));

export function usePrompt(): PromptFn {
  return useContext(PromptCtx);
}

export function PromptProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(PromptOptions & { resolve: (v: string | boolean | null) => void }) | null>(null);
  const [inputVal, setInputVal] = useState('');

  const ask = useCallback<PromptFn>((opts) => {
    return new Promise((resolve) => {
      setInputVal(opts.input?.value ?? '');
      setState({ ...opts, resolve });
    });
  }, []);

  const close = useCallback((result: string | boolean | null) => {
    setState((s) => {
      s?.resolve(result);
      return null;
    });
  }, []);

  return (
    <PromptCtx.Provider value={ask}>
      {children}
      {state && (
        <Modal
          open
          onClose={() => close(null)}
          title={state.title}
          desc={state.message}
          labelledBy="prompt-title"
        >
          {state.input && (
            <div className="mb-3">
              <label className="block text-xs font-medium text-ink-soft mb-2">{state.input.label}</label>
              <input
                className="field w-full"
                value={inputVal}
                autoFocus
                onChange={(e) => setInputVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') close(inputVal);
                }}
              />
            </div>
          )}
          <div className="flex justify-end gap-2 mt-4">
            <button type="button" className="btn btn-ghost" onClick={() => close(null)}>
              {state.cancelText || '取消'}
            </button>
            <button
              type="button"
              className={`btn ${state.danger ? 'btn-danger' : 'btn-primary'}`}
              onClick={() => close(state.input ? inputVal : true)}
            >
              {state.okText || '确定'}
            </button>
          </div>
        </Modal>
      )}
    </PromptCtx.Provider>
  );
}