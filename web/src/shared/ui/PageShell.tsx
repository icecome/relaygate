/**
 * 页面外壳模式：页标题 + 可选工具条 + 内容区。
 * 统一各页顶部结构，避免每页各写一遍标题区。
 *
 * ## 为什么 toolbar 与 children 在同一层 flex 流里
 *
 * 此前是两个独立节点：
 *   {toolbar && <div className="toolbar">…</div>}   ← .toolbar 自带 mb-4
 *   <div className="flex flex-col gap-4">{children}</div>
 * 于是「工具条 → 第一块内容」之间是 16px 外边距 + 16px gap = 32px，
 * 而内容块之间是 16px。同一个页面里出现两种「区块间距」，
 * 视觉上像是第一块内容被孤立出来了。
 *
 * 现在三者共用同一个 gap-4：间距只有一处来源，改间距改一个数。
 * 配套改动见 global.css 的 .toolbar（去掉了 mb-4）。
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
          {description && <p className="text-[13px] mt-1 fg-2">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
      <div className="flex flex-col gap-4">
        {toolbar && <div className="toolbar">{toolbar}</div>}
        {children}
      </div>
    </>
  );
}

/** 区块间距容器，配合 PageShell 使用。 */
export function Stack({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-4">{children}</div>;
}