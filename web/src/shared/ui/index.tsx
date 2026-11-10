/**
 * 基础 UI 组件（无业务语义）。
 * 只负责结构与可访问性，不发起请求、不含业务判断。
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { forwardRef, useId } from 'react';

/* Button */

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

/* Field */

/**
 * 单输入框 + 可选标签。
 *
 * 刻意在类型上排除 children：input 是 void 元素，传入 children 会被 React
 * 判为「void 元素带 children」并在渲染期抛错（对应压缩错误 #137）。
 * 需要「时:分」这类组合控件时用 FieldRow。
 *
 * id 必须兜底生成：调用方几乎都只传 label，不传 id；此时若直接
 * htmlFor={undefined}，可见标签与输入框之间没有任何关联，点击标签不聚焦、
 * 读屏也不播报字段名。useId 提供稳定且唯一的 id，调用方传 id 时仍然优先用它。
 */
export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'children'> {
  label?: string;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, id, className = '', ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const input = (
    <input
      ref={ref}
      id={inputId}
      className={['field', 'w-full', className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
  // 无 label 时不渲染 <label>，此时 id 仍挂上，便于外部 aria-labelledby 引用
  if (!label) return input;
  return (
    <label className="flex flex-col gap-1 min-w-0" htmlFor={inputId}>
      <span className="text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
        {label}
      </span>
      {input}
    </label>
  );
});

/**
 * 带标签的表单行，接受任意 children。
 * 用于「时:分」这类需要多个输入框或组合控件的场景。
 */
export function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
        {label}
      </span>
      {children}
    </div>
  );
}

/* Stepper */

/**
 * 紧凑整数步进器。用于表格单元格等空间受限处：
 * - 高度 h-6，比 .field（h-8）小一号，嵌入表格不突兀
 * - 两侧 ± 微调，中间可直接键入目标值
 * - 隐藏 number input 的原生 spinners（见 global.css 的 .stepper-input），
 *   否则会与两侧按钮重复且撑高行高
 */
export interface StepperProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /** 无障碍标签（该控件无可见文字时必须提供） */
  label: string;
  onChange: (next: number) => void;
}

export function Stepper({
  value,
  min = 0,
  max = 99,
  step = 1,
  disabled,
  label,
  onChange,
}: StepperProps) {
  const clamp = (n: number) => Math.max(min, Math.min(max, Math.round(n)));
  const nudge = (delta: number) => {
    if (disabled) return;
    const next = clamp(value + delta);
    if (next !== value) onChange(next);
  };
  return (
    <div
      className="stepper inline-flex items-stretch h-6 rounded-md border overflow-hidden"
      style={{ borderColor: 'var(--rg-border-stronger)', background: 'var(--rg-bg-base)' }}
      role="group"
      aria-label={label}
    >
      <button
        type="button"
        className="stepper-btn px-1.5 text-[13px] leading-none disabled:opacity-40"
        style={{ color: 'var(--rg-text-secondary)' }}
        disabled={disabled || value <= min}
        aria-label={`${label}：减少`}
        onClick={() => nudge(-step)}
      >
        −
      </button>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => {
          const raw = Number.parseInt(e.target.value, 10);
          if (!Number.isFinite(raw)) return;
          const next = clamp(raw);
          if (next !== value) onChange(next);
        }}
        className="stepper-input w-[34px] border-0 text-center text-aux font-mono p-0"
        style={{ color: 'var(--rg-text-primary)', background: 'transparent' }}
      />
      <button
        type="button"
        className="stepper-btn px-1.5 text-[13px] leading-none disabled:opacity-40"
        style={{ color: 'var(--rg-text-secondary)' }}
        disabled={disabled || value >= max}
        aria-label={`${label}：增加`}
        onClick={() => nudge(step)}
      >
        +
      </button>
    </div>
  );
}

/* Panel */

export interface PanelProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** 内容区去掉内边距，供表格贴边铺满 */
  flush?: boolean;
  footer?: ReactNode;
  /**
   * 面板根节点的 id，供面板外的控件用 `aria-controls` 指向它。
   *
   * 典型场景：工具栏上的「展开/收起权益总览」按钮在面板**外部**，
   * 它需要一个可解析的目标，否则 `aria-controls` 指向不存在的 id，
   * 读屏播报不到被控制的区域（Chrome 会把整个 aria-controls 忽略掉）。
   */
  id?: string;
}

