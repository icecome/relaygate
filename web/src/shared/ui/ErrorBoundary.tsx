import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 「动态导入模块加载失败」的特征。
 *
 * 典型场景：服务端重新构建后，浏览器仍持有旧的 index.html，
 * 其引用的 chunk（带 hash）已被新构建删除，import() 便以网络错误告终。
 * 这类错误重试同一个 URL 永远不会成功，刷新页面拿到新 HTML 才能恢复。
 */
const CHUNK_RE = /(Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk \d+ failed|ChunkLoadError)/i;

/** 恢复标记：写入 sessionStorage，保证同一次故障只自动刷新一次，避免刷新循环。 */
const RELOAD_FLAG = 'relaygate:chunk-reload';

function isChunkLoadError(error: Error): boolean {
  return CHUNK_RE.test(error.message || String(error));
}

function alreadyReloaded(): boolean {
  try {
    return sessionStorage.getItem(RELOAD_FLAG) === '1';
  } catch {
    // 隐私模式下 sessionStorage 可能抛错；按「未刷新过」处理，允许一次恢复机会
    return false;
  }
}

function markReloaded(): void {
  try {
    sessionStorage.setItem(RELOAD_FLAG, '1');
  } catch {
    /* 写入失败不影响主流程 */
  }
}

function clearReloaded(): void {
  try {
    sessionStorage.removeItem(RELOAD_FLAG);
  } catch {
    /* ignore */
  }
}
/**
 * 顶层错误边界：任一组件在渲染期抛错时，React 会卸载整棵树。
 * 没有边界时表现为整页白屏且无任何入口，用户只能靠刷新猜测原因。
 * 这里给出错误摘要与「重新加载」入口，并把详情留给控制台。
 *
 * 对 chunk 加载失败额外做一次静默自动恢复：新构建后旧页面引用已失效的
 * chunk 是可自愈的部署场景，无需用户介入；已恢复过一次后不再自动刷新，
 * 避免真实缺陷（如打包产物缺失）被无限刷新掩盖。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 渲染期异常不会进全局 unhandledrejection，只能在此记录组件栈
    console.error('[RelayGate] 渲染异常:', error, info.componentStack);

    if (isChunkLoadError(error) && !alreadyReloaded()) {
      markReloaded();
      console.warn('[RelayGate] 检测到模块加载失败，正在重新加载页面以获取最新构建');
      window.location.reload();
    }
  }

  handleReload = () => {
    // 用户手动点击「重新加载」视为一次新的恢复尝试，重置自动刷新计数
    clearReloaded();
    window.location.reload();
  };

  componentDidUpdate(prevProps: Props) {
    // 应用成功渲染过，说明本次刷新已恢复到可用版本。
    // 此时清除标记，避免标记长期滞留，使后续真正的模块故障仍能自动恢复一次。
    if (!this.state.error && prevProps.children !== this.props.children) clearReloaded();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunkFailure = isChunkLoadError(error);
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-white">
        <div className="panel w-[min(560px,100%)]">
          <div className="panel-body">
            <h1 className="text-block mb-2">面板渲染出错</h1>
            <p className="text-[13px] mb-4 leading-relaxed" style={{ color: 'var(--rg-text-secondary)' }}>
              {chunkFailure
                ? '页面引用的某个模块文件已失效，通常是网关重新构建后当前页面仍是旧版本所致。已尝试自动刷新；若仍反复出现，请确认前后端版本一致后重新构建。'
                : '页面组件抛出异常，界面已停止渲染。可以先重新加载；若反复出现，请把下面的错误摘要一并反馈。'}
            </p>
            <pre
              className="rounded-md border p-3 mb-4 font-mono text-[12px] whitespace-pre-wrap break-all"
              style={{
                borderColor: 'var(--rg-border)',
                background: 'var(--rg-state-error-surface)',
                color: 'var(--rg-state-error)',
              }}
            >
              {error.message || String(error)}
            </pre>
            <div className="flex gap-2">
              <button type="button" className="btn btn-primary" onClick={this.handleReload}>
                重新加载
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => this.setState({ error: null })}
              >
                尝试继续
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}