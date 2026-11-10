/**
 * 可展开的指标卡。
 *
 * 总览页的「可用额度 / 今日消耗 / 即将到期」都需要「数字 → 点开看构成」，
 * 三处的交互完全一致，所以抽成一个组件，而不是在页面里写三套。
 *
 * 交互约定（三处必须一致，否则用户每次都要重新学）：
 *   - 整块卡头可点，`aria-expanded` + `aria-controls` 表达展开态
 *   - 展开区在卡内、卡下方，不跳页、不弹窗（这是「就地看构成」的诉求）
 *   - 角标始终显示，告诉用户这里可以展开（`＋ / －`）
 *   - 展开区加载中 / 出错 / 空态都有明确文案，不留白
 */
import { useEffect, useId, useState, type ReactNode } from 'react';
import { LoadingBlock } from '../../shared/ui';

export function MetricCard({
  label,
  value,
  unit,
  hint,
  /** 角标（如「仅计 Trae / WorkBuddy」），显示在标题右侧 */
  badge,
  /** 点击展开后才挂载的明细；为 undefined 表示该卡不可展开 */
  detail,
  /** 展开时触发的加载（例如去拉完整 packs）；可重复触发，需幂等 */
  onExpand,
  defaultOpen = false,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  badge?: ReactNode;
  detail?: ReactNode;
  onExpand?: () => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  // 首次展开时拉一次；后续展开不重复打上游（数据由父级刷新驱动）
  useEffect(() => {
    if (open) onExpand?.();
    // onExpand 由父级用 useCallback 固定；刻意不放进依赖避免每次渲染都重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const expandable = detail !== undefined;
  const Head = expandable ? 'button' : 'div';

  return (
    <div className="metric-card" data-open={open ? 'on' : 'off'}>
      <Head
        type={expandable ? 'button' : undefined}
        className={expandable ? 'metric-card-head is-clickable' : 'metric-card-head'}
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? bodyId : undefined}
        onClick={expandable ? () => setOpen((v) => !v) : undefined}
      >
        <div className="metric-card-title">
          <span className="text-[12px] leading-[18px]" style={{ color: 'var(--rg-text-secondary)' }}>
            {label}
          </span>
          {badge}
          {expandable && (
            <span className="metric-card-caret" aria-hidden="true">
              {open ? '−' : '+'}
            </span>
          )}
        </div>
        <div className="mt-1.5 flex items-baseline gap-1.5 min-w-0">
          <span className="text-read truncate">{value}</span>
          {unit && <span className="text-unit shrink-0">{unit}</span>}
        </div>
        {hint && (
          <div className="mt-1 text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
            {hint}
          </div>
        )}
      </Head>

      {expandable && open && (
        <div id={bodyId} className="metric-card-body">
          {detail}
        </div>
      )}
    </div>
  );
}

/** 展开区的加载 / 空 / 错误三态统一出口，避免每处各写一套。 */
export function DetailState({
  loading,
  error,
  empty,
  emptyHint,
  children,
}: {
  loading?: boolean;
  error?: string | null;
  empty?: boolean;
  emptyHint?: string;
  children?: ReactNode;
}) {
  if (loading) return <LoadingBlock label="读取明细" />;
  if (error) {
    return (
      <div className="text-aux" style={{ color: 'var(--rg-state-error)' }}>
        {error}
      </div>
    );
  }
  if (empty) {
    return (
      <div className="text-aux leading-relaxed" style={{ color: 'var(--rg-text-tertiary)' }}>
        {emptyHint ?? '没有可展示的明细'}
      </div>
    );
  }
  return <>{children}</>;
}