export function Panel({ id, title, description, actions, children, flush, footer }: PanelProps) {
  return (
    <section className="panel" id={id}>
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

/* MetricGrid */

export interface Metric {
  key: string;
  value: ReactNode;
  delta?: ReactNode;
}

export function MetricGrid({ items }: { items: Metric[] }) {
  // 项数写进 data-cols：4 项以内按实际数量铺满，避免四列里空一片
  const cols = Math.min(Math.max(items.length, 1), 4);
  return (
    <div className="metric-grid" data-cols={cols}>
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

/* StateChip */

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

/* Tabs */

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

/* KeyValue */

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

/* KeyCards */

/**
 * 逐字段卡片。适合字段少、彼此独立且需要横向扫读的运行态指标。
 * 语义相近的一组字段请改用 KeyCardGroups。
 *
 * 列数交给 auto-fit：调用方只知道「大致想要几列」，实际可用宽度由容器决定。
 * 传死列数会在窄容器里把每卡压到 100px 以内，字段名全部折行。
 */
export function KeyCards({ cols = 3, rows }: { cols?: number; rows: KeyValueRow[] }) {
  return (
    <div
      className="grid gap-2.5"
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${Math.max(150, 900 / cols)}px, 1fr))` }}
    >
      {rows.map((r) => (
        <div key={r.k} className="subcard-soft px-3.5 py-2.5">
          <div className="text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
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
 * 外层两列（容器窄时自动降一列）；同一行卡片等高。
 */
export function KeyCardGroups({ groups }: { groups: KeyCardGroup[] }) {
  return (
    <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
      {groups.map((g) => {
        const dense = g.rows.length > DENSE_ROW_THRESHOLD;
        return (
          <div key={g.title} className="subcard px-3.5">
            <div className="mb-1.5 card-head">
              <span className="text-aux font-medium" style={{ color: 'var(--rg-text-secondary)' }}>
                {g.title}
              </span>
              <span className="card-head-line" />
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
                      ? 'kv-compact col-span-2'
                      : 'kv-compact'
                  }
                  style={{ gridTemplateColumns: dense ? '88px minmax(0, 1fr)' : '132px minmax(0, 1fr)' }}
                >
                  <dt className="text-aux leading-[1.5]" style={{ color: 'var(--rg-text-tertiary)' }}>
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

/* Note */

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

/* ProgressBar */

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

/* Loading / Empty */

/**
 * 加载态。
 *
 * 省略号由组件统一追加，调用方传「加载模块」而不是「加载模块…」——
 * 否则会渲染成「加载模块……」。这一点此前被 App.tsx 踩到过。
 */
export function LoadingBlock({ label = '加载中' }: { label?: string }) {
  return (
    <div className="p-4 text-aux" style={{ color: 'var(--rg-text-tertiary)' }} role="status">
      {label.replace(/…+$/, '')}…
    </div>
  );
}

/** 空态与错误态里「标签式」短句统一不带句末句号，这里做一次兜底收敛。 */
function stripTrailingPeriod(text: string): string {
  return text.replace(/。\s*$/, '');
}

/**
 * 空态。回答两个问题：为什么空、现在该做什么。
 * 只有纯展示的空态可以省略 action，但 hint 至少要说明原因，
 * 否则用户停在空页面时无法判断是「还没配」还是「筛错了」。
 */
export function EmptyState({
  label,
  hint,
  action,
}: {
  label: string;
  /** 原因说明，例如「官方账单通常在请求后 1 至 2 天出现」 */
  hint?: string;
  /** 下一步动作，例如「接入第一个账号」 */
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="p-4 text-aux flex flex-col items-start gap-2" style={{ color: 'var(--rg-text-tertiary)' }}>
      <div>{stripTrailingPeriod(label)}</div>
      {hint && (
        <div className="text-aux leading-relaxed" style={{ color: 'var(--rg-text-tertiary)' }}>
          {hint}
        </div>
      )}
      {action && (
        <Button size="sm" variant="primary" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
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