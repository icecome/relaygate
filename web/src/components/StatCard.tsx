import type { ReactNode } from 'react';

interface StatCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  accent?: 'acc' | 'warn' | 'default';
  clickable?: boolean;
  onClick?: () => void;
  /**
   * 值的呈现档位。
   *   readout（默认）—— 数值读数，28px 等宽，用于 KPI 数字
   *   text           —— 文本/标识符值，16px，用于「上游函数」这类非数字值
   * 28px 是仪表读数档，套在中文词或标识符上会撑爆卡片且喧宾夺主，
   * 故文本值必须显式声明此属性降档。
   */
  kind?: 'readout' | 'text';
}

export default function StatCard({ label, value, hint, accent = 'default', clickable, onClick, kind = 'readout' }: StatCardProps) {
  const color = accent === 'acc' ? 'text-acc-hover' : accent === 'warn' ? 'text-warn' : 'text-ink';
  const valueCls = kind === 'text' ? 'text-block-title font-semibold' : 'text-read';
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      className={`bg-surf border border-line-hairline rounded-card px-4 py-3.5 h-full flex flex-col ${clickable ? 'cursor-pointer transition-colors hover:border-line-strong' : ''}`}
    >
      <div className="text-aux font-medium text-ink-soft mb-1">{label}</div>
      <div className={`${valueCls} ${color}`}>{value}</div>
      {hint != null && <div className="text-aux text-ink-faint mt-0.5">{hint}</div>}
    </div>
  );
}