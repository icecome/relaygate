import type { ReactNode } from 'react';

interface StatCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  accent?: 'acc' | 'warn' | 'danger' | 'default';
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
  /**
   * 待处理量。仅当为正数时，卡片整体呈现"需要注意"的外观（左侧色条 + 淡色底）。
   *
   * 与 accent 的分工：accent 给数值上色，回答"这个数是什么"；
   * todo 给整卡上色，回答"这个数要不要我管"。两者叠加时不冲突——
   * 例如"已停用 3（danger accent）"整卡泛红提示需要人工恢复。
   *
   * 为零时不渲染任何异常外观，避免"字段存在"被误读为"出了问题"。
   */
  todo?: boolean;
}

export default function StatCard({
  label,
  value,
  hint,
  accent = 'default',
  clickable,
  onClick,
  kind = 'readout',
  todo,
}: StatCardProps) {
  const color =
    accent === 'acc' ? 'text-acc-hover' : accent === 'warn' ? 'text-warn' : accent === 'danger' ? 'text-danger' : 'text-ink';
  const valueCls = kind === 'text' ? 'text-block-title font-semibold' : 'text-read';
  // 异常态的整卡底色：与表格异常行同源，保证"首屏 KPI"与"明细行"用同一套颜色语言
  const todoCls = todo
    ? accent === 'danger'
      ? 'border-[#F5C9C9] bg-[#FEF5F5]'
      : 'border-warn-line bg-[#FFF8F2]'
    : 'border-line-hairline bg-surf';
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
      className={`border rounded-card px-4 py-3.5 h-full flex flex-col ${todoCls} ${clickable ? 'cursor-pointer transition-colors hover:border-line-strong' : ''}`}
    >
      <div className="text-aux font-medium text-ink-soft mb-1">{label}</div>
      <div className={`${valueCls} ${color}`}>{value}</div>
      {hint != null && <div className="text-aux text-ink-faint mt-0.5">{hint}</div>}
    </div>
  );
}