/**
 * 可展开的指标卡（受控触发器）。
 *
 * ## 为什么展开区不在这里渲染
 *
 * 上一版把明细渲染成卡片的子节点，于是明细被限制在 1/3 行的卡体宽度内。
 * 明细的实际内容是「平台 × 计量 × 数值 × 说明」四列表，在约 450px 里只能
 * 靠换行与不等宽数值列勉强排下：左边界对不齐、无法纵向比较、单位混进
 * 数值列 —— 而「比较谁占大头」正是这张卡唯一的价值。
 *
 * 同时 .metric-cards 是 grid + align-items:start，一张卡变高时另外两张
 * 原地不动，展开/收起会带动下方「待处理」面板上下跳约 175px。
 *
 * 现在的分工：
 *   - 本组件只渲染**卡头**（触发器），固定高度，三张卡永远等高
 *   - 明细由页面在卡片之后渲染成整行 `.metric-panel`，占满内容宽度
 *   - 单开手风琴：同时只展开一张，由页面持有 `openKey`
 *
 * ## 交互约定（三处必须一致，否则用户每次都要重新学）
 *   - 整块卡头可点，`aria-expanded` + `aria-controls` 表达展开态
 *   - chevron 在标签**左侧**并随展开旋转 90°：右上角的「+」会被读成「新增」
 *   - 可访问名里显式带上「展开/收起」动作，读屏才知道这是开关
 */
import type { ReactNode } from 'react';
import { LoadingBlock } from '../../shared/ui';

/** 展开指示符。集中在这里，三张卡的旋转与尺寸才不会漂。 */
function Chevron() {
  return (
    <span className="metric-card-chevron" aria-hidden="true">
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M4.5 2.5 L8 6 L4.5 9.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export function MetricCard({
  label,
  value,
  unit,
  hint,
  badge,
  /** 展开区的 DOM id；与页面上 `.metric-panel` 的 id 对应 */
  panelId,
  /** 当前是否展开 */
  open,
  /** 点击卡头；不可展开时传 undefined */
  onToggle,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  badge?: ReactNode;
  panelId?: string;
  open?: boolean;
  onToggle?: () => void;
}) {
  const expandable = !!onToggle;
  const expanded = expandable && !!open;

  return (
    <div className="metric-card" data-open={expanded ? 'on' : 'off'}>
      <button
        type="button"
        className={expandable ? 'metric-card-head is-clickable' : 'metric-card-head'}
        aria-expanded={expandable ? expanded : undefined}
        aria-controls={expandable ? panelId : undefined}
        onClick={onToggle}
        disabled={!expandable}
      >
        <span className="metric-card-title">
          {expandable && <Chevron />}
          <span className="metric-key">{label}</span>
          {badge}
          {/*
           * 动作词进可访问名，视觉上不可见：
           * 「可用额度 46,844.87 积分」读不出这里可以展开。
           */}
          {expandable && (
            <span className="sr-only">{expanded ? '收起明细' : '展开明细'}</span>
          )}
        </span>
        <span className="mt-1.5 flex items-baseline gap-1.5 min-w-0">
          {/*
           * 这里不加 truncate：主读数是本页最重要的数字，位数多时宁可用
           * formatCompact 缩短，也不能静默截断成「46,864.…」。
           */}
          <span className="text-read">{value}</span>
          {unit && <span className="text-unit shrink-0">{unit}</span>}
        </span>
        {hint && (
          <span className="mt-1 text-aux block fg-3">
            {hint}
          </span>
        )}
      </button>
    </div>
  );
}

/**
 * 整行展开面板。
 *
 * 与 MetricCard 是兄弟节点，占满内容宽度。头部的「收起」按钮与卡头
 * 形成双入口 —— 展开后视线已经在下方，不该逼用户滚回去点卡头。
 */
export function MetricPanel({
  id,
  title,
  sub,
  onClose,
  children,
}: {
  id: string;
  title: string;
  sub?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <section className="metric-panel" id={id} aria-label={title}>
      <header className="metric-panel-head">
        <span className="metric-panel-title">{title}</span>
        {sub && <span className="metric-panel-sub">{sub}</span>}
        <button
          type="button"
          className="btn btn-sm btn-ghost ml-auto"
          onClick={onClose}
          aria-label={`收起${title}`}
        >
          收起
        </button>
      </header>
      <div className="metric-panel-body">{children}</div>
    </section>
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
      <div className="text-aux fg-danger">
        {error}
      </div>
    );
  }
  if (empty) {
    return (
      <div className="text-aux leading-relaxed fg-3">
        {emptyHint ?? '没有可展示的明细'}
      </div>
    );
  }
  return <>{children}</>;
}