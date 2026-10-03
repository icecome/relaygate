import type { ReactNode } from 'react';

/** 面板卡片：统一「标题 + 说明 + 右侧操作 + 内容」的表头结构 */
export function Panel({
  title,
  desc,
  right,
  children,
  bodyClass = '',
}: {
  title: ReactNode;
  desc?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  bodyClass?: string;
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="min-w-0">
          <div className="panel-title">{title}</div>
          {desc && <div className="panel-desc">{desc}</div>}
        </div>
        {right && <div className="right">{right}</div>}
      </div>
      <div className={bodyClass}>{children}</div>
    </div>
  );
}

/** 提示条：口径说明或风险警示。warn 用于需要用户注意的偏差 */
export function Note({
  kind = 'info',
  icon,
  children,
}: {
  kind?: 'info' | 'warn' | 'acc';
  icon?: ReactNode;
  children: ReactNode;
}) {
  const cls = kind === 'warn' ? 'note note-warn' : kind === 'acc' ? 'note note-acc' : 'note';
  return (
    <div className={cls}>
      {icon}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** 作用对象标签。用于把「这个操作动的是谁」写在动作名旁边 */
export function WhoTag({ who, children }: { who: string; children: ReactNode }) {
  return <span className={`who ${who}`}>{children}</span>;
}

/** 运维动作行：动作名 + 作用对象 + 副作用 + 右侧操作 */
export function ActionRow({
  name,
  tag,
  meta,
  targetText,
  side,
  actions,
}: {
  name: ReactNode;
  tag?: ReactNode;
  meta?: ReactNode;
  targetText: ReactNode;
  side?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="op">
      <div className="op-main">
        <div className="op-name">
          {name}
          {tag}
          {meta}
        </div>
        <div className="op-desc">{targetText}</div>
        {side && <div className="op-side">副作用：{side}</div>}
      </div>
      {actions && <div className="op-actions">{actions}</div>}
    </div>
  );
}

export const ICON = {
  alert: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  ),
  info: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  ),
};