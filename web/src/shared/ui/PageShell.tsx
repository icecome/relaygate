/**
 * 页面外壳模式：页标题 + 可选工具条 + 内容区。
 * 统一各页顶部结构，避免每页各写一遍标题区。
 */
import type { ReactNode } from 'react';

export interface PageShellProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
}

export function PageShell({ title, description, actions, toolbar, children }: PageShellProps) {
  return (
    <>
      <div className="flex items-start justify-between gap-6 mb-4">
        <div className="min-w-0">
          <h1 className="text-page">{title}</h1>
          {description && (
            <p className="text-[13px] mt-1" style={{ color: 'var(--rg-text-secondary)' }}>
              {description}
            </p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
      {toolbar && <div className="toolbar">{toolbar}</div>}
      <div className="flex flex-col gap-4">{children}</div>
    </>
  );
}

/** 区块间距容器，配合 PageShell 使用。 */
export function Stack({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-4">{children}</div>;
}