/**
 * 基础 UI 组件（无业务语义）。
 * 只负责结构与可访问性，不发起请求、不含业务判断。
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

/* ---------------------------------------------------------------- Button */

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: '',
  primary: 'btn-primary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
};

export function Button({
  variant = 'default',
  size = 'md',
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = ['btn', VARIANT_CLASS[variant], size === 'sm' ? 'btn-sm' : '', className]
    .filter(Boolean)
    .join(' ');
  return <button type={type} className={classes} {...rest} />;
}

/* ----------------------------------------------------------------- Field */

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, id, className = '', ...rest },
  ref,
) {
  const input = (
    <input
      ref={ref}
      id={id}
      className={['field', 'w-full', className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
  if (!label) return input;
  return (
    <label className="flex flex-col gap-1 min-w-0" htmlFor={id}>
      <span className="text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
        {label}
      </span>
      {input}
    </label>
  );
});

/* ------------------------------------------------------------------ Panel */

export interface PanelProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** 内容区去掉内边距，供表格贴边铺满 */
  flush?: boolean;
  footer?: ReactNode;
}

export function Panel({ title, description, actions, children, flush, footer }: PanelProps) {
  return (
    <section className="panel">
      {(title || actions) && (
        <header className="panel-head">
          <div className="min-w-0">
            {title && <h2 className="panel-title">{title}</h2>}
            {description && <p className="panel-desc">{description}</p>}
          </div>
          {actions && <div className="right">{actions}</div>}
        </header>
      )}
      <div className={flush ? 'panel-body-flush' : 'panel-body'}>{children}</div>
      {footer && <footer className="panel-foot text-aux">{footer}</footer>}
    </section>
  );
}

/* ------------------------------------------------------------ MetricGrid */

export interface Metric {
  key: string;
  value: ReactNode;
  delta?: ReactNode;
}

export function MetricGrid({ items }: { items: Metric[] }) {
  return (
    <div className="metric-grid">
      {items.map((m) => (
        <div key={m.key} className="metric-cell">
          <div className="metric-key">{m.key}</div>
          <div className="text-read mt-1.5">{m.value}</div>
          {m.delta && <div className="metric-delta">{m.delta}</div>}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- StateChip */

export type ChipTone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger';

const CHIP_CLASS: Record<ChipTone, string> = {
  neutral: 'pill',
  brand: 'pill pill-brand',
  ok: 'pill pill-ok',
  warn: 'pill pill-warn',
  danger: 'pill pill-danger',
};

export interface ChipProps {
  tone?: ChipTone;
  /** 状态方点，颜色需与 tone 语义一致 */
  dot?: string;
  children: ReactNode;
}

export function Chip({ tone = 'neutral', dot, children }: ChipProps) {
  return (
    <span className={CHIP_CLASS[tone]}>
      {dot && <i className={`dot ${dot}`} aria-hidden="true" />}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------- Tabs */

export interface SegOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  options: readonly SegOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
}

/** 分段控件。用于筛选与页内分区，选中项用 aria-selected 标记。 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: SegmentedProps<T>) {
  return (
    <div className="seg" role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          className="seg-item"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- KeyValue */

export interface KeyValueRow {
  k: string;
  v: ReactNode;
  /** 密排时占满整行，用于长 URL 等不宜被压窄的内容。 */
  wide?: boolean;
}

export function KeyValue({ rows }: { rows: KeyValueRow[] }) {
  return (
    <dl className="kv">
      {rows.map((r) => (
        <div key={r.k} className="contents">
          <dt>{r.k}</dt>
          <dd>{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------- KeyCards */

/**
 * 逐字段卡片。适合字段少、彼此独立且需要横向扫读的运行态指标。
 * 语义相近的一组字段请改用 KeyCardGroups。
 */
export function KeyCards({ cols, rows }: { cols: number; rows: KeyValueRow[] }) {
  return (
    <div
      className="grid gap-2.5"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {rows.map((r) => (
        <div
          key={r.k}
          className="rounded-lg border px-3.5 py-2.5 min-w-0"
          style={{ borderColor: 'var(--rg-border)', background: 'var(--rg-bg-secondary)' }}
        >
          <div className="text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
            {r.k}
          </div>
          <div className="mt-1 text-[15px] font-medium break-words">{r.v}</div>
        </div>
      ))}
    </div>
  );
}

export interface KeyCardGroup {
  /** 分组标题 */
  title: string;
  rows: KeyValueRow[];
}

/** 超过该字段数的分组在卡内分两列排布，避免单卡高度明显高出同排卡片。 */
const DENSE_ROW_THRESHOLD = 6;

/**
 * 分组卡片：一个语义分组一张卡，字段以无边框紧凑行排列在卡内。
 * 卡面沿用面板底色，仅用描边区分层级，避免在白色面板内再压一层灰底。
 * 外层栅格固定两列，保证四组呈 2x2 分布；同一行卡片等高。
 */
export function KeyCardGroups({ groups }: { groups: KeyCardGroup[] }) {
  return (
    <div className="grid gap-4 grid-cols-2">
      {groups.map((g) => {
        const dense = g.rows.length > DENSE_ROW_THRESHOLD;
        return (
          <div
            key={g.title}
            className="rounded-lg border px-3.5 py-3 min-w-0"
            style={{ borderColor: 'var(--rg-border)' }}
          >
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-aux font-medium" style={{ color: 'var(--rg-text-secondary)' }}>
                {g.title}
              </span>
              <span className="h-px flex-1" style={{ background: 'var(--rg-border)' }} />
            </div>
            <dl
              className={dense ? 'grid gap-x-4 grid-cols-2' : 'flex flex-col'}
              style={dense ? { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } : undefined}
            >
              {g.rows.map((r) => (
                <div
                  key={r.k}
                  className={
                    dense && r.wide
                      ? 'grid items-baseline gap-2 py-[5px] col-span-2'
                      : 'grid items-baseline gap-2 py-[5px]'
                  }
                  style={{ gridTemplateColumns: dense ? '88px minmax(0, 1fr)' : '132px minmax(0, 1fr)' }}
                >
                  <dt className="text-[12px] leading-[1.5]" style={{ color: 'var(--rg-text-tertiary)' }}>
                    {r.k}
                  </dt>
                  <dd className="m-0 text-[13px] leading-[1.5] break-words">{r.v}</dd>
                </div>
              ))}
            </dl>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ Note */

export function Note({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'warn' | 'danger';
  children: ReactNode;
}) {
  const cls = tone === 'neutral' ? 'note' : `note note-${tone}`;
  return (
    <div className={cls} role={tone === 'neutral' ? undefined : 'alert'}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------- ProgressBar */

export function ProgressBar({
  ratio,
  tone = 'brand',
}: {
  /** 0-1，超出范围会被夹紧 */
  ratio: number;
  tone?: 'brand' | 'soft' | 'warn' | 'danger';
}) {
  const pct = Math.max(0, Math.min(100, ratio * 100));
  const toneClass = tone === 'brand' ? '' : `bar-${tone}`;
  return (
    <div className={`bar ${toneClass}`} role="presentation">
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ------------------------------------------------------- Loading / Empty */

export function LoadingBlock({ label = '加载中' }: { label?: string }) {
  return (
    <div className="p-4 text-aux" style={{ color: 'var(--rg-text-tertiary)' }} role="status">
      {label}…
    </div>
  );
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="p-4 text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
      {label}
    </div>
  );
}

/** 错误态。区分传输失败与业务失败，避免把业务原因说成网络错误。 */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="note note-danger" role="alert">
      <div className="flex-1 min-w-0">{message}</div>
      {onRetry && (
        <Button size="sm" variant="danger" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  );
}