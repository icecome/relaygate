import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 顶层错误边界：任一组件在渲染期抛错时，React 会卸载整棵树。
 * 没有边界时表现为整页白屏且无任何入口，用户只能靠刷新猜测原因。
 * 这里给出错误摘要与「重新加载」入口，并把详情留给控制台/崩溃日志。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 渲染期异常不会进全局 unhandledrejection，只能在此记录组件栈
    console.error('[RelayGate] 渲染异常:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-bg">
        <div className="card w-[min(560px,100%)] p-6">
          <h1 className="text-base font-semibold text-ink mb-2">面板渲染出错</h1>
          <p className="text-[13px] text-ink-soft mb-4 leading-relaxed">
            页面组件抛出异常，界面已停止渲染。可以先重新加载；若反复出现，请把下面的错误摘要一并反馈。
          </p>
          <pre className="rounded-md border border-line bg-surf-soft p-3 mb-4 font-mono text-[12px] text-danger whitespace-pre-wrap break-all">
            {error.message || String(error)}
          </pre>
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              重新加载
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => this.setState({ error: null })}>
              尝试继续
            </button>
          </div>
        </div>
      </div>
    );
  }
}
