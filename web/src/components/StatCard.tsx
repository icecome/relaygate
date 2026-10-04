import type { ReactNode } from 'react';

interface StatCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  accent?: 'acc' | 'warn' | 'default';
  clickable?: boolean;
  onClick?: () => void;
}

export default function StatCard({ label, value, hint, accent = 'default', clickable, onClick }: StatCardProps) {
  const color = accent === 'acc' ? 'text-acc-hover' : accent === 'warn' ? 'text-warn' : 'text-ink';
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
      className={`bg-surf border border-line-hairline rounded-card px-4 py-3.5 ${clickable ? 'cursor-pointer transition-colors hover:border-line-strong' : ''}`}
    >
      <div className="text-aux font-medium text-ink-soft mb-1">{label}</div>
      <div className={`text-read ${color}`}>{value}</div>
      {hint != null && <div className="text-aux text-ink-faint mt-0.5">{hint}</div>}
    </div>
  );
}